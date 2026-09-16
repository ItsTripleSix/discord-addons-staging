(() => {
  "use strict";

  const V = vendetta;
  const { React, ReactNative: RN } = V.metro.common;
  const { findByProps } = V.metro;
  const storage = V.plugin?.storage ?? {};

  const EPOCH = 1420070400000n;
  const LOW = 22n;
  const PAGE = 100;
  const SEARCH_PAGE = 25;
  const VERIFY_PASSES = 3;
  const TRANSIENT_RETRIES = 2;
  const TRANSIENT_RETRY_BASE_MS = 1000;
  const PLUGIN_VERSION = "1.2.10-shiggy";
  const BULK_MAX = 100;
  const BULK_SAFE_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
  const JOB_VERSION = 3;
  const RUNTIME_KEY = "__itsTripleSixPurgeToolsRuntime";
  const PERM = {
    VIEW_CHANNEL: 1024n,
    MANAGE_MESSAGES: 8192n,
    READ_MESSAGE_HISTORY: 65536n,
  };

  try { globalThis[RUNTIME_KEY]?.cleanup?.(); } catch {}

  const runtime = {
    control: null,
    listeners: new Set(),
    autoResumeTimer: null,
    previewSnapshot: null,
    cleanup: null,
    unresolvedFailures: new Set(),
  };
  globalThis[RUNTIME_KEY] = runtime;
  storage.autoResumeInterrupted ??= false;

  let progress = emptyProgress();

  function emptyProgress() {
    return {
      phase: "idle",
      status: "Idle",
      targetIndex: 0,
      targetCount: 0,
      currentTarget: "",
      currentTargetKind: "",
      currentGuildName: "",
      currentChannelName: "",
      pages: 0,
      scanned: 0,
      messagesFound: 0,
      reactionsFound: 0,
      reactedEmojisChecked: 0,
      reactionUsersChecked: 0,
      messagesDeleted: 0,
      reactionsRemoved: 0,
      bulkBatches: 0,
      permissionSkipped: 0,
      skipped: 0,
      failed: 0,
      recoveredFailures: 0,
      waitMs: 0,
      resumed: false,
    };
  }

  function notify() {
    for (const fn of runtime.listeners) try { fn(); } catch {}
  }
  function setProgress(patch) { progress = { ...progress, ...patch }; notify(); }
  function bump(patch) {
    const next = { ...progress };
    for (const [key, value] of Object.entries(patch)) next[key] = (next[key] || 0) + (value || 0);
    progress = next;
    notify();
  }
  function toast(text) { try { V.ui.toasts.showToast(String(text)); } catch {} }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

  function purgeAccountId() {
    try {
      const store = find("getCurrentUser");
      const id = store?.getCurrentUser?.()?.id;
      return id ? String(id) : "";
    } catch { return ""; }
  }
  function purgeJobMap() {
    try {
      const raw = storage.activePurgeJobs;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? clone(raw) : {};
    } catch { return {}; }
  }
  function purgeJobComplete(job) {
    const targets = Array.isArray(job?.spec?.targets) ? job.spec.targets : [];
    if (!targets.length) return false;
    const completed = new Set(Array.isArray(job?.completedKeys) ? job.completedKeys : []);
    return targets.every(target => completed.has(target.key));
  }
  function writePurgeJobMap(map) {
    storage.activePurgeJobs = clone(map ?? {});
  }
  function getSavedJob() {
    try {
      const accountId = purgeAccountId();
      if (!accountId) return null;
      const map = purgeJobMap();

      // v1.1.4 and older stored a single unscoped checkpoint. It cannot be
      // safely attributed after an account switch, so never auto-resume it.
      const legacy = storage.activePurgeJob;
      if (legacy) {
        storage.activePurgeJob = null;
        const legacyOwner = String(legacy?.accountId ?? "");
        if (legacyOwner === accountId && legacy?.version === JOB_VERSION && legacy?.spec?.targets?.length && !purgeJobComplete(legacy)) {
          map[accountId] = clone(legacy);
          writePurgeJobMap(map);
        }
      }

      const job = map[accountId];
      const invalid = !job || job.version !== JOB_VERSION || !job.spec?.targets?.length || (job.accountId && String(job.accountId) !== accountId);
      if (invalid || purgeJobComplete(job)) {
        if (job) {
          delete map[accountId];
          writePurgeJobMap(map);
          notify();
        }
        return null;
      }
      return clone(job);
    } catch { return null; }
  }
  function saveJob(job) {
    const currentId = purgeAccountId();
    const ownerId = String(job?.accountId ?? currentId ?? "");
    if (!currentId || !ownerId) throw new Error("Could not verify the Discord account for this purge checkpoint");
    if (ownerId !== currentId) throw new Error("Discord account changed during purge; stopped before writing this checkpoint");
    const map = purgeJobMap();
    map[ownerId] = { ...clone(job), accountId: ownerId };
    writePurgeJobMap(map);
    try { storage.activePurgeJob = null; } catch {}
    notify();
  }
  function clearSavedJob() {
    try {
      const accountId = purgeAccountId();
      const map = purgeJobMap();
      if (accountId && map[accountId]) {
        delete map[accountId];
        writePurgeJobMap(map);
      }
      storage.activePurgeJob = null;
    } catch {}
    notify();
  }

  function previewSignature(spec) {
    return JSON.stringify((spec?.targets ?? []).map(target => clone(target)));
  }
  function clearPreviewSnapshot() {
    runtime.previewSnapshot = null;
    notify();
  }
  function getMatchingPreviewSnapshot(spec) {
    const snapshot = runtime.previewSnapshot;
    if (!snapshot || snapshot.accountId !== purgeAccountId() || snapshot.signature !== previewSignature(spec)) return null;
    return snapshot;
  }

  const PACING_VERSION = 5;
  const PACING_DAY = 86400000;
  const PACING_TTL = 7 * PACING_DAY;
  const PACING_BUFFER = 250;
  const PACING_LONG_WAIT = 300000;
  const PROBE_FREEZE = 180000;
  const PROBE_ACCEPT_MS = 150000;
  const PROBE_ACCEPT_SUCCESSES = 100;
  const PROBE_ARM_SUCCESSES = 60;
  const GLOBAL_START_GAP = 200;
  const pacingFloor = kind => kind === "read" ? 200 : 350;
  const pacingStart = kind => kind === "read" ? 400 : 1400;
  const pacingNumber = value => {
    if (value == null || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const pacingClamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function pacingStop(message) {
    const error = new Error(message);
    error.purgeStop = true;
    return error;
  }
  function pacingDuration(ms) {
    if (!Number.isFinite(ms)) return "Calculating…";
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.ceil(seconds / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  function responseHeader(source, name) {
    const wanted = String(name).toLowerCase();
    for (const headers of [source?.headers, source?.response?.headers]) {
      if (!headers) continue;
      try {
        if (typeof headers.get === "function") {
          const value = headers.get(name) ?? headers.get(wanted);
          if (value != null) return value;
        }
        for (const [key, raw] of Object.entries(headers)) {
          if (String(key).toLowerCase() !== wanted) continue;
          if (Array.isArray(raw)) return raw[0];
          return raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
        }
      } catch {}
    }
    return undefined;
  }
  function pacingWindow(response, now = Date.now()) {
    const after = pacingNumber(responseHeader(response, "X-RateLimit-Reset-After"));
    const epoch = pacingNumber(responseHeader(response, "X-RateLimit-Reset"));
    return after != null ? Math.ceil(after * 1000) : epoch != null ? Math.max(0, Math.ceil(epoch * 1000 - now)) : null;
  }
  function pacingRetry(error, now = Date.now()) {
    const body = error?.body ?? error?.response?.body;
    const values = [body?.retry_after, error?.retry_after, responseHeader(error, "Retry-After")]
      .map(pacingNumber).filter(value => value != null).map(value => Math.ceil(value * 1000));
    const header = responseHeader(error, "Retry-After");
    if (header && pacingNumber(header) == null) {
      const date = Date.parse(String(header));
      if (Number.isFinite(date)) values.push(Math.max(0, date - now));
    }
    if (!values.length) {
      const window = pacingWindow(error, now);
      if (window != null) values.push(window);
    }
    const ms = values.length ? Math.max(...values) : 1000;
    if (!Number.isSafeInteger(now + ms + PACING_BUFFER)) throw pacingStop("Discord returned an unreadable cooldown; stopped for review");
    return ms;
  }
  function pacingIdentity(key, kind, url) {
    const operation = String(key).split(":")[0];
    const match = String(url ?? "").match(/^\/(channels|guilds)\/([^/]+)/);
    const major = match ? `${match[1]}:${match[2]}` : `channels:${String(key).split(":")[1] ?? "unknown"}`;
    return { operation, major, key: `${kind}:${operation}:${major}` };
  }

  class Control {
    constructor() {
      this.cancelled = false;
      this.userCancelled = false;
      this.paused = false;
      this.resumePhase = "discovering";
      this.accountId = purgeAccountId();
      this.failure = null;
      this.pausedAt = 0;
      this.pausedMs = 0;
    }
    assertAccount() {
      if (this.failure) throw this.failure;
      if (!this.accountId || purgeAccountId() !== this.accountId) {
        this.failure = pacingStop("Discord account changed; purge stopped before the next request");
        throw this.failure;
      }
      if (this.cancelled) throw new Error("__PURGE_CANCELLED__");
    }
    pausedTime(now = Date.now()) { return this.pausedMs + (this.paused ? now - this.pausedAt : 0); }
    cancel(user = false) {
      this.cancelled = true;
      this.userCancelled ||= user && purgeAccountId() === this.accountId;
      if (this.paused) this.pausedMs += Date.now() - this.pausedAt;
      this.paused = false;
    }
    pause(reason = "Paused") {
      if (this.cancelled || this.paused) return;
      if (["discovering", "purging", "verifying"].includes(progress.phase)) this.resumePhase = progress.phase;
      this.paused = true;
      this.pausedAt = Date.now();
      setProgress({ phase: "paused", status: reason });
    }
    resume() {
      if (!this.paused || this.cancelled) return;
      try { this.assertAccount(); } catch (error) { toast(error.message); return; }
      this.pausedMs += Date.now() - this.pausedAt;
      this.paused = false;
      runtime.rateController?.releaseHold();
      setProgress({ phase: this.resumePhase, status: `Resuming ${this.resumePhase}...` });
    }
    async check() {
      this.assertAccount();
      while (this.paused && !this.cancelled) {
        await sleep(250);
        this.assertAccount();
      }
      this.assertAccount();
    }
    async wait(ms) {
      const deadline = Date.now() + Math.max(0, ms);
      do {
        await this.check();
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        await sleep(Math.min(remaining, 250));
      } while (true);
    }
  }

  class RateLane {
    constructor(kind, saved = {}) {
      const now = Date.now();
      this.kind = kind;
      const fresh = pacingNumber(saved.updatedAt) != null && now - saved.updatedAt <= PACING_TTL;
      const savedSafe = fresh ? pacingNumber(saved.safeDelay) : null;
      const savedCurrent = fresh ? pacingNumber(saved.currentDelay ?? saved.delay) : null;
      const start = pacingStart(kind);
      this.safeDelay = pacingClamp(savedSafe ?? start, pacingFloor(kind), 30000);
      if (fresh && savedSafe != null && now - saved.updatedAt <= PACING_DAY) {
        this.currentDelay = pacingClamp(savedCurrent ?? this.safeDelay, pacingFloor(kind), 30000);
      } else {
        this.currentDelay = Math.max(start, this.safeDelay);
      }
      this.unsafeDelay = fresh ? pacingNumber(saved.unsafeDelay) : null;
      if (this.unsafeDelay != null && this.unsafeDelay >= this.safeDelay) this.unsafeDelay = null;
      this.blocked = fresh ? pacingNumber(saved.blocked) ?? 0 : 0;
      this.nextAt = 0;
      this.resetAt = fresh ? pacingNumber(saved.resetAt) ?? 0 : 0;
      this.headerDelay = fresh ? pacingNumber(saved.headerDelay) ?? 0 : 0;
      this.lastLimited = fresh ? pacingNumber(saved.lastLimited) ?? 0 : 0;
      this.probeFreezeUntil = fresh ? pacingNumber(saved.probeFreezeUntil) ?? 0 : 0;
      this.confidence = pacingClamp(pacingNumber(saved.confidence) ?? (savedSafe != null ? 0.55 : 0.35), 0, 1);
      this.cleanSuccesses = 0;
      this.firstCleanAt = 0;
      this.probing = false;
      this.probeStartedAt = 0;
      this.probeSuccesses = 0;
      this.previousSafe = this.safeDelay;
      this.limitTimes = Array.isArray(saved.limitTimes) ? saved.limitTimes.filter(time => Number.isFinite(time) && time > now - 600000) : [];
      this.updatedAt = now;
    }
    effectiveDelay(now = Date.now()) {
      return Math.max(this.currentDelay, now < this.resetAt ? this.headerDelay : 0);
    }
    observe(response, now = Date.now()) {
      const remaining = pacingNumber(responseHeader(response, "X-RateLimit-Remaining"));
      const window = pacingWindow(response, now);
      if (remaining == null || window == null) return false;
      this.resetAt = now + window;
      this.headerDelay = remaining > 0 ? Math.min(window + PACING_BUFFER, Math.ceil((window / remaining) * 1.15)) : 0;
      if (remaining === 0) this.blocked = Math.max(this.blocked, now + window + PACING_BUFFER);
      this.confidence = Math.min(1, this.confidence + 0.015);
      this.updatedAt = now;
      return true;
    }
    candidate() {
      const floor = pacingFloor(this.kind);
      if (this.unsafeDelay != null && this.unsafeDelay < this.safeDelay) {
        const gap = this.safeDelay - this.unsafeDelay;
        return Math.max(floor, Math.ceil(this.safeDelay - gap * 0.35));
      }
      return Math.max(floor, Math.ceil(this.safeDelay * (this.kind === "read" ? 0.90 : 0.92)));
    }
    maybeProbe(now = Date.now()) {
      if (this.probing || now < this.probeFreezeUntil || now - this.lastLimited < PROBE_FREEZE) return;
      if (this.cleanSuccesses < PROBE_ARM_SUCCESSES || !this.firstCleanAt || now - this.firstCleanAt < 60000) return;
      const next = this.candidate();
      if (next >= this.safeDelay - 20) return;
      this.previousSafe = this.safeDelay;
      this.currentDelay = next;
      this.probing = true;
      this.probeStartedAt = now;
      this.probeSuccesses = 0;
      this.cleanSuccesses = 0;
      this.firstCleanAt = 0;
      this.updatedAt = now;
    }
    success(headersAvailable, now = Date.now()) {
      if (headersAvailable) {
        this.cleanSuccesses++;
        this.updatedAt = now;
        return;
      }
      if (!this.firstCleanAt) this.firstCleanAt = now;
      this.cleanSuccesses++;
      if (this.probing) {
        this.probeSuccesses++;
        if (this.probeSuccesses >= PROBE_ACCEPT_SUCCESSES && now - this.probeStartedAt >= PROBE_ACCEPT_MS) {
          this.safeDelay = this.currentDelay;
          this.previousSafe = this.safeDelay;
          this.probing = false;
          this.probeSuccesses = 0;
          this.cleanSuccesses = 0;
          this.firstCleanAt = 0;
          this.confidence = Math.min(1, this.confidence + 0.12);
          this.probeFreezeUntil = now + 60000;
        }
      } else {
        this.maybeProbe(now);
      }
      this.updatedAt = now;
    }
    limited(ms, scope = "route", now = Date.now()) {
      this.limitTimes = this.limitTimes.filter(time => time > now - 600000);
      this.limitTimes.push(now);
      const wasProbe = this.probing;
      const limitedDelay = this.currentDelay;
      this.unsafeDelay = Math.max(this.unsafeDelay ?? 0, limitedDelay);
      if (wasProbe) {
        this.currentDelay = Math.max(this.previousSafe, this.safeDelay);
      } else {
        this.safeDelay = Math.min(30000, Math.max(pacingStart(this.kind), Math.ceil(limitedDelay * (this.limitTimes.length >= 3 ? 1.18 : 1.10))));
        this.currentDelay = this.safeDelay;
      }
      this.probing = false;
      this.probeSuccesses = 0;
      this.cleanSuccesses = 0;
      this.firstCleanAt = 0;
      this.lastLimited = now;
      const freeze = this.limitTimes.length >= 3 ? 1800000 : PROBE_FREEZE;
      this.probeFreezeUntil = Math.max(this.probeFreezeUntil, now + freeze);
      const drain = scope === "shared" ? 5000 : scope === "global" ? 2500 : 1000;
      this.blocked = Math.max(this.blocked, now + ms + PACING_BUFFER, now + drain);
      this.confidence = Math.max(0.1, this.confidence - (wasProbe ? 0.08 : 0.18));
      this.updatedAt = now;
    }
    mode(now = Date.now()) {
      if (now < this.blocked) return "cooldown";
      if (this.probing) return "probing";
      if (now < this.probeFreezeUntil) return "stabilizing";
      return this.confidence >= 0.7 ? "learned" : "learning";
    }
    snapshot() {
      return {
        kind: this.kind, safeDelay: this.safeDelay, currentDelay: this.currentDelay,
        unsafeDelay: this.unsafeDelay, blocked: this.blocked, resetAt: this.resetAt,
        headerDelay: this.headerDelay, lastLimited: this.lastLimited,
        probeFreezeUntil: this.probeFreezeUntil, confidence: this.confidence,
        limitTimes: this.limitTimes, updatedAt: this.updatedAt,
      };
    }
  }

  class SharedResourceGovernor {
    constructor(saved = {}) {
      const now = Date.now(), fresh = pacingNumber(saved.updatedAt) != null && now - saved.updatedAt <= PACING_TTL;
      this.starts = fresh && Array.isArray(saved.starts) ? saved.starts.filter(t => Number.isFinite(t) && t > now - 120000) : [];
      this.blocked = fresh ? pacingNumber(saved.blocked) ?? 0 : 0;
      this.safe = fresh ? pacingNumber(saved.safe) : 28;
      if (this.safe == null) this.safe = 28;
      this.safe = Math.min(30, Math.max(1, this.safe));
      this.unsafe = fresh ? pacingNumber(saved.unsafe) : null;
      this.probe = null; this.proven = fresh && saved.proven === true;
      this.confidence = pacingClamp(pacingNumber(saved.confidence) ?? (this.proven ? .75 : .25), 0, 1);
      this.lastLimited = fresh ? pacingNumber(saved.lastLimited) ?? 0 : 0;
      this.freezeUntil = fresh ? pacingNumber(saved.freezeUntil) ?? 0 : 0;
      this.clean = 0; this.firstClean = 0; this.probeStarted = 0; this.probeGood = 0; this.updatedAt = now;
    }
    trim(now = Date.now()) { this.starts = this.starts.filter(t => t > now - 120000); }
    started(now = Date.now()) { this.trim(now); this.starts.push(now); this.updatedAt = now; }
    cap() { return Math.min(30, this.probe ?? this.safe ?? 28); }
    next(now = Date.now()) {
      let d = this.blocked, cap = this.cap(); if (cap == null || cap < 1) return d;
      const a = this.starts.filter(t => t > now - 60000).sort((x,y)=>x-y);
      const gap = Math.ceil(60000 / cap);
      if (a.length) d = Math.max(d, a[a.length - 1] + gap);
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
      let n = Math.min(30, this.safe + 1);
      if (this.unsafe != null) n = Math.min(n, this.unsafe - 1);
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

  class PurgeMetrics {
    constructor(rate) {
      this.rate = rate;
      this.startedAt = Date.now();
      this.finishedAt = 0;
      this.requests = [];
      this.deletions = [];
      this.reactionEvents = [];
      this.workEvents = [];
      this.responses = {};
      this.routes = {};
      this.limitEvents = [];
      this.rateLimits = 0;
      this.transientErrors = 0;
      this.recoveredTransientRequests = 0;
      this.headersSeen = 0;
      this.requestCount = 0;
      this.networkMs = {};
      this.pacingMs = {};
      this.observedLimits = {};
      this.inFlightAt = 0;
      this.inFlightOperation = "";
      this.inFlightCount = 0;
      this.pending = null;
      this.workTotal = 0;
      this.workDone = 0;
      this.workMessagesTotal = 0;
      this.workMessagesDone = 0;
      this.workReactionsTotal = 0;
      this.workReactionsDone = 0;
      this.workActive = false;
      this.workStartedAt = 0;
      this.waitUntil = 0;
      this.waitKind = "";
      this.waitStarted = 0;
      this.waitTotals = { pacing: 0, cooldown: 0, indexing: 0, transient: 0 };
      this.indexWaits = 0;
      this.lastSavedAt = 0;
      this.lastSavedLimits = 0;
    }
    request(operation) {
      const now = Date.now();
      this.requests.push(now);
      this.requests = this.requests.filter(time => time > now - 3600000);
      this.requestCount++;
      this.routes[operation] = (this.routes[operation] ?? 0) + 1;
      this.inFlightCount++;
      if (!this.inFlightAt) this.inFlightAt = now;
      this.inFlightOperation = operation;
    }
    response(operation, status, duration, response) {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      if (!this.inFlightCount) this.inFlightAt = 0;
      this.responses[status] = (this.responses[status] ?? 0) + 1;
      if (status >= 200 && status < 300) {
        this.networkMs[operation] = this.networkMs[operation] == null ? duration : this.networkMs[operation] * 0.8 + duration * 0.2;
      }
      if (pacingNumber(responseHeader(response, "X-RateLimit-Remaining")) != null) {
        this.headersSeen++;
        this.observedLimits[operation] = {
          limit: pacingNumber(responseHeader(response, "X-RateLimit-Limit")),
          remaining: pacingNumber(responseHeader(response, "X-RateLimit-Remaining")),
          reset_after_s: pacingNumber(responseHeader(response, "X-RateLimit-Reset-After")),
        };
      }
    }
    observePace(operation, delay) {
      this.pacingMs[operation] = this.pacingMs[operation] == null ? delay : this.pacingMs[operation] * 0.9 + delay * 0.1;
    }
    limit(operation, scope, ms, response, lane) {
      this.rateLimits++;
      this.limitEvents.push({
        elapsed_s: Math.round((Date.now() - this.startedAt) / 1000), operation, scope,
        retry_after_s: ms / 1000, pacing_ms: Math.ceil(lane.currentDelay), route_pacing_ms: Math.ceil(lane.currentDelay),
        effective_pacing_ms: Math.ceil(Math.max(lane.effectiveDelay(), this.rate.activeResource?.cap() ? 60000 / this.rate.activeResource.cap() : 0)),
        shared_safe_per_min: this.rate.activeResource?.safe == null ? null : Math.floor(this.rate.activeResource.safe),
        safe_ms: Math.ceil(lane.safeDelay), unsafe_ms: lane.unsafeDelay == null ? null : Math.ceil(lane.unsafeDelay),
        controller_mode: lane.mode(),
        limit: pacingNumber(responseHeader(response, "X-RateLimit-Limit")),
        remaining: pacingNumber(responseHeader(response, "X-RateLimit-Remaining")),
        reset_after_s: pacingNumber(responseHeader(response, "X-RateLimit-Reset-After")),
      });
      this.limitEvents = this.limitEvents.slice(-30);
    }
    beginWait(kind, until) {
      this.endWait();
      this.waitKind = kind;
      this.waitUntil = until;
      this.waitStarted = Date.now();
    }
    endWait() {
      if (this.waitStarted && this.waitKind in this.waitTotals) {
        this.waitTotals[this.waitKind] += Math.max(0, Math.min(Date.now(), this.waitUntil) - this.waitStarted);
      }
      this.waitStarted = 0;
      this.waitUntil = 0;
      this.waitKind = "";
    }
    messagePlan(messages, target) {
      const plan = { delete: 0, "bulk-delete": 0, reaction: 0 };
      const groups = new Map();
      for (const message of messages) {
        if (target.strictOrder !== true && message.moderation && isBulkRecent(message.messageId)) {
          groups.set(message.channelId, (groups.get(message.channelId) ?? 0) + 1);
        } else plan.delete++;
      }
      for (const size of groups.values()) {
        plan["bulk-delete"] += Math.floor(size / BULK_MAX);
        const remainder = size % BULK_MAX;
        if (remainder === 1) plan.delete++;
        else if (remainder > 1) plan["bulk-delete"]++;
      }
      return plan;
    }
    beginWork(found, target, verify) {
      this.pending = this.messagePlan(found.messages, target);
      this.pending.reaction = found.reactions.length;
      this.workTotal = found.messages.length + found.reactions.length;
      this.workDone = 0;
      this.workMessagesTotal = found.messages.length;
      this.workMessagesDone = 0;
      this.workReactionsTotal = found.reactions.length;
      this.workReactionsDone = 0;
      this.workActive = true;
      this.workStartedAt = Date.now();
      this.workEvents = [];
      this.verificationWork = !!verify;
      notify();
    }
    recordWork(units) {
      const now = Date.now();
      if (units > 0) this.workEvents.push({ time: now, units });
      this.workEvents = this.workEvents.filter(item => item.time > now - 300000);
    }
    finishTask(operation, units, deleted = false) {
      if (this.pending) this.pending[operation] = Math.max(0, (this.pending[operation] ?? 0) - 1);
      this.workDone += units;
      if (operation === "reaction") { this.workReactionsDone += units; this.reactionEvents.push({ time: Date.now(), units }); }
      else this.workMessagesDone += units;
      this.recordWork(units);
      if (deleted) this.deletions.push({ time: Date.now(), units });
      this.deletions = this.deletions.filter(item => item.time > Date.now() - 60000);
      this.reactionEvents = this.reactionEvents.filter(item => item.time > Date.now() - 60000);
    }
    skipMessages(messages, target) {
      const plan = this.messagePlan(messages, target);
      if (this.pending) for (const key of Object.keys(plan)) this.pending[key] = Math.max(0, this.pending[key] - plan[key]);
      this.workDone += messages.length;
      this.workMessagesDone += messages.length;
      this.recordWork(messages.length);
    }
    fallbackBatch(size) {
      if (!this.pending) return;
      this.pending["bulk-delete"] = Math.max(0, this.pending["bulk-delete"] - 1);
      this.pending.delete += size;
    }
    endWork() { this.workActive = false; this.pending = null; notify(); }
    queueEta(now = Date.now()) {
      if (!this.workActive || !this.pending) return null;
      let ms = 0;
      for (const [operation, count] of Object.entries(this.pending)) {
        ms += count * Math.max(this.rate.operationDelay(operation), this.networkMs[operation] ?? 0);
      }
      const cooldown = Math.max(this.rate.globalUntil, this.rate.activeLane?.blocked ?? 0, this.waitKind === "cooldown" ? this.waitUntil : 0);
      return Math.ceil(ms + Math.max(0, cooldown - now));
    }
    empiricalEta(now = Date.now()) {
      if (!this.workActive || this.workDone <= 0) return null;
      const windowStart = Math.max(this.workStartedAt, now - 180000);
      const recent = this.workEvents.filter(item => item.time >= windowStart);
      const units = recent.reduce((sum, item) => sum + item.units, 0);
      const elapsed = Math.max(1, now - windowStart);
      if (units < 20 || elapsed < 30000) return null;
      const perMs = units / elapsed;
      const remaining = Math.max(0, this.workTotal - this.workDone);
      return perMs > 0 ? Math.ceil(remaining / perMs) : null;
    }
    eta(now = Date.now()) {
      const queue = this.queueEta(now);
      const empirical = this.empiricalEta(now);
      if (queue == null) return empirical;
      if (empirical == null) return queue;
      const weight = Math.min(0.7, Math.max(0.25, this.workDone / Math.max(1, this.workTotal)));
      return Math.ceil(queue * (1 - weight) + empirical * weight);
    }
    etaRange(now = Date.now()) {
      const best = this.eta(now);
      if (best == null) return null;
      const sample = this.workEvents.reduce((sum, item) => sum + item.units, 0);
      const recentLimit = this.rate.limitTimes.some(time => time > now - 600000);
      const confidence = pacingClamp(0.35 + Math.min(0.45, sample / 250) - (recentLimit ? 0.15 : 0), 0.2, 0.9);
      const spread = 0.35 - confidence * 0.22;
      return { best, low: Math.max(0, Math.floor(best * (1 - spread))), high: Math.ceil(best * (1 + spread * 1.5)), confidence };
    }
    report() {
      const now = this.finishedAt || Date.now();
      const requestCountSince = ms => this.requests.filter(time => time > now - ms).length;
      const deletedLastMinute = this.deletions.filter(item => item.time > now - 60000).reduce((sum, item) => sum + item.units, 0);
      const reactionsProcessedLastMinute = this.reactionEvents.filter(item => item.time > now - 60000).reduce((sum, item) => sum + item.units, 0);
      const range = this.etaRange(now);
      const lane = this.rate.activeLane;
      return {
        plugin_version: PLUGIN_VERSION, report_version: 3, phase: progress.phase,
        elapsed_s: Math.round((now - this.startedAt) / 1000),
        requests: this.requestCount,
        requests_last_1s: requestCountSince(1000), requests_last_60s: requestCountSince(60000), requests_last_3600s: requestCountSince(3600000),
        responses: { ...this.responses }, operations: { ...this.routes }, rate_limits: this.rateLimits,
        transient_errors: this.transientErrors, recovered_transient_requests: this.recoveredTransientRequests,
        unresolved_failures: progress.failed, recovered_failures: progress.recoveredFailures ?? 0,
        observed_limits: clone(this.observedLimits),
        average_response_ms: Object.fromEntries(Object.entries(this.networkMs).map(([key, ms]) => [key, Math.round(ms)])),
        in_flight_s: this.inFlightAt ? Math.round((now - this.inFlightAt) / 1000) : 0,
        in_flight_requests: this.inFlightCount,
        responses_with_rate_headers: this.headersSeen, search_index_waits: this.indexWaits,
        wait_seconds: Object.fromEntries(Object.entries(this.waitTotals).map(([key, ms]) => [key, Math.round(ms / 1000)])),
        messages_deleted: progress.messagesDeleted, reactions_removed: progress.reactionsRemoved,
        deleted_last_60s: deletedLastMinute, reactions_processed_last_60s: reactionsProcessedLastMinute, skipped: progress.skipped, failed: progress.failed,
        pages: progress.pages, messages_examined: progress.scanned, permission_skips: progress.permissionSkipped,
        current_target_total: this.workTotal, current_target_processed: this.workDone,
        current_target_messages_total: this.workMessagesTotal, current_target_messages_processed: this.workMessagesDone,
        current_target_reactions_total: this.workReactionsTotal, current_target_reactions_processed: this.workReactionsDone,
        cleanup_eta_s: range == null ? null : Math.ceil(range.best / 1000),
        cleanup_eta_low_s: range == null ? null : Math.ceil(range.low / 1000),
        cleanup_eta_high_s: range == null ? null : Math.ceil(range.high / 1000),
        eta_confidence: range == null ? null : Number(range.confidence.toFixed(2)),
        route_pacing_ms: Math.ceil(lane?.effectiveDelay(now) ?? pacingStart("modify")),
        effective_pacing_ms: Math.ceil(Math.max(lane?.effectiveDelay(now) ?? pacingStart("modify"), this.rate.activeResource?.cap() ? 60000/this.rate.activeResource.cap() : 0)),
        current_pacing_ms: Math.ceil(Math.max(lane?.effectiveDelay(now) ?? pacingStart("modify"), this.rate.activeResource?.cap() ? 60000/this.rate.activeResource.cap() : 0)),
        shared_hard_cap_per_min: 30,
        shared_bottleneck: !!(this.rate.activeResource?.cap() && 60000/this.rate.activeResource.cap() > (lane?.effectiveDelay(now) ?? pacingStart("modify")) + 50),
        controller_mode: this.rate.activeResource?.safe != null ? this.rate.activeResource.mode(now) : lane?.mode(now) ?? "initializing",
        learned_safe_ms: lane ? Math.ceil(lane.safeDelay) : null,
        known_unsafe_ms: lane?.unsafeDelay == null ? null : Math.ceil(lane.unsafeDelay),
        learning_confidence: lane ? Number(lane.confidence.toFixed(2)) : null,
        probe_successes: this.rate.activeResource?.probe != null ? this.rate.activeResource.probeGood : lane?.probing ? lane.probeSuccesses : 0,
        shared_safe_per_min: this.rate.activeResource?.safe == null ? null : Math.floor(this.rate.activeResource.safe),
        shared_unsafe_per_min: this.rate.activeResource?.unsafe == null ? null : Math.floor(this.rate.activeResource.unsafe),
        shared_controller_mode: this.rate.activeResource?.mode(now) ?? "observing",
        limits_last_10m: this.rate.limitTimes.filter(time => time > now - 600000).length,
        active_resource_lanes: this.rate.resources.size,
        wait_reason: this.waitKind || null,
        cooldown_remaining_s: Math.ceil(Math.max(0, this.rate.globalUntil - now, (lane?.blocked ?? 0) - now, (this.rate.activeResource?.blocked ?? 0) - now) / 1000),
        recent_limits: this.limitEvents.map(event => ({ ...event })),
      };
    }
    saveReport() {
      if (purgeAccountId() === this.rate.accountId) {
        const reports = { ...(storage.shiggyPurgeTestReports ?? {}) };
        reports[this.rate.accountId] = this.report();
        storage.shiggyPurgeTestReports = reports;
        this.lastSavedAt = Date.now();
        this.lastSavedLimits = this.rateLimits;
      }
    }
    finish() {
      this.endWait();
      this.finishedAt = Date.now();
      this.rate.persist();
      this.saveReport();
    }
  }

  class RateController {
    constructor(control) {
      this.control = control;
      this.accountId = control.accountId;
      const state = storage.shiggyPurgePacing?.[this.accountId];
      const saved = state?.version === PACING_VERSION ? state : {};
      this.lanes = new Map();
      this.aliases = new Map();
      this.resources = new Map();
      for (const [key, value] of Object.entries(saved.lanes ?? {})) {
        if (value?.updatedAt > Date.now() - PACING_TTL || value?.blocked > Date.now()) {
          this.lanes.set(key, new RateLane(value.kind === "read" ? "read" : "modify", value));
        }
      }
      for (const [key, value] of Object.entries(saved.aliases ?? {})) if (this.lanes.has(value)) this.aliases.set(key, value);
      for (const [key, value] of Object.entries(saved.resources ?? {})) if (value?.updatedAt > Date.now() - PACING_TTL || value?.blocked > Date.now()) this.resources.set(key, new SharedResourceGovernor(value));
      this.globalUntil = pacingNumber(saved.globalUntil) ?? 0;
      this.globalNextAt = 0;
      this.limitTimes = Array.isArray(saved.limitTimes) ? saved.limitTimes.filter(time => Number.isFinite(time) && time > Date.now() - 600000) : [];
      this.holdReason = typeof saved.holdReason === "string" ? saved.holdReason : "";
      this.activeLane = null;
      this.activeResource = null;
      this.operationLanes = new Map();
      this.resourceQueues = new Map();
      this.startGate = Promise.resolve();
      this.metrics = new PurgeMetrics(this);
      if (this.holdReason) control.pause(this.holdReason);
    }
    resource(identity) { if (!this.resources.has(identity.major)) this.resources.set(identity.major, new SharedResourceGovernor()); return this.resources.get(identity.major); }
    lane(identity, kind) {
      const key = this.aliases.get(identity.key) ?? identity.key;
      if (!this.lanes.has(key)) this.lanes.set(key, new RateLane(kind));
      const lane = this.lanes.get(key);
      if (kind === "modify") lane.kind = "modify";
      this.operationLanes.set(identity.operation, lane);
      return lane;
    }
    mergeLane(target, source) {
      target.safeDelay = Math.max(target.safeDelay, source.safeDelay);
      target.currentDelay = Math.max(target.currentDelay, source.currentDelay);
      if (source.unsafeDelay != null) target.unsafeDelay = Math.max(target.unsafeDelay ?? 0, source.unsafeDelay);
      target.blocked = Math.max(target.blocked, source.blocked);
      target.resetAt = Math.max(target.resetAt, source.resetAt);
      target.headerDelay = Math.max(target.headerDelay, source.headerDelay);
      target.lastLimited = Math.max(target.lastLimited, source.lastLimited);
      target.probeFreezeUntil = Math.max(target.probeFreezeUntil, source.probeFreezeUntil);
      target.confidence = Math.min(target.confidence, source.confidence);
      target.updatedAt = Date.now();
      return target;
    }
    bind(identity, kind, response, lane) {
      const bucket = responseHeader(response, "X-RateLimit-Bucket");
      if (!bucket) return lane;
      const key = `bucket:${String(bucket)}:${identity.major}`;
      const previousKey = this.aliases.get(identity.key);
      const shared = this.lanes.get(key);
      if (shared && shared !== lane) lane = this.mergeLane(shared, lane);
      else if (!shared && previousKey && previousKey !== key) lane = new RateLane(kind, lane.snapshot());
      this.lanes.set(key, lane);
      this.aliases.set(identity.key, key);
      this.operationLanes.set(identity.operation, lane);
      return lane;
    }
    operationDelay(operation) {
      const c=this.activeResource?.cap(); return Math.max(this.operationLanes.get(operation)?.effectiveDelay() ?? pacingStart("modify"), this.metrics.pacingMs[operation] ?? 0, c ? 60000/c : 0);
    }
    persist() {
      const all = { ...(storage.shiggyPurgePacing ?? {}) };
      all[this.accountId] = {
        version: PACING_VERSION, updatedAt: Date.now(), globalUntil: this.globalUntil,
        holdReason: this.holdReason, limitTimes: this.limitTimes,
        aliases: Object.fromEntries(this.aliases),
        lanes: Object.fromEntries([...this.lanes.entries()].map(([key, lane]) => [key, lane.snapshot()])),
        resources: Object.fromEntries([...this.resources.entries()].map(([key, resource]) => [key, resource.snapshot()])),
      };
      storage.shiggyPurgePacing = clone(all);
      if (this.metrics && (Date.now() - this.metrics.lastSavedAt >= 30000 || this.control.paused || this.metrics.lastSavedLimits !== this.metrics.rateLimits)) this.metrics.saveReport();
    }
    releaseHold() {
      this.holdReason = "";
      this.longWaitAcknowledged = Math.max(this.globalUntil, ...[...this.lanes.values()].map(lane => lane.blocked));
      this.persist();
    }
    hold(reason) { this.holdReason = reason; this.control.pause(reason); this.persist(); }
    reserveGlobal() {
      const task = this.startGate.then(async () => {
        await this.control.check();
        const now = Date.now();
        const deadline = Math.max(this.globalUntil, this.globalNextAt);
        if (deadline > now) await this.control.wait(deadline - now);
        await this.control.check();
        this.globalNextAt = Date.now() + GLOBAL_START_GAP;
      });
      this.startGate = task.catch(() => {});
      return task;
    }
    run(key, kind, fn, url) {
      const identity = pacingIdentity(key, kind, url);
      const queueKey = identity.major;
      const previous = this.resourceQueues.get(queueKey) ?? Promise.resolve();
      const pending = previous.then(() => this.runRequest(identity, kind, fn));
      const tail = pending.catch(() => {});
      this.resourceQueues.set(queueKey, tail);
      pending.finally(() => {
        if (this.resourceQueues.get(queueKey) === tail) this.resourceQueues.delete(queueKey);
      }).catch(() => {});
      return pending;
    }
    async runRequest(identity, kind, fn) {
      let lane = this.lane(identity, kind);
      const resource = this.resource(identity);
      let transientAttempts = 0;
      for (;;) {
        await this.control.check();
        this.activeLane = lane; this.activeResource = resource;
        const now = Date.now();
        const hardBlocked = Math.max(lane.blocked, resource.blocked, this.globalUntil);
        const deadline = Math.max(lane.nextAt, hardBlocked, resource.next(now));
        if (deadline > now) {
          const reason = hardBlocked > now ? "cooldown" : "pacing";
          this.metrics.beginWait(reason, deadline);
          setProgress({ waitMs: deadline - now });
          if (hardBlocked - now >= PACING_LONG_WAIT && !this.control.paused && hardBlocked > (this.longWaitAcknowledged ?? 0)) {
            this.longWaitAcknowledged = hardBlocked;
            this.hold(`Long Discord cooldown. Paused; requests can resume after ${new Date(hardBlocked).toLocaleTimeString()}.`);
          }
          await this.control.wait(deadline - now);
          this.metrics.endWait();
          continue;
        }
        await this.reserveGlobal();
        await this.control.check();
        const afterGate = Date.now();
        const changedBlock = Math.max(lane.blocked, resource.blocked, resource.next(afterGate), this.globalUntil);
        if (changedBlock > afterGate) continue;
        this.metrics.endWait();
        setProgress({ waitMs: 0 });
        const requestStart = Date.now();
        resource.started(requestStart);
        this.metrics.request(identity.operation);
        let response;
        try {
          response = await fn();
          const status = Number(response?.status ?? 200);
          if (status >= 400) throw response;
        } catch (error) {
          const status = Number(error?.status ?? error?.response?.status ?? 0);
          this.metrics.response(identity.operation, status, Date.now() - requestStart, error);
          lane = this.bind(identity, kind, error, lane);
          this.activeLane = lane;
          const headersAvailable = lane.observe(error);
          if (status === 401 || status === 403) {
            this.control.failure = pacingStop(status === 401
              ? "Discord authentication failed; stopped and kept the resume checkpoint"
              : "Discord denied permission; stopped and kept the resume checkpoint");
            this.persist();
            throw this.control.failure;
          }
          const transient = status >= 500 && status <= 599;
          if (transient) this.metrics.transientErrors++;
          if (status !== 429) {
            if (transient && transientAttempts < TRANSIENT_RETRIES) {
              transientAttempts++;
              const retryMs = TRANSIENT_RETRY_BASE_MS * (2 ** (transientAttempts - 1));
              this.persist();
              this.metrics.beginWait("transient", Date.now() + retryMs);
              setProgress({ status: `Discord returned ${status}; retrying automatically (${transientAttempts}/${TRANSIENT_RETRIES})...`, waitMs: retryMs });
              await this.control.wait(retryMs);
              this.metrics.endWait();
              continue;
            }
            this.persist();
            throw error;
          }
          const ms = pacingRetry(error);
          const body = error?.body ?? error?.response?.body;
          const rawScope = String(responseHeader(error, "X-RateLimit-Scope") ?? "").toLowerCase();
          const global = body?.global === true || error?.global === true || rawScope === "global" || String(responseHeader(error, "X-RateLimit-Global")).toLowerCase() === "true";
          const scope = global ? "global" : rawScope === "shared" ? "shared" : "route";
          this.metrics.limit(identity.operation, scope, ms, error, lane);
          if (scope === "shared") { resource.limited(ms); if (lane.probing) { lane.currentDelay=Math.max(lane.previousSafe,lane.safeDelay); lane.probing=false; lane.probeSuccesses=0; lane.cleanSuccesses=0; lane.firstCleanAt=0; } lane.probeFreezeUntil=Math.max(lane.probeFreezeUntil,Date.now()+PROBE_FREEZE); } else lane.limited(ms, scope);
          if (global) this.globalUntil = Math.max(this.globalUntil, Date.now() + ms + PACING_BUFFER);
          this.limitTimes = this.limitTimes.filter(time => time > Date.now() - 600000);
          this.limitTimes.push(Date.now());
          this.persist();
          setProgress({ status: `Discord ${scope} cooldown; controller adjusted automatically.`, waitMs: Math.max(ms, lane.blocked - Date.now()) });
          if (this.limitTimes.length >= 6) this.hold("Discord is repeatedly rate limiting this purge. Paused with progress saved; copy the report before resuming.");
          continue;
        }
        this.metrics.response(identity.operation, Number(response?.status ?? 200), Date.now() - requestStart, response);
        lane = this.bind(identity, kind, response, lane);
        this.activeLane = lane;
        const headersAvailable = lane.observe(response);
        const sharedDelay = resource.cap() ? 60000 / resource.cap() : 0;
        const routeDelay = lane.effectiveDelay();
        const sharedBottleneck = sharedDelay > routeDelay + 50;
        if (sharedBottleneck) { if (lane.probing) { lane.currentDelay=Math.max(lane.previousSafe,lane.safeDelay); lane.probing=false; lane.probeSuccesses=0; lane.cleanSuccesses=0; lane.firstCleanAt=0; } lane.probeFreezeUntil=Math.max(lane.probeFreezeUntil,Date.now()+PROBE_FREEZE); } else lane.success(headersAvailable);
        resource.success();
        this.metrics.observePace(identity.operation, lane.effectiveDelay());
        lane.nextAt = requestStart + lane.effectiveDelay();
        if (transientAttempts > 0) this.metrics.recoveredTransientRequests++;
        this.persist();
        this.control.assertAccount();
        return response;
      }
    }
    async indexing(ms) {
      const wait = Number.isFinite(ms) && ms >= 0 ? ms : 1000;
      this.metrics.indexWaits++;
      this.metrics.beginWait("indexing", Date.now() + wait);
      setProgress({ waitMs: wait, status: "Waiting for Discord search index..." });
      await this.control.wait(wait);
      this.metrics.endWait();
    }
  }

  function copyPurgeTestReport() {
    const accountId = purgeAccountId();
    const rate = runtime.rateController;
    const report = rate?.accountId === accountId ? rate.metrics.report() : storage.shiggyPurgeTestReports?.[accountId];
    if (!report) { toast("Run a preview or purge to collect a report"); return; }
    const clipboard = V.metro.common?.clipboard ?? find("setString", "getString") ?? RN.Clipboard;
    if (!clipboard?.setString) { toast("Clipboard unavailable; take a screenshot of the pacing panel"); return; }
    try {
      Promise.resolve(clipboard.setString(JSON.stringify(report, null, 2)))
        .then(() => toast("Purge report copied. No message content or account identifiers included."))
        .catch(() => toast("Could not copy the report"));
    } catch { toast("Could not copy the report"); }
  }
  function PacingStatus() {
    const [, tick] = React.useReducer(value => value + 1, 0);
    const [advanced, setAdvanced] = React.useState(false);
    const rate = runtime.rateController;
    const live = !!runtime.control;
    React.useEffect(() => {
      if (!live) return;
      const timer = setInterval(() => tick(), 1000);
      return () => clearInterval(timer);
    }, [live]);
    if (!rate || rate.accountId !== purgeAccountId()) return null;
    const metrics = rate.metrics;
    const now = metrics.finishedAt || Date.now();
    const report = metrics.report();
    const range = metrics.etaRange(now);
    const waiting = Math.max(0, metrics.waitUntil - now);
    let estimate;
    if (progress.phase === "paused") estimate = "Paused";
    else if (!live && ["error", "cancelled"].includes(progress.phase)) estimate = "Stopped — resume required";
    else if (!range) estimate = ["discovering", "verifying"].includes(progress.phase) ? "Calculating — discovery in progress" : live ? "Calculating…" : "Finished";
    else if (range.high - range.low > 60000) estimate = `${pacingDuration(range.low)}–${pacingDuration(range.high)}`;
    else estimate = pacingDuration(range.best);
    const confidenceText = range ? `${Math.round(range.confidence * 100)}% ETA confidence` : "ETA learning";
    const sharedMode = report.shared_controller_mode ?? report.controller_mode ?? "observing";
    const activeCooldown = (report.cooldown_remaining_s ?? 0) > 0 || (metrics.waitKind === "cooldown" && waiting > 0);
    const speedAdjusting = sharedMode === "probing" || sharedMode === "stabilizing";
    const softWait = !activeCooldown && ((metrics.waitKind === "indexing" && waiting > 0) || report.in_flight_s >= 5 || speedAdjusting);
    let badge = "🟢", headline = progress.phase === "discovering" ? "Purge scanning normally" : "Purge running normally";
    if (progress.phase === "completed") { badge = "✅"; headline = "Purge complete"; }
    else if (progress.phase === "paused") { badge = "⏸️"; headline = "Purge paused"; }
    else if (progress.phase === "error") { badge = "⚠️"; headline = "Purge needs attention"; }
    else if (progress.phase === "cancelled") { badge = "⚠️"; headline = "Purge stopped"; }
    else if (activeCooldown) { badge = "🔴"; headline = "Discord rate limit active"; }
    else if (softWait) { badge = "🟡"; headline = sharedMode === "probing" ? "Purge checking speed" : sharedMode === "stabilizing" ? "Purge confirming speed" : "Purge temporarily slowing down"; }

    const targetKind = progress.currentTargetKind ?? "";
    const targetName = progress.currentTarget ?? "";
    const guildName = progress.currentGuildName ?? "";
    const messagesTotal = report.current_target_messages_total ?? 0;
    const messagesDone = report.current_target_messages_processed ?? 0;
    const reactionsTotal = report.current_target_reactions_total ?? 0;
    const reactionsDone = report.current_target_reactions_processed ?? 0;
    const messagesPending = messagesTotal > messagesDone;
    const reactionsPending = reactionsTotal > reactionsDone;
    const reactionPhase = reactionsTotal > 0 && !messagesPending && reactionsPending;
    const reactionStatus = reactionsTotal <= 0
      ? "No reactions queued"
      : messagesPending && reactionsPending
        ? "Waiting for message deletion to finish"
        : reactionsPending
          ? "Cleaning reactions now"
          : "Reaction cleanup complete";
    const speedValue = reactionPhase ? (report.reactions_processed_last_60s ?? 0) : (report.deleted_last_60s ?? 0);
    const speedUnit = reactionPhase ? "reactions" : "messages";
    const etaText = progress.phase === "paused" ? "Paused" : range ? `About ${pacingDuration(range.best)}` : ["discovering", "verifying"].includes(progress.phase) ? "Calculating while scanning" : "Calculating";
    const confidencePhrase = !range ? "Learning" : range.confidence >= .8 ? "High confidence" : range.confidence >= .55 ? "Getting more accurate" : "Still learning";
    const safe = report.shared_safe_per_min;
    const unsafe = report.shared_unsafe_per_min;
    const modeText = sharedMode === "probing" ? "Checking a slightly faster speed" : sharedMode === "stabilizing" ? "Confirming the safe speed" : sharedMode === "learned" ? "Safe speed learned" : sharedMode === "cooldown" ? "Temporarily slowing down" : "Learning the safe speed";
    const whatDoing = progress.phase === "completed"
      ? "Cleanup finished."
      : reactionsTotal > 0 && messagesPending
        ? "Message deletion is being completed first. Reaction cleanup will begin automatically afterward."
        : activeCooldown
          ? "Discord asked us to slow down. Purge Tools is waiting and will continue automatically."
          : sharedMode === "probing"
            ? "Purge Tools is checking a slightly faster speed without exceeding the 30-per-minute cap."
            : sharedMode === "stabilizing"
              ? "Purge Tools is confirming the fastest safe speed."
              : sharedMode === "learned"
                ? "Purge Tools is staying within the learned safe speed and will adjust automatically if needed."
                : "Purge Tools is learning a safe speed and adjusting automatically.";

    return React.createElement(RN.View, null,
      React.createElement(Txt, { style: { fontWeight: "800", fontSize: 16 } }, `${badge} ${headline}`),
      targetName ? (targetKind === "dm"
        ? React.createElement(Txt, { style: { marginTop: 5, fontWeight: "700" } }, `Direct message: ${targetName}`)
        : targetKind === "channel"
          ? React.createElement(React.Fragment, null,
              React.createElement(Txt, { style: { marginTop: 5, fontWeight: "700" } }, `Server: ${guildName || "Unknown server"}`),
              React.createElement(Txt, { style: { fontWeight: "700" } }, `Channel: ${targetName}`))
          : targetKind === "server"
            ? React.createElement(Txt, { style: { marginTop: 5, fontWeight: "700" } }, `Server: ${targetName}`)
            : React.createElement(Txt, { style: { marginTop: 5, fontWeight: "700" } }, `Target: ${targetName}`)) : null,
      progress.targetCount > 1 ? React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 2 } }, `Target ${progress.targetIndex} of ${progress.targetCount}`) : null,

      metrics.workActive ? React.createElement(React.Fragment, null,
        React.createElement(Txt, { style: { fontWeight: "700", marginTop: 9 } }, "Messages"),
        React.createElement(Txt, null, `Progress: ${messagesDone} / ${messagesTotal}`),
        React.createElement(Txt, { style: { fontWeight: "700", marginTop: 7 } }, "Reactions"),
        React.createElement(Txt, null, `Progress: ${reactionsDone} / ${reactionsTotal}`),
        React.createElement(Txt, { style: { color: C.muted } }, `Status: ${reactionStatus}`),
        reactionsTotal > 0 && messagesPending ? React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, "Reaction cleanup will begin automatically after messages are finished.") : null,
      ) : React.createElement(React.Fragment, null,
        progress.phase === "completed"
          ? React.createElement(React.Fragment, null,
              React.createElement(Txt, { style: { marginTop: 8 } }, `Messages deleted: ${progress.messagesDeleted}`),
              React.createElement(Txt, null, `Reactions removed: ${progress.reactionsRemoved}`))
          : React.createElement(React.Fragment, null,
              React.createElement(Txt, { style: { marginTop: 8 } }, `Messages found: ${progress.messagesFound}`),
              React.createElement(Txt, null, `Reactions found: ${progress.reactionsFound}`)),
        React.createElement(Txt, { style: { color: C.muted } }, progress.status),
      ),

      progress.phase === "purging" || progress.phase === "paused" ? React.createElement(React.Fragment, null,
        React.createElement(Txt, { style: { fontWeight: "700", marginTop: 9 } }, "Progress"),
        React.createElement(Txt, null, `Speed: ${speedValue} ${speedUnit} per minute`),
        React.createElement(Txt, null, `Time left: ${etaText}`),
        React.createElement(Txt, null, `ETA confidence: ${range ? Math.round(range.confidence * 100) + "%" : "Learning"} — ${confidencePhrase}`),
        React.createElement(Txt, { style: { fontWeight: "700", marginTop: 9 } }, "Discord limit"),
        React.createElement(Txt, null, `🟢 Safe speed: ${safe == null ? "Learning" : "About " + safe + " per minute"}`),
        React.createElement(Txt, null, `🔴 Too fast: ${unsafe == null ? "Not learned yet" : "Around " + unsafe + " per minute"}`),
        React.createElement(Txt, null, `Status: ${modeText}`),
        React.createElement(Txt, { style: { marginTop: 7 } }, `Rate limits: ${report.rate_limits} total · ${report.limits_last_10m} in the last 10 minutes`),
        React.createElement(Txt, null, `Failures: ${report.failed}`),
        (report.transient_errors ?? 0) > 0 ? React.createElement(Txt, null, `Transient server errors: ${report.transient_errors} · recovered by retry: ${report.recovered_transient_requests ?? 0} · recovered later: ${report.recovered_failures ?? 0}`) : null,
        React.createElement(Txt, { style: { fontWeight: "700", marginTop: 9 } }, "What it's doing"),
        React.createElement(Txt, { style: { color: C.muted } }, whatDoing),
      ) : null,

      React.createElement(RN.Pressable, { onPress: () => setAdvanced(value => !value), style: { marginTop: 10, paddingVertical: 6 } },
        React.createElement(Txt, { style: { color: C.brand, fontWeight: "700" } }, advanced ? "Advanced details ▴" : "Advanced details ▾")),
      advanced ? React.createElement(RN.View, { style: { marginTop: 3 } },
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Requests: ${report.requests_last_1s}/last second · ${report.requests_last_60s}/last minute · ${report.requests_last_3600s}/last hour`),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Route spacing: ${((report.route_pacing_ms ?? report.current_pacing_ms) / 1000).toFixed(2)}s · Effective spacing: ${((report.effective_pacing_ms ?? report.current_pacing_ms) / 1000).toFixed(2)}s`),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Route learned safe: ${report.learned_safe_ms == null ? "learning" : (report.learned_safe_ms / 1000).toFixed(2) + "s"} · Shared hard cap: ${report.shared_hard_cap_per_min ?? 30}/min`),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Shared controller: ${report.shared_controller_mode} · Route confidence: ${report.learning_confidence == null ? "?" : Math.round(report.learning_confidence * 100) + "%"}`),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Pages scanned: ${progress.pages} · Messages examined: ${progress.scanned}`),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Reacted emojis checked: ${progress.reactedEmojisChecked} · Reactor users checked: ${progress.reactionUsersChecked}`),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Bulk batches: ${progress.bulkBatches} · Permission skips: ${progress.permissionSkipped} · Other skips: ${progress.skipped}`),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `Rate headers seen: ${report.responses_with_rate_headers} · Active resources: ${report.active_resource_lanes}`),
      ) : null,
      React.createElement(Row, null, React.createElement(Button, { text: "Copy report", small: true, onPress: copyPurgeTestReport })),
    );
    return React.createElement(Card, { style: { marginTop: 8, borderColor: C.brand } },
      React.createElement(Txt, { style: { fontWeight: "800", fontSize: 16 } }, `Current target cleanup ETA: ${estimate}`),
      range && live && !rate.control.paused ? React.createElement(Txt, { style: { color: C.muted } }, `${confidenceText} · likely finish around ${new Date(now + range.best).toLocaleTimeString()}`) : null,
      React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, "Estimate covers queued cleanup for this target. Discovery, later targets, and additional verification are extra."),
      metrics.workActive ? React.createElement(Txt, null, `Processed: ${metrics.workDone}/${metrics.workTotal} queued actions`) : null,
      React.createElement(Txt, null, `Deleted in last minute: ${report.deleted_last_60s} · Elapsed: ${pacingDuration(now - metrics.startedAt)}`),
      React.createElement(Txt, null, `Requests: ${report.requests_last_1s}/last second · ${report.requests_last_60s}/last minute · ${report.requests_last_3600s}/last hour`),
      React.createElement(Txt, null, `Controller: ${report.controller_mode} · Rate limits: ${report.rate_limits} · Search-index waits: ${report.search_index_waits}`),
      React.createElement(Txt, null, `Current spacing: ${(report.current_pacing_ms / 1000).toFixed(2)}s · learned route-safe: ${report.learned_safe_ms == null ? "learning" : (report.learned_safe_ms / 1000).toFixed(2) + "s"}`),
      report.shared_safe_per_min != null ? React.createElement(Txt, null, `Shared rolling governor: ${report.shared_safe_per_min}/min safe · ${report.shared_unsafe_per_min ?? "?"}/min unsafe · ${report.shared_controller_mode}`) : null,
      report.known_unsafe_ms != null ? React.createElement(Txt, null, `Known unsafe boundary: ${(report.known_unsafe_ms / 1000).toFixed(2)}s · confidence: ${Math.round((report.learning_confidence ?? 0) * 100)}%`) : null,
      waiting ? React.createElement(Txt, null, `${metrics.waitKind === "cooldown" ? "Discord cooldown" : metrics.waitKind === "indexing" ? "Search indexing" : "Preventive pacing"}: ${pacingDuration(waiting)} remaining`) : null,
      report.in_flight_s >= 5 ? React.createElement(Txt, null, `Waiting for Discord response: ${report.in_flight_s}s`) : null,
      React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, report.responses_with_rate_headers
        ? "Discord rate headers detected; the controller combines them with learned pacing and safety headroom."
        : "No rate headers exposed. The controller learns from sustained success and 429 feedback, then remembers the safe envelope."),
      React.createElement(Row, null, React.createElement(Button, { text: "Copy test report", small: true, onPress: copyPurgeTestReport })),
    );
  }

  function find(...props) { try { return findByProps(...props); } catch { return undefined; } }

  function resolveRuntime() {
    const userStore = find("getCurrentUser");
    const rest = find("getAPIBaseURL", "get", "del", "post") ?? find("getAPIBaseURL", "get", "del");
    if (!userStore?.getCurrentUser) throw new Error("Could not locate Discord UserStore");
    if (!rest?.get || !rest?.del) throw new Error("Could not locate Discord REST module");
    const selfId = userStore.getCurrentUser()?.id;
    if (!selfId) throw new Error("Could not determine current user");

    const guildStore = find("getGuilds", "getGuild") ?? find("getGuilds");
    const channelStore = find("getChannel", "getMutableGuildChannelsForGuild")
      ?? find("getChannel", "getChannelIds")
      ?? find("getChannel", "getMutablePrivateChannels")
      ?? find("getChannel");
    const privateStore = find("getPrivateChannelIds");
    const permissionStore = find("can", "getChannelPermissions")
      ?? find("can", "computePermissions")
      ?? find("can", "getPermissions");
    const permissionModule = find("Permissions", "PermissionOverwriteType") ?? find("Permissions");
    const permissions = permissionModule?.Permissions ?? {};

    return {
      userStore, rest, selfId, guildStore, channelStore, privateStore,
      permissionStore, permissions,
    };
  }

  function permissionValue(rt, name) {
    return rt.permissions?.[name] ?? PERM[name];
  }

  function guildOwner(rt, guildId) {
    if (!guildId) return false;
    const guild = rt.guildStore?.getGuild?.(String(guildId));
    return String(guild?.ownerId ?? guild?.owner_id ?? "") === String(rt.selfId);
  }

  function channelObject(rt, channelId, fallback) {
    return rt.channelStore?.getChannel?.(String(channelId)) ?? fallback ?? null;
  }

  function permissionState(rt, channelId, fallbackChannel, guildId, permissionName) {
    if (guildOwner(rt, guildId ?? fallbackChannel?.guild_id ?? fallbackChannel?.guildId)) return true;
    const store = rt.permissionStore;
    const channel = channelObject(rt, channelId, fallbackChannel);
    if (!store?.can || !channel) return null;
    const permission = permissionValue(rt, permissionName);
    const candidates = [channel];
    const parentId = channel?.parent_id ?? channel?.parentId;
    const parent = parentId ? rt.channelStore?.getChannel?.(String(parentId)) : null;
    if (parent && parent !== channel) candidates.push(parent);
    for (const candidate of candidates) {
      try { return !!store.can(permission, candidate); } catch {}
    }
    return null;
  }

  function canReadHistory(rt, channelId, fallbackChannel, guildId) {
    if (!guildId && !fallbackChannel?.guild_id && !fallbackChannel?.guildId) return true;
    const view = permissionState(rt, channelId, fallbackChannel, guildId, "VIEW_CHANNEL");
    const history = permissionState(rt, channelId, fallbackChannel, guildId, "READ_MESSAGE_HISTORY");
    if (view === false || history === false) return false;
    if (view === null || history === null) return null;
    return true;
  }

  function canManageMessages(rt, channelId, fallbackChannel, guildId) {
    return permissionState(rt, channelId, fallbackChannel, guildId, "MANAGE_MESSAGES");
  }

  function dmName(channel, userStore) {
    if (channel?.name) return String(channel.name);
    const ids = Array.isArray(channel?.recipients) ? channel.recipients : [];
    const names = ids.map(id => userStore.getUser?.(id)).filter(Boolean)
      .map(user => user.globalName ?? user.global_name ?? user.username ?? user.id);
    if (names.length) return names.join(", ");
    const raw = Array.isArray(channel?.rawRecipients) ? channel.rawRecipients : [];
    if (raw.length) return raw.map(user => user.globalName ?? user.global_name ?? user.username ?? user.id).filter(Boolean).join(", ");
    return `DM ${channel?.id ?? "unknown"}`;
  }

  function catalog() {
    const rt = resolveRuntime();
    const dms = [], guilds = [];
    let privateChannels = [];
    if (rt.channelStore?.getSortedPrivateChannels) privateChannels = rt.channelStore.getSortedPrivateChannels() ?? [];
    else if (rt.channelStore?.getMutablePrivateChannels) privateChannels = Object.values(rt.channelStore.getMutablePrivateChannels() ?? {});
    else if (rt.privateStore?.getPrivateChannelIds && rt.channelStore?.getChannel) {
      privateChannels = rt.privateStore.getPrivateChannelIds().map(id => rt.channelStore.getChannel(id)).filter(Boolean);
    }
    for (const channel of privateChannels) if (channel?.id) dms.push({ id: String(channel.id), name: dmName(channel, rt.userStore) });

    const guildMap = rt.guildStore?.getGuilds?.() ?? {};
    for (const guild of Object.values(guildMap)) {
      if (!guild?.id) continue;
      let channels = [];
      if (rt.channelStore?.getMutableGuildChannelsForGuild) {
        channels = Object.values(rt.channelStore.getMutableGuildChannelsForGuild(String(guild.id)) ?? {});
      } else if (rt.channelStore?.getChannelIds && rt.channelStore?.getChannel) {
        channels = rt.channelStore.getChannelIds(String(guild.id)).map(id => rt.channelStore.getChannel(id)).filter(Boolean);
      }
      const listed = channels
        .filter(channel => ![4, 15, 16].includes(Number(channel?.type)))
        .map(channel => ({ id: String(channel.id), name: String(channel.name ?? channel.id), guildId: String(guild.id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      guilds.push({ id: String(guild.id), name: String(guild.name ?? guild.id), channels: listed });
    }
    dms.sort((a, b) => a.name.localeCompare(b.name));
    guilds.sort((a, b) => a.name.localeCompare(b.name));
    return { dms, guilds };
  }

  function extractId(value) {
    const raw = String(value ?? "").trim();
    if (/^\d{16,22}$/.test(raw)) return raw;
    return raw.match(/discord(?:app)?\.com\/channels\/(?:@me|\d+)\/\d+\/(\d{16,22})/i)?.[1]
      ?? raw.match(/(\d{16,22})(?:\D*)$/)?.[1];
  }
  function extractUserId(value) {
    const raw = String(value ?? "").trim();
    if (/^\d{16,22}$/.test(raw)) return raw;
    return raw.match(/^<@!?(\d{16,22})>$/)?.[1] ?? raw.match(/(\d{16,22})/)?.[1];
  }
  function sfTime(id) { return Number((BigInt(id) >> LOW) + EPOCH); }
  function minSf(ms) {
    const value = BigInt(Math.max(0, Math.trunc(ms)));
    return value < EPOCH ? "0" : ((value - EPOCH) << LOW).toString();
  }
  function maxSf(ms) { return (BigInt(minSf(ms)) | ((1n << LOW) - 1n)).toString(); }
  function incSf(id) { return (BigInt(id) + 1n).toString(); }

  function parseBoundary(boundary) {
    if (!boundary) return undefined;
    if (boundary.kind === "message") {
      const id = extractId(boundary.value);
      if (!id) throw new Error(`Invalid message ID/link: ${boundary.value}`);
      return { ...boundary, id, time: sfTime(id) };
    }
    const raw = String(boundary.value ?? "").trim();
    if (!raw) throw new Error("Date/time boundary is empty");
    const ms = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw).getTime();
    if (!Number.isFinite(ms)) throw new Error(`Invalid date/time: ${boundary.value}`);
    return { ...boundary, id: minSf(ms), time: ms };
  }

  function resolveFilter(filter) {
    const out = { mode: filter.mode };
    if (["before", "between"].includes(filter.mode)) out.before = parseBoundary(filter.before);
    if (["after", "between"].includes(filter.mode)) out.after = parseBoundary(filter.after);
    if (out.before && out.after && out.after.time > out.before.time) throw new Error("After boundary must be earlier than Before boundary");
    return out;
  }

  function compareMessageToBoundary(message, boundary) {
    if (boundary.kind === "message") {
      return BigInt(message.id) < BigInt(boundary.id) ? -1 : BigInt(message.id) > BigInt(boundary.id) ? 1 : 0;
    }
    const time = message.timestamp ? new Date(message.timestamp).getTime() : sfTime(message.id);
    return time < boundary.time ? -1 : time > boundary.time ? 1 : 0;
  }
  function matchesFilter(message, filter) {
    if (filter.mode === "all") return true;
    if (filter.before) {
      const cmp = compareMessageToBoundary(message, filter.before);
      if (cmp > 0 || (cmp === 0 && !filter.before.include)) return false;
    }
    if (filter.after) {
      const cmp = compareMessageToBoundary(message, filter.after);
      if (cmp < 0 || (cmp === 0 && !filter.after.include)) return false;
    }
    return true;
  }
  function initialBefore(filter) {
    const boundary = filter.before;
    if (!boundary) return undefined;
    if (boundary.kind === "message") return boundary.include ? incSf(boundary.id) : boundary.id;
    const id = boundary.include ? maxSf(boundary.time) : minSf(boundary.time);
    return boundary.include ? incSf(id) : id;
  }
  function passedLowerBoundary(message, filter) {
    if (!message || !filter.after) return false;
    const cmp = compareMessageToBoundary(message, filter.after);
    return cmp < 0 || (cmp === 0 && !filter.after.include);
  }
  function searchBounds(filter) {
    const query = {};
    if (filter.after) {
      const b = filter.after;
      if (b.kind === "message") query.min_id = b.include && BigInt(b.id) > 0n ? (BigInt(b.id) - 1n).toString() : b.id;
      else {
        const id = b.include ? minSf(b.time) : maxSf(b.time);
        query.min_id = b.include && BigInt(id) > 0n ? (BigInt(id) - 1n).toString() : id;
      }
    }
    if (filter.before) {
      const b = filter.before;
      const id = b.kind === "message" ? b.id : b.include ? maxSf(b.time) : minSf(b.time);
      query.max_id = b.include ? incSf(id) : id;
    }
    return query;
  }

  function messageAuthorMode(target) { return target.kind === "dm" ? "self" : (target.authorMode ?? "self"); }
  function reactionMode(target) {
    if (target.kind === "dm") return target.reactionMode === "self" || target.actions?.removeOwnReactions ? "self" : "off";
    if (target.reactionMode) return target.reactionMode;
    return target.actions?.removeOwnReactions ? "self" : "off";
  }
  function targetAuthorId(target, rt) {
    const mode = messageAuthorMode(target);
    if (mode === "self") return rt.selfId;
    if (mode === "specific") {
      const id = extractUserId(target.authorId);
      if (!id) throw new Error(`${target.name}: enter a valid message-author user ID or mention`);
      return id;
    }
    return undefined;
  }
  function targetReactionUserId(target) {
    if (reactionMode(target) !== "specific") return undefined;
    const id = extractUserId(target.reactionUserId);
    if (!id) throw new Error(`${target.name}: enter a valid reaction user ID or mention`);
    return id;
  }
  function moderatorMessageNeeded(target) { return !!target.actions?.deleteMessages && messageAuthorMode(target) !== "self"; }
  function moderatorReactionNeeded(target) { return reactionMode(target) === "specific"; }
  function nonModeratorWork(target) {
    return (!!target.actions?.deleteMessages && messageAuthorMode(target) === "self") || reactionMode(target) === "self";
  }

  function attachmentExtension(value) {
    const raw = String(
      value?.filename ?? value?.name ?? value?.url ?? value?.proxy_url ?? value?.proxyUrl ?? ""
    ).trim();
    if (raw) {
      const clean = raw.split(/[?#]/)[0];
      const match = clean.match(/\.([a-z0-9]{1,12})$/i);
      if (match) return match[1].toLowerCase();
    }
    const type = String(value?.content_type ?? value?.contentType ?? "").toLowerCase().split(";")[0];
    const subtype = type.match(/^[a-z0-9.+-]+\/([a-z0-9.+-]+)$/i)?.[1];
    return subtype && /^[a-z0-9]{1,12}$/i.test(subtype) ? subtype.toLowerCase() : "";
  }
  function mediaMimeFromUrl(url) {
    const ext = attachmentExtension({ url });
    if (["png", "jpg", "jpeg", "webp", "bmp", "avif", "heic", "heif", "svg"].includes(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
    if (ext === "gif") return "image/gif";
    if (["mp4", "m4v", "mov", "webm", "mkv", "avi"].includes(ext)) return `video/${ext}`;
    if (["mp3", "m4a", "wav", "ogg", "oga", "flac", "aac"].includes(ext)) return `audio/${ext}`;
    return "";
  }
  function mediaHost(url) {
    const match = String(url ?? "").match(/^https?:\/\/([^/?#]+)/i);
    return match ? match[1].split(":")[0].toLowerCase() : "";
  }
  function providerGifUrl(url) {
    const host = mediaHost(url);
    return host === "tenor.com" || host.endsWith(".tenor.com") || host === "giphy.com" || host.endsWith(".giphy.com");
  }
  function directMediaUrl(url) {
    const raw = String(url ?? "");
    if (!raw) return false;
    if (/\.(?:png|jpe?g|gif|webp|bmp|avif|heic|heif|svg|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|oga|flac|aac)(?:[?#].*)?$/i.test(raw)) return true;
    const host = mediaHost(raw);
    return host === "media.discordapp.net" || host === "media.tenor.com" || host === "c.tenor.com" || host === "i.giphy.com" || host === "media.giphy.com";
  }
  function attachmentKind(attachment) {
    const type = String(attachment?.content_type ?? attachment?.contentType ?? "").toLowerCase();
    const ext = attachmentExtension(attachment);
    if (/^(image|video|audio)\//.test(type)) return "media";
    if (/^(?:png|jpe?g|gif|webp|bmp|avif|heic|heif|svg|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|oga|flac|aac)$/i.test(ext)) return "media";
    return "file";
  }
  function messageAttachmentItems(message) {
    const items = [];
    const seen = new Set();
    const add = item => {
      if (!item) return;
      const key = String(item.id ?? item.url ?? item.proxy_url ?? item.proxyUrl ?? item.filename ?? item.name ?? "");
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      items.push(item);
    };

    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) add(attachment);

    for (const embed of Array.isArray(message?.embeds) ? message.embeds : []) {
      const type = String(embed?.type ?? "").toLowerCase();
      const provider = String(embed?.provider?.name ?? "").toLowerCase();
      const pageUrl = String(embed?.url ?? "");
      const mediaUrl = String(embed?.video?.url ?? embed?.image?.url ?? embed?.thumbnail?.url ?? pageUrl ?? "");
      const gifLike = type === "gifv" || provider.includes("tenor") || provider.includes("giphy") || providerGifUrl(pageUrl) || providerGifUrl(mediaUrl);
      const direct = directMediaUrl(mediaUrl) || directMediaUrl(pageUrl);
      const renderedMedia = type === "image" || type === "gifv" || gifLike || (type === "video" && direct) || (!!(embed?.image || embed?.video) && direct);
      if (!renderedMedia) continue;
      add({
        id: embed?.id,
        filename: gifLike ? "linked-media.gif" : mediaUrl,
        name: gifLike ? "linked-media.gif" : mediaUrl,
        url: mediaUrl || pageUrl,
        content_type: gifLike ? "image/gif" : type === "video" ? "video/external" : (mediaMimeFromUrl(mediaUrl || pageUrl) || "image/external"),
        __purgeLinkedMedia: true,
      });
    }

    const urls = String(message?.content ?? "").match(/https?:\/\/[^\s<>()]+/gi) ?? [];
    for (const rawUrl of urls) {
      const url = rawUrl.replace(/[),.!?]+$/, "");
      const gifLike = providerGifUrl(url);
      if (!gifLike && !directMediaUrl(url)) continue;
      add({
        filename: gifLike ? "linked-media.gif" : url,
        name: gifLike ? "linked-media.gif" : url,
        url,
        content_type: gifLike ? "image/gif" : (mediaMimeFromUrl(url) || "image/external"),
        __purgeLinkedMedia: true,
      });
    }

    return items;
  }
  function preservedAttachmentExtensions(target) {
    return [...new Set(String(target?.preserveAttachmentExtensions ?? "")
      .toLowerCase()
      .split(/[\s,;]+/)
      .map(value => value.replace(/^\.+/, "").trim())
      .filter(value => /^[a-z0-9]{1,12}$/.test(value)))];
  }
  function messageHasPreservedAttachment(message, target) {
    const kept = new Set(preservedAttachmentExtensions(target));
    if (!kept.size) return false;
    return messageAttachmentItems(message).some(item => kept.has(attachmentExtension(item)));
  }
  function selectedAttachmentMatch(message, target) {
    const attachments = messageAttachmentItems(message);
    if (!attachments.length) return false;
    const types = target.attachmentTypes ?? "both";
    if (types === "both") return true;
    return attachments.some(attachment => attachmentKind(attachment) === types);
  }
  function messageContentDeleteEligible(message, target) {
    if (target.preservePinned !== false && message?.pinned === true) return false;
    const mode = target.attachmentMode ?? "all";
    if (mode === "all") return true;
    if (messageHasPreservedAttachment(message, target)) return false;
    const matches = selectedAttachmentMatch(message, target);
    if (mode === "preserve") return !matches;
    if (mode === "only") return matches;
    return true;
  }
  function messageDeleteEligible(message, target, rt, allowModerator) {
    if (!target.actions?.deleteMessages) return false;
    const mode = messageAuthorMode(target);
    let authorMatches = false;
    if (mode === "self") authorMatches = message.author?.id === rt.selfId;
    else if (allowModerator && mode === "all") authorMatches = true;
    else if (allowModerator && mode === "specific") authorMatches = message.author?.id === targetAuthorId(target, rt);
    if (!authorMatches) return false;
    return messageContentDeleteEligible(message, target);
  }

  function safeEmoji(reaction) {
    const name = reaction?.emoji?.name;
    const id = reaction?.emoji?.id;
    if (!name && !id) return undefined;
    return id ? `${name ?? "emoji"}:${id}` : String(name);
  }
  function reactionTypes(reaction) {
    const details = reaction?.count_details ?? reaction?.countDetails;
    if (!details) return [0];
    const types = [];
    if (Number(details.normal ?? 0) > 0) types.push(0);
    if (Number(details.burst ?? 0) > 0) types.push(1);
    return types.length ? types : [0];
  }

  async function get(rt, rate, control, lane, url, query) {
    await control.check();
    return rate.run(lane, "read", () => rt.rest.get({ url, query }), url);
  }
  function body(response) { return response?.body; }

  async function userHasReaction(rt, rate, control, channelId, messageId, emoji, reaction, userId) {
    const encoded = encodeURIComponent(emoji);
    for (const type of reactionTypes(reaction)) {
      let after;
      for (;;) {
        await control.check();
        bump({ reactedEmojisChecked: after ? 0 : 1 });
        const users = body(await get(
          rt, rate, control,
          `reactors:${channelId}:${messageId}:${emoji}:${type}`,
          `/channels/${channelId}/messages/${messageId}/reactions/${encoded}`,
          { limit: 100, type, ...(after ? { after } : {}) },
        ));
        bump({ pages: 1 });
        if (!Array.isArray(users) || !users.length) break;
        bump({ reactionUsersChecked: users.length });
        if (users.some(user => String(user?.id) === String(userId))) return true;
        if (users.length < 100) break;
        const next = users[users.length - 1]?.id;
        if (!next || next === after) break;
        after = String(next);
      }
    }
    return false;
  }

  async function scanChannel(rt, rate, control, target, channelId, filter, channelRecord) {
    const found = { messages: [], reactions: [] };
    const guildId = target.guildId ?? (target.kind === "server" ? target.id : (channelRecord?.guild_id ?? channelRecord?.guildId));
    const read = target.kind === "dm" ? true : canReadHistory(rt, channelId, channelRecord, guildId);
    if (read === false) {
      bump({ permissionSkipped: 1 });
      setProgress({ status: `Skipping ${channelRecord?.name ?? channelId}: no View Channel / Read Message History access.` });
      return found;
    }

    const needsModMessages = moderatorMessageNeeded(target);
    const needsModReactions = moderatorReactionNeeded(target);
    const manage = (needsModMessages || needsModReactions)
      ? canManageMessages(rt, channelId, channelRecord, guildId)
      : true;

    if ((needsModMessages || needsModReactions) && manage !== true && !nonModeratorWork(target)) {
      bump({ permissionSkipped: 1 });
      setProgress({
        status: manage === false
          ? `Skipping ${channelRecord?.name ?? channelId}: Manage Messages is not allowed here.`
          : `Skipping ${channelRecord?.name ?? channelId}: could not verify Manage Messages safely.`,
      });
      return found;
    }
    if ((needsModMessages || needsModReactions) && manage !== true) bump({ permissionSkipped: 1 });

    const allowModerator = manage === true;
    const reactMode = reactionMode(target);
    const reactionUserId = reactMode === "specific" ? targetReactionUserId(target) : undefined;
    let before = initialBefore(filter);
    let last;

    for (;;) {
      setProgress({ currentTarget: target.name, currentTargetKind: target.kind, currentGuildName: target.guildName ?? "", currentChannelName: target.kind === "channel" ? target.name : "", status: `Scanning ${target.name}...` });
      const page = body(await get(
        rt, rate, control,
        `history:${channelId}`,
        `/channels/${channelId}/messages`,
        { limit: PAGE, ...(before ? { before } : {}) },
      ));
      bump({ pages: 1 });
      if (!Array.isArray(page) || !page.length) break;

      for (const message of page) {
        bump({ scanned: 1 });
        if (!matchesFilter(message, filter)) continue;

        const deleteEligible = messageDeleteEligible(message, target, rt, allowModerator);
        if (deleteEligible) {
          found.messages.push({
            channelId,
            messageId: String(message.id),
            moderation: messageAuthorMode(target) !== "self",
          });
          bump({ messagesFound: 1 });
        }

        if (reactMode === "self" && !deleteEligible) {
          for (const reaction of message.reactions ?? []) {
            if (reaction?.me !== true) continue;
            const emoji = safeEmoji(reaction);
            if (!emoji) continue;
            found.reactions.push({ channelId, messageId: String(message.id), emoji, userId: null });
            bump({ reactionsFound: 1 });
          }
        } else if (reactMode === "specific" && allowModerator && !deleteEligible) {
          for (const reaction of message.reactions ?? []) {
            if (!reaction || Number(reaction.count ?? 0) <= 0) continue;
            const emoji = safeEmoji(reaction);
            if (!emoji) continue;
            try {
              if (await userHasReaction(rt, rate, control, channelId, String(message.id), emoji, reaction, reactionUserId)) {
                found.reactions.push({
                  channelId,
                  messageId: String(message.id),
                  emoji,
                  userId: reactionUserId,
                  moderation: true,
                });
                bump({ reactionsFound: 1 });
              }
            } catch (error) {
              const status = error?.status ?? error?.response?.status;
              if ([400, 403, 404].includes(status)) { bump({ skipped: 1 }); continue; }
              throw error;
            }
          }
        }
      }

      const oldest = page[page.length - 1];
      if (passedLowerBoundary(oldest, filter) || page.length < PAGE) break;
      if (!oldest?.id || oldest.id === last) break;
      last = oldest.id;
      before = oldest.id;
    }
    return found;
  }

  function flattenSearch(response) {
    const out = [], seen = new Set();
    for (const group of Array.isArray(response?.messages) ? response.messages : []) {
      for (const message of Array.isArray(group) ? group : [group]) {
        if (message?.id && !seen.has(String(message.id))) {
          seen.add(String(message.id));
          out.push(message);
        }
      }
    }
    return out.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
  }

  async function searchGuild(rt, rate, control, target, filter, guildId, channelId) {
    const found = { messages: [], reactions: [], authorHits: 0 };
    const bounds = searchBounds(filter);
    const authorId = targetAuthorId(target, rt);
    let maxId = bounds.max_id;
    let previous;
    for (;;) {
      setProgress({ currentTarget: target.name, currentTargetKind: target.kind, currentGuildName: target.guildName ?? "", currentChannelName: target.kind === "channel" ? target.name : "", status: `Searching ${target.name}...` });
      const response = await get(
        rt, rate, control,
        `search:${guildId}`,
        `/guilds/${guildId}/messages/search`,
        {
          limit: SEARCH_PAGE,
          author_id: authorId,
          sort_by: "timestamp",
          sort_order: "desc",
          include_nsfw: true,
          ...(channelId ? { channel_id: channelId } : {}),
          ...(bounds.min_id ? { min_id: bounds.min_id } : {}),
          ...(maxId ? { max_id: maxId } : {}),
        },
      );
      const responseBody = body(response) ?? {};
      bump({ pages: 1 });
      if (response?.status === 202 || responseBody.code === 110000) {
        const ms = Math.max(250, Number(responseBody.retry_after ?? 1) * 1000);
        await rate.indexing(ms);
        continue;
      }
      const hits = flattenSearch(responseBody)
        .filter(message => message.author?.id === authorId && matchesFilter(message, filter));
      if (!hits.length) break;
      found.authorHits += hits.length;
      for (const message of hits) {
        const actualChannelId = String(message.channel_id ?? channelId ?? "");
        if (!actualChannelId) continue;
        const channel = channelObject(rt, actualChannelId);
        let allowModerator = false;
        if (messageAuthorMode(target) !== "self") {
          const manage = canManageMessages(rt, actualChannelId, channel, guildId);
          if (manage !== true) { bump({ permissionSkipped: 1 }); continue; }
          allowModerator = true;
        }
        if (!messageDeleteEligible(message, target, rt, allowModerator)) continue;
        found.messages.push({
          channelId: actualChannelId,
          messageId: String(message.id),
          moderation: messageAuthorMode(target) !== "self",
        });
        bump({ scanned: 1, messagesFound: 1 });
      }
      const oldest = hits.reduce((a, b) => BigInt(a.id) < BigInt(b.id) ? a : b);
      if (!oldest?.id || oldest.id === previous) break;
      previous = oldest.id;
      maxId = oldest.id;
    }
    return found;
  }

  async function archivedThreads(rt, rate, control, parentId) {
    const out = [];
    let before;
    for (;;) {
      try {
        const response = body(await get(
          rt, rate, control,
          `threads-public:${parentId}`,
          `/channels/${parentId}/threads/archived/public`,
          { limit: 100, ...(before ? { before } : {}) },
        )) ?? {};
        bump({ pages: 1 });
        const threads = Array.isArray(response.threads) ? response.threads : [];
        out.push(...threads);
        if (!response.has_more || !threads.length) break;
        const next = threads[threads.length - 1]?.thread_metadata?.archive_timestamp;
        if (!next || next === before) break;
        before = next;
      } catch { break; }
    }
    let beforeId;
    for (;;) {
      try {
        const response = body(await get(
          rt, rate, control,
          `threads-private:${parentId}`,
          `/channels/${parentId}/users/@me/threads/archived/private`,
          { limit: 100, ...(beforeId ? { before: beforeId } : {}) },
        )) ?? {};
        bump({ pages: 1 });
        const threads = Array.isArray(response.threads) ? response.threads : [];
        out.push(...threads);
        if (!response.has_more || !threads.length) break;
        const next = threads[threads.length - 1]?.id;
        if (!next || next === beforeId) break;
        beforeId = next;
      } catch { break; }
    }
    return out;
  }

  async function serverChannels(rt, rate, control, guildId) {
    const base = body(await get(
      rt, rate, control,
      `guild-channels:${guildId}`,
      `/guilds/${guildId}/channels`,
    )) ?? [];
    bump({ pages: 1 });
    const all = base.filter(channel => [0, 2, 5, 13].includes(Number(channel.type)));
    try {
      const active = body(await get(
        rt, rate, control,
        `active-threads:${guildId}`,
        `/guilds/${guildId}/threads/active`,
      )) ?? {};
      bump({ pages: 1 });
      if (Array.isArray(active.threads)) all.push(...active.threads);
    } catch {}
    for (const parent of base.filter(channel => [0, 5, 15, 16].includes(Number(channel.type)))) {
      await control.check();
      all.push(...await archivedThreads(rt, rate, control, String(parent.id)));
    }
    return [...new Map(all.filter(channel => channel?.id).map(channel => [String(channel.id), channel])).values()];
  }

  function shouldUseSearch(target) {
    const mode = messageAuthorMode(target);
    return target.actions?.deleteMessages
      && reactionMode(target) === "off"
      && (mode === "self" || mode === "specific");
  }

  async function discoverTarget(rt, rate, control, target) {
    const filter = resolveFilter(target.filter);
    const mode = messageAuthorMode(target);

    if (shouldUseSearch(target) && target.kind === "server") {
      try {
        const result = await searchGuild(rt, rate, control, target, filter, target.id);
        if (mode !== "specific" || result.authorHits > 0) return result;
        setProgress({ status: `Discord search returned 0 for ${target.name}; full-scanning history for a deleted/unindexed user...` });
      } catch {
        setProgress({ status: `Discord author search failed for ${target.name}; full-scanning history instead...` });
      }
    }

    if (shouldUseSearch(target) && target.kind === "channel" && target.guildId) {
      try {
        const result = await searchGuild(rt, rate, control, target, filter, target.guildId, target.id);
        if (mode !== "specific" || result.authorHits > 0) return result;
        setProgress({ status: `Discord search returned 0 for ${target.name}; full-scanning channel history for a deleted/unindexed user...` });
      } catch {
        setProgress({ status: `Discord author search failed for ${target.name}; full-scanning channel history instead...` });
      }
    }

    if (target.kind !== "server") {
      const record = channelObject(rt, target.id);
      return scanChannel(rt, rate, control, target, target.id, filter, record);
    }

    const all = { messages: [], reactions: [] };
    const channels = await serverChannels(rt, rate, control, target.id);
    let index = 0;
    for (const channel of channels) {
      await control.check();
      index++;
      setProgress({ status: `Scanning ${target.name} ${index}/${channels.length}...` });
      try {
        const result = await scanChannel(rt, rate, control, target, String(channel.id), filter, channel);
        all.messages.push(...result.messages);
        all.reactions.push(...result.reactions);
      } catch (error) {
        const status = error?.status ?? error?.response?.status;
        if ([400, 403, 404].includes(status)) { bump({ skipped: 1 }); continue; }
        throw error;
      }
    }
    return all;
  }

  function dedupe(found) {
    return {
      messages: [...new Map(found.messages.map(message => [`${message.channelId}:${message.messageId}`, message])).values()],
      reactions: [...new Map(found.reactions.map(reaction => [
        `${reaction.channelId}:${reaction.messageId}:${reaction.emoji}:${reaction.userId ?? "@me"}`,
        reaction,
      ])).values()],
    };
  }
  function compareTaskIds(a, b, order) {
    const left = BigInt(a.messageId), right = BigInt(b.messageId);
    if (left === right) return 0;
    const ascending = left < right ? -1 : 1;
    return order === "oldest" ? ascending : -ascending;
  }
  function sortedTasks(tasks, target) {
    return [...tasks].sort((a, b) => compareTaskIds(a, b, target.deleteOrder ?? "newest"));
  }
  function isBulkRecent(messageId) {
    const age = Date.now() - sfTime(messageId);
    return age >= 0 && age < BULK_SAFE_AGE_MS;
  }
  function missing(error) {
    const status = error?.status ?? error?.response?.status;
    const code = error?.body?.code ?? error?.response?.body?.code;
    return status === 404 || code === 10008 || code === 10014;
  }
  function failureTaskKey(kind, item) {
    return kind === "reaction"
      ? `reaction:${item.channelId}:${item.messageId}:${item.emoji}:${item.userId ?? "@me"}`
      : `message:${item.channelId}:${item.messageId}`;
  }
  function markTaskFailed(key) {
    runtime.unresolvedFailures.add(key);
    setProgress({ failed: runtime.unresolvedFailures.size });
  }
  function markTaskResolved(key) {
    if (!runtime.unresolvedFailures.delete(key)) return;
    setProgress({
      failed: runtime.unresolvedFailures.size,
      recoveredFailures: (progress.recoveredFailures ?? 0) + 1,
    });
  }

  async function deleteOne(rt, rate, control, message) {
    await control.check();
    const failureKey = failureTaskKey("message", message);
    try {
      await rate.run(`delete:${message.channelId}`, "modify", () => rt.rest.del({
        url: `/channels/${message.channelId}/messages/${message.messageId}`,
      }));
      rate.metrics.finishTask("delete", 1, true);
      bump({ messagesDeleted: 1 });
      markTaskResolved(failureKey);
      return true;
    } catch (error) {
      if (error?.purgeStop || control.cancelled) throw error;
      rate.metrics.finishTask("delete", 1);
      if (missing(error)) { markTaskResolved(failureKey); bump({ skipped: 1 }); }
      else markTaskFailed(failureKey);
      return false;
    }
  }
  async function bulkDelete(rt, rate, control, channelId, batch) {
    if (!rt.rest.post || batch.length < 2) { rate.metrics.fallbackBatch(batch.length); return false; }
    try {
      await rate.run(`bulk-delete:${channelId}`, "modify", () => rt.rest.post({
        url: `/channels/${channelId}/messages/bulk-delete`,
        body: { messages: batch.map(message => message.messageId) },
      }));
      rate.metrics.finishTask("bulk-delete", batch.length, true);
      bump({ messagesDeleted: batch.length, bulkBatches: 1 });
      return true;
    } catch (error) {
      if (error?.purgeStop || control.cancelled) throw error;
      rate.metrics.fallbackBatch(batch.length);
      return false;
    }
  }

  async function purgeMessages(rt, rate, control, messages, target, verify) {
    const ordered = sortedTasks(messages, target);
    if (target.strictOrder === true) {
      let index = 0;
      for (const message of ordered) {
        await control.check();
        setProgress({ status: `${verify ? "Verification cleanup" : "Purging"} strict-order messages ${++index}/${ordered.length}...` });
        await deleteOne(rt, rate, control, message);
      }
      return;
    }

    const bulkByChannel = new Map(), individual = [];
    for (const message of ordered) {
      if (message.moderation && isBulkRecent(message.messageId)) {
        if (!bulkByChannel.has(message.channelId)) bulkByChannel.set(message.channelId, []);
        bulkByChannel.get(message.channelId).push(message);
      } else individual.push(message);
    }
    for (const items of bulkByChannel.values()) items.sort((a, b) => compareTaskIds(a, b, target.deleteOrder ?? "newest"));
    const channelGroups = [...bulkByChannel.entries()].sort((a, b) => compareTaskIds(a[1][0], b[1][0], target.deleteOrder ?? "newest"));

    const processBulk = async () => {
      for (const [channelId, items] of channelGroups) {
        const channel = channelObject(rt, channelId);
        const guildId = channel?.guild_id ?? channel?.guildId ?? target.guildId ?? (target.kind === "server" ? target.id : undefined);
        if (canManageMessages(rt, channelId, channel, guildId) !== true) {
          rate.metrics.skipMessages(items, target);
          bump({ permissionSkipped: items.length });
          continue;
        }
        for (let i = 0; i < items.length; i += BULK_MAX) {
          await control.check();
          const batch = items.slice(i, i + BULK_MAX);
          setProgress({ status: `${verify ? "Verification cleanup" : "Purging"} recent moderator messages ${Math.min(i + batch.length, items.length)}/${items.length}...` });
          if (batch.length >= 2 && await bulkDelete(rt, rate, control, channelId, batch)) continue;
          for (const message of batch) await deleteOne(rt, rate, control, message);
        }
      }
    };
    const processIndividual = async () => {
      const list = sortedTasks(individual, target);
      let index = 0;
      for (const message of list) {
        await control.check();
        if (message.moderation) {
          const channel = channelObject(rt, message.channelId);
          const guildId = channel?.guild_id ?? channel?.guildId ?? target.guildId ?? (target.kind === "server" ? target.id : undefined);
          if (canManageMessages(rt, message.channelId, channel, guildId) !== true) {
            rate.metrics.finishTask("delete", 1);
            bump({ permissionSkipped: 1 });
            continue;
          }
        }
        setProgress({ status: `${verify ? "Verification cleanup" : "Purging"} messages ${++index}/${list.length}...` });
        await deleteOne(rt, rate, control, message);
      }
    };
    if ((target.deleteOrder ?? "newest") === "oldest") { await processIndividual(); await processBulk(); }
    else { await processBulk(); await processIndividual(); }
  }

  async function purgeReactions(rt, rate, control, reactions, target, verify) {
    const ordered = sortedTasks(reactions, target);
    let index = 0;
    for (const reaction of ordered) {
      await control.check();
      const failureKey = failureTaskKey("reaction", reaction);
      const encoded = encodeURIComponent(reaction.emoji);
      const specific = !!reaction.userId;
      if (specific) {
        const channel = channelObject(rt, reaction.channelId);
        const guildId = channel?.guild_id ?? channel?.guildId ?? target.guildId ?? (target.kind === "server" ? target.id : undefined);
        if (canManageMessages(rt, reaction.channelId, channel, guildId) !== true) {
          rate.metrics.finishTask("reaction", 1);
          bump({ permissionSkipped: 1 });
          continue;
        }
      }
      setProgress({
        status: `${verify ? "Verification cleanup" : "Purging"} ${specific ? "selected-user" : "my"} reactions ${++index}/${ordered.length}...`,
      });
      try {
        const suffix = specific ? String(reaction.userId) : "@me";
        await rate.run(`reaction:${reaction.channelId}`, "modify", () => rt.rest.del({
          url: `/channels/${reaction.channelId}/messages/${reaction.messageId}/reactions/${encoded}/${suffix}`,
        }));
        rate.metrics.finishTask("reaction", 1);
        bump({ reactionsRemoved: 1 });
        markTaskResolved(failureKey);
      } catch (error) {
        if (error?.purgeStop || control.cancelled) throw error;
        rate.metrics.finishTask("reaction", 1);
        if (missing(error)) { markTaskResolved(failureKey); bump({ skipped: 1 }); }
        else markTaskFailed(failureKey);
      }
    }
  }

  async function purgeFound(rt, rate, control, found, target, verify = false) {
    rate.metrics.beginWork(found, target, verify);
    await purgeMessages(rt, rate, control, found.messages, target, verify);
    await purgeReactions(rt, rate, control, found.reactions, target, verify);
    await control.check();
    rate.metrics.endWork();
  }

  function validateTarget(target, rt) {
    if (!target.actions?.deleteMessages && reactionMode(target) === "off") throw new Error(`${target.name}: select at least one action`);
    resolveFilter(target.filter);
    if (messageAuthorMode(target) === "specific") targetAuthorId(target, rt);
    if (reactionMode(target) === "specific") targetReactionUserId(target);
    if (!target.deleteOrder) target.deleteOrder = "newest";

    if (target.kind === "channel" && (moderatorMessageNeeded(target) || moderatorReactionNeeded(target))) {
      const channel = channelObject(rt, target.id);
      const manage = canManageMessages(rt, target.id, channel, target.guildId);
      if (manage === false) throw new Error(`${target.name}: you do not have Manage Messages here`);
      if (manage === null) throw new Error(`${target.name}: Purge Tools could not verify Manage Messages safely`);
    }
  }

  async function previewJob(spec, control, rate, rt) {
    let index = 0;
    let messageTotal = 0;
    let reactionTotal = 0;
    const targets = {};
    clearPreviewSnapshot();

    for (const target of spec.targets) {
      await control.check();
      setProgress({ phase: "discovering", targetIndex: ++index, currentTarget: target.name, currentTargetKind: target.kind, currentGuildName: target.guildName ?? "", currentChannelName: target.kind === "channel" ? target.name : "", status: `Previewing ${target.name}...` });
      const found = dedupe(await discoverTarget(rt, rate, control, target));
      targets[target.key] = found;
      messageTotal += found.messages.length;
      reactionTotal += found.reactions.length;
    }

    await control.check();
    runtime.previewSnapshot = {
      accountId: purgeAccountId(),
      signature: previewSignature(spec),
      createdAt: Date.now(),
      targets,
      messageTotal,
      reactionTotal,
    };
    notify();
    setProgress({
      phase: "completed",
      status: `Preview complete: ${messageTotal} messages and ${reactionTotal} reactions matched. Snapshot ready — Start Purge will use these results without rediscovering.`,
      waitMs: 0,
    });
  }

  async function executePersistentJob(spec, control, rate, rt, resume, previewSnapshot = null) {
    let saved = resume ? getSavedJob() : null;
    if (!saved) {
      saved = {
        version: JOB_VERSION,
        accountId: purgeAccountId(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedKeys: [],
        currentKey: null,
        spec: clone(spec),
      };
      saveJob(saved);
    }
    const completed = new Set(saved.completedKeys ?? []);
    const total = spec.targets.length;

    for (let index = 0; index < spec.targets.length; index++) {
      const target = spec.targets[index];
      if (completed.has(target.key)) continue;
      await control.check();
      saved.currentKey = target.key;
      saved.updatedAt = Date.now();
      saveJob(saved);

      const cached = !resume ? previewSnapshot?.targets?.[target.key] : null;
      let found;
      if (cached) {
        found = dedupe(clone(cached));
        setProgress({
          phase: "purging",
          targetIndex: index + 1,
          targetCount: total,
          currentTarget: target.name, currentTargetKind: target.kind, currentGuildName: target.guildName ?? "", currentChannelName: target.kind === "channel" ? target.name : "",
          status: `Using preview snapshot for ${target.name}; skipping discovery. ${found.messages.length} messages and ${found.reactions.length} reactions queued.`,
        });
      } else {
        setProgress({
          phase: "discovering",
          targetIndex: index + 1,
          targetCount: total,
          currentTarget: target.name, currentTargetKind: target.kind, currentGuildName: target.guildName ?? "", currentChannelName: target.kind === "channel" ? target.name : "",
          status: `${resume ? "Resuming" : "Discovering"} ${target.name}...`,
        });
        found = dedupe(await discoverTarget(rt, rate, control, target));
        setProgress({
          phase: "purging",
          status: `Found ${found.messages.length} messages and ${found.reactions.length} reactions in ${target.name}.`,
        });
      }
      await purgeFound(rt, rate, control, found, target, false);

      if (spec.verify) {
        for (let pass = 1; pass <= VERIFY_PASSES; pass++) {
          await control.check();
          setProgress({ phase: "verifying", status: `Verifying ${target.name} — pass ${pass}/${VERIFY_PASSES}...` });
          await control.wait(700);
          found = dedupe(await discoverTarget(rt, rate, control, target));
          if (!found.messages.length && !found.reactions.length) break;
          await purgeFound(rt, rate, control, found, target, true);
        }
      }

      await control.check();
      completed.add(target.key);
      saved.completedKeys = [...completed];
      saved.currentKey = null;
      saved.updatedAt = Date.now();
      saveJob(saved);
    }
    clearSavedJob();
    setProgress({ phase: "completed", status: "Complete", waitMs: 0 });
  }

  function startJob(spec, options = {}) {
    if (runtime.control) throw new Error("A purge/preview is already running");
    if (!spec?.targets?.length) throw new Error("Select at least one target");
    const rt = resolveRuntime();
    for (const target of spec.targets) validateTarget(target, rt);

    if (options.preview) clearPreviewSnapshot();
    const previewSnapshot = !options.preview && !options.resume ? getMatchingPreviewSnapshot(spec) : null;
    if (!options.preview && !options.resume && runtime.previewSnapshot && !previewSnapshot) clearPreviewSnapshot();
    if (previewSnapshot) {
      runtime.previewSnapshot = null;
      notify();
    }

    const control = new Control();
    runtime.control = control;
    runtime.unresolvedFailures.clear();
    progress = {
      ...emptyProgress(),
      phase: previewSnapshot ? "purging" : "discovering",
      status: options.resume ? "Resuming saved purge..." : previewSnapshot ? "Using completed preview snapshot..." : "Discovering...",
      targetCount: spec.targets.length,
      resumed: !!options.resume,
    };
    notify();
    const rate = new RateController(control);
    runtime.rateController = rate;

    void (async () => {
      try {
        if (options.preview) await previewJob(spec, control, rate, rt);
        else await executePersistentJob(spec, control, rate, rt, !!options.resume, previewSnapshot);
      } catch (error) {
        if (control.cancelled || error?.message === "__PURGE_CANCELLED__") {
          if (control.userCancelled) {
            clearSavedJob();
            setProgress({ phase: "cancelled", status: "Cancelled and saved job discarded.", waitMs: 0 });
          } else setProgress({ phase: "cancelled", status: "Interrupted. Saved job can be resumed.", waitMs: 0 });
        } else {
          setProgress({
            phase: "error",
            status: `Failed: ${error?.message ?? String(error)} — saved job can be resumed or discarded.`,
            waitMs: 0,
          });
        }
      } finally {
        try { rate.metrics.finish(); } catch { toast("Could not save the purge test report"); }
        if (runtime.control === control) runtime.control = null;
        notify();
      }
    })();
  }

  function resumeSavedJob() {
    const saved = getSavedJob();
    if (!saved) throw new Error("No interrupted purge is saved");
    startJob(saved.spec, { resume: true });
  }

  const C = { border: "#4F5158", text: "#F2F3F5", muted: "#B5BAC1", brand: "#5865F2", danger: "#DA373C", button: "#4E5058" };
  const Txt = ({ children, style }) => React.createElement(RN.Text, { style: [{ color: C.text, fontSize: 14 }, style] }, children);
  const Button = ({ text, onPress, disabled, danger, active, small }) => React.createElement(
    RN.Pressable,
    { disabled, onPress, style: { paddingHorizontal: 12, paddingVertical: small ? 7 : 10, borderRadius: 8, backgroundColor: danger ? C.danger : active ? C.brand : C.button, opacity: disabled ? 0.45 : 1, marginRight: 7, marginBottom: 7 } },
    React.createElement(Txt, { style: { fontWeight: "700" } }, text),
  );
  const Chip = ({ text, onPress, active, disabled, danger }) => React.createElement(
    RN.Pressable,
    { disabled, onPress, style: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: danger && active ? C.danger : active ? C.brand : C.border, backgroundColor: danger && active ? "rgba(218,55,60,0.12)" : "transparent", opacity: disabled ? 0.4 : 1, marginRight: 6, marginBottom: 6 } },
    React.createElement(Txt, { style: { fontWeight: "600" } }, `${active ? "✓ " : ""}${text}`),
  );
  const Toggle = ({ label, value, onChange, disabled, desc }) => React.createElement(
    RN.Pressable,
    { disabled, onPress: () => onChange(!value), style: { paddingVertical: 6, opacity: disabled ? 0.45 : 1 } },
    React.createElement(Txt, { style: { fontWeight: "600" } }, `${value ? "☑" : "☐"} ${label}`),
    desc ? React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 2 } }, desc) : null,
  );
  const Input = ({ value, onChange, placeholder, disabled }) => React.createElement(
    RN.TextInput,
    { value, onChangeText: onChange, placeholder, placeholderTextColor: "#80848E", editable: !disabled, autoCapitalize: "none", autoCorrect: false, style: { color: C.text, borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 10, minHeight: 42, marginTop: 7 } },
  );
  const Card = ({ children, style }) => React.createElement(RN.View, { style: [{ borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 10, marginBottom: 10 }, style] }, children);
  const Row = ({ children }) => React.createElement(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" } }, children);

  function SearchSelect({ label, placeholder, options = [], selectedId, onSelect, disabled }) {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const selectedItem = options.find(item => String(item.id) === String(selectedId));
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? options.filter(item => `${item.name ?? ""} ${item.id ?? ""}`.toLowerCase().includes(needle))
      : options;

    const close = () => { setOpen(false); setQuery(""); };
    return React.createElement(
      RN.View,
      { style: { marginTop: 8 } },
      label ? React.createElement(Txt, { style: { fontWeight: "700", marginBottom: 5 } }, label) : null,
      React.createElement(
        RN.Pressable,
        {
          disabled,
          onPress: () => setOpen(true),
          style: {
            minHeight: 44,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: 8,
            paddingHorizontal: 11,
            paddingVertical: 10,
            opacity: disabled ? 0.45 : 1,
            flexDirection: "row",
            alignItems: "center",
          },
        },
        React.createElement(Txt, { style: { flex: 1, color: selectedItem ? C.text : "#80848E" } }, selectedItem?.name ?? placeholder ?? "Choose…"),
        React.createElement(Txt, { style: { color: C.muted, fontSize: 16, marginLeft: 8 } }, "⌄"),
      ),
      React.createElement(
        RN.Modal,
        { visible: open, transparent: true, animationType: "fade", onRequestClose: close },
        React.createElement(
          RN.View,
          { style: { flex: 1, justifyContent: "center", padding: 18, backgroundColor: "rgba(0,0,0,0.68)" } },
          React.createElement(RN.Pressable, { onPress: close, style: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } }),
          React.createElement(
            RN.View,
            { style: { maxHeight: "78%", borderWidth: 1, borderColor: C.border, borderRadius: 12, backgroundColor: "#111214", padding: 12 } },
            React.createElement(Txt, { style: { fontSize: 17, fontWeight: "800" } }, label ?? "Choose target"),
            React.createElement(Input, { value: query, onChange: setQuery, placeholder: "Search by name or ID" }),
            React.createElement(
              RN.ScrollView,
              { style: { marginTop: 8 }, keyboardShouldPersistTaps: "handled" },
              filtered.length
                ? filtered.map(item => React.createElement(
                    RN.Pressable,
                    {
                      key: String(item.id),
                      onPress: () => { onSelect(item); close(); },
                      style: {
                        paddingVertical: 11,
                        paddingHorizontal: 9,
                        borderBottomWidth: 1,
                        borderBottomColor: "#2B2D31",
                        backgroundColor: String(item.id) === String(selectedId) ? "rgba(88,101,242,0.18)" : "transparent",
                      },
                    },
                    React.createElement(Txt, { style: { fontWeight: "650" } }, `${String(item.id) === String(selectedId) ? "✓ " : ""}${item.name}`),
                    React.createElement(Txt, { style: { color: C.muted, fontSize: 11, marginTop: 2 } }, String(item.id)),
                  ))
                : React.createElement(Txt, { style: { color: C.muted, paddingVertical: 18, textAlign: "center" } }, "No matches"),
            ),
            React.createElement(Row, null, React.createElement(Button, { text: "Close", small: true, onPress: close })),
          ),
        ),
      ),
    );
  }

  function newTarget(kind, id, name, guildId, guildName) {
    return {
      key: `${kind}:${id}`,
      kind, id, name, guildId, guildName,
      authorMode: "self",
      authorId: "",
      reactionMode: "off",
      reactionUserId: "",
      deleteOrder: "newest",
      strictOrder: false,
      preservePinned: true,
      attachmentMode: "all",
      attachmentTypes: "both",
      preserveAttachmentExtensions: "",
      filter: { mode: "all" },
      actions: { deleteMessages: true },
    };
  }
  function boundary() { return { kind: "message", value: "", include: false }; }
  function modeFilter(filter, mode) {
    if (mode === "all") return { mode };
    if (mode === "before") return { mode, before: filter.before ?? boundary() };
    if (mode === "after") return { mode, after: filter.after ?? boundary() };
    return { mode, before: filter.before ?? boundary(), after: filter.after ?? boundary() };
  }

  function Boundary({ label, value, onChange, disabled }) {
    let decoded = "";
    if (value.kind === "message" && value.value) {
      try { const id = extractId(value.value); if (id) decoded = new Date(sfTime(id)).toLocaleString(); } catch {}
    }
    return React.createElement(
      Card,
      { style: { marginTop: 8 } },
      React.createElement(Txt, { style: { fontWeight: "700" } }, label),
      React.createElement(Row, null,
        React.createElement(Chip, { text: "Date / time", active: value.kind === "date", disabled, onPress: () => onChange({ ...value, kind: "date" }) }),
        React.createElement(Chip, { text: "Message ID / link", active: value.kind === "message", disabled, onPress: () => onChange({ ...value, kind: "message" }) }),
      ),
      React.createElement(Input, {
        value: value.value,
        onChange: next => onChange({ ...value, value: next }),
        disabled,
        placeholder: value.kind === "message" ? "Message ID or Discord message link" : "YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss",
      }),
      decoded ? React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 5 } }, `Decoded: ${decoded}`) : null,
      React.createElement(Toggle, { label: "Include boundary", value: value.include, disabled, onChange: next => onChange({ ...value, include: next }) }),
    );
  }

  function AuthorSelector({ target, onChange, disabled }) {
    if (target.kind === "dm") return null;
    const mode = messageAuthorMode(target);
    return React.createElement(
      Card,
      { style: { marginTop: 8 } },
      React.createElement(Txt, { style: { fontWeight: "700", marginBottom: 6 } }, "Message author"),
      React.createElement(Row, null,
        React.createElement(Chip, { text: "Only mine", active: mode === "self", disabled, onPress: () => onChange({ ...target, authorMode: "self" }) }),
        React.createElement(Chip, { text: "Specific user", active: mode === "specific", disabled, onPress: () => onChange({ ...target, authorMode: "specific" }) }),
        React.createElement(Chip, { text: "Everyone", active: mode === "all", disabled, danger: true, onPress: () => onChange({ ...target, authorMode: "all" }) }),
      ),
      mode === "specific" ? React.createElement(Input, { value: target.authorId ?? "", onChange: next => onChange({ ...target, authorId: next }), disabled, placeholder: "User ID or <@mention>" }) : null,
      mode !== "self" ? React.createElement(Txt, { style: { color: mode === "all" ? "#F23F42" : C.muted, fontSize: 12, marginTop: 6 } }, mode === "all" ? "Moderator mode: deletes every matching message where Manage Messages is verified." : "Moderator mode: deletes matching messages by this user where Manage Messages is verified.") : null,
    );
  }

  function ReactionSelector({ target, onChange, disabled }) {
    const mode = reactionMode(target);
    const guild = target.kind !== "dm";
    return React.createElement(
      Card,
      { style: { marginTop: 8 } },
      React.createElement(Txt, { style: { fontWeight: "700", marginBottom: 6 } }, "Reaction cleanup"),
      React.createElement(Row, null,
        React.createElement(Chip, { text: "Off", active: mode === "off", disabled, onPress: () => onChange({ ...target, reactionMode: "off" }) }),
        React.createElement(Chip, { text: "Only mine", active: mode === "self", disabled, onPress: () => onChange({ ...target, reactionMode: "self" }) }),
        guild ? React.createElement(Chip, { text: "Specific user", active: mode === "specific", disabled, onPress: () => onChange({ ...target, reactionMode: "specific", reactionUserId: target.reactionUserId || target.authorId || "" }) }) : null,
      ),
      mode === "specific" ? React.createElement(Input, { value: target.reactionUserId ?? "", onChange: next => onChange({ ...target, reactionUserId: next }), disabled, placeholder: "Reaction user ID or <@mention>" }) : null,
      mode === "specific" ? React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 6 } }, "Purge Tools verifies Manage Messages per channel, enumerates the users behind each reacted emoji, and removes only this user's matching reaction.") : null,
    );
  }

  function ContentSelector({ target, onChange, disabled }) {
    const attachmentMode = target.attachmentMode ?? "all";
    const attachmentTypes = target.attachmentTypes ?? "both";
    return React.createElement(
      Card,
      { style: { marginTop: 8 } },
      React.createElement(Txt, { style: { fontWeight: "700", marginBottom: 6 } }, "Message protection / attachments"),
      React.createElement(Toggle, {
        label: "Preserve pinned messages",
        value: target.preservePinned !== false,
        disabled,
        onChange: next => onChange({ ...target, preservePinned: next }),
        desc: "Default ON. Pinned messages are never queued for message deletion when enabled.",
      }),
      React.createElement(Txt, { style: { fontWeight: "700", marginTop: 7, marginBottom: 6 } }, "Attachment handling"),
      React.createElement(Row, null,
        React.createElement(Chip, { text: "No attachment filter", active: attachmentMode === "all", disabled, onPress: () => onChange({ ...target, attachmentMode: "all" }) }),
        React.createElement(Chip, { text: "Preserve attachments", active: attachmentMode === "preserve", disabled, onPress: () => onChange({ ...target, attachmentMode: "preserve" }) }),
        React.createElement(Chip, { text: "Only attachments / media", active: attachmentMode === "only", disabled, onPress: () => onChange({ ...target, attachmentMode: "only" }) }),
      ),
      attachmentMode !== "all" ? React.createElement(React.Fragment, null,
        React.createElement(Txt, { style: { fontWeight: "700", marginTop: 5, marginBottom: 6 } }, "Attachment types"),
        React.createElement(Row, null,
          React.createElement(Chip, { text: "Images / GIFs / media", active: attachmentTypes === "media", disabled, onPress: () => onChange({ ...target, attachmentTypes: "media" }) }),
          React.createElement(Chip, { text: "Other files", active: attachmentTypes === "file", disabled, onPress: () => onChange({ ...target, attachmentTypes: "file" }) }),
          React.createElement(Chip, { text: "Both", active: attachmentTypes === "both", disabled, onPress: () => onChange({ ...target, attachmentTypes: "both" }) }),
        ),
        attachmentMode === "only" ? React.createElement(React.Fragment, null,
          React.createElement(Txt, { style: { fontWeight: "700", marginTop: 8, marginBottom: 4 } }, "Always keep file extensions"),
          React.createElement(Input, {
            value: target.preserveAttachmentExtensions ?? "",
            onChange: next => onChange({ ...target, preserveAttachmentExtensions: next }),
            disabled,
            placeholder: "ogg, oga, mp3",
          }),
          React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 3 } },
            "Comma/space-separated. If a matching message contains one of these file types, the whole message is kept. Example: ogg keeps OGG audio/voice messages while other attachments can still be purged."
          ),
        ) : null,
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 5 } },
          attachmentMode === "preserve"
            ? "Any message containing matching uploaded or rendered media is kept intact, including its text."
            : "Only messages containing matching uploaded or rendered media are eligible for message deletion. GIF-picker links, Tenor/Giphy media, and direct rendered image/media links are included in preview, purge, and verification."
        ),
      ) : null,
    );
  }

  function OrderSelector({ target, onChange, disabled }) {
    const order = target.deleteOrder ?? "newest";
    return React.createElement(
      Card,
      { style: { marginTop: 8 } },
      React.createElement(Txt, { style: { fontWeight: "700", marginBottom: 6 } }, "Deletion order"),
      React.createElement(Row, null,
        React.createElement(Chip, { text: "Newest → Oldest", active: order === "newest", disabled, onPress: () => onChange({ ...target, deleteOrder: "newest" }) }),
        React.createElement(Chip, { text: "Oldest → Newest", active: order === "oldest", disabled, onPress: () => onChange({ ...target, deleteOrder: "oldest" }) }),
      ),
      React.createElement(Toggle, { label: "Strict order", value: target.strictOrder === true, disabled, onChange: next => onChange({ ...target, strictOrder: next }), desc: "Deletes one message at a time in exact chronological order. Slower; disables moderator bulk-delete batches for this target." }),
    );
  }

  function TargetEditor({ target, onChange, onRemove, disabled }) {
    const [open, setOpen] = React.useState(false);
    const filter = target.filter;
    const author = messageAuthorMode(target);
    const reaction = reactionMode(target);
    const order = target.deleteOrder ?? "newest";
    const attachmentMode = target.attachmentMode ?? "all";
    const attachmentTypes = target.attachmentTypes ?? "both";
    const filterLabel = filter.mode === "all" ? "Everything" : filter.mode[0].toUpperCase() + filter.mode.slice(1);
    const attachmentLabel = attachmentMode === "all"
      ? ""
      : `${attachmentMode === "preserve" ? "Keep" : "Only"} ${attachmentTypes === "media" ? "media" : attachmentTypes === "file" ? "files" : "attachments"}`;
    const authorLabel = target.kind === "dm"
      ? "My messages"
      : author === "all" ? "Everyone" : author === "specific" ? `User ${extractUserId(target.authorId) ?? target.authorId ?? "?"}` : "My messages";
    const reactionLabel = reaction === "off"
      ? "Reactions off"
      : reaction === "specific" ? `Reactions by ${extractUserId(target.reactionUserId) ?? target.reactionUserId ?? "?"}` : "My reactions";

    return React.createElement(
      Card,
      null,
      React.createElement(Row, null,
        React.createElement(RN.View, { style: { flex: 1, minWidth: 180 } },
          React.createElement(Txt, { style: { fontWeight: "700", fontSize: 16 } }, target.name),
          React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, `${target.kind.toUpperCase()} · ${target.guildName ? `${target.guildName} · ` : ""}${target.id}`),
        ),
        React.createElement(Button, { text: open ? "Hide" : "Configure", small: true, onPress: () => setOpen(value => !value) }),
        React.createElement(Button, { text: "Remove", small: true, disabled, onPress: onRemove }),
      ),
      React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 3 } }, `${authorLabel} · ${reactionLabel} · ${filterLabel} · ${order === "oldest" ? "Oldest → Newest" : "Newest → Oldest"}${target.strictOrder ? " · Strict" : ""}${target.preservePinned !== false ? " · Pinned safe" : ""}${attachmentLabel ? ` · ${attachmentLabel}` : ""}`),
      open ? React.createElement(React.Fragment, null,
        React.createElement(Toggle, { label: "Delete messages", value: target.actions?.deleteMessages !== false, disabled, onChange: next => onChange({ ...target, actions: { ...target.actions, deleteMessages: next } }) }),
        React.createElement(AuthorSelector, { target, onChange, disabled }),
        React.createElement(ReactionSelector, { target, onChange, disabled }),
        React.createElement(ContentSelector, { target, onChange, disabled }),
        React.createElement(OrderSelector, { target, onChange, disabled }),
        React.createElement(Txt, { style: { fontWeight: "700", marginTop: 7, marginBottom: 6 } }, "Filter for this target"),
        React.createElement(Row, null,
          ...["all", "before", "after", "between"].map(mode => React.createElement(Chip, {
            key: mode,
            text: mode[0].toUpperCase() + mode.slice(1),
            active: filter.mode === mode,
            disabled,
            onPress: () => onChange({ ...target, filter: modeFilter(filter, mode) }),
          })),
        ),
        filter.after && ["after", "between"].includes(filter.mode) ? React.createElement(Boundary, { label: "After", value: filter.after, disabled, onChange: next => onChange({ ...target, filter: { ...filter, after: next } }) }) : null,
        filter.before && ["before", "between"].includes(filter.mode) ? React.createElement(Boundary, { label: "Before", value: filter.before, disabled, onChange: next => onChange({ ...target, filter: { ...filter, before: next } }) }) : null,
      ) : null,
    );
  }

  function Settings() {
    const [cat, setCat] = React.useState({ dms: [], guilds: [] });
    const [selected, setSelected] = React.useState(() => { try { const accountId = purgeAccountId(); const draft = storage.shiggyPurgeDraftTargets?.[accountId]; return draft && typeof draft === "object" && !Array.isArray(draft) ? clone(draft) : {}; } catch { return {}; } });
    const [verify, setVerify] = React.useState(true);
    const [pickerType, setPickerType] = React.useState("server");
    const [pickerDmId, setPickerDmId] = React.useState("");
    const [pickerGuildId, setPickerGuildId] = React.useState("");
    const [pickerScope, setPickerScope] = React.useState("server");
    const [pickerChannelId, setPickerChannelId] = React.useState("");
    const [manualOpen, setManualOpen] = React.useState(false);
    const [manualId, setManualId] = React.useState("");
    const [manualName, setManualName] = React.useState("");
    const [, render] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => {
      try {
        const accountId = purgeAccountId();
        if (accountId) {
          const drafts = { ...(storage.shiggyPurgeDraftTargets ?? {}) };
          if (Object.keys(selected).length) drafts[accountId] = clone(selected);
          else delete drafts[accountId];
          storage.shiggyPurgeDraftTargets = drafts;
        }
      } catch {}
    }, [selected]);

    React.useEffect(() => {
      const listener = () => render();
      runtime.listeners.add(listener);
      try { setCat(catalog()); } catch (error) { toast(error?.message ?? error); }
      return () => runtime.listeners.delete(listener);
    }, []);

    const running = ["discovering", "purging", "verifying", "paused"].includes(progress.phase) || !!runtime.control;
    const targets = Object.values(selected);
    const savedJob = getSavedJob();
    const toggle = target => {
      if (running) return;
      setSelected(current => {
        const next = { ...current };
        if (next[target.key]) delete next[target.key]; else next[target.key] = target;
        return next;
      });
    };
    const change = target => setSelected(current => ({ ...current, [target.key]: target }));
    const refresh = () => { try { setCat(catalog()); } catch (error) { toast(error?.message ?? error); } };
    const chosenGuild = cat.guilds.find(guild => String(guild.id) === String(pickerGuildId));
    const addPickerTarget = () => {
      if (running) return;
      let target;
      if (pickerType === "dm") {
        const dm = cat.dms.find(item => String(item.id) === String(pickerDmId));
        if (!dm) { toast("Choose a direct message first"); return; }
        target = newTarget("dm", dm.id, dm.name);
      } else {
        if (!chosenGuild) { toast("Choose a server first"); return; }
        if (pickerScope === "server") {
          target = newTarget("server", chosenGuild.id, chosenGuild.name);
        } else {
          const channel = chosenGuild.channels.find(item => String(item.id) === String(pickerChannelId));
          if (!channel) { toast("Choose a channel first"); return; }
          target = newTarget("channel", channel.id, `#${channel.name}`, chosenGuild.id, chosenGuild.name);
        }
      }
      if (selected[target.key]) { toast(`${target.name} is already selected`); return; }
      setSelected(current => ({ ...current, [target.key]: target }));
      if (pickerType === "dm") setPickerDmId("");
      else if (pickerScope === "channel") setPickerChannelId("");
    };
    const prepareSpec = () => ({ targets: targets.map(target => clone(target)), verify });
    const readyPreview = getMatchingPreviewSnapshot(prepareSpec());
    const previewReady = !!readyPreview;
    const beginPreview = () => { try { const accountId = purgeAccountId(); if (accountId) { const drafts = { ...(storage.shiggyPurgeDraftTargets ?? {}) }; drafts[accountId] = clone(selected); storage.shiggyPurgeDraftTargets = drafts; } startJob(prepareSpec(), { preview: true }); } catch (error) { toast(error?.message ?? error); } };

    const confirmStart = () => {
      try {
        const rt = resolveRuntime();
        for (const target of targets) validateTarget(target, rt);
        if (!targets.length) throw new Error("Select at least one target");
        const allTargets = targets.filter(target => messageAuthorMode(target) === "all");
        const modReactionTargets = targets.filter(target => reactionMode(target) === "specific");
        const strictTargets = targets.filter(target => target.strictOrder === true);
        const warnings = [];
        if (allTargets.length) warnings.push(`${allTargets.length} target${allTargets.length === 1 ? " uses" : "s use"} Everyone message mode.`);
        if (modReactionTargets.length) warnings.push(`${modReactionTargets.length} target${modReactionTargets.length === 1 ? " removes" : "s remove"} another user's reactions.`);
        if (strictTargets.length) warnings.push(`${strictTargets.length} target${strictTargets.length === 1 ? " uses" : "s use"} Strict order.`);
        RN.Alert.alert(
          warnings.length ? "Start Moderator Purge?" : "Start Purge?",
          `Permanently remove the selected messages/reactions from ${targets.length} target${targets.length === 1 ? "" : "s"}?${warnings.length ? `\n\nWARNING:\n${warnings.join("\n")}` : ""}${previewReady ? "\n\nThe completed preview snapshot will be used; initial discovery will be skipped." : ""}\n\nModerator actions are permission-checked per channel before requests are sent.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: warnings.length ? "START MODERATOR PURGE" : "Start Purge", style: "destructive", onPress: () => { try { startJob(prepareSpec()); } catch (error) { toast(error?.message ?? error); } } },
          ],
        );
      } catch (error) { toast(error?.message ?? error); }
    };

    const addManual = () => {
      const id = manualId.trim();
      if (!/^\d{16,22}$/.test(id)) { toast("Enter a valid DM channel ID"); return; }
      const target = newTarget("dm", id, manualName.trim() || `DM ${id}`);
      setSelected(current => ({ ...current, [target.key]: target }));
      setManualId(""); setManualName("");
    };
    const resumeJob = () => { try { resumeSavedJob(); } catch (error) { toast(error?.message ?? error); } };

    return React.createElement(
      RN.ScrollView,
      { contentContainerStyle: { padding: 16, paddingBottom: 40 } },
      React.createElement(Txt, { style: { fontSize: 22, fontWeight: "800" } }, "Purge Tools"),
      React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 2 } }, `Version ${PLUGIN_VERSION}`),
      React.createElement(Txt, { style: { color: C.muted, marginTop: 4, marginBottom: 12 } }, "Select DMs, channels, or entire servers. Every target has independent author, reaction, filter, and deletion-order settings."),

      savedJob && !running ? React.createElement(Card, { style: { borderColor: C.brand } },
        React.createElement(Txt, { style: { fontWeight: "800", fontSize: 16 } }, "Interrupted purge available"),
        React.createElement(Txt, { style: { color: C.muted, marginTop: 4 } }, `${savedJob.completedKeys?.length ?? 0}/${savedJob.spec.targets.length} targets completed${savedJob.currentKey ? ` · interrupted in ${savedJob.currentKey}` : ""}.`),
        React.createElement(Row, null,
          React.createElement(Button, { text: "Resume purge", active: true, onPress: resumeJob }),
          React.createElement(Button, { text: "Discard saved job", danger: true, onPress: () => { clearSavedJob(); toast("Saved purge checkpoint discarded"); } }),
        ),
      ) : null,

      runtime.rateController?.accountId !== purgeAccountId() && storage.shiggyPurgeTestReports?.[purgeAccountId()] ? React.createElement(Button, { text: "Copy last report", small: true, onPress: copyPurgeTestReport }) : null,
      React.createElement(Toggle, { label: "Auto-resume interrupted purge", value: storage.autoResumeInterrupted === true, disabled: running, onChange: next => { storage.autoResumeInterrupted = next; notify(); }, desc: "Automatically continue a saved purge after Discord/plugin reloads." }),
      React.createElement(Toggle, { label: "Verify after each target", value: verify, disabled: running, onChange: setVerify, desc: "Re-scan each target and clean anything still matching before marking it complete." }),
      React.createElement(Row, null, React.createElement(Button, { text: "Refresh DMs / servers", small: true, disabled: running, onPress: refresh })),

      React.createElement(Txt, { style: { fontSize: 17, fontWeight: "800", marginTop: 12, marginBottom: 8 } }, "Add target"),
      React.createElement(Card, null,
        React.createElement(Row, null,
          React.createElement(Chip, { text: "Direct message", active: pickerType === "dm", disabled: running, onPress: () => setPickerType("dm") }),
          React.createElement(Chip, { text: "Server / channel", active: pickerType === "server", disabled: running, onPress: () => setPickerType("server") }),
        ),
        pickerType === "dm" ? React.createElement(React.Fragment, null,
          React.createElement(SearchSelect, {
            label: "Direct message",
            placeholder: "Search or choose a DM…",
            options: cat.dms,
            selectedId: pickerDmId,
            disabled: running,
            onSelect: item => setPickerDmId(String(item.id)),
          }),
        ) : React.createElement(React.Fragment, null,
          React.createElement(SearchSelect, {
            label: "Server",
            placeholder: "Search or choose a server…",
            options: cat.guilds,
            selectedId: pickerGuildId,
            disabled: running,
            onSelect: item => { setPickerGuildId(String(item.id)); setPickerChannelId(""); },
          }),
          pickerGuildId ? React.createElement(React.Fragment, null,
            React.createElement(Txt, { style: { fontWeight: "700", marginTop: 10, marginBottom: 5 } }, "Scope"),
            React.createElement(Row, null,
              React.createElement(Chip, { text: "Entire server", active: pickerScope === "server", disabled: running, onPress: () => { setPickerScope("server"); setPickerChannelId(""); } }),
              React.createElement(Chip, { text: "Specific channel", active: pickerScope === "channel", disabled: running, onPress: () => setPickerScope("channel") }),
            ),
            pickerScope === "channel" ? React.createElement(SearchSelect, {
              label: "Channel",
              placeholder: "Search or choose a channel…",
              options: chosenGuild?.channels ?? [],
              selectedId: pickerChannelId,
              disabled: running,
              onSelect: item => setPickerChannelId(String(item.id)),
            }) : null,
          ) : null,
        ),
        React.createElement(Row, { },
          React.createElement(Button, { text: "Add target", active: true, disabled: running, onPress: addPickerTarget }),
          React.createElement(Button, { text: "Refresh list", small: true, disabled: running, onPress: refresh }),
          React.createElement(Button, { text: manualOpen ? "Hide old DM ID" : "Old DM by ID", small: true, disabled: running, onPress: () => setManualOpen(value => !value) }),
        ),
        manualOpen ? React.createElement(Card, { style: { marginTop: 5, marginBottom: 0 } },
          React.createElement(Txt, { style: { fontWeight: "700" } }, "Add closed/old DM by channel ID"),
          React.createElement(Input, { value: manualId, onChange: setManualId, disabled: running, placeholder: "DM channel ID" }),
          React.createElement(Input, { value: manualName, onChange: setManualName, disabled: running, placeholder: "Optional label" }),
          React.createElement(Row, null, React.createElement(Button, { text: "Add DM", small: true, disabled: running, onPress: addManual })),
        ) : null,
      ),

      React.createElement(Txt, { style: { fontSize: 17, fontWeight: "800", marginTop: 12, marginBottom: 8 } }, `Selected targets (${targets.length})`),
      targets.length
        ? targets.map(target => React.createElement(TargetEditor, { key: target.key, target, disabled: running, onChange: change, onRemove: () => toggle(target) }))
        : React.createElement(Txt, { style: { color: C.muted, marginBottom: 10 } }, "Nothing selected yet."),

      previewReady ? React.createElement(Card, { style: { borderColor: C.brand } },
        React.createElement(Txt, { style: { fontWeight: "800" } }, "Preview snapshot ready"),
        React.createElement(Txt, { style: { color: C.muted, marginTop: 3 } }, `${readyPreview.messageTotal} messages · ${readyPreview.reactionTotal} reactions · Purge will skip initial discovery.`),
      ) : null,
      React.createElement(Row, null,
        React.createElement(Button, { text: "Preview / Discover", disabled: running || !targets.length, onPress: beginPreview }),
        React.createElement(Button, { text: previewReady ? "Start Purge (use preview)" : "Start Purge", danger: true, disabled: running || !targets.length, onPress: confirmStart }),
      ),
      running ? React.createElement(Row, null,
        progress.phase === "paused" ? React.createElement(Button, { text: "Resume", active: true, onPress: () => runtime.control?.resume() }) : React.createElement(Button, { text: "Pause", onPress: () => runtime.control?.pause() }),
        React.createElement(Button, { text: "Cancel + discard job", danger: true, onPress: () => runtime.control?.cancel(true) }),
      ) : null,

      progress.phase !== "idle" ? React.createElement(Card, { style: { marginTop: 8, borderColor: C.brand } },
        React.createElement(PacingStatus),
      ) : null,

      React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 10 } }, "Safety: moderator actions require a verified Manage Messages permission per channel. Specific-user reactions enumerate reactor lists and delete only that user's matching emoji reaction; own-reaction cleanup uses /@me only. No clear-all reaction route is used."),
      React.createElement(Txt, { style: { color: C.muted, fontSize: 12, marginTop: 6 } }, "Background note: this JS plugin runs only while Android keeps Discord's process alive. Persistent checkpoints let it resume after Discord is reopened."),
    );
  }

  function scheduleAutoResume() {
    if (runtime.autoResumeTimer) clearTimeout(runtime.autoResumeTimer);
    runtime.autoResumeTimer = setTimeout(() => {
      runtime.autoResumeTimer = null;
      if (storage.autoResumeInterrupted !== true || runtime.control || !getSavedJob()) return;
      try { resumeSavedJob(); } catch (error) { toast(`Purge auto-resume failed: ${error?.message ?? error}`); }
    }, 1800);
  }

  function cleanup() {
    if (runtime.autoResumeTimer) { clearTimeout(runtime.autoResumeTimer); runtime.autoResumeTimer = null; }
    try { runtime.control?.cancel(false); } catch {}
    runtime.listeners.clear();
    if (globalThis[RUNTIME_KEY] === runtime) {
      try { delete globalThis[RUNTIME_KEY]; } catch { globalThis[RUNTIME_KEY] = null; }
    }
  }
  runtime.cleanup = cleanup;

  return {
    onLoad() { scheduleAutoResume(); },
    onUnload() { cleanup(); },
    settings: Settings,
  };
})()
