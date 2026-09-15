(() => {
  "use strict";
  const V = vendetta;
  if (!V?.metro || !V?.patcher) return {};
  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const BASE_URL = "https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/f193a94e67e9fc3b0a8c8b0a67bb87cc5e3689af/plugins/purge-tools/index.js";
  const CACHE = "shiggyPurgeWrapperBase120";
  let inner = null, innerError = null, loadPromise = null, started = false;
  const listeners = new Set();
  const toast = text => { try { V.ui?.toasts?.showToast?.(String(text)); } catch {} };
  const notify = () => { for (const fn of listeners) try { fn(); } catch {} };
  async function fetchBase() {
    try {
      const r = await V.utils.safeFetch(BASE_URL, { cache: "no-store" });
      if (!r?.ok) throw new Error(`HTTP ${r?.status ?? "?"}`);
      const s = await r.text();
      if (!s?.includes("1.2.0-shiggy")) throw new Error("Invalid Purge Tools v1.2.0 base source");
      storage[CACHE] = s; return s;
    } catch (e) {
      const s = storage[CACHE]; if (typeof s === "string" && s.length > 1000) return s; throw e;
    }
  }
  function once(s, a, b, label) {
    const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + a.length) >= 0) throw new Error(`Could not patch ${label}`);
    return s.slice(0, i) + b + s.slice(i + a.length);
  }
  const esc = s => JSON.stringify(String(s)).slice(1, -1);
  const rex = (s, a, b, label) => once(s, esc(a), esc(b), label);
  function rinsert(s, marker, raw, label) {
    const m = esc(marker), i = s.indexOf(m); if (i < 0 || s.indexOf(m, i + m.length) >= 0) throw new Error(`Could not patch ${label}`);
    return s.slice(0, i) + esc(raw) + s.slice(i);
  }

  const SHARED_CLASS = `  class SharedResourceGovernor {
    constructor(saved = {}) {
      const now = Date.now(), fresh = pacingNumber(saved.updatedAt) != null && now - saved.updatedAt <= PACING_TTL;
      this.starts = fresh && Array.isArray(saved.starts) ? saved.starts.filter(t => Number.isFinite(t) && t > now - 120000) : [];
      this.blocked = fresh ? pacingNumber(saved.blocked) ?? 0 : 0;
      this.safe = fresh ? pacingNumber(saved.safe) : null;
      this.unsafe = fresh ? pacingNumber(saved.unsafe) : null;
      this.probe = null; this.proven = fresh && saved.proven === true;
      this.confidence = pacingClamp(pacingNumber(saved.confidence) ?? (this.proven ? .75 : .25), 0, 1);
      this.lastLimited = fresh ? pacingNumber(saved.lastLimited) ?? 0 : 0;
      this.freezeUntil = fresh ? pacingNumber(saved.freezeUntil) ?? 0 : 0;
      this.clean = 0; this.firstClean = 0; this.probeStarted = 0; this.probeGood = 0; this.updatedAt = now;
    }
    trim(now = Date.now()) { this.starts = this.starts.filter(t => t > now - 120000); }
    started(now = Date.now()) { this.trim(now); this.starts.push(now); this.updatedAt = now; }
    cap() { return this.probe ?? this.safe; }
    next(now = Date.now()) {
      let d = this.blocked, cap = this.cap(); if (cap == null || cap < 1) return d;
      const a = this.starts.filter(t => t > now - 60000).sort((x,y)=>x-y);
      if (a.length >= cap) d = Math.max(d, a[Math.max(0, a.length - Math.floor(cap))] + 60000 + PACING_BUFFER);
      return d;
    }
    infer(now = Date.now()) {
      this.trim(now); const a = this.starts.filter(t => t > now - 60000).sort((x,y)=>x-y);
      if (a.length < 12) return null; const span = Math.max(1, now - a[0]); if (span < 30000) return null;
      return Math.max(a.length, Math.ceil(a.length * 60000 / Math.min(60000, span)));
    }
    maybeProbe(now = Date.now()) {
      if (!this.proven || this.probe != null || now < this.freezeUntil || now - this.lastLimited < PROBE_FREEZE || this.safe == null || this.clean < 60 || !this.firstClean || now - this.firstClean < 90000) return;
      let n = this.unsafe != null && this.unsafe > this.safe + 1 ? Math.min(this.unsafe - 1, this.safe + Math.max(1, Math.ceil((this.unsafe - this.safe) * .25))) : Math.ceil(this.safe * 1.05);
      if (n <= this.safe) return; this.probe = n; this.probeStarted = now; this.probeGood = 0; this.clean = 0; this.firstClean = 0; this.updatedAt = now;
    }
    success(now = Date.now()) {
      if (this.safe == null) return; if (!this.firstClean) this.firstClean = now; this.clean++;
      if (!this.proven) {
        if (this.clean >= 60 && now - this.firstClean >= 120000) { this.proven = true; this.confidence = Math.max(this.confidence,.72); this.clean=0; this.firstClean=0; this.freezeUntil=Math.max(this.freezeUntil,now+60000); }
      } else if (this.probe != null) {
        this.probeGood++; if (this.probeGood >= 60 && now - this.probeStarted >= 120000) { this.safe=this.probe; this.probe=null; this.probeGood=0; this.clean=0; this.firstClean=0; this.confidence=Math.min(1,this.confidence+.1); this.freezeUntil=now+60000; }
      } else this.maybeProbe(now);
      this.updatedAt = now;
    }
    limited(ms, now = Date.now()) {
      const probing = this.probe, inferred = this.infer(now);
      if (probing != null) this.unsafe = this.unsafe == null ? probing : Math.min(this.unsafe, probing);
      else if (inferred != null) this.unsafe = this.unsafe == null ? inferred : Math.min(this.unsafe, inferred);
      if (this.safe == null) { const u=this.unsafe ?? inferred; if (u != null) this.safe=Math.max(1,Math.floor((u-1)*.80)); }
      else if (probing == null) { const c=this.unsafe==null?this.safe:Math.min(this.safe,this.unsafe-1); this.safe=Math.max(1,Math.floor(c*.90)); }
      this.probe=null; this.probeGood=0; this.clean=0; this.firstClean=0; this.proven=false; this.lastLimited=now; this.freezeUntil=Math.max(this.freezeUntil,now+PROBE_FREEZE); this.confidence=Math.max(.1,this.confidence-.15);
      this.blocked=Math.max(this.blocked,now+ms+PACING_BUFFER,now+5000,this.next(now)); this.updatedAt=now;
    }
    mode(now = Date.now()) { return now<this.blocked?"cooldown":this.probe!=null?"probing":now<this.freezeUntil?"stabilizing":this.proven?"learned":this.safe==null?"observing":"learning"; }
    snapshot() { return { starts:this.starts, blocked:this.blocked, safe:this.safe, unsafe:this.unsafe, proven:this.proven, confidence:this.confidence, lastLimited:this.lastLimited, freezeUntil:this.freezeUntil, updatedAt:this.updatedAt }; }
  }

`;

  function patch(source) {
    let out = String(source);
    out = once(out, "1.2.0-shiggy", "1.2.1-shiggy", "version");
    out = once(out, "purge-tools-shiggy-v1.2.0-base.js", "purge-tools-shiggy-v1.2.1-base.js", "source label");
    out = rex(out, '  const PACING_VERSION = 4;\n', '  const PACING_VERSION = 5;\n', "pacing version");
    out = rex(out, '  const PROBE_FREEZE = 600000;\n', '  const PROBE_FREEZE = 180000;\n', "probe freeze");
    out = rex(out, '  const pacingStart = kind => kind === "read" ? 400 : 1200;\n', '  const pacingStart = kind => kind === "read" ? 400 : 1400;\n', "start pace");
    out = rinsert(out, '  class PurgeMetrics {\n', SHARED_CLASS, "shared governor class");
    out = rex(out,
      '      this.lanes = new Map();\n      this.aliases = new Map();\n',
      '      this.lanes = new Map();\n      this.aliases = new Map();\n      this.resources = new Map();\n', "resource map");
    out = rex(out,
      '      for (const [key, value] of Object.entries(saved.aliases ?? {})) if (this.lanes.has(value)) this.aliases.set(key, value);\n',
      '      for (const [key, value] of Object.entries(saved.aliases ?? {})) if (this.lanes.has(value)) this.aliases.set(key, value);\n      for (const [key, value] of Object.entries(saved.resources ?? {})) if (value?.updatedAt > Date.now() - PACING_TTL || value?.blocked > Date.now()) this.resources.set(key, new SharedResourceGovernor(value));\n', "load resources");
    out = rex(out,
      '      this.activeLane = null;\n',
      '      this.activeLane = null;\n      this.activeResource = null;\n', "active resource");
    out = rinsert(out, '    lane(identity, kind) {\n', '    resource(identity) { if (!this.resources.has(identity.major)) this.resources.set(identity.major, new SharedResourceGovernor()); return this.resources.get(identity.major); }\n', "resource accessor");
    out = rex(out,
      '      return Math.max(this.operationLanes.get(operation)?.effectiveDelay() ?? pacingStart("modify"), this.metrics.pacingMs[operation] ?? 0);\n',
      '      const c=this.activeResource?.cap(); return Math.max(this.operationLanes.get(operation)?.effectiveDelay() ?? pacingStart("modify"), this.metrics.pacingMs[operation] ?? 0, c ? 60000/c : 0);\n', "ETA shared pace");
    out = rex(out,
      '        aliases: Object.fromEntries(this.aliases),\n        lanes: Object.fromEntries([...this.lanes.entries()].map(([key, lane]) => [key, lane.snapshot()])),\n',
      '        aliases: Object.fromEntries(this.aliases),\n        lanes: Object.fromEntries([...this.lanes.entries()].map(([key, lane]) => [key, lane.snapshot()])),\n        resources: Object.fromEntries([...this.resources.entries()].map(([key, resource]) => [key, resource.snapshot()])),\n', "persist resources");
    out = rex(out,
      '      const queueKey = `${kind}:${identity.major}`;\n',
      '      const queueKey = identity.major;\n', "shared resource queue");
    out = rex(out,
      '      let lane = this.lane(identity, kind);\n      for (;;) {\n',
      '      let lane = this.lane(identity, kind);\n      const resource = this.resource(identity);\n      for (;;) {\n', "request resource");
    out = rex(out,
      '        this.activeLane = lane;\n        const now = Date.now();\n        const blockedUntil = Math.max(lane.blocked, this.globalUntil);\n        const deadline = Math.max(lane.nextAt, blockedUntil);\n',
      '        this.activeLane = lane; this.activeResource = resource;\n        const now = Date.now();\n        const hardBlocked = Math.max(lane.blocked, resource.blocked, this.globalUntil);\n        const deadline = Math.max(lane.nextAt, hardBlocked, resource.next(now));\n', "shared deadline");
    out = rex(out,
      '          const reason = blockedUntil > now ? "cooldown" : "pacing";\n',
      '          const reason = hardBlocked > now ? "cooldown" : "pacing";\n', "wait reason");
    out = rex(out,
      '          if (blockedUntil - now >= PACING_LONG_WAIT && !this.control.paused && blockedUntil > (this.longWaitAcknowledged ?? 0)) {\n            this.longWaitAcknowledged = blockedUntil;\n            this.hold(`Long Discord cooldown. Paused; requests can resume after ${new Date(blockedUntil).toLocaleTimeString()}.`);\n',
      '          if (hardBlocked - now >= PACING_LONG_WAIT && !this.control.paused && hardBlocked > (this.longWaitAcknowledged ?? 0)) {\n            this.longWaitAcknowledged = hardBlocked;\n            this.hold(`Long Discord cooldown. Paused; requests can resume after ${new Date(hardBlocked).toLocaleTimeString()}.`);\n', "long wait");
    out = rex(out,
      '        const changedBlock = Math.max(lane.blocked, this.globalUntil);\n',
      '        const changedBlock = Math.max(lane.blocked, resource.blocked, resource.next(afterGate), this.globalUntil);\n', "post gate shared block");
    out = rex(out,
      '        const requestStart = Date.now();\n        this.metrics.request(identity.operation);\n',
      '        const requestStart = Date.now();\n        resource.started(requestStart);\n        this.metrics.request(identity.operation);\n', "shared start tracking");
    out = rex(out,
      '          lane.limited(ms, scope);\n          if (global) this.globalUntil = Math.max(this.globalUntil, Date.now() + ms + PACING_BUFFER);\n          this.metrics.limit(identity.operation, scope, ms, error, lane);\n',
      '          this.metrics.limit(identity.operation, scope, ms, error, lane);\n          if (scope === "shared") { resource.limited(ms); if (lane.probing) { lane.currentDelay=Math.max(lane.previousSafe,lane.safeDelay); lane.probing=false; lane.probeSuccesses=0; lane.cleanSuccesses=0; lane.firstCleanAt=0; } lane.probeFreezeUntil=Math.max(lane.probeFreezeUntil,Date.now()+PROBE_FREEZE); } else lane.limited(ms, scope);\n          if (global) this.globalUntil = Math.max(this.globalUntil, Date.now() + ms + PACING_BUFFER);\n', "shared 429 handling");
    out = rex(out,
      '          if (this.limitTimes.length >= 8) this.hold("Discord is repeatedly rate limiting this purge. Paused with progress saved; copy the test report before resuming.");\n',
      '          if (this.limitTimes.length >= 6) this.hold("Discord is repeatedly rate limiting this purge. Paused with progress saved; copy the test report before resuming.");\n', "circuit breaker");
    out = rex(out,
      '        lane.success(headersAvailable);\n        this.metrics.observePace(identity.operation, lane.effectiveDelay());\n',
      '        lane.success(headersAvailable);\n        resource.success();\n        this.metrics.observePace(identity.operation, lane.effectiveDelay());\n', "shared success");
    out = rex(out,
      '        current_pacing_ms: Math.ceil(lane?.effectiveDelay(now) ?? pacingStart("modify")),\n        controller_mode: lane?.mode(now) ?? "initializing",\n',
      '        current_pacing_ms: Math.ceil(Math.max(lane?.effectiveDelay(now) ?? pacingStart("modify"), this.rate.activeResource?.cap() ? 60000/this.rate.activeResource.cap() : 0)),\n        controller_mode: this.rate.activeResource?.safe != null ? this.rate.activeResource.mode(now) : lane?.mode(now) ?? "initializing",\n', "reported pace");
    out = rex(out,
      '        probe_successes: lane?.probing ? lane.probeSuccesses : 0,\n        limits_last_10m: this.rate.limitTimes.filter(time => time > now - 600000).length,\n        active_resource_lanes: this.rate.lanes.size,\n',
      '        probe_successes: this.rate.activeResource?.probe != null ? this.rate.activeResource.probeGood : lane?.probing ? lane.probeSuccesses : 0,\n        shared_safe_per_min: this.rate.activeResource?.safe == null ? null : Math.floor(this.rate.activeResource.safe),\n        shared_unsafe_per_min: this.rate.activeResource?.unsafe == null ? null : Math.floor(this.rate.activeResource.unsafe),\n        shared_controller_mode: this.rate.activeResource?.mode(now) ?? "observing",\n        limits_last_10m: this.rate.limitTimes.filter(time => time > now - 600000).length,\n        active_resource_lanes: this.rate.resources.size,\n', "shared report");
    out = rex(out,
      '      React.createElement(Txt, null, `Current spacing: ${(report.current_pacing_ms / 1000).toFixed(2)}s · learned safe: ${report.learned_safe_ms == null ? "learning" : (report.learned_safe_ms / 1000).toFixed(2) + "s"}`),\n',
      '      React.createElement(Txt, null, `Current spacing: ${(report.current_pacing_ms / 1000).toFixed(2)}s · learned route-safe: ${report.learned_safe_ms == null ? "learning" : (report.learned_safe_ms / 1000).toFixed(2) + "s"}`),\n      report.shared_safe_per_min != null ? React.createElement(Txt, null, `Shared rolling governor: ${report.shared_safe_per_min}/min safe · ${report.shared_unsafe_per_min ?? "?"}/min unsafe · ${report.shared_controller_mode}`) : null,\n', "shared UI");
    return out;
  }
  async function load() {
    const source = patch(await fetchBase());
    const factory = (0, eval)(`vendetta=>{return ${source}}\n//# sourceURL=purge-tools-shiggy-v1.2.1-wrapper.js`);
    const raw = factory(V), resolved = typeof raw === "function" ? raw() : raw;
    return await Promise.resolve(resolved?.default ?? resolved ?? {});
  }
  function ensure() {
    if (inner) return Promise.resolve(inner); if (loadPromise) return loadPromise; innerError = null;
    loadPromise = load().then(p => { inner=p; if (started) inner?.onLoad?.(); notify(); return inner; }).catch(e => { innerError=e; inner=null; loadPromise=null; notify(); toast(`Purge Tools failed to load: ${e?.message ?? e}`); throw e; });
    loadPromise.catch(()=>{}); return loadPromise;
  }
  function accountId() { try { return String(V.metro.findByProps?.("getCurrentUser")?.getCurrentUser?.()?.id ?? ""); } catch { return ""; } }
  function Settings() {
    const [,render]=React.useReducer(v=>v+1,0);
    React.useEffect(()=>{const f=()=>render();listeners.add(f);ensure();return()=>listeners.delete(f);},[]);
    if (typeof inner?.settings === "function") return React.createElement(inner.settings);
    return React.createElement(RN.View,{style:{flex:1,padding:16,backgroundColor:"#111214"}},React.createElement(RN.Text,{style:{color:"#F2F3F5"}},innerError?`Could not load Purge Tools: ${innerError?.message ?? innerError}`:"Loading Purge Tools…"));
  }
  return {
    onLoad(){started=true;if(storage.autoResumeInterrupted===true&&accountId()&&storage.activePurgeJobs?.[accountId()])ensure();},
    onUnload(){started=false;try{inner?.onUnload?.();}catch{}listeners.clear();},
    settings:Settings,
  };
})()
