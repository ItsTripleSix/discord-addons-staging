(() => {
  "use strict";
  const V = vendetta;
  if (!V?.metro || !V?.patcher) return {};
  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const BASE_URL = "https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/10bcce8814bde3565fa3f6074b860c0f926df6cc/plugins/purge-tools/index.js";
  const CACHE = "shiggyPurgeWrapperBase122";
  let inner = null, innerError = null, loadPromise = null, started = false;
  const listeners = new Set();
  const toast = text => { try { V.ui?.toasts?.showToast?.(String(text)); } catch {} };
  const notify = () => { for (const fn of listeners) try { fn(); } catch {} };

  async function fetchBase() {
    try {
      const r = await V.utils.safeFetch(BASE_URL, { cache: "no-store" });
      if (!r?.ok) throw new Error(`HTTP ${r?.status ?? "?"}`);
      const s = await r.text();
      if (!s?.includes("1.2.2-shiggy")) throw new Error("Invalid Purge Tools v1.2.2 base source");
      storage[CACHE] = s;
      return s;
    } catch (e) {
      const s = storage[CACHE];
      if (typeof s === "string" && s.length > 1000) return s;
      throw e;
    }
  }

  function once(s, a, b, label) {
    const i = s.indexOf(a);
    if (i < 0 || s.indexOf(a, i + a.length) >= 0) throw new Error(`Could not patch ${label}`);
    return s.slice(0, i) + b + s.slice(i + a.length);
  }

  function switchRexForLabel(source, label) {
    const labelPos = source.indexOf(`"${label}"`);
    if (labelPos < 0 || source.indexOf(`"${label}"`, labelPos + label.length + 2) >= 0) {
      throw new Error(`Could not locate ${label}`);
    }
    const callPos = source.lastIndexOf("out = rex(out,", labelPos);
    if (callPos < 0) throw new Error(`Could not locate rex call for ${label}`);
    return source.slice(0, callPos) + "out = srex(out," + source.slice(callPos + "out = rex(out,".length);
  }

  function patch(source) {
    let out = String(source);

    out = once(
      out,
      '  const rex = (s, a, b, label) => once(s, esc(a), esc(b), label);\n',
      '  const rex = (s, a, b, label) => once(s, esc(a), esc(b), label);\n  const sq = s => String(s).replace(/\\\\/g, "\\\\\\\\").replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r").replace(/\\\'/g, "\\\\\\\'");\n  const srex = (s, a, b, label) => once(s, sq(a), sq(b), label);\n',
      "single-quoted wrapper patch helper",
    );

    out = switchRexForLabel(out, "clear pacing report");
    out = switchRexForLabel(out, "report wording");

    out = once(
      out,
      '    out = once(out, "1.2.0-shiggy", "1.2.2-shiggy", "version");',
      '    out = once(out, "1.2.0-shiggy", "1.2.3-shiggy", "version");',
      "v1.2.3 version",
    );
    out = once(
      out,
      '    out = once(out, "purge-tools-shiggy-v1.2.0-base.js", "purge-tools-shiggy-v1.2.2-base.js", "source label");',
      '    out = once(out, "purge-tools-shiggy-v1.2.0-base.js", "purge-tools-shiggy-v1.2.3-base.js", "source label");',
      "v1.2.3 source label",
    );

    return out;
  }

  async function load() {
    const source = patch(await fetchBase());
    const factory = (0, eval)(`vendetta=>{return ${source}}\n//# sourceURL=purge-tools-shiggy-v1.2.3-wrapper.js`);
    const raw = factory(V), resolved = typeof raw === "function" ? raw() : raw;
    return await Promise.resolve(resolved?.default ?? resolved ?? {});
  }

  function ensure() {
    if (inner) return Promise.resolve(inner);
    if (loadPromise) return loadPromise;
    innerError = null;
    loadPromise = load()
      .then(p => { inner = p; if (started) inner?.onLoad?.(); notify(); return inner; })
      .catch(e => { innerError = e; inner = null; loadPromise = null; notify(); toast(`Purge Tools failed to load: ${e?.message ?? e}`); throw e; });
    loadPromise.catch(() => {});
    return loadPromise;
  }

  function accountId() {
    try { return String(V.metro.findByProps?.("getCurrentUser")?.getCurrentUser?.()?.id ?? ""); }
    catch { return ""; }
  }

  function Settings() {
    const [, render] = React.useReducer(v => v + 1, 0);
    React.useEffect(() => {
      const f = () => render();
      listeners.add(f);
      ensure();
      return () => listeners.delete(f);
    }, []);
    if (typeof inner?.settings === "function") return React.createElement(inner.settings);
    return React.createElement(
      RN.View,
      { style: { flex: 1, padding: 16, backgroundColor: "#111214" } },
      React.createElement(
        RN.Text,
        { style: { color: "#F2F3F5" } },
        innerError ? `Could not load Purge Tools: ${innerError?.message ?? innerError}` : "Loading Purge Tools…",
      ),
    );
  }

  return {
    onLoad() {
      started = true;
      if (storage.autoResumeInterrupted === true && accountId() && storage.activePurgeJobs?.[accountId()]) ensure();
    },
    onUnload() {
      started = false;
      try { inner?.onUnload?.(); } catch {}
      listeners.clear();
    },
    settings: Settings,
  };
})()
