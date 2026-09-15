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

  const PACING_RUNTIME_SOURCE = "  const PACING_VERSION = 1;\n  const PACING_DAY = 86400000;\n  const PACING_BUFFER = 250;\n  const PACING_LONG_WAIT = 300000;\n  const pacingFloor = kind => kind === \"read\" ? 400 : 1200;\n  const pacingNumber = value => {\n    if (value == null || String(value).trim() === \"\") return null;\n    const n = Number(value);\n    return Number.isFinite(n) && n >= 0 ? n : null;\n  };\n  function pacingStop(message) {\n    const error = new Error(message);\n    error.purgeStop = true;\n    return error;\n  }\n  function pacingDuration(ms) {\n    if (!Number.isFinite(ms)) return \"Calculating…\";\n    const seconds = Math.max(0, Math.ceil(ms / 1000));\n    if (seconds < 60) return `${seconds}s`;\n    const minutes = Math.ceil(seconds / 60);\n    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;\n  }\n  function responseHeader(source, name) {\n    const wanted = String(name).toLowerCase();\n    for (const headers of [source?.headers, source?.response?.headers]) {\n      if (!headers) continue;\n      try {\n        if (typeof headers.get === \"function\") {\n          const value = headers.get(name) ?? headers.get(wanted);\n          if (value != null) return value;\n        }\n        for (const [key, raw] of Object.entries(headers)) {\n          if (String(key).toLowerCase() !== wanted) continue;\n          if (Array.isArray(raw)) return raw[0];\n          return raw && typeof raw === \"object\" && \"value\" in raw ? raw.value : raw;\n        }\n      } catch {}\n    }\n    return undefined;\n  }\n  function pacingWindow(response, now = Date.now()) {\n    const after = pacingNumber(responseHeader(response, \"X-RateLimit-Reset-After\"));\n    const epoch = pacingNumber(responseHeader(response, \"X-RateLimit-Reset\"));\n    return after != null ? Math.ceil(after * 1000) : epoch != null ? Math.max(0, Math.ceil(epoch * 1000 - now)) : null;\n  }\n  function pacingRetry(error, now = Date.now()) {\n    const body = error?.body ?? error?.response?.body;\n    const values = [body?.retry_after, error?.retry_after, responseHeader(error, \"Retry-After\")]\n      .map(pacingNumber).filter(value => value != null).map(value => Math.ceil(value * 1000));\n    const header = responseHeader(error, \"Retry-After\");\n    if (header && pacingNumber(header) == null) {\n      const date = Date.parse(String(header));\n      if (Number.isFinite(date)) values.push(Math.max(0, date - now));\n    }\n    if (!values.length) {\n      const window = pacingWindow(error, now);\n      if (window != null) values.push(window);\n    }\n    const ms = values.length ? Math.max(...values) : 1000;\n    if (!Number.isSafeInteger(now + ms + PACING_BUFFER)) throw pacingStop(\"Discord returned an unreadable cooldown; stopped for review\");\n    return ms;\n  }\n  function pacingIdentity(key, kind, url) {\n    const operation = String(key).split(\":\")[0];\n    const match = String(url ?? \"\").match(/^\\/(channels|guilds)\\/([^/]+)/);\n    const major = match ? `${match[1]}:${match[2]}` : `channels:${String(key).split(\":\")[1] ?? \"unknown\"}`;\n    return { operation, major, key: `${kind}:${operation}:${major}` };\n  }\n\n  class Control {\n    constructor() {\n      this.cancelled = false;\n      this.userCancelled = false;\n      this.paused = false;\n      this.resumePhase = \"discovering\";\n      this.accountId = purgeAccountId();\n      this.failure = null;\n      this.pausedAt = 0;\n      this.pausedMs = 0;\n    }\n    assertAccount() {\n      if (this.failure) throw this.failure;\n      if (!this.accountId || purgeAccountId() !== this.accountId) {\n        this.failure = pacingStop(\"Discord account changed; purge stopped before the next request\");\n        throw this.failure;\n      }\n      if (this.cancelled) throw new Error(\"__PURGE_CANCELLED__\");\n    }\n    pausedTime(now = Date.now()) { return this.pausedMs + (this.paused ? now - this.pausedAt : 0); }\n    cancel(user = false) {\n      this.cancelled = true;\n      this.userCancelled ||= user && purgeAccountId() === this.accountId;\n      if (this.paused) this.pausedMs += Date.now() - this.pausedAt;\n      this.paused = false;\n    }\n    pause(reason = \"Paused\") {\n      if (this.cancelled || this.paused) return;\n      if ([\"discovering\", \"purging\", \"verifying\"].includes(progress.phase)) this.resumePhase = progress.phase;\n      this.paused = true;\n      this.pausedAt = Date.now();\n      setProgress({ phase: \"paused\", status: reason });\n    }\n    resume() {\n      if (!this.paused || this.cancelled) return;\n      try { this.assertAccount(); } catch (error) { toast(error.message); return; }\n      this.pausedMs += Date.now() - this.pausedAt;\n      this.paused = false;\n      runtime.rateController?.releaseHold();\n      setProgress({ phase: this.resumePhase, status: `Resuming ${this.resumePhase}...` });\n    }\n    async check() {\n      this.assertAccount();\n      while (this.paused && !this.cancelled) {\n        await sleep(250);\n        this.assertAccount();\n      }\n      this.assertAccount();\n    }\n    async wait(ms) {\n      const deadline = Date.now() + Math.max(0, ms);\n      do {\n        await this.check();\n        const remaining = deadline - Date.now();\n        if (remaining <= 0) return;\n        await sleep(Math.min(remaining, 250));\n      } while (true);\n    }\n  }\n\n  class RateLane {\n    constructor(kind, saved = {}) {\n      this.kind = kind;\n      this.delay = Math.max(pacingFloor(kind), pacingNumber(saved.delay) ?? 0);\n      this.blocked = pacingNumber(saved.blocked) ?? 0;\n      this.nextAt = pacingNumber(saved.nextAt) ?? 0;\n      this.resetAt = pacingNumber(saved.resetAt) ?? 0;\n      this.headerDelay = pacingNumber(saved.headerDelay) ?? 0;\n      this.lastLimited = pacingNumber(saved.lastLimited) ?? 0;\n      this.good = 0;\n      this.updatedAt = Date.now();\n    }\n    effectiveDelay(now = Date.now()) {\n      return Math.max(this.delay, now < this.resetAt ? this.headerDelay : 0);\n    }\n    observe(response, now = Date.now()) {\n      const remaining = pacingNumber(responseHeader(response, \"X-RateLimit-Remaining\"));\n      const window = pacingWindow(response, now);\n      if (remaining == null || window == null) return false;\n      this.resetAt = now + window;\n      this.headerDelay = remaining > 0 ? Math.min(window + PACING_BUFFER, Math.ceil(window / remaining / 0.8)) : 0;\n      if (remaining === 0) this.blocked = Math.max(this.blocked, now + window + PACING_BUFFER);\n      this.updatedAt = now;\n      return true;\n    }\n    success(headersAvailable, now = Date.now()) {\n      if (headersAvailable && now - this.lastLimited >= 600000 && ++this.good >= 120) {\n        this.delay = Math.max(pacingFloor(this.kind), Math.ceil(this.delay * 0.95));\n        this.good = 0;\n      }\n    }\n    limited(ms, now = Date.now()) {\n      this.good = 0;\n      this.lastLimited = now;\n      this.delay = Math.min(30000, Math.max(this.delay + 250, Math.ceil(this.delay * 1.5)));\n      this.blocked = Math.max(this.blocked, now + ms + PACING_BUFFER);\n      this.updatedAt = now;\n    }\n  }\n\n  class PurgeMetrics {\n    constructor(rate) {\n      this.rate = rate;\n      this.startedAt = Date.now();\n      this.finishedAt = 0;\n      this.requests = [];\n      this.deletions = [];\n      this.responses = {};\n      this.routes = {};\n      this.limitEvents = [];\n      this.rateLimits = 0;\n      this.headersSeen = 0;\n      this.requestCount = 0;\n      this.networkMs = {};\n      this.pacingMs = {};\n      this.observedLimits = {};\n      this.inFlightAt = 0;\n      this.inFlightOperation = \"\";\n      this.pending = null;\n      this.workTotal = 0;\n      this.workDone = 0;\n      this.workActive = false;\n      this.waitUntil = 0;\n      this.waitKind = \"\";\n      this.waitStarted = 0;\n      this.waitTotals = { pacing: 0, cooldown: 0, indexing: 0 };\n      this.indexWaits = 0;\n      this.lastSavedAt = 0;\n      this.lastSavedLimits = 0;\n    }\n    request(operation) {\n      const now = Date.now();\n      this.requests.push(now);\n      this.requests = this.requests.filter(time => time > now - 3600000);\n      this.requestCount++;\n      this.routes[operation] = (this.routes[operation] ?? 0) + 1;\n      this.inFlightAt = now;\n      this.inFlightOperation = operation;\n    }\n    response(operation, status, duration, response) {\n      this.inFlightAt = 0;\n      this.responses[status] = (this.responses[status] ?? 0) + 1;\n      if (status >= 200 && status < 300) {\n        this.networkMs[operation] = this.networkMs[operation] == null ? duration : this.networkMs[operation] * 0.8 + duration * 0.2;\n      }\n      if (pacingNumber(responseHeader(response, \"X-RateLimit-Remaining\")) != null) {\n        this.headersSeen++;\n        this.observedLimits[operation] = {\n          limit: pacingNumber(responseHeader(response, \"X-RateLimit-Limit\")),\n          remaining: pacingNumber(responseHeader(response, \"X-RateLimit-Remaining\")),\n          reset_after_s: pacingNumber(responseHeader(response, \"X-RateLimit-Reset-After\")),\n        };\n      }\n    }\n    observePace(operation, delay) {\n      this.pacingMs[operation] = this.pacingMs[operation] == null ? delay : this.pacingMs[operation] * 0.9 + delay * 0.1;\n    }\n    limit(operation, scope, ms, response, delay) {\n      this.rateLimits++;\n      this.limitEvents.push({\n        elapsed_s: Math.round((Date.now() - this.startedAt) / 1000), operation, scope,\n        retry_after_s: ms / 1000, pacing_ms: delay,\n        limit: pacingNumber(responseHeader(response, \"X-RateLimit-Limit\")),\n        remaining: pacingNumber(responseHeader(response, \"X-RateLimit-Remaining\")),\n        reset_after_s: pacingNumber(responseHeader(response, \"X-RateLimit-Reset-After\")),\n      });\n      this.limitEvents = this.limitEvents.slice(-30);\n    }\n    beginWait(kind, until) {\n      this.endWait();\n      this.waitKind = kind;\n      this.waitUntil = until;\n      this.waitStarted = Date.now();\n    }\n    endWait() {\n      if (this.waitStarted && this.waitKind in this.waitTotals) {\n        this.waitTotals[this.waitKind] += Math.max(0, Math.min(Date.now(), this.waitUntil) - this.waitStarted);\n      }\n      this.waitStarted = 0;\n      this.waitUntil = 0;\n      this.waitKind = \"\";\n    }\n    messagePlan(messages, target) {\n      const plan = { delete: 0, \"bulk-delete\": 0, reaction: 0 };\n      const groups = new Map();\n      for (const message of messages) {\n        if (target.strictOrder !== true && message.moderation && isBulkRecent(message.messageId)) {\n          groups.set(message.channelId, (groups.get(message.channelId) ?? 0) + 1);\n        } else plan.delete++;\n      }\n      for (const size of groups.values()) {\n        plan[\"bulk-delete\"] += Math.floor(size / BULK_MAX);\n        const remainder = size % BULK_MAX;\n        if (remainder === 1) plan.delete++;\n        else if (remainder > 1) plan[\"bulk-delete\"]++;\n      }\n      return plan;\n    }\n    beginWork(found, target, verify) {\n      this.pending = this.messagePlan(found.messages, target);\n      this.pending.reaction = found.reactions.length;\n      this.workTotal = found.messages.length + found.reactions.length;\n      this.workDone = 0;\n      this.workActive = true;\n      this.verificationWork = !!verify;\n      notify();\n    }\n    finishTask(operation, units, deleted = false) {\n      if (this.pending) this.pending[operation] = Math.max(0, (this.pending[operation] ?? 0) - 1);\n      this.workDone += units;\n      if (deleted) this.deletions.push({ time: Date.now(), units });\n      this.deletions = this.deletions.filter(item => item.time > Date.now() - 60000);\n    }\n    skipMessages(messages, target) {\n      const plan = this.messagePlan(messages, target);\n      if (this.pending) for (const key of Object.keys(plan)) this.pending[key] = Math.max(0, this.pending[key] - plan[key]);\n      this.workDone += messages.length;\n    }\n    fallbackBatch(size) {\n      if (!this.pending) return;\n      this.pending[\"bulk-delete\"] = Math.max(0, this.pending[\"bulk-delete\"] - 1);\n      this.pending.delete += size;\n    }\n    endWork() { this.workActive = false; this.pending = null; notify(); }\n    eta(now = Date.now()) {\n      if (!this.workActive || !this.pending) return null;\n      let ms = 0;\n      for (const [operation, count] of Object.entries(this.pending)) {\n        ms += count * (this.rate.operationDelay(operation) + (this.networkMs[operation] ?? 0));\n      }\n      const cooldown = Math.max(this.rate.globalUntil, this.rate.activeLane?.blocked ?? 0, this.waitKind === \"cooldown\" ? this.waitUntil : 0);\n      const overdueResponse = this.inFlightAt ? Math.max(0, now - this.inFlightAt - (this.networkMs[this.inFlightOperation] ?? 0)) : 0;\n      return Math.ceil(ms + Math.max(0, cooldown - now) + overdueResponse);\n    }\n    report() {\n      const now = this.finishedAt || Date.now();\n      const requestCountSince = ms => this.requests.filter(time => time > now - ms).length;\n      const deletedLastMinute = this.deletions.filter(item => item.time > now - 60000).reduce((sum, item) => sum + item.units, 0);\n      return {\n        plugin_version: PLUGIN_VERSION, report_version: 1, phase: progress.phase,\n        elapsed_s: Math.round((now - this.startedAt) / 1000),\n        requests: this.requestCount,\n        requests_last_1s: requestCountSince(1000), requests_last_60s: requestCountSince(60000), requests_last_3600s: requestCountSince(3600000),\n        responses: { ...this.responses }, operations: { ...this.routes }, rate_limits: this.rateLimits,\n        observed_limits: clone(this.observedLimits),\n        average_response_ms: Object.fromEntries(Object.entries(this.networkMs).map(([key, ms]) => [key, Math.round(ms)])),\n        in_flight_s: this.inFlightAt ? Math.round((now - this.inFlightAt) / 1000) : 0,\n        responses_with_rate_headers: this.headersSeen, search_index_waits: this.indexWaits,\n        wait_seconds: Object.fromEntries(Object.entries(this.waitTotals).map(([key, ms]) => [key, Math.round(ms / 1000)])),\n        messages_deleted: progress.messagesDeleted, reactions_removed: progress.reactionsRemoved,\n        deleted_last_60s: deletedLastMinute, skipped: progress.skipped, failed: progress.failed,\n        pages: progress.pages, messages_examined: progress.scanned, permission_skips: progress.permissionSkipped,\n        current_target_total: this.workTotal, current_target_processed: this.workDone,\n        cleanup_eta_s: this.eta(now) == null ? null : Math.ceil(this.eta(now) / 1000),\n        current_pacing_ms: Math.ceil(this.rate.activeLane?.effectiveDelay(now) ?? pacingFloor(\"modify\")),\n        wait_reason: this.waitKind || null, cooldown_remaining_s: Math.ceil(Math.max(0, this.rate.globalUntil - now, (this.rate.activeLane?.blocked ?? 0) - now) / 1000),\n        recent_limits: this.limitEvents.map(event => ({ ...event })),\n      };\n    }\n    saveReport() {\n      if (purgeAccountId() === this.rate.accountId) {\n        const reports = { ...(storage.shiggyPurgeTestReports ?? {}) };\n        reports[this.rate.accountId] = this.report();\n        storage.shiggyPurgeTestReports = reports;\n        this.lastSavedAt = Date.now();\n        this.lastSavedLimits = this.rateLimits;\n      }\n    }\n    finish() {\n      this.endWait();\n      this.finishedAt = Date.now();\n      this.rate.persist();\n      this.saveReport();\n    }\n  }\n\n  class RateController {\n    constructor(control) {\n      this.control = control;\n      this.accountId = control.accountId;\n      const state = storage.shiggyPurgePacing?.[this.accountId];\n      const saved = state?.version === PACING_VERSION ? state : {};\n      this.lanes = new Map();\n      this.aliases = new Map();\n      for (const [key, value] of Object.entries(saved.lanes ?? {})) {\n        if (value?.updatedAt > Date.now() - PACING_DAY || value?.blocked > Date.now() || value?.nextAt > Date.now()) {\n          this.lanes.set(key, new RateLane(value.kind === \"read\" ? \"read\" : \"modify\", value));\n        }\n      }\n      for (const [key, value] of Object.entries(saved.aliases ?? {})) if (this.lanes.has(value)) this.aliases.set(key, value);\n      this.globalUntil = pacingNumber(saved.globalUntil) ?? 0;\n      this.accountNextAt = pacingNumber(saved.accountNextAt) ?? 0;\n      this.limitTimes = Array.isArray(saved.limitTimes) ? saved.limitTimes.filter(time => Number.isFinite(time) && time > Date.now() - 600000) : [];\n      this.holdReason = typeof saved.holdReason === \"string\" ? saved.holdReason : \"\";\n      this.activeLane = null;\n      this.operationLanes = new Map();\n      this.serial = Promise.resolve();\n      this.metrics = new PurgeMetrics(this);\n      if (this.holdReason) control.pause(this.holdReason);\n    }\n    lane(identity, kind) {\n      const key = this.aliases.get(identity.key) ?? identity.key;\n      if (!this.lanes.has(key)) this.lanes.set(key, new RateLane(kind));\n      const lane = this.lanes.get(key);\n      this.operationLanes.set(identity.operation, lane);\n      return lane;\n    }\n    bind(identity, kind, response, lane) {\n      const bucket = responseHeader(response, \"X-RateLimit-Bucket\");\n      if (!bucket) return lane;\n      const key = `bucket:${String(bucket)}:${identity.major}`;\n      const previousKey = this.aliases.get(identity.key);\n      const shared = this.lanes.get(key);\n      if (!shared && previousKey && previousKey !== key) lane = new RateLane(kind, { delay: lane.delay });\n      if (shared && shared !== lane) {\n        shared.delay = Math.max(shared.delay, lane.delay);\n        shared.blocked = Math.max(shared.blocked, lane.blocked);\n        shared.nextAt = Math.max(shared.nextAt, lane.nextAt);\n        shared.lastLimited = Math.max(shared.lastLimited, lane.lastLimited);\n        lane = shared;\n      }\n      this.lanes.set(key, lane);\n      if (kind === \"modify\") { lane.kind = kind; lane.delay = Math.max(lane.delay, pacingFloor(kind)); }\n      this.aliases.set(identity.key, key);\n      this.operationLanes.set(identity.operation, lane);\n      return lane;\n    }\n    operationDelay(operation) {\n      return Math.max(this.operationLanes.get(operation)?.effectiveDelay() ?? pacingFloor(\"modify\"), this.metrics.pacingMs[operation] ?? 0);\n    }\n    persist() {\n      const all = { ...(storage.shiggyPurgePacing ?? {}) };\n      all[this.accountId] = {\n        version: PACING_VERSION, updatedAt: Date.now(), globalUntil: this.globalUntil,\n        accountNextAt: this.accountNextAt, holdReason: this.holdReason, limitTimes: this.limitTimes,\n        aliases: Object.fromEntries(this.aliases), lanes: Object.fromEntries(this.lanes),\n      };\n      storage.shiggyPurgePacing = clone(all);\n      if (this.metrics && (Date.now() - this.metrics.lastSavedAt >= 30000 || this.control.paused || this.metrics.lastSavedLimits !== this.metrics.rateLimits)) this.metrics.saveReport();\n    }\n    releaseHold() {\n      this.holdReason = \"\";\n      this.longWaitAcknowledged = Math.max(this.globalUntil, ...[...this.lanes.values()].map(lane => lane.blocked));\n      this.persist();\n    }\n    hold(reason) { this.holdReason = reason; this.control.pause(reason); this.persist(); }\n    run(key, kind, fn, url) {\n      const pending = this.serial.then(() => this.runRequest(key, kind, fn, url));\n      this.serial = pending.catch(() => {});\n      return pending;\n    }\n    async runRequest(key, kind, fn, url) {\n      const identity = pacingIdentity(key, kind, url);\n      let lane = this.lane(identity, kind);\n      for (;;) {\n        await this.control.check();\n        this.activeLane = lane;\n        const now = Date.now();\n        const blockedUntil = Math.max(lane.blocked, this.globalUntil);\n        const deadline = Math.max(this.accountNextAt, lane.nextAt, blockedUntil);\n        if (deadline > now) {\n          const reason = blockedUntil > now ? \"cooldown\" : \"pacing\";\n          this.metrics.beginWait(reason, deadline);\n          setProgress({ waitMs: deadline - now });\n          if (blockedUntil - now >= PACING_LONG_WAIT && !this.control.paused && blockedUntil > (this.longWaitAcknowledged ?? 0)) {\n            this.longWaitAcknowledged = blockedUntil;\n            this.hold(`Long Discord cooldown. Paused; requests can resume after ${new Date(blockedUntil).toLocaleTimeString()}.`);\n          }\n          await this.control.wait(deadline - now);\n          this.metrics.endWait();\n          continue;\n        }\n        this.control.assertAccount();\n        this.metrics.endWait();\n        setProgress({ waitMs: 0 });\n        const requestStart = Date.now();\n        this.metrics.request(identity.operation);\n        let response;\n        try {\n          response = await fn();\n          const status = Number(response?.status ?? 200);\n          if (status >= 400) throw response;\n        } catch (error) {\n          const status = Number(error?.status ?? error?.response?.status ?? 0);\n          this.metrics.response(identity.operation, status, Date.now() - requestStart, error);\n          lane = this.bind(identity, kind, error, lane);\n          this.activeLane = lane;\n          lane.observe(error);\n          this.accountNextAt = Date.now() + pacingFloor(kind);\n          if (status === 401 || status === 403) {\n            this.control.failure = pacingStop(status === 401\n              ? \"Discord authentication failed; stopped and kept the resume checkpoint\"\n              : \"Discord denied permission; stopped and kept the resume checkpoint\");\n            this.persist();\n            throw this.control.failure;\n          }\n          if (status !== 429) { this.persist(); throw error; }\n          const ms = pacingRetry(error);\n          const body = error?.body ?? error?.response?.body;\n          const rawScope = String(responseHeader(error, \"X-RateLimit-Scope\") ?? \"\").toLowerCase();\n          const global = body?.global === true || error?.global === true || rawScope === \"global\" || String(responseHeader(error, \"X-RateLimit-Global\")).toLowerCase() === \"true\";\n          const scope = global ? \"global\" : rawScope === \"shared\" ? \"shared\" : \"route\";\n          lane.limited(ms);\n          if (global) this.globalUntil = Math.max(this.globalUntil, Date.now() + ms + PACING_BUFFER);\n          this.metrics.limit(identity.operation, scope, ms, error, lane.delay);\n          this.limitTimes = this.limitTimes.filter(time => time > Date.now() - 600000);\n          this.limitTimes.push(Date.now());\n          this.persist();\n          setProgress({ status: `Discord ${scope} cooldown; waiting ${pacingDuration(ms)}.`, waitMs: ms });\n          if (this.limitTimes.length >= 3) this.hold(\"Repeated Discord rate limits. Paused with progress saved; copy the test report before resuming.\");\n          continue;\n        }\n        this.metrics.response(identity.operation, Number(response?.status ?? 200), Date.now() - requestStart, response);\n        lane = this.bind(identity, kind, response, lane);\n        this.activeLane = lane;\n        const headersAvailable = lane.observe(response);\n        lane.success(headersAvailable);\n        this.metrics.observePace(identity.operation, lane.effectiveDelay());\n        lane.nextAt = Date.now() + lane.effectiveDelay();\n        this.accountNextAt = Date.now() + pacingFloor(kind);\n        this.persist();\n        this.control.assertAccount();\n        return response;\n      }\n    }\n    async indexing(ms) {\n      const wait = Number.isFinite(ms) && ms >= 0 ? ms : 1000;\n      this.metrics.indexWaits++;\n      this.metrics.beginWait(\"indexing\", Date.now() + wait);\n      setProgress({ waitMs: wait, status: \"Waiting for Discord search index...\" });\n      await this.control.wait(wait);\n      this.metrics.endWait();\n    }\n  }\n\n  function copyPurgeTestReport() {\n    const accountId = purgeAccountId();\n    const rate = runtime.rateController;\n    const report = rate?.accountId === accountId ? rate.metrics.report() : storage.shiggyPurgeTestReports?.[accountId];\n    if (!report) { toast(\"Run a preview or purge to collect a test report\"); return; }\n    const clipboard = V.metro.common?.clipboard ?? find(\"setString\", \"getString\") ?? RN.Clipboard;\n    if (!clipboard?.setString) { toast(\"Clipboard unavailable; take a screenshot of the pacing panel\"); return; }\n    try {\n      Promise.resolve(clipboard.setString(JSON.stringify(report, null, 2)))\n        .then(() => toast(\"Purge test report copied. No message content or account identifiers included.\"))\n        .catch(() => toast(\"Could not copy the test report\"));\n    } catch { toast(\"Could not copy the test report\"); }\n  }\n  function PacingStatus() {\n    const [, tick] = React.useReducer(value => value + 1, 0);\n    const rate = runtime.rateController;\n    const live = !!runtime.control;\n    React.useEffect(() => {\n      if (!live) return;\n      const timer = setInterval(() => tick(), 1000);\n      return () => clearInterval(timer);\n    }, [live]);\n    if (!rate || rate.accountId !== purgeAccountId()) return null;\n    const metrics = rate.metrics;\n    const now = metrics.finishedAt || Date.now();\n    const report = metrics.report();\n    const eta = metrics.eta(now);\n    const waiting = Math.max(0, metrics.waitUntil - now);\n    const estimate = progress.phase === \"paused\" ? \"Paused\" : !live && [\"error\", \"cancelled\"].includes(progress.phase) ? \"Stopped — resume required\" : eta == null\n      ? [\"discovering\", \"verifying\"].includes(progress.phase) ? \"Calculating — discovery in progress\" : live ? \"Calculating…\" : \"Finished\"\n      : pacingDuration(eta);\n    return React.createElement(Card, { style: { marginTop: 8, borderColor: C.brand } },\n      React.createElement(Txt, { style: { fontWeight: \"800\", fontSize: 16 } }, `Current target cleanup ETA: ${estimate}`),\n      eta != null && live && !rate.control.paused ? React.createElement(Txt, { style: { color: C.muted } }, `Estimated finish: ${new Date(now + eta).toLocaleTimeString()}`) : null,\n      React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, \"Estimate covers queued cleanup for this target. Discovery, later targets, and additional verification are extra.\"),\n      metrics.workActive ? React.createElement(Txt, null, `Processed: ${metrics.workDone}/${metrics.workTotal} queued actions`) : null,\n      React.createElement(Txt, null, `Deleted in last minute: ${report.deleted_last_60s} · Elapsed: ${pacingDuration(now - metrics.startedAt)}`),\n      React.createElement(Txt, null, `Requests: ${report.requests_last_1s}/last second · ${report.requests_last_60s}/last minute · ${report.requests_last_3600s}/last hour`),\n      React.createElement(Txt, null, `Rate limits observed: ${report.rate_limits} · Search-index waits: ${report.search_index_waits}`),\n      React.createElement(Txt, null, `Current request spacing: ${(report.current_pacing_ms / 1000).toFixed(2)}s`),\n      waiting ? React.createElement(Txt, null, `${metrics.waitKind === \"cooldown\" ? \"Discord cooldown\" : metrics.waitKind === \"indexing\" ? \"Search indexing\" : \"Preventive pacing\"}: ${pacingDuration(waiting)} remaining`) : null,\n      waiting && metrics.waitKind === \"cooldown\" ? React.createElement(Txt, null, `Earliest request: ${new Date(metrics.waitUntil).toLocaleTimeString()}`) : null,\n      report.in_flight_s >= 5 ? React.createElement(Txt, null, `Waiting for Discord response: ${report.in_flight_s}s`) : null,\n      React.createElement(Txt, { style: { color: C.muted, fontSize: 12 } }, report.responses_with_rate_headers ? \"Pacing follows available Discord headers with headroom.\" : \"No rate headers observed yet; using conservative pacing.\"),\n      React.createElement(Row, null, React.createElement(Button, { text: \"Copy test report\", small: true, onPress: copyPurgeTestReport })),\n    );\n  }";

  function patchPacing(source) {
    let out = source;
    const exact = (before, after, label) => {
      if (out.split(before).length !== 2) throw new Error(`Could not patch Purge Tools ${label}`);
      out = out.replace(before, after);
    };
    out = replaceBlock(out, "  class Control {", "  function find(...props)", PACING_RUNTIME_SOURCE + "\n\n", "pacing runtime");
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
      'const PLUGIN_VERSION = "1.1.7-shiggy";',
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
