(() => {
  "use strict";

  const V = vendetta;
  const B = globalThis.bunny;
  if (!V?.metro?.common || !V?.plugins) return {};

  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const SELF_ID = String(V.plugin?.id ?? "");
  const VERSION = "1.0.4-shiggy";
  const SECTION = "ShiggyCord";
  const KEY_PREFIX = "ITS666_SETTINGS_PIN_";
  const STATE_VERSION = 1;

  const rootNavigation = B?.metro?.findByPropsLazy?.("getRootNavigationRef") ?? null;

  const C = {
    bg: "#111214",
    card: "#1e1f22",
    text: "#f2f3f5",
    muted: "#b5bac1",
    border: "#3f4147",
  };

  function toast(text) {
    try { V.ui?.toasts?.showToast?.(String(text)); } catch {}
  }

  function allPlugins() {
    try { return V.plugins?.plugins ?? {}; }
    catch { return {}; }
  }

  function hashId(id) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).toUpperCase();
  }

  function pinRowKey(id) {
    return `${KEY_PREFIX}${hashId(id)}`;
  }

  function pinStorageKey(id) {
    return `pin_${hashId(id)}`;
  }

  function ensurePinState() {
    if (storage.pinStateVersion === STATE_VERSION) return;

    const legacy = Array.isArray(storage.pinnedIds)
      ? new Set(storage.pinnedIds.map(String))
      : null;
    const defaults = new Set(["Account Switcher", "Purge Tools"]);

    for (const plugin of Object.values(allPlugins())) {
      if (!plugin?.id) continue;
      const id = String(plugin.id);
      const key = pinStorageKey(id);
      if (storage[key] != null) continue;

      const enabled = legacy
        ? legacy.has(id)
        : defaults.has(String(plugin?.manifest?.name ?? ""));
      storage[key] = enabled;
    }

    storage.pinStateVersion = STATE_VERSION;
  }

  function isPinned(id) {
    return storage[pinStorageKey(id)] === true;
  }

  function setPinned(id, value) {
    storage[pinStorageKey(id)] = !!value;
  }

  function currentPins() {
    return Object.values(allPlugins())
      .filter(plugin => plugin?.id && isPinned(String(plugin.id)))
      .map(plugin => String(plugin.id));
  }

  function shiggyRows() {
    try {
      const rows = B?.ui?.settings?.registeredSections?.[SECTION];
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null;
    }
  }

  function removeOurRows(rows) {
    if (!Array.isArray(rows)) return;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i]?.key ?? "").startsWith(KEY_PREFIX)) rows.splice(i, 1);
    }
  }

  function iconFor(plugin) {
    const requested = plugin?.manifest?.vendetta?.icon;
    for (const name of [requested, "PuzzlePieceIcon"]) {
      if (!name) continue;
      try {
        const id = V.ui?.assets?.getAssetIDByName?.(name);
        if (id != null) return id;
      } catch {}
    }
    return undefined;
  }

  function openPinnedPlugin(id) {
    const plugin = allPlugins()[id];
    if (!plugin) {
      toast("That pinned plugin is no longer installed.");
      return;
    }
    if (!plugin.enabled) {
      toast(`Enable ${plugin.manifest?.name ?? "that plugin"} first.`);
      return;
    }

    const Component = V.plugins?.getSettings?.(id);
    if (typeof Component !== "function") {
      toast(`${plugin.manifest?.name ?? "That plugin"} has no available settings page.`);
      return;
    }

    try {
      let navigation = rootNavigation?.getRootNavigationRef?.();
      if (!navigation?.navigate) {
        navigation = V.metro?.findByProps?.("getRootNavigationRef")?.getRootNavigationRef?.();
      }
      if (!navigation?.navigate) throw new Error("Navigation unavailable");

      navigation.navigate("BUNNY_CUSTOM_PAGE", {
        title: String(plugin.manifest?.name ?? "Plugin Settings"),
        render: () => React.createElement(Component),
      });
    } catch (error) {
      toast(`Could not open plugin settings: ${error?.message ?? error}`);
    }
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
        try { return typeof V.plugins?.getSettings?.(id) === "function"; }
        catch { return false; }
      },
    };
  }

  function syncPins() {
    ensurePinState();
    const rows = shiggyRows();
    if (!rows) return false;

    removeOurRows(rows);
    const pinRows = currentPins().map(makePinRow).filter(Boolean);
    if (!pinRows.length) return true;

    const pluginsIndex = rows.findIndex(row => row?.key === "BUNNY_PLUGINS");
    const insertAt = pluginsIndex >= 0 ? pluginsIndex + 1 : rows.length;
    rows.splice(insertAt, 0, ...pinRows);
    return true;
  }

  function Settings() {
    ensurePinState();
    const [, forceUpdate] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => () => {
      syncPins();
    }, []);

    const plugins = Object.values(allPlugins())
      .filter(plugin => plugin?.id && plugin?.manifest?.name)
      .sort((a, b) => String(a.manifest.name).localeCompare(String(b.manifest.name)));

    return React.createElement(
      RN.ScrollView,
      { contentContainerStyle: { padding: 16, paddingBottom: 40 } },
      React.createElement(RN.Text, {
        style: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 8 },
      }, "Settings Pins"),
      React.createElement(RN.Text, {
        style: { color: C.muted, fontSize: 13, lineHeight: 18, marginBottom: 14 },
      }, "Choose which plugin settings appear directly in ShiggyCord. Changes save immediately; reopen Settings to refresh the main list."),
      ...plugins.map(plugin => {
        const id = String(plugin.id);
        const pinned = isPinned(id);
        const enabled = plugin.enabled === true;
        let settingsAvailable = false;
        try { settingsAvailable = typeof V.plugins?.getSettings?.(id) === "function"; } catch {}

        return React.createElement(RN.View, {
          key: id,
          style: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 14,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
          },
        },
        React.createElement(RN.View, { style: { flex: 1, paddingRight: 16 } },
          React.createElement(RN.Text, {
            style: { color: C.text, fontSize: 16, fontWeight: "600", marginBottom: 3 },
          }, String(plugin.manifest.name)),
          React.createElement(RN.Text, {
            style: { color: C.muted, fontSize: 12, lineHeight: 17 },
          }, id === SELF_ID
            ? "Settings Pins manager"
            : enabled && settingsAvailable
              ? "Settings available"
              : enabled
                ? "No settings page detected"
                : "Disabled — pin appears when enabled"),
        ),
        React.createElement(RN.Switch, {
          value: pinned,
          onValueChange(value) {
            setPinned(id, value);
            forceUpdate();
            toast(`${plugin.manifest.name}: ${value ? "pinned" : "unpinned"}`);
          },
        }));
      }),
      React.createElement(RN.Text, {
        style: { color: C.muted, fontSize: 12, marginTop: 14 },
      }, `v${VERSION}`),
    );
  }

  return {
    onLoad() {
      ensurePinState();
      syncPins();
    },
    onUnload() {
      removeOurRows(shiggyRows());
    },
    settings: Settings,
  };
})()