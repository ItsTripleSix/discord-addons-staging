(() => {
  "use strict";

  const V = vendetta;
  if (!V?.metro || !V?.patcher) return {};

  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const BASE_URL = "https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/9528af7b82f442173805b5db3fc9a061c1a3b857/plugins/purge-tools/index.js";
  const BASE_CACHE_KEY = "shiggyPurgeWrapperBase117";

  let inner = null;
  let innerError = null;
  let loadPromise = null;
  let started = false;
  const listeners = new Set();

  function toast(text) {
    try { V.ui?.toasts?.showToast?.(String(text)); } catch {}
  }

  function notify() {
    for (const fn of listeners) try { fn(); } catch {}
  }

  async function fetchBaseSource() {
    try {
      const response = await V.utils.safeFetch(BASE_URL, { cache: "no-store" });
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "?"}`);
      const source = await response.text();
      if (!source?.includes("Purge Tools") || !source?.includes("1.1.7-shiggy")) {
        throw new Error("Invalid Purge Tools v1.1.7 base source");
      }
      storage[BASE_CACHE_KEY] = source;
      return source;
    } catch (error) {
      const cached = storage[BASE_CACHE_KEY];
      if (typeof cached === "string" && cached.length > 1000) return cached;
      throw error;
    }
  }

  function replaceOnce(source, before, after, label) {
    const first = source.indexOf(before);
    if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
      throw new Error(`Could not patch ${label}`);
    }
    return source.slice(0, first) + after + source.slice(first + before.length);
  }

  function patchBaseSource(source) {
    let out = String(source);

    out = replaceOnce(
      out,
      'const PLUGIN_VERSION = "1.1.7-shiggy";',
      'const PLUGIN_VERSION = "1.1.8-shiggy";',
      "plugin version",
    );

    out = replaceOnce(
      out,
      '  const PACING_VERSION = 1;\\n',
      '  const PACING_VERSION = 2;\\n',
      "pacing state version",
    );

    out = replaceOnce(
      out,
      '  const pacingFloor = kind => kind === \\"read\\" ? 400 : 1200;\\n',
      '  const pacingFloor = kind => kind === \\"read\\" ? 400 : 300;\\n  const pacingStart = kind => kind === \\"read\\" ? 400 : 650;\\n',
      "pacing floors",
    );

    out = replaceOnce(
      out,
      '      this.delay = Math.max(pacingFloor(kind), pacingNumber(saved.delay) ?? 0);\\n',
      '      this.delay = Math.max(pacingFloor(kind), pacingNumber(saved.delay) ?? pacingStart(kind));\\n',
      "pacing start delay",
    );

    out = replaceOnce(
      out,
      '    success(headersAvailable, now = Date.now()) {\\n      if (headersAvailable && now - this.lastLimited >= 600000 && ++this.good >= 120) {\\n        this.delay = Math.max(pacingFloor(this.kind), Math.ceil(this.delay * 0.95));\\n        this.good = 0;\\n      }\\n    }\\n',
      '    success(headersAvailable, now = Date.now()) {\\n      if (now - this.lastLimited < 600000) { this.good = 0; return; }\\n      this.good++;\\n      const threshold = headersAvailable ? 120 : 60;\\n      if (this.good >= threshold) {\\n        const factor = headersAvailable ? 0.95 : 0.90;\\n        this.delay = Math.max(pacingFloor(this.kind), Math.ceil(this.delay * factor));\\n        this.good = 0;\\n      }\\n    }\\n',
      "headerless pacing adaptation",
    );

    const insertMarker = '    return out;\n  }\n\n  function portSource(source) {';
    const draftPatch = `    exact(
      '    const [selected, setSelected] = React.useState({});',
      '    const [selected, setSelected] = React.useState(() => { try { const accountId = purgeAccountId(); const draft = storage.shiggyPurgeDraftTargets?.[accountId]; return draft && typeof draft === "object" && !Array.isArray(draft) ? clone(draft) : {}; } catch { return {}; } });',
      "persistent target draft init",
    );
    exact(
      '    const [, render] = React.useReducer(value => value + 1, 0);\\n\\n    React.useEffect(() => {',
      '    const [, render] = React.useReducer(value => value + 1, 0);\\n\\n    React.useEffect(() => {\\n      try {\\n        const accountId = purgeAccountId();\\n        if (accountId) {\\n          const drafts = { ...(storage.shiggyPurgeDraftTargets ?? {}) };\\n          if (Object.keys(selected).length) drafts[accountId] = clone(selected);\\n          else delete drafts[accountId];\\n          storage.shiggyPurgeDraftTargets = drafts;\\n        }\\n      } catch {}\\n    }, [selected]);\\n\\n    React.useEffect(() => {',
      "persistent target draft save",
    );
    return out;
  }

  function portSource(source) {`;
    out = replaceOnce(out, insertMarker, draftPatch, "persistent target draft hook");

    return out;
  }

  async function loadInner() {
    const source = patchBaseSource(await fetchBaseSource());
    const factory = (0, eval)(`vendetta=>{return ${source}}\n//# sourceURL=purge-tools-shiggy-v1.1.8-base.js`);
    const raw = factory(V);
    const resolved = typeof raw === "function" ? raw() : raw;
    return await Promise.resolve(resolved?.default ?? resolved ?? {});
  }

  function ensureInner() {
    if (inner) return Promise.resolve(inner);
    if (loadPromise) return loadPromise;

    innerError = null;
    loadPromise = loadInner()
      .then(plugin => {
        inner = plugin;
        if (started) {
          try { inner?.onLoad?.(); }
          catch (error) { throw new Error(`Inner start failed: ${error?.message ?? error}`); }
        }
        notify();
        return inner;
      })
      .catch(error => {
        innerError = error;
        inner = null;
        loadPromise = null;
        notify();
        toast(`Purge Tools failed to load: ${error?.message ?? error}`);
        throw error;
      });

    loadPromise.catch(() => {});
    return loadPromise;
  }

  function wrapperCurrentAccountId() {
    try {
      const store = V.metro.findByProps?.("getCurrentUser");
      const id = store?.getCurrentUser?.()?.id;
      return id ? String(id) : "";
    } catch { return ""; }
  }

  function hasInterruptedAutoResume() {
    try {
      if (storage.autoResumeInterrupted !== true) return false;
      const accountId = wrapperCurrentAccountId();
      if (!accountId) return false;
      return !!storage.activePurgeJobs?.[accountId];
    } catch {
      return false;
    }
  }

  function SettingsBridge() {
    const [, render] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => {
      const listener = () => render();
      listeners.add(listener);
      ensureInner();
      return () => listeners.delete(listener);
    }, []);

    if (typeof inner?.settings === "function") {
      return React.createElement(inner.settings);
    }

    const Pressable = RN.Pressable ?? RN.TouchableOpacity;
    return React.createElement(
      RN.View,
      { style: { flex: 1, padding: 16, backgroundColor: "#111214" } },
      React.createElement(
        RN.Text,
        { style: { color: "#F2F3F5", fontSize: 16 } },
        innerError
          ? `Could not load Purge Tools: ${innerError?.message ?? innerError}`
          : "Loading Purge Tools…",
      ),
      innerError ? React.createElement(
        Pressable,
        {
          onPress: () => {
            innerError = null;
            loadPromise = null;
            ensureInner();
            render();
          },
          style: {
            marginTop: 14,
            padding: 11,
            borderRadius: 8,
            backgroundColor: "#5865F2",
            alignItems: "center",
          },
        },
        React.createElement(
          RN.Text,
          { style: { color: "#F2F3F5", fontWeight: "700" } },
          "Retry",
        ),
      ) : null,
    );
  }

  return {
    onLoad() {
      started = true;
      if (hasInterruptedAutoResume()) ensureInner();
    },
    onUnload() {
      started = false;
      try { inner?.onUnload?.(); } catch {}
      listeners.clear();
    },
    settings: SettingsBridge,
  };
})()
