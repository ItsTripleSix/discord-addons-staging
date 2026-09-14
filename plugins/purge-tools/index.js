(() => {
  "use strict";

  const V = vendetta;
  if (!V?.metro || !V?.patcher) return {};

  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const CORE_URL = "https://raw.githubusercontent.com/ItsTripleSix/revenge-plugins/main/plugins/purge-tools/index.js";

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
      .split(/[\\\s,;]+/)
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

  function portSource(source) {
    let out = String(source);

    out = out.replace(
      "const V = globalThis.vendetta;",
      "const V = vendetta;",
    );

    out = out.replace(
      'const PLUGIN_VERSION = "1.1.1";',
      'const PLUGIN_VERSION = "1.1.4-shiggy";',
    );

    out = patchMediaFiltering(out);

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

  function hasInterruptedAutoResume() {
    try {
      return storage.autoResumeInterrupted === true && !!storage.activePurgeJob;
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
