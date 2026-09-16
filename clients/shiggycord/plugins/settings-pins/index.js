(() => {
  "use strict";

  const V = vendetta;
  const B = globalThis.bunny;
  if (!V?.metro?.common || !V?.plugins) return {};

  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const SELF_ID = String(V.plugin?.id ?? "");
  const VERSION = "1.0.5-shiggy";
  const SECTION = "ShiggyCord";
  const KEY_PREFIX = "ITS666_SETTINGS_PIN_";
  const STATE_VERSION = 1;

  const rootNavigation = B?.metro?.findByPropsLazy?.("getRootNavigationRef") ?? null;
  const capturedSections = new Set();
  let unpatchCreateList = null;

  const C = { bg: "#111214", text: "#f2f3f5", muted: "#b5bac1", border: "#3f4147" };

  function toast(text) { try { V.ui?.toasts?.showToast?.(String(text)); } catch {} }
  function allPlugins() { try { return V.plugins?.plugins ?? {}; } catch { return {}; } }

  function hashId(id) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) { hash ^= id.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    return (hash >>> 0).toString(36).toUpperCase();
  }
  function pinRowKey(id) { return `${KEY_PREFIX}${hashId(id)}`; }
  function pinStorageKey(id) { return `pin_${hashId(id)}`; }

  function ensurePinState() {
    if (storage.pinStateVersion === STATE_VERSION) return;
    const legacy = Array.isArray(storage.pinnedIds) ? new Set(storage.pinnedIds.map(String)) : null;
    const defaults = new Set(["Account Switcher", "Purge Tools"]);
    for (const plugin of Object.values(allPlugins())) {
      if (!plugin?.id) continue;
      const id = String(plugin.id), key = pinStorageKey(id);
      if (storage[key] != null) continue;
      storage[key] = legacy ? legacy.has(id) : defaults.has(String(plugin?.manifest?.name ?? ""));
    }
    storage.pinStateVersion = STATE_VERSION;
  }
  function isPinned(id) { return storage[pinStorageKey(id)] === true; }
  function setPinned(id, value) { storage[pinStorageKey(id)] = !!value; }
  function currentPins() {
    return Object.values(allPlugins()).filter(p => p?.id && isPinned(String(p.id))).map(p => String(p.id));
  }

  function shiggyRows() {
    try { const rows = B?.ui?.settings?.registeredSections?.[SECTION]; return Array.isArray(rows) ? rows : null; }
    catch { return null; }
  }
  function removeOurRows(rows) {
    if (!Array.isArray(rows)) return;
    for (let i = rows.length - 1; i >= 0; i--) if (String(rows[i]?.key ?? "").startsWith(KEY_PREFIX)) rows.splice(i, 1);
  }
  function iconFor(plugin) {
    for (const name of [plugin?.manifest?.vendetta?.icon, "PuzzlePieceIcon"]) {
      if (!name) continue;
      try { const id = V.ui?.assets?.getAssetIDByName?.(name); if (id != null) return id; } catch {}
    }
  }

  function openPinnedPlugin(id) {
    const plugin = allPlugins()[id];
    if (!plugin) return toast("That pinned plugin is no longer installed.");
    if (!plugin.enabled) return toast(`Enable ${plugin.manifest?.name ?? "that plugin"} first.`);
    const Component = V.plugins?.getSettings?.(id);
    if (typeof Component !== "function") return toast(`${plugin.manifest?.name ?? "That plugin"} has no available settings page.`);
    try {
      let navigation = rootNavigation?.getRootNavigationRef?.();
      if (!navigation?.navigate) navigation = V.metro?.findByProps?.("getRootNavigationRef")?.getRootNavigationRef?.();
      if (!navigation?.navigate) throw new Error("Navigation unavailable");
      navigation.navigate("BUNNY_CUSTOM_PAGE", { title: String(plugin.manifest?.name ?? "Plugin Settings"), render: () => React.createElement(Component) });
    } catch (error) { toast(`Could not open plugin settings: ${error?.message ?? error}`); }
  }

  function makePinRow(id) {
    const plugin = allPlugins()[id];
    if (!plugin) return null;
    return {
      key: pinRowKey(id),
      title: () => String(allPlugins()[id]?.manifest?.name ?? plugin.manifest?.name ?? "Plugin"),
      icon: iconFor(plugin),
      onPress: () => openPinnedPlugin(id),
      usePredicate: () => {
        const live = allPlugins()[id];
        if (!live?.enabled) return false;
        try { return typeof V.plugins?.getSettings?.(id) === "function"; } catch { return false; }
      },
    };
  }

  function desiredKeys() { return (shiggyRows() ?? []).map(row => row.key); }
  function refreshCapturedSections() {
    const keys = desiredKeys();
    for (const section of [...capturedSections]) {
      if (!section || !Array.isArray(section.settings)) { capturedSections.delete(section); continue; }
      section.settings.splice(0, section.settings.length, ...keys);
    }
  }
  function captureSections(sections) {
    if (!Array.isArray(sections)) return;
    for (const section of sections) {
      if (section?.label === SECTION || section?.title === SECTION) capturedSections.add(section);
    }
    refreshCapturedSections();
  }
  function patchSectionRefresh() {
    try {
      const mod = V.metro?.findByProps?.("createList");
      if (!mod?.createList || !V.patcher?.after) return null;
      return V.patcher.after("createList", mod, (args) => {
        const sections = args?.[0]?.sections;
        captureSections(sections);
        setTimeout(() => captureSections(sections), 0);
      });
    } catch { return null; }
  }

  function syncPins() {
    ensurePinState();
    const rows = shiggyRows();
    if (!rows) return false;
    removeOurRows(rows);
    const pinRows = currentPins().map(makePinRow).filter(Boolean);
    if (pinRows.length) {
      const pluginsIndex = rows.findIndex(row => row?.key === "BUNNY_PLUGINS");
      rows.splice(pluginsIndex >= 0 ? pluginsIndex + 1 : rows.length, 0, ...pinRows);
    }
    refreshCapturedSections();
    return true;
  }

  function Settings() {
    ensurePinState();
    const [, forceUpdate] = React.useReducer(value => value + 1, 0);
    const plugins = Object.values(allPlugins()).filter(p => p?.id && p?.manifest?.name)
      .sort((a, b) => String(a.manifest.name).localeCompare(String(b.manifest.name)));

    return React.createElement(RN.ScrollView, { contentContainerStyle: { padding: 16, paddingBottom: 40 } },
      React.createElement(RN.Text, { style: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 8 } }, "Settings Pins"),
      React.createElement(RN.Text, { style: { color: C.muted, fontSize: 13, lineHeight: 18, marginBottom: 14 } }, "Choose which plugin settings appear directly in ShiggyCord. Changes apply when you return to the main Settings page—no ReShiggy required."),
      ...plugins.map(plugin => {
        const id = String(plugin.id), pinned = isPinned(id), enabled = plugin.enabled === true;
        let settingsAvailable = false;
        try { settingsAvailable = typeof V.plugins?.getSettings?.(id) === "function"; } catch {}
        return React.createElement(RN.View, { key: id, style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border } },
          React.createElement(RN.View, { style: { flex: 1, paddingRight: 16 } },
            React.createElement(RN.Text, { style: { color: C.text, fontSize: 16, fontWeight: "600", marginBottom: 3 } }, String(plugin.manifest.name)),
            React.createElement(RN.Text, { style: { color: C.muted, fontSize: 12, lineHeight: 17 } }, id === SELF_ID ? "Settings Pins manager" : enabled && settingsAvailable ? "Settings available" : enabled ? "No settings page detected" : "Disabled — pin appears when enabled")
          ),
          React.createElement(RN.Switch, { value: pinned, onValueChange(value) { setPinned(id, value); forceUpdate(); setTimeout(syncPins, 0); } })
        );
      }),
      React.createElement(RN.Text, { style: { color: C.muted, fontSize: 12, marginTop: 14 } }, `v${VERSION}`)
    );
  }

  return {
    onLoad() { ensurePinState(); unpatchCreateList = patchSectionRefresh(); syncPins(); },
    onUnload() { try { unpatchCreateList?.(); } catch {} unpatchCreateList = null; capturedSections.clear(); removeOurRows(shiggyRows()); },
    settings: Settings,
  };
})()