(() => {
  "use strict";

  const { after, instead } = vendetta.patcher;
  const { find, findByName, findByProps } = vendetta.metro;
  const { React, ReactNative: RN } = vendetta.metro.common;
  const { getAssetIDByName } = vendetta.ui.assets;
  const { storage } = vendetta.plugin;

  const RUNTIME_KEY = "__itsTripleSixSilentTypingRuntime";
  const DEFAULT_VISIBLE_COLOR = "#B5BAC1";
  const DEFAULT_SILENT_COLOR = "#B5BAC1";
  const DEFAULT_SLASH_COLOR = "#F23F42";
  const DEFAULT_ALPHA = 255;
  const CONFIG_VERSION = 2;

  try {
    globalThis[RUNTIME_KEY]?.cleanup?.();
  } catch {}

  const runtime = {
    patches: [],
    refreshListeners: new Set(),
    leftPatched: false,
    rightPatched: false,
    typingPatched: false,
    cleanup: null,
  };

  globalThis[RUNTIME_KEY] = runtime;

  const Typing =
    findByProps("startTyping", "stopTyping")
    ?? findByProps("startTyping");

  const Toasts =
    vendetta.ui?.toasts
    ?? findByProps("showToast");

  const ActionSheet = findByProps("openLazy", "hideActionSheet");
  const CustomColorPickerActionSheet = findByName("CustomColorPickerActionSheet");

  function clampByte(value, fallback = DEFAULT_ALPHA) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(255, parsed));
  }

  function normalizeHex(value, fallback) {
    if (typeof value !== "string") return fallback;

    let hex = value.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      hex = hex.split("").map(char => char + char).join("");
    }
    if (/^[0-9a-fA-F]{8}$/.test(hex)) hex = hex.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return fallback;

    return `#${hex.toUpperCase()}`;
  }

  function colorWithAlpha(hex, alpha) {
    const normalized = normalizeHex(hex, "#FFFFFF");
    const r = Number.parseInt(normalized.slice(1, 3), 16);
    const g = Number.parseInt(normalized.slice(3, 5), 16);
    const b = Number.parseInt(normalized.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${clampByte(alpha) / 255})`;
  }

  function migrateStorage() {
    storage.visibleKeyboardColor ??=
      storage.keyboardColor ?? DEFAULT_VISIBLE_COLOR;
    storage.visibleKeyboardAlpha ??=
      storage.keyboardAlpha ?? DEFAULT_ALPHA;
    storage.silentKeyboardColor ??=
      storage.keyboardColor ?? DEFAULT_SILENT_COLOR;
    storage.silentKeyboardAlpha ??=
      storage.keyboardAlpha ?? DEFAULT_ALPHA;
    storage.slashColor ??= DEFAULT_SLASH_COLOR;
    storage.slashAlpha ??= DEFAULT_ALPHA;
    storage.showButton ??= true;
    storage.showToast ??= true;
    storage.showSlash ??= true;
    storage.enabled ??= false;

    if ((storage.configVersion ?? 0) < CONFIG_VERSION) {
      storage.buttonSide = "left";
      storage.configVersion = CONFIG_VERSION;
    } else {
      storage.buttonSide ??= "left";
    }
  }

  function notifyRefresh() {
    for (const listener of runtime.refreshListeners) {
      try {
        listener();
      } catch {}
    }
  }

  function usePluginRefresh() {
    const [, forceRender] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => {
      runtime.refreshListeners.add(forceRender);
      return () => runtime.refreshListeners.delete(forceRender);
    }, []);

    return forceRender;
  }

  function showStateToast(enabled) {
    if (storage.showToast === false) return;

    const text = enabled
      ? "Enabled Silent Typing — You are Now Invisible"
      : "Disabled Silent Typing — You are Now Visible";

    try {
      Toasts?.showToast?.(
        text,
        getAssetIDByName("KeyboardIcon") ?? getAssetIDByName("ChatIcon"),
      );
    } catch {}
  }

  function openColorPicker(storageKey, fallback) {
    if (!ActionSheet?.openLazy || !CustomColorPickerActionSheet) return false;

    const current = normalizeHex(storage[storageKey], fallback);

    try {
      ActionSheet.openLazy(
        Promise.resolve({ default: CustomColorPickerActionSheet }),
        "ActionSheet",
        {
          color: Number.parseInt(current.slice(1), 16),
          onSelect: color => {
            const rgb = Number(color) & 0xFFFFFF;
            storage[storageKey] =
              `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;
            notifyRefresh();
          },
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  function findRenderedComponent(name) {
    try {
      const byDisplayName = find(module => module?.type?.displayName === name);
      if (byDisplayName) return byDisplayName;
    } catch {}

    try {
      return findByName(name, false) ?? findByName(name);
    } catch {
      return null;
    }
  }

  function getRenderTarget(name) {
    const component = findRenderedComponent(name);

    if (component && typeof component.default === "function") {
      return { target: component, method: "default" };
    }

    const target = component?.type ?? component;
    if (target && typeof target.render === "function") {
      return { target, method: "render" };
    }

    return null;
  }

  function getKeyboardIcon() {
    return (
      getAssetIDByName("KeyboardIcon")
      ?? getAssetIDByName("ChatIcon")
      ?? getAssetIDByName("PencilIcon")
    );
  }

  function getKeyboardColor(enabled) {
    return enabled
      ? colorWithAlpha(storage.silentKeyboardColor, storage.silentKeyboardAlpha)
      : colorWithAlpha(storage.visibleKeyboardColor, storage.visibleKeyboardAlpha);
  }

  function KeyboardGraphic({ enabled, size = 30 }) {
    return React.createElement(
      RN.View,
      {
        pointerEvents: "none",
        style: {
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
        },
      },
      React.createElement(RN.Image, {
        source: getKeyboardIcon(),
        resizeMode: "contain",
        style: {
          width: size * 0.8,
          height: size * 0.8,
          tintColor: getKeyboardColor(enabled),
        },
      }),
      enabled && storage.showSlash !== false
        ? React.createElement(RN.View, {
            style: {
              position: "absolute",
              width: Math.max(3, size * 0.09),
              height: size * 1.05,
              borderRadius: 2,
              backgroundColor: colorWithAlpha(storage.slashColor, storage.slashAlpha),
              transform: [{ rotate: "45deg" }],
            },
          })
        : null,
    );
  }

  function SilentTypingSlot({ side }) {
    usePluginRefresh();

    if (storage.showButton === false) return null;
    if ((storage.buttonSide ?? "left") !== side) return null;

    const enabled = storage.enabled === true;

    return React.createElement(
      RN.Pressable,
      {
        accessibilityRole: "button",
        accessibilityLabel: enabled
          ? "Silent typing enabled. Tap to disable."
          : "Silent typing disabled. Tap to enable.",
        onPress: () => {
          const next = !enabled;
          storage.enabled = next;
          notifyRefresh();
          showStateToast(next);
        },
        hitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
        style: {
          width: 40,
          height: 40,
          marginHorizontal: 2,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        },
      },
      React.createElement(KeyboardGraphic, { enabled, size: 30 }),
    );
  }

  function wrapWithSlot(result, side) {
    const slot = React.createElement(SilentTypingSlot, {
      key: `silent-typing-slot-${side}`,
      side,
    });

    return React.createElement(
      RN.View,
      {
        testID: `itsTripleSixSilentTyping-${side}`,
        style: {
          flexDirection: "row",
          alignItems: "center",
        },
      },
      side === "right" ? slot : result,
      side === "right" ? result : slot,
    );
  }

  function patchComposerSide(name, side) {
    const flag = side === "left" ? "leftPatched" : "rightPatched";
    if (runtime[flag]) return true;

    const found = getRenderTarget(name);
    if (!found) return false;

    runtime.patches.push(
      after(found.method, found.target, (_, result) => wrapWithSlot(result, side)),
    );

    runtime[flag] = true;
    return true;
  }

  function patchComposer() {
    const left = patchComposerSide("ChatInputActions", "left");
    const right = patchComposerSide("ChatInputRightActions", "right");

    if (!left && !right) return false;
    if (!left) storage.buttonSide = "right";
    if (!right) storage.buttonSide = "left";
    return true;
  }

  function patchTyping() {
    if (runtime.typingPatched) return true;
    if (!Typing?.startTyping) return false;

    runtime.patches.push(
      instead("startTyping", Typing, (args, original) => {
        if (storage.enabled === true) return;
        return original(...args);
      }),
    );

    runtime.typingPatched = true;
    return true;
  }

  function installPatches() {
    return [patchComposer(), patchTyping()];
  }

  function SettingRow({ title, description, control }) {
    return React.createElement(
      RN.View,
      {
        style: {
          paddingVertical: 12,
          borderBottomWidth: RN.StyleSheet.hairlineWidth,
          borderBottomColor: "#3F4147",
        },
      },
      React.createElement(
        RN.View,
        {
          style: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          },
        },
        React.createElement(
          RN.Text,
          {
            style: {
              color: "#F2F3F5",
              fontSize: 16,
              fontWeight: "600",
              flex: 1,
              paddingRight: 12,
            },
          },
          title,
        ),
        control,
      ),
      description
        ? React.createElement(
            RN.Text,
            {
              style: {
                color: "#B5BAC1",
                fontSize: 13,
                marginTop: 4,
                lineHeight: 18,
              },
            },
            description,
          )
        : null,
    );
  }

  function AlphaInput({ storageKey, forceRender }) {
    const [text, setText] = React.useState(
      String(clampByte(storage[storageKey])),
    );

    React.useEffect(() => {
      setText(String(clampByte(storage[storageKey])));
    }, [storage[storageKey]]);

    return React.createElement(RN.TextInput, {
      value: text,
      keyboardType: "number-pad",
      maxLength: 3,
      selectTextOnFocus: true,
      onChangeText: value => {
        const cleaned = value.replace(/\D/g, "").slice(0, 3);
        setText(cleaned);
        if (cleaned.length) {
          storage[storageKey] = clampByte(cleaned);
          forceRender();
          notifyRefresh();
        }
      },
      onBlur: () => {
        const normalized = clampByte(text);
        storage[storageKey] = normalized;
        setText(String(normalized));
        forceRender();
        notifyRefresh();
      },
      style: {
        width: 64,
        minHeight: 38,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: "#1E1F22",
        color: "#F2F3F5",
        textAlign: "center",
        fontSize: 15,
      },
    });
  }

  function ColorControl({
    title,
    description,
    storageKey,
    alphaKey,
    fallback,
    previewType,
    forceRender,
  }) {
    const hex = normalizeHex(storage[storageKey], fallback);
    const alpha = clampByte(storage[alphaKey]);

    const selectColor = () => {
      if (!openColorPicker(storageKey, fallback)) {
        Toasts?.showToast?.("Color picker unavailable on this Discord build");
      }
      forceRender();
    };

    return React.createElement(
      RN.View,
      {
        style: {
          marginTop: 18,
          padding: 14,
          borderRadius: 12,
          backgroundColor: "#2B2D31",
        },
      },
      React.createElement(
        RN.Text,
        { style: { color: "#F2F3F5", fontSize: 16, fontWeight: "700" } },
        title,
      ),
      React.createElement(
        RN.Text,
        {
          style: {
            color: "#B5BAC1",
            fontSize: 12,
            marginTop: 3,
            marginBottom: 12,
          },
        },
        description,
      ),
      React.createElement(
        RN.View,
        { style: { flexDirection: "row", alignItems: "center" } },
        React.createElement(
          RN.Pressable,
          {
            accessibilityRole: "button",
            accessibilityLabel: `Open color picker for ${title.toLowerCase()}`,
            onPress: selectColor,
            style: {
              width: 58,
              height: 58,
              borderRadius: 29,
              marginRight: 12,
              backgroundColor: colorWithAlpha(hex, alpha),
              borderWidth: 2,
              borderColor: "#4E5058",
              alignItems: "center",
              justifyContent: "center",
            },
          },
          previewType === "slash"
            ? React.createElement(RN.View, {
                style: {
                  width: 4,
                  height: 44,
                  borderRadius: 2,
                  backgroundColor: "#111214",
                  transform: [{ rotate: "45deg" }],
                },
              })
            : React.createElement(RN.Image, {
                source: getKeyboardIcon(),
                resizeMode: "contain",
                style: { width: 32, height: 32, tintColor: "#111214" },
              }),
        ),
        React.createElement(
          RN.View,
          { style: { flex: 1 } },
          React.createElement(
            RN.Text,
            { style: { color: "#F2F3F5", fontSize: 15, fontWeight: "600" } },
            hex,
          ),
          React.createElement(
            RN.Pressable,
            {
              onPress: selectColor,
              style: {
                alignSelf: "flex-start",
                marginTop: 6,
                paddingVertical: 6,
                paddingHorizontal: 10,
                borderRadius: 8,
                backgroundColor: "#4E5058",
              },
            },
            React.createElement(
              RN.Text,
              { style: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" } },
              "Open color picker",
            ),
          ),
        ),
      ),
      React.createElement(
        RN.View,
        {
          style: {
            marginTop: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          },
        },
        React.createElement(
          RN.View,
          null,
          React.createElement(
            RN.Text,
            { style: { color: "#F2F3F5", fontSize: 14, fontWeight: "600" } },
            "Alpha",
          ),
          React.createElement(
            RN.Text,
            { style: { color: "#B5BAC1", fontSize: 12, marginTop: 2 } },
            "0 = transparent, 255 = opaque",
          ),
        ),
        React.createElement(AlphaInput, { storageKey: alphaKey, forceRender }),
      ),
      React.createElement(
        RN.Pressable,
        {
          onPress: () => {
            storage[storageKey] = fallback;
            storage[alphaKey] = DEFAULT_ALPHA;
            forceRender();
            notifyRefresh();
          },
          style: {
            marginTop: 12,
            alignSelf: "flex-start",
            paddingVertical: 7,
            paddingHorizontal: 12,
            borderRadius: 8,
            backgroundColor: "#4E5058",
          },
        },
        React.createElement(
          RN.Text,
          { style: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" } },
          "Reset color",
        ),
      ),
    );
  }

  function StatePreview({ enabled, label }) {
    usePluginRefresh();

    return React.createElement(
      RN.View,
      {
        style: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 12,
        },
      },
      React.createElement(KeyboardGraphic, { enabled, size: 40 }),
      React.createElement(
        RN.Text,
        { style: { color: "#B5BAC1", fontSize: 13, marginTop: 8 } },
        label,
      ),
    );
  }

  function Settings() {
    const forceRender = usePluginRefresh();

    return React.createElement(
      RN.ScrollView,
      { contentContainerStyle: { padding: 16, paddingBottom: 32 } },
      React.createElement(
        RN.Text,
        {
          style: {
            color: "#F2F3F5",
            fontSize: 20,
            fontWeight: "700",
            marginBottom: 4,
          },
        },
        "Silent Typing",
      ),
      React.createElement(
        RN.Text,
        { style: { color: "#B5BAC1", fontSize: 13, marginBottom: 12 } },
        "Plain keyboard means visible. Silent mode can use its own keyboard color and an optional slash.",
      ),
      React.createElement(
        RN.View,
        {
          style: {
            flexDirection: "row",
            borderRadius: 12,
            backgroundColor: "#1E1F22",
            marginBottom: 16,
            overflow: "hidden",
          },
        },
        React.createElement(StatePreview, { enabled: false, label: "Visible" }),
        React.createElement(StatePreview, { enabled: true, label: "Invisible" }),
      ),
      React.createElement(SettingRow, {
        title: "Show composer button",
        description: "Shows the keyboard toggle beside the chat controls.",
        control: React.createElement(RN.Switch, {
          value: storage.showButton !== false,
          onValueChange: value => {
            storage.showButton = value;
            forceRender();
            notifyRefresh();
          },
        }),
      }),
      React.createElement(SettingRow, {
        title: "Show confirmation popup",
        description: "Shows Visible/Invisible confirmation whenever you tap the keyboard button.",
        control: React.createElement(RN.Switch, {
          value: storage.showToast !== false,
          onValueChange: value => {
            storage.showToast = value;
            forceRender();
          },
        }),
      }),
      React.createElement(SettingRow, {
        title: "Show slash when silent",
        description: "ON = slash while invisible. OFF = active/inactive keyboard colors are the only visual difference.",
        control: React.createElement(RN.Switch, {
          value: storage.showSlash !== false,
          onValueChange: value => {
            storage.showSlash = value;
            forceRender();
            notifyRefresh();
          },
        }),
      }),
      React.createElement(SettingRow, {
        title: "Button on right side",
        description: "OFF places it on the left by default. Changes apply immediately.",
        control: React.createElement(RN.Switch, {
          value: storage.buttonSide === "right",
          onValueChange: value => {
            storage.buttonSide = value ? "right" : "left";
            forceRender();
            notifyRefresh();
          },
        }),
      }),
      React.createElement(ColorControl, {
        title: "Inactive / visible keyboard color",
        description: "Keyboard color while silent typing is OFF.",
        storageKey: "visibleKeyboardColor",
        alphaKey: "visibleKeyboardAlpha",
        fallback: DEFAULT_VISIBLE_COLOR,
        previewType: "keyboard",
        forceRender,
      }),
      React.createElement(ColorControl, {
        title: "Active / silent keyboard color",
        description: "Keyboard color while silent typing is ON.",
        storageKey: "silentKeyboardColor",
        alphaKey: "silentKeyboardAlpha",
        fallback: DEFAULT_SILENT_COLOR,
        previewType: "keyboard",
        forceRender,
      }),
      React.createElement(ColorControl, {
        title: "Silent slash color",
        description: "Independent color for the slash shown while silent typing is ON.",
        storageKey: "slashColor",
        alphaKey: "slashAlpha",
        fallback: DEFAULT_SLASH_COLOR,
        previewType: "slash",
        forceRender,
      }),
      React.createElement(
        RN.Pressable,
        {
          onPress: () => {
            storage.visibleKeyboardColor = DEFAULT_VISIBLE_COLOR;
            storage.visibleKeyboardAlpha = DEFAULT_ALPHA;
            storage.silentKeyboardColor = DEFAULT_SILENT_COLOR;
            storage.silentKeyboardAlpha = DEFAULT_ALPHA;
            storage.slashColor = DEFAULT_SLASH_COLOR;
            storage.slashAlpha = DEFAULT_ALPHA;
            storage.showButton = true;
            storage.showToast = true;
            storage.showSlash = true;
            storage.buttonSide = "left";
            forceRender();
            notifyRefresh();
          },
          style: {
            marginTop: 22,
            minHeight: 46,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#4E5058",
          },
        },
        React.createElement(
          RN.Text,
          { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" } },
          "Reset all appearance settings",
        ),
      ),
    );
  }

  function cleanup() {
    while (runtime.patches.length) {
      try {
        runtime.patches.pop()?.();
      } catch {}
    }

    runtime.refreshListeners.clear();
    runtime.leftPatched = false;
    runtime.rightPatched = false;
    runtime.typingPatched = false;

    if (globalThis[RUNTIME_KEY] === runtime) {
      try {
        delete globalThis[RUNTIME_KEY];
      } catch {
        globalThis[RUNTIME_KEY] = null;
      }
    }
  }

  runtime.cleanup = cleanup;
  migrateStorage();
  const earlyResults = installPatches();

  return {
    onLoad() {
      migrateStorage();
      const results = installPatches();
      if (![...earlyResults, ...results].some(Boolean)) {
        throw new Error("Discord composer components were not found");
      }
    },

    onUnload() {
      cleanup();
    },

    settings: Settings,
  };
})()