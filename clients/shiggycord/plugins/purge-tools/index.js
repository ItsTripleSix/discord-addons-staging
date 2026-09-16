(() => {
  "use strict";
  const V = vendetta;
  if (!V?.metro || !V?.patcher) return {};
  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const BASE_URL = "https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/10bcce8814bde3565fa3f6074b860c0f926df6cc/plugins/purge-tools/index.js";
  const CACHE = "shiggyPurgeWrapperBase122v126";
  let inner = null, innerError = null, loadPromise = null, started = false;
  const listeners = new Set();
  const toast = text => { try { V.ui?.toasts?.showToast?.(String(text)); } catch {} };
  const notify = () => { for (const fn of listeners) try { fn(); } catch {} };

  async function fetchBase() {
    try {
      const r = await V.utils.safeFetch(BASE_URL, { cache: "no-store" });
      if (!r?.ok) throw new Error(`HTTP ${r?.status ?? "?"}`);
      const s = await r.text();
      if (!s?.includes("version target") || !s?.includes("clear pacing report")) throw new Error("Invalid Purge Tools v1.2.2 base source");
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

  function callBoundsByLabel(source, label, callPrefix) {
    const needle = `"${label}"`;
    const labelPos = source.indexOf(needle);
    if (labelPos < 0 || source.indexOf(needle, labelPos + needle.length) >= 0) throw new Error(`Could not locate ${label}`);
    const start = source.lastIndexOf(callPrefix, labelPos);
    if (start < 0) throw new Error(`Could not locate call for ${label}`);
    const end = source.indexOf(");", labelPos);
    if (end < 0) throw new Error(`Could not locate call end for ${label}`);
    return { start, end: end + 2 };
  }

  function replaceInsideCall(source, label, before, after, callPrefix = "out = once(out,") {
    const { start, end } = callBoundsByLabel(source, label, callPrefix);
    const part = source.slice(start, end);
    const i = part.indexOf(before);
    if (i < 0 || part.indexOf(before, i + before.length) >= 0) throw new Error(`Could not patch ${label}`);
    const next = part.slice(0, i) + after + part.slice(i + before.length);
    return source.slice(0, start) + next + source.slice(end);
  }

  function switchRexForLabel(source, label) {
    const { start, end } = callBoundsByLabel(source, label, "out = rex(out,");
    const part = source.slice(start, end);
    if (!part.startsWith("out = rex(out,")) throw new Error(`Could not patch ${label}`);
    return source.slice(0, start) + "out = srex(out," + part.slice("out = rex(out,".length) + source.slice(end);
  }

  function replaceEscapedUnicodeSequence(source, parts, value) {
    let out = String(source);
    let from = 0;
    while (from < out.length) {
      const pos = out.indexOf(parts[0], from);
      if (pos < 0) break;
      let start = pos;
      while (start > 0 && out.charCodeAt(start - 1) === 92) start--;
      if (start === pos) { from = pos + parts[0].length; continue; }
      let cursor = pos + parts[0].length;
      let matched = true;
      for (let i = 1; i < parts.length; i++) {
        const slashStart = cursor;
        while (cursor < out.length && out.charCodeAt(cursor) === 92) cursor++;
        if (cursor === slashStart || out.slice(cursor, cursor + parts[i].length) !== parts[i]) { matched = false; break; }
        cursor += parts[i].length;
      }
      if (!matched) { from = pos + parts[0].length; continue; }
      out = out.slice(0, start) + value + out.slice(cursor);
      from = start + value.length;
    }
    return out;
  }

  function literalizeUnicodeEscapes(source) {
    let out = String(source);
    const replacements = [
      [["ud83d", "udfe2"], "🟢"],
      [["ud83d", "udd34"], "🔴"],
      [["ud83d", "udfe1"], "🟡"],
      [["u2705"], "✅"],
      [["u23f8", "ufe0f"], "⏸️"],
      [["u26a0", "ufe0f"], "⚠️"],
      [["u2014"], "—"],
      [["u00b7"], "·"],
      [["u25b4"], "▴"],
      [["u25be"], "▾"],
    ];
    for (const [parts, value] of replacements) out = replaceEscapedUnicodeSequence(out, parts, value);
    return out;
  }

  function patch(source) {
    let out = String(source);

    out = once(
      out,
      '  const rex = (s, a, b, label) => once(s, esc(a), esc(b), label);\n',
      '  const rex = (s, a, b, label) => once(s, esc(a), esc(b), label);\n  const sq = s => String(s).replace(/\\\\/g, "\\\\\\\\").replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r").replace(/\'/g, "\\\\\'");\n  const srex = (s, a, b, label) => once(s, sq(a), sq(b), label);\n',
      "single-quoted wrapper patch helper",
    );

    out = switchRexForLabel(out, "clear pacing report");
    out = switchRexForLabel(out, "report wording");
    out = replaceInsideCall(out, "version target", "1.2.2-shiggy", "1.2.6-shiggy");
    out = replaceInsideCall(out, "source label target", "purge-tools-shiggy-v1.2.2-base.js", "purge-tools-shiggy-v1.2.6-base.js");
    out = literalizeUnicodeEscapes(out);

    return out;
  }

  async function load() {
    const source = patch(await fetchBase());
    const factory = (0, eval)(`vendetta=>{return ${source}}\n//# sourceURL=purge-tools-shiggy-v1.2.6-wrapper.js`);
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
