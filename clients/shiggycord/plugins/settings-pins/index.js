(() => {
  "use strict";

  const V = vendetta;
  const B = globalThis.bunny;
  if (!V?.metro?.common || !V?.plugins) return {};

  const { React, ReactNative: RN } = V.metro.common;
  const storage = V.plugin?.storage ?? {};
  const SELF_ID = String(V.plugin?.id ?? "");
  const VERSION = "1.0.0-shiggy";
  const SECTION = "ShiggyCord";
  const KEY_PREFIX = "ITS666_SETTINGS_PIN_";

  // Shiggy's own lazy Metro finder. Merely creating this proxy does not scan or
  // load Discord modules; it resolves only if a pinned row is actually pressed.
  const rootNavigation = B?.metro?.findByPropsLazy?.("getRootNavigationRef") ?? null;

  const C = {
    bg: "#111214",
    card: "#1e1f22",
    text: "#f2f3f5",
    muted: "#b5bac1",
    brand: "#5865f2",
    border: "#3f4147",
  };

  function toast(text) {
    try { V.ui?.toasts?.showToast?.(String(text)); } catch {}
  }

  function allPlugins() {
    try { return V.plugins?.plugins ?? {}; }
    catch { return {}; }
  }

  function currentPins() {
    const raw = storage.pinnedIds;
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map(String).filter(Boolean))];
  }

  function initializeDefaults() {
    if (Array.isArray(storage.pinnedIds)) return;

    // Preserve the two shortcuts that existed before this central pin manager.
    // This runs only on first install; after that the user's choices are kept.
    const wanted = new Set(["Account Switcher", "Purge Tools"]);
    const defaults = Object.values(allPlugins())
      .filter(plugin => wanted.has(String(plugin?.manifest?.name ?? "")))
      .map(plugin => String(plugin?.id ?? ""))
      .filter(Boolean);

    storage.pinnedIds = defaults;
  }

  function setPins(ids) {
    storage.pinnedIds = [...new Set(ids.map(String).filter(Boolean))];
  }

  function pinKey(id) {
    // Small deterministic FNV-1a key. Avoids putting long raw URLs into Discord's
    // setting IDs while remaining stable across restarts.
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${KEY_PREFIX}${(hash >>> 0).toString(36).toUpperCase()}`;
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
        // Fallback is only allowed on an explicit tap, never during startup.
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
      key: pinKey(id),
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
    const rows = shiggyRows();
    if (!rows) return false;

    // Never replace Shiggy's section object and never patch Discord's settings
    // renderer. Mutate only our own rows in Shiggy's exported section registry.
    removeOurRows(rows);

    const pinRows = currentPins().map(makePinRow).filter(Boolean);
    if (!pinRows.length) return true;

    const pluginsIndex = rows.findIndex(row => row?.key === "BUNNY_PLUGINS");
    const insertAt = pluginsIndex >= 0 ? pluginsIndex + 1 : rows.length;
    rows.splice(insertAt, 0, ...pinRows);
    return true;
  }

  function setPinned(id, value) {
    const pins = currentPins();
    const has = pins.includes(id);
    if (value && !has) pins.push(id);
    if (!value && has) pins.splice(pins.indexOf(id), 1);
    setPins(pins);
    syncPins();
  }

  function Settings() {
    const [, refresh] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => {
      initializeDefaults();
      syncPins();
      refresh();
    }, []);

    const pins = currentPins();
    const plugins = Object.values(allPlugins())
      .filter(plugin => plugin?.id && plugin?.manifest?.name)
      .sort((a, b) => String(a.manifest.name).localeCompare(String(b.manifest.name)));

    const children = [
      React.createElement(RN.View, {
        key: "intro",
        style: { backgroundColor: C.card, padding: 14, borderRadius: 12 },
      }, [
        React.createElement(RN.Text, {
          key: "title",
          style: { color: C.text, fontSize: 18, fontWeight: "700" },
        }, "Settings Pins"),
        React.createElement(RN.Text, {
          key: "desc",
          style: { color: C.muted, marginTop: 6, fontSize: 12, lineHeight: 17 },
        }, "Choose which installed plugins appear directly in ShiggyCord settings. Pins use ShiggyCord's own settings registry—no createList patch, renderer monkey-patch, Metro polling, or plugin-specific shortcut code."),
        React.createElement(RN.Text, {
          key: "refresh-note",
          style: { color: C.muted, marginTop: 6, fontSize: 12, lineHeight: 17 },
        }, "After changing pins, back out of Settings and reopen it if the main list was already on screen."),
      ]),
    ];

    for (const plugin of plugins) {
      const id = String(plugin.id);
      const enabled = plugin.enabled === true;
      const pinned = pins.includes(id);
      let settingsAvailable = false;
      try { settingsAvailable = typeof V.plugins?.getSettings?.(id) === "function"; } catch {}

      children.push(React.createElement(RN.View, {
        key: id,
        style: {
          backgroundColor: C.card,
          paddingHorizontal: 14,
          paddingVertical: 11,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: C.border,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        },
      }, [
        React.createElement(RN.View, {
          key: "text",
          style: { flex: 1 },
        }, [
          React.createElement(RN.Text, {
            key: "name",
            style: { color: C.text, fontSize: 15, fontWeight: "700" },
          }, String(plugin.manifest.name)),
          React.createElement(RN.Text, {
            key: "state",
            style: { color: C.muted, fontSize: 12, marginTop: 2 },
          }, id === SELF_ID
            ? "Settings Pins manager"
            : enabled && settingsAvailable
              ? "Settings available"
              : enabled
                ? "No settings page detected"
                : "Disabled — pin will appear when enabled"),
        ]),
        React.createElement(RN.Switch, {
          key: "toggle",
          value: pinned,
          onValueChange: value => {
            setPinned(id, value);
            refresh();
          },
        }),
      ]));
    }

    if (!plugins.length) {
      children.push(React.createElement(RN.Text, {
        key: "empty",
        style: { color: C.muted, fontSize: 13 },
      }, "No installed plugins were found."));
    }

    children.push(React.createElement(RN.Text, {
      key: "version",
      style: { color: C.muted, fontSize: 12, marginTop: 4 },
    }, `v${VERSION}`));

    return React.createElement(
      RN.ScrollView ?? RN.View,
      {
        style: { flex: 1, backgroundColor: C.bg },
        contentContainerStyle: { padding: 16, paddingBottom: 40, gap: 10 },
      },
      children,
    );
  }

  return {
    onLoad() {
      initializeDefaults();
      syncPins();
    },
    onUnload() {
      removeOurRows(shiggyRows());
    },
    settings: Settings,
  };
})()
