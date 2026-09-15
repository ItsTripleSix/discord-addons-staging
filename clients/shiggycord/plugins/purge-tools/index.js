(() => {
  "use strict";

  const V = vendetta;
  if (!V?.metro || !V?.patcher) return {};

  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const CORE_URL = "https://raw.githubusercontent.com/ItsTripleSix/discord-addons/main/plugins/purge-tools/index.js";

  let core = null;
  let coreError = null;
  let loadPromise = null;
  let started = false;
  const listeners = new Set();

  function toast(text) {
    try { V.ui?.toasts?.showToast?.(String(text)); } catch {}
  }

  function notify() {
    for (const fn of listeners) try { fn(); } catch {}
  }

  async function fetchCoreSource() {
    try {
      const response = await V.utils.safeFetch(CORE_URL, { cache: "no-store" });
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "?"}`);
      const source = await response.text();
      if (!source?.includes("Purge Tools")) throw new Error("Invalid Purge Tools source");
      storage.shiggyPurgeSource = source;
      return source;
    } catch (error) {
      const cached = storage.shiggyPurgeSource;
      if (typeof cached === "string" && cached.length > 1000) return cached;
      throw error;
    }
  }

  function replaceBlock(source, startMarker, endMarker, replacement, label) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end < 0 || end <= start) throw new Error(`Could not patch ${label}`);
    return source.slice(0, start) + replacement + source.slice(end);
  }

  function patchMediaFiltering(source) {
    let out = source;

    const mediaBlock = `  function attachmentExtension(value) {
    const raw = String(
      value?.filename ?? value?.name ?? value?.url ?? value?.proxy_url ?? value?.proxyUrl ?? ""
    ).trim();
    if (raw) {
      const clean = raw.split(/[?#]/)[0];
      const match = clean.match(/\\.([a-z0-9]{1,12})$/i);
      if (match) return match[1].toLowerCase();
    }
    const type = String(value?.content_type ?? value?.contentType ?? "").toLowerCase().split(";")[0];
    const subtype = type.match(/^[a-z0-9.+-]+\\/([a-z0-9.+-]+)$/i)?.[1];
    return subtype && /^[a-z0-9]{1,12}$/i.test(subtype) ? subtype.toLowerCase() : "";
  }
  function mediaMimeFromUrl(url) {
    const ext = attachmentExtension({ url });
    if (["png", "jpg", "jpeg", "webp", "bmp", "avif", "heic", "heif", "svg"].includes(ext)) return \`image/\${ext === "jpg" ? "jpeg" : ext}\`;
    if (ext === "gif") return "image/gif";
    if (["mp4", "m4v", "mov", "webm", "mkv", "avi"].includes(ext)) return \`video/\${ext}\`;
    if (["mp3", "m4a", "wav", "ogg", "oga", "flac", "aac"].includes(ext)) return \`audio/\${ext}\`;
    return "";
  }
  function mediaHost(url) {
    const match = String(url ?? "").match(/^https?:\\/\\/([^/?#]+)/i);
    return match ? match[1].split(":")[0].toLowerCase() : "";
  }
  function providerGifUrl(url) {
    const host = mediaHost(url);
    return host === "tenor.com" || host.endsWith(".tenor.com") || host === "giphy.com" || host.endsWith(".giphy.com");
  }
  function directMediaUrl(url) {
    const raw = String(url ?? "");
    if (!raw) return false;
    if (/\\.(?:png|jpe?g|gif|webp|bmp|avif|heic|heif|svg|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|oga|flac|aac)(?:[?#].*)?$/i.test(raw)) return true;
    const host = mediaHost(raw);
    return host === "media.discordapp.net" || host === "media.tenor.com" || host === "c.tenor.com" || host === "i.giphy.com" || host === "media.giphy.com";
  }
  function attachmentKind(attachment) {
    const type = String(attachment?.content_type ?? attachment?.contentType ?? "").toLowerCase();
    const ext = attachmentExtension(attachment);
    if (/^(image|video|audio)\\//.test(type)) return "media";
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

    const urls = String(message?.content ?? "").match(/https?:\\/\\/[^\\s<>()]+/gi) ?? [];
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
      .split(/[\\s,;]+/)
      .map(value => value.replace(/^\\.+/, "").trim())
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
`;

    out = replaceBlock(
      out,
      "  function attachmentKind(attachment) {",
      "  function messageDeleteEligible(message, target, rt, allowModerator) {",
      mediaBlock,
      "Purge Tools media discovery",
    );

    const oldTargetDefaults = '      attachmentMode: "all",\n      attachmentTypes: "both",\n      filter: { mode: "all" },';
    const newTargetDefaults = '      attachmentMode: "all",\n      attachmentTypes: "both",\n      preserveAttachmentExtensions: "",\n      filter: { mode: "all" },';
    if (!out.includes(oldTargetDefaults)) throw new Error("Could not patch Purge Tools target defaults");
    out = out.replace(oldTargetDefaults, newTargetDefaults);

    const contentSelector = `  function ContentSelector({ target, onChange, disabled }) {
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

`;

    out = replaceBlock(
      out,
      "  function ContentSelector({ target, onChange, disabled }) {",
      "  function OrderSelector({ target, onChange, disabled }) {",
      contentSelector,
      "Purge Tools attachment settings",
    );

    return out;
  }

  function patchCheckpointStorage(source) {
    let out = source;

    const checkpointBlock = `  function purgeAccountId() {
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

`;

    out = replaceBlock(
      out,
      "  function getSavedJob() {",
      "  function previewSignature(spec) {",
      checkpointBlock,
      "account-scoped purge checkpoints",
    );

    const oldSavedJob = `      saved = {
        version: JOB_VERSION,
        createdAt: Date.now(),`;
    const newSavedJob = `      saved = {
        version: JOB_VERSION,
        accountId: purgeAccountId(),
        createdAt: Date.now(),`;
    if (!out.includes(oldSavedJob)) throw new Error("Could not patch Purge Tools checkpoint owner");
    out = out.replace(oldSavedJob, newSavedJob);

    const oldDiscard = '          React.createElement(Button, { text: "Discard saved job", danger: true, onPress: () => RN.Alert.alert("Discard saved purge?", "This removes the resume checkpoint. It does not restore anything already deleted.", [{ text: "Keep", style: "cancel" }, { text: "Discard", style: "destructive", onPress: clearSavedJob }]) }),';
    const newDiscard = '          React.createElement(Button, { text: "Discard saved job", danger: true, onPress: () => { clearSavedJob(); toast("Saved purge checkpoint discarded"); } }),';
    if (!out.includes(oldDiscard)) throw new Error("Could not patch Purge Tools discard action");
    out = out.replace(oldDiscard, newDiscard);

    return out;
  }

  function pacingRuntimeSource() {
    const PACING_VERSION = 1;
    const PACING_DAY = 86400000;
    const PACING_BUFFER = 250;
    const PACING_LONG_WAIT = 300000;
    const pacingFloor = kind => kind === "read" ? 400 : 1200;
    const pacingNumber = value => {
      if (value == null || String(value).trim() === "") return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
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
        this.kind = kind;
        this.delay = Math.max(pacingFloor(kind), pacingNumber(saved.delay) ?? 0);
        this.blocked = pacingNumber(saved.blocked) ?? 0;
        this.nextAt = pacingNumber(saved.nextAt) ?? 0;
        this.resetAt = pacingNumber(saved.resetAt) ?? 0;
        this.headerDelay = pacingNumber(saved.headerDelay) ?? 0;
        this.lastLimited = pacingNumber(saved.lastLimited) ?? 0;
        this.good = 0;
        this.updatedAt = Date.now();
      }
      effectiveDelay(now = Date.now()) {
        return Math.max(this.delay, now < this.resetAt ? this.headerDelay : 0);
      }
      observe(response, now = Date.now()) {
        const remaining = pacingNumber(responseHeader(response, "X-RateLimit-Remaining"));
        const window = pacingWindow(response, now);
        if (remaining == null || window == null) return false;
        this.resetAt = now + window;
        this.headerDelay = remaining > 0 ? Math.min(window + PACING_BUFFER, Math.ceil(window / remaining / 0.8)) : 0;
        if (remaining === 0) this.blocked = Math.max(this.blocked, now + window + PACING_BUFFER);
        this.updatedAt = now;
        return true;
      }
      success(headersAvailable, now = Date.now()) {
        if (headersAvailable && now - this.lastLimited >= 600000 && ++this.good >= 120) {
          this.delay = Math.max(pacingFloor(this.kind), Math.ceil(this.delay * 0.95));
          this.good = 0;
        }
      }
      limited(ms, now = Date.now()) {
        this.good = 0;
        this.lastLimited = now;
        this.delay = Math.min(30000, Math.max(this.delay + 250, Math.ceil(this.delay * 1.5)));
        this.blocked = Math.max(this.blocked, now + ms + PACING_BUFFER);
        this.updatedAt = now;
      }
    }
  
    class PurgeMetrics {
      constructor(rate) {
        this.rate = rate;
        this.startedAt = Date.now();
        this.finishedAt = 0;
        this.requests = [];
        this.deletions = [];
        this.responses = {};
        this.routes = {};
        this.limitEvents = [];
        this.rateLimits = 0;
        this.headersSeen = 0;
        this.requestCount = 0;
        this.networkMs = {};
        this.pacingMs = {};
        this.observedLimits = {};
        this.inFlightAt = 0;
        this.inFlightOperation = "";
        this.pending = null;
        this.workTotal = 0;
        this.workDone = 0;
        this.workActive = false;
        this.waitUntil = 0;
        this.waitKind = "";
        this.waitStarted = 0;
        this.waitTotals = { pacing: 0, cooldown: 0, indexing: 0 };
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
        this.inFlightAt = now;
        this.inFlightOperation = operation;
      }
      response(operation, status, duration, response) {
        this.inFlightAt = 0;
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
      limit(operation, scope, ms, response, delay) {
        this.rateLimits++;
        this.limitEvents.push({
          elapsed_s: Math.round((Date.now() - this.startedAt) / 1000), operation, scope,
          retry_after_s: ms / 1000, pacing_ms: delay,
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
        this.workActive = true;
        this.verificationWork = !!verify;
        notify();
      }
      finishTask(operation, units, deleted = false) {
        if (this.pending) this.pending[operation] = Math.max(0, (this.pending[operation] ?? 0) - 1);
        this.workDone += units;
        if (deleted) this.deletions.push({ time: Date.now(), units });
        this.deletions = this.deletions.filter(item => item.time > Date.now() - 60000);
      }
      skipMessages(messages, target) {
        const plan = this.messagePlan(messages, target);
        if (this.pending) for (const key of Object.keys(plan)) this.pending[key] = Math.max(0, this.pending[key] - plan[key]);
        this.workDone += messages.length;
      }
      fallbackBatch(size) {
        if (!this.pending) return;
        this.pending["bulk-delete"] = Math.max(0, this.pending["bulk-delete"] - 1);
        this.pending.delete += size;
      }
      endWork() { this.workActive = false; this.pending = null; notify(); }
      eta(now = Date.now()) {
        if (!this.workActive || !this.pending) return null;
        let ms = 0;
        for (const [operation, count] of Object.entries(this.pending)) {
          ms += count * (this.rate.operationDelay(operation) + (this.networkMs[operation] ?? 0));
        }
        const cooldown = Math.max(this.rate.globalUntil, this.rate.activeLane?.blocked ?? 0, this.waitKind === "cooldown" ? this.waitUntil : 0);
        const overdueResponse = this.inFlightAt ? Math.max(0, now - this.inFlightAt - (this.networkMs[this.inFlightOperation] ?? 0)) : 0;
        return Math.ceil(ms + Math.max(0, cooldown - now) + overdueResponse);
      }
      report() {
        const now = this.finishedAt || Date.now();
        const requestCountSince = ms => this.requests.filter(time => time > now - ms).length;
        const deletedLastMinute = this.deletions.filter(item => item.time > now - 60000).reduce((sum, item) => sum + item.units, 0);
        return {
          plugin_version: PLUGIN_VERSION, report_version: 1, phase: progress.phase,
          elapsed_s: Math.round((now - this.startedAt) / 1000),
          requests: this.requestCount,
          requests_last_1s: requestCountSince(1000), requests_last_60s: requestCountSince(60000), requests_last_3600s: requestCountSince(3600000),
          responses: { ...this.responses }, operations: { ...this.routes }, rate_limits: this.rateLimits,
          observed_limits: clone(this.observedLimits),
          average_response_ms: Object.fromEntries(Object.entries(this.networkMs).map(([key, ms]) => [key, Math.round(ms)])),
          in_flight_s: this.inFlightAt ? Math.round((now - this.inFlightAt) / 1000) : 0,
          responses_with_rate_headers: this.headersSeen, search_index_waits: this.indexWaits,
          wait_seconds: Object.fromEntries(Object.entries(this.waitTotals).map(([key, ms]) => [key, Math.round(ms / 1000)])),
          messages_deleted: progress.messagesDeleted, reactions_removed: progress.reactionsRemoved,
          deleted_last_60s: deletedLastMinute, skipped: progress.skipped, failed: progress.failed,
          pages: progress.pages, messages_examined: progress.scanned, permission_skips: progress.permissionSkipped,
          current_target_total: this.workTotal, current_target_processed: this.workDone,
          cleanup_eta_s: this.eta(now) == null ? null : Math.ceil(this.eta(now) / 1000),
          current_pacing_ms: Math.ceil(this.rate.activeLane?.effectiveDelay(now) ?? pacingFloor("modify")),
          wait_reason: this.waitKind || null, cooldown_remaining_s: Math.ceil(Math.max(0, this.rate.globalUntil - now, (this.rate.activeLane?.blocked ?? 0) - now) / 1000),
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
        for (const [key, value] of Object.entries(saved.lanes ?? {})) {
          if (value?.updatedAt > Date.now() - PACING_DAY || value?.blocked > Date.now() || value?.nextAt > Date.now()) {
            this.lanes.set(key, new RateLane(value.kind === "read" ? "read" : "modify", value));
          }
        }
        for (const [key, value] of Object.entries(saved.aliases ?? {})) if (this.lanes.has(value)) this.aliases.set(key, value);
        this.globalUntil = pacingNumber(saved.globalUntil) ?? 0;
        this.accountNextAt = pacingNumber(saved.accountNextAt) ?? 0;
        this.limitTimes = Array.isArray(saved.limitTimes) ? saved.limitTimes.filter(time => Number.isFinite(time) && time > Date.now() - 600000) : [];
        this.holdReason = typeof saved.holdReason === "string" ? saved.holdReason : "";
        this.activeLane = null;
        this.operationLanes = new Map();
        this.serial = Promise.resolve();
        this.metrics = new PurgeMetrics(this);
        if (this.holdReason) control.pause(this.holdReason);
      }
      lane(identity, kind) {
        const key = this.aliases.get(identity.key) ?? identity.key;
        if (!this.lanes.has(key)) this.lanes.set(key, new RateLane(kind));
        const lane = this.lanes.get(key);
        this.operationLanes.set(identity.operation, lane);
        return lane;
      }
      bind(identity, kind, response, lane) {
        const bucket = responseHeader(response, "X-RateLimit-Bucket");
        if (!bucket) return lane;
        const key = `bucket:${String(bucket)}:${identity.major}`;
        const previousKey = this.aliases.get(identity.key);
        const shared = this.lanes.get(key);
        if (!shared && previousKey && previousKey !== key) lane = new RateLane(kind, { delay: lane.delay });
        if (shared && shared !== lane) {
          shared.delay = Math.max(shared.delay, lane.delay);
          shared.blocked = Math.max(shared.blocked, lane.blocked);
          shared.nextAt = Math.max(shared.nextAt, lane.nextAt);
          shared.lastLimited = Math.max(shared.lastLimited, lane.lastLimited);
          lane = shared;
        }
        this.lanes.set(key, lane);
        if (kind === "modify") { lane.kind = kind; lane.delay = Math.max(lane.delay, pacingFloor(kind)); }
        this.aliases.set(identity.key, key);
        this.operationLanes.set(identity.operation, lane);
        return lane;
      }
      operationDelay(operation) {
        return Math.max(this.operationLanes.get(operation)?.effectiveDelay() ?? pacingFloor("modify"), this.metrics.pacingMs[operation] ?? 0);
      }
      persist() {
        const all = { ...(storage.shiggyPurgePacing ?? {}) };
        all[this.accountId] = {
          version: PACING_VERSION, updatedAt: Date.now(), globalUntil: this.globalUntil,
          accountNextAt: this.accountNextAt, holdReason: this.holdReason, limitTimes: this.limitTimes,
          aliases: Object.fromEntries(this.aliases), lanes: Object.fromEntries(this.lanes),
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
      run(key, kind, fn, url) {
        const pending = this.serial.then(() => this.runRequest(key, kind, fn, url));
        this.serial = pending.catch(() => {});
        return pending;
      }
      async runRequest(key, kind, fn, url) {
        const identity = pacingIdentity(key, kind, url);
        let lane = this.lane(identity, kind);
        for (;;) {
          await this.control.check();
          this.activeLane = lane;
          const now = Date.now();
          const blockedUntil = Math.max(lane.blocked, this.globalUntil);
          const deadline = Math.max(this.accountNextAt, lane.nextAt, blockedUntil);
          if (deadline > now) {
            const reason = blockedUntil > now ? "cooldown" : "pacing";
            this.metrics.beginWait(reason, deadline);
            setProgress({ waitMs: deadline - now });
            if (blockedUntil - now >= PACING_LONG_WAIT && !this.control.paused && blockedUntil > (this.longWaitAcknowledged ?? 0)) {
              this.longWaitAcknowledged = blockedUntil;
              this.hold(`Long Discord cooldown. Paused; requests can resume after ${new Date(blockedUntil).toLocaleTimeString()}.`);
            }
            await this.control.wait(deadline - now);
            this.metrics.endWait();
            continue;
          }
          this.control.assertAccount();
          this.metrics.endWait();
          setProgress({ waitMs: 0 });
          const requestStart = Date.now();
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
            lane.observe(error);
            this.accountNextAt = Date.now() + pacingFloor(kind);
            if (status === 401 || status === 403) {
              this.control.failure = pacingStop(status === 401
                ? "Discord authentication failed; stopped and kept the resume checkpoint"
                : "Discord denied permission; stopped and kept the resume checkpoint");
              this.persist();
              throw this.control.failure;
            }
            if (status !== 429) { this.persist(); throw error; }
            const ms = pacingRetry(error);
            const body = error?.body ?? error?.response?.body;
            const rawScope = String(responseHeader(error, "X-RateLimit-Scope") ?? "").toLowerCase();
            const global = body?.global === true || error?.global === true || rawScope === "global" || String(responseHeader(error, "X-RateLimit-Global")).toLowerCase() === "true";
            const scope = global ? "global" : rawScope === "shared" ? "shared" : "route";
            lane.limited(ms);
            if (global) this.globalUntil = Math.max(this.globalUntil, Date.now() + ms + PACING_BUFFER);
            this.metrics.limit(identity.operation, scope, ms, error, lane.delay);
            this.limitTimes = this.limitTimes.filter(time => time > Date.now() - 600000);
            this.limitTimes.push(Date.now());
            this.persist();
            setProgress({ status: `Discord ${scope} cooldown; waiting ${pacingDuration(ms)}.`, waitMs: ms });
            if (this.limitTimes.length >= 3) this.hold("Repeated Discord rate limits. Paused with progress saved; copy the test report before resuming.");
            continue;
          }
          this.metrics.response(identity.operation, Number(response?.status ?? 200), Date.now() - requestStart, response);
          lane = this.bind(identity, kind, response, lane);
          this.activeLane = lane;
          const headersAvailable = lane.observe(response);
          lane.success(headersAvailable);
          this.metrics.observePace(identity.operation, lane.effectiveDelay());
          lane.nextAt = Date.now() + lane.effectiveDelay();
          this.accountNextAt = Date.now() + pacingFloor(kind);
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
      if (!report) { toast("Run a preview or purge to collect a test report"); return; }
      const clipboard = V.metro.common?.clipboard ?? find("setString", "getString") ?? RN.Clipboard;
      if (!clipboard?.setString) { toast("Clipboard unavailable; take a screenshot of the pacing panel"); return; }
      try {
        Promise.resolve(clipboard.setString(JSON.stringify(report, null, 2)))
          .then(() => toast("Purge test report copied. No message content or account identifiers included."))
          .catch(() => toast("Could not copy the test report"));
      } catch { toast("Could not copy the test report"); }
    }
    function PacingStatus() {
      const [, tick] = React.useReducer(value => value + 1, 0);
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
      const eta = metrics.eta(now);
      const waiting = Math.max(0, metrics.waitUntil - now);
      const estimate = progress.phase === "paused" ? "Paused" : !live && ["error", "cancelled"].includes(progress.phase) ? "Stopped — resume required" : eta == null
        ? ["discovering", "verifying"].includes(progress.phase) ? "Calculating — discovery in progress" : live ? "Calculating…" : "Finished"
        : pacingDuration(eta);
      return React.createElement(Card, { style: { marginTop: 8, borderColor: C.brand } },
        React.createElement(Txt, { style: { fontWeight: "800", fontSize: 16 } }, `Current target cleanup ETA: ${estimate}`),
        eta != null && live && !rate.control.paused ? React.createElement(Txt, { style: { color: C.muted } }, `Estimated finish: ${new Date(now + eta).toLocaleTimeString()}`) : null,
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, "Estimate covers queued cleanup for this target. Discovery, later targets, and additional verification are extra."),
        metrics.workActive ? React.createElement(Txt, null, `Processed: ${metrics.workDone}/${metrics.workTotal} queued actions`) : null,
        React.createElement(Txt, null, `Deleted in last minute: ${report.deleted_last_60s} · Elapsed: ${pacingDuration(now - metrics.startedAt)}`),
        React.createElement(Txt, null, `Requests: ${report.requests_last_1s}/last second · ${report.requests_last_60s}/last minute · ${report.requests_last_3600s}/last hour`),
        React.createElement(Txt, null, `Rate limits observed: ${report.rate_limits} · Search-index waits: ${report.search_index_waits}`),
        React.createElement(Txt, null, `Current request spacing: ${(report.current_pacing_ms / 1000).toFixed(2)}s`),
        waiting ? React.createElement(Txt, null, `${metrics.waitKind === "cooldown" ? "Discord cooldown" : metrics.waitKind === "indexing" ? "Search indexing" : "Preventive pacing"}: ${pacingDuration(waiting)} remaining`) : null,
        waiting && metrics.waitKind === "cooldown" ? React.createElement(Txt, null, `Earliest request: ${new Date(metrics.waitUntil).toLocaleTimeString()}`) : null,
        report.in_flight_s >= 5 ? React.createElement(Txt, null, `Waiting for Discord response: ${report.in_flight_s}s`) : null,
        React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, report.responses_with_rate_headers ? "Pacing follows available Discord headers with headroom." : "No rate headers observed yet; using conservative pacing."),
        React.createElement(Row, null, React.createElement(Button, { text: "Copy test report", small: true, onPress: copyPurgeTestReport })),
      );
    }
  }
  
  function patchPacing(source) {
    let out = source;
    const exact = (before, after, label) => {
      if (out.split(before).length !== 2) throw new Error(`Could not patch Purge Tools ${label}`);
      out = out.replace(before, after);
    };
    const runtimeSource = pacingRuntimeSource.toString();
    out = replaceBlock(out, "  class Control {", "  function find(...props)", runtimeSource.slice(runtimeSource.indexOf("{") + 1, runtimeSource.lastIndexOf("}")) + "\n\n", "pacing runtime");
    exact('    return rate.run(lane, "read", () => rt.rest.get({ url, query }));', '    return rate.run(lane, "read", () => rt.rest.get({ url, query }), url);', "read route identity");
    exact('    const rate = new RateController(control);', '    const rate = new RateController(control);\n    runtime.rateController = rate;', "pacing session");
    exact('      } finally {\n        if (runtime.control === control)', '      } finally {\n        try { rate.metrics.finish(); } catch { toast("Could not save the purge test report"); }\n        if (runtime.control === control)', "report completion");
    exact('      completed.add(target.key);', '      await control.check();\n      completed.add(target.key);', "completion permission guard");
    exact('    runtime.previewSnapshot = {\n      signature:', '    await control.check();\n    runtime.previewSnapshot = {\n      signature:', "preview account guard");
    exact('      signature: previewSignature(spec),', '      accountId: purgeAccountId(),\n      signature: previewSignature(spec),', "preview account owner");
    exact('    if (!snapshot || snapshot.signature !== previewSignature(spec)) return null;', '    if (!snapshot || snapshot.accountId !== purgeAccountId() || snapshot.signature !== previewSignature(spec)) return null;', "preview account isolation");
    exact('    await purgeMessages(rt, rate, control, found.messages, target, verify);', '    rate.metrics.beginWork(found, target, verify);\n    await purgeMessages(rt, rate, control, found.messages, target, verify);', "work estimate start");
    exact('    await purgeReactions(rt, rate, control, found.reactions, target, verify);', '    await purgeReactions(rt, rate, control, found.reactions, target, verify);\n    await control.check();\n    rate.metrics.endWork();', "work estimate completion");
    exact('      bump({ messagesDeleted: 1 });', '      rate.metrics.finishTask("delete", 1, true);\n      bump({ messagesDeleted: 1 });', "delete progress");
    exact('      bump(missing(error) ? { skipped: 1 } : { failed: 1 });\n      return false;', '      if (error?.purgeStop || control.cancelled) throw error;\n      rate.metrics.finishTask("delete", 1);\n      bump(missing(error) ? { skipped: 1 } : { failed: 1 });\n      return false;', "delete failure progress");
    exact('    if (!rt.rest.post || batch.length < 2) return false;', '    if (!rt.rest.post || batch.length < 2) { rate.metrics.fallbackBatch(batch.length); return false; }', "bulk availability estimate");
    exact('      bump({ messagesDeleted: batch.length, bulkBatches: 1 });', '      rate.metrics.finishTask("bulk-delete", batch.length, true);\n      bump({ messagesDeleted: batch.length, bulkBatches: 1 });', "bulk progress");
    exact('    } catch { return false; }\n  }\n\n  async function purgeMessages', '    } catch (error) {\n      if (error?.purgeStop || control.cancelled) throw error;\n      rate.metrics.fallbackBatch(batch.length);\n      return false;\n    }\n  }\n\n  async function purgeMessages', "bulk failure guard");
    exact('          bump({ permissionSkipped: items.length });', '          rate.metrics.skipMessages(items, target);\n          bump({ permissionSkipped: items.length });', "bulk permission estimate");
    exact('            bump({ permissionSkipped: 1 });\n            continue;\n          }\n        }\n        setProgress({ status: `${verify', '            rate.metrics.finishTask("delete", 1);\n            bump({ permissionSkipped: 1 });\n            continue;\n          }\n        }\n        setProgress({ status: `${verify', "individual permission estimate");
    exact('          bump({ permissionSkipped: 1 });\n          continue;\n        }\n      }\n      setProgress({\n        status: `${verify', '          rate.metrics.finishTask("reaction", 1);\n          bump({ permissionSkipped: 1 });\n          continue;\n        }\n      }\n      setProgress({\n        status: `${verify', "reaction permission estimate");
    exact('        bump({ reactionsRemoved: 1 });', '        rate.metrics.finishTask("reaction", 1);\n        bump({ reactionsRemoved: 1 });', "reaction progress");
    exact('        bump(missing(error) ? { skipped: 1 } : { failed: 1 });', '        if (error?.purgeStop || control.cancelled) throw error;\n        rate.metrics.finishTask("reaction", 1);\n        bump(missing(error) ? { skipped: 1 } : { failed: 1 });', "reaction failure progress");
    exact('        setProgress({ waitMs: ms, status: "Waiting for Discord search index..." });\n        await control.wait(ms);', '        await rate.indexing(ms);', "search indexing timer");
    exact('        progress.waitMs ? React.createElement(Txt, { style: { color: C.muted } }, `Adaptive wait: ${(progress.waitMs / 1000).toFixed(1)}s`) : null,', '        React.createElement(PacingStatus),', "live pacing panel");
    exact('      React.createElement(Toggle, { label: "Auto-resume interrupted purge"', '      runtime.rateController?.accountId !== purgeAccountId() && storage.shiggyPurgeTestReports?.[purgeAccountId()] ? React.createElement(Button, { text: "Copy last test report", small: true, onPress: copyPurgeTestReport }) : null,\n      React.createElement(Toggle, { label: "Auto-resume interrupted purge"', "saved test report");
    return out;
  }

  function portSource(source) {
    let out = String(source);

    out = out.replace(
      "const V = globalThis.vendetta;",
      "const V = vendetta;",
    );

    out = out.replace(
      'const PLUGIN_VERSION = "1.1.1";',
      'const PLUGIN_VERSION = "1.1.6-shiggy";',
    );

    out = patchMediaFiltering(out);
    out = patchCheckpointStorage(out);
    out = patchPacing(out);

    const shortcutStart = "  let settingsShortcutCleanup = null;\n\n  function installSettingsShortcut() {";
    const scheduleStart = "  function scheduleAutoResume() {";
    const startIndex = out.indexOf(shortcutStart);
    const scheduleIndex = out.indexOf(scheduleStart);

    if (startIndex < 0 || scheduleIndex < 0 || scheduleIndex <= startIndex) {
      throw new Error("Could not strip Purge Tools settings shortcut");
    }

    out = out.slice(0, startIndex) + out.slice(scheduleIndex);

    out = out.replace(
      "    try { settingsShortcutCleanup?.(); } catch {}\n    settingsShortcutCleanup = null;\n",
      "",
    );

    out = out.replace(
      "    onLoad() { installSettingsShortcut(); scheduleAutoResume(); },",
      "    onLoad() { scheduleAutoResume(); },",
    );

    if (out.includes("installSettingsShortcut") || out.includes("settingsShortcutCleanup")) {
      throw new Error("Purge Tools shortcut code was not fully removed");
    }

    return out;
  }

  async function loadCore() {
    const source = portSource(await fetchCoreSource());
    const factory = (0, eval)(`vendetta=>{return ${source}}\n//# sourceURL=purge-tools-shiggy-core.js`);
    const raw = factory(V);
    const resolved = typeof raw === "function" ? raw() : raw;
    return await Promise.resolve(resolved?.default ?? resolved ?? {});
  }

  function ensureCore() {
    if (core) return Promise.resolve(core);
    if (loadPromise) return loadPromise;

    coreError = null;
    loadPromise = loadCore()
      .then(plugin => {
        core = plugin;
        if (started) {
          try { core?.onLoad?.(); }
          catch (error) { throw new Error(`Core start failed: ${error?.message ?? error}`); }
        }
        notify();
        return core;
      })
      .catch(error => {
        coreError = error;
        core = null;
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
      ensureCore();
      return () => listeners.delete(listener);
    }, []);

    if (typeof core?.settings === "function") {
      return React.createElement(core.settings);
    }

    const Pressable = RN.Pressable ?? RN.TouchableOpacity;
    return React.createElement(
      RN.View,
      { style: { flex: 1, padding: 16, backgroundColor: "#111214" } },
      React.createElement(
        RN.Text,
        { style: { color: "#F2F3F5", fontSize: 16 } },
        coreError
          ? `Could not load Purge Tools: ${coreError?.message ?? coreError}`
          : "Loading Purge Tools…",
      ),
      coreError ? React.createElement(
        Pressable,
        {
          onPress: () => {
            coreError = null;
            loadPromise = null;
            ensureCore();
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
      if (hasInterruptedAutoResume()) ensureCore();
    },
    onUnload() {
      started = false;
      try { core?.onUnload?.(); } catch {}
      listeners.clear();
    },
    settings: SettingsBridge,
  };
})()
