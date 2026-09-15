(() => {
  "use strict";

  const { after } = vendetta.patcher;
  const { find, findByName } = vendetta.metro;
  const { React, ReactNative: RN } = vendetta.metro.common;
  const { storage } = vendetta.plugin;

  const KEY = "__itsTripleSixComposerCleanerRuntime";
  const DEFAULTS = {
    hideAttachment: false,
    hideGift: false,
    hideEmoji: false,
    hideMicrophone: false,
    hideApps: false,
    hideThread: false,
  };

  try { globalThis[KEY]?.cleanup?.(); } catch {}

  const runtime = {
    patches: [],
    listeners: new Set(),
    patched: {},
    liveChatInput: null,
    frame: null,
    timer: null,
    initialRefreshPending: true,
    active: true,
    cleanup: null,
  };
  globalThis[KEY] = runtime;

  function ensureDefaults() {
    for (const [key, value] of Object.entries(DEFAULTS)) storage[key] ??= value;
  }

  function notify() {
    for (const listener of runtime.listeners) {
      try { listener(); } catch {}
    }
  }

  function useRefresh() {
    const [, render] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
      runtime.listeners.add(render);
      return () => runtime.listeners.delete(render);
    }, []);
  }

  function findComponent(name) {
    try {
      const found = find(module => (
        module?.type?.displayName === name
        || module?.type?.render?.displayName === name
        || module?.default?.displayName === name
        || module?.default?.type?.displayName === name
        || module?.default?.type?.render?.displayName === name
      ));
      if (found) return found;
    } catch {}

    try {
      return findByName(name, false) ?? findByName(name);
    } catch {
      return null;
    }
  }

  function renderTarget(name) {
    const component = findComponent(name);
    if (!component) return null;
    if (typeof component.default === "function") return [component, "default"];
    if (component.default?.type && typeof component.default.type.render === "function") return [component.default.type, "render"];
    if (component.default && typeof component.default.render === "function") return [component.default, "render"];

    const target = component.type ?? component;
    if (target?.type && typeof target.type.render === "function") return [target.type, "render"];
    if (target && typeof target.render === "function") return [target, "render"];
    return null;
  }

  function elementName(element) {
    if (!React.isValidElement(element)) return "";
    const type = element.type;
    return type?.displayName
      ?? type?.type?.displayName
      ?? type?.render?.displayName
      ?? type?.type?.render?.displayName
      ?? (typeof type === "function" ? type.name : "")
      ?? "";
  }

  function iconName(icon) {
    return String(icon?.displayName ?? icon?.name ?? "").toLowerCase();
  }

  function describe(element) {
    if (!React.isValidElement(element)) return "";
    const props = element.props ?? {};
    const icon = props.IconComponent ?? props.iconComponent ?? props.Icon;
    return [
      props.accessibilityLabel,
      props.accessibilityHint,
      props.label,
      props.title,
      props.testID,
      props.nativeID,
      elementName(element),
      iconName(icon),
    ].filter(value => typeof value === "string" && value.length).join(" ").toLowerCase();
  }

  function isNativeExpressionButton(element) {
    if (!React.isValidElement(element)) return false;
    const props = element.props ?? {};
    return Object.prototype.hasOwnProperty.call(props, "showKeyboardIcon")
      && Object.prototype.hasOwnProperty.call(props, "active")
      && typeof props.onPress === "function";
  }

  function menuHasAttachment(items, depth = 0) {
    if (!Array.isArray(items) || depth > 4) return false;

    for (const item of items) {
      if (Array.isArray(item)) {
        if (menuHasAttachment(item, depth + 1)) return true;
        continue;
      }

      if (!item || typeof item !== "object") continue;

      const icon = item.IconComponent ?? item.iconComponent ?? item.Icon;
      if (iconName(icon).includes("attachmenticon")) return true;
      if (menuHasAttachment(item.items, depth + 1)) return true;
      if (Array.isArray(item.children) && menuHasAttachment(item.children, depth + 1)) return true;
    }

    return false;
  }

  function isNativeAttachmentControl(element, scope) {
    if (scope !== "actions" || !React.isValidElement(element)) return false;

    const props = element.props ?? {};
    const icon = iconName(props.IconComponent ?? props.iconComponent ?? props.Icon);

    if (icon.includes("mediakeyboardbuttonicon") || icon.includes("attachmenticon")) {
      return true;
    }

    return typeof props.children === "function"
      && props.triggerOnLongPress === true
      && Array.isArray(props.items)
      && menuHasAttachment(props.items);
  }

  function shouldHide(element, scope) {
    if (storage.hideAttachment && isNativeAttachmentControl(element, scope)) return true;
    if (storage.hideEmoji && scope === "rightActions" && isNativeExpressionButton(element)) return true;

    const text = describe(element);
    if (!text) return false;

    if (storage.hideAttachment && scope === "actions" && (/\battachment\b|\bupload\b|\bphotos?\b|\bmedia\b/.test(text) || text.includes("mediakeyboardbuttonicon") || text.includes("attachmenticon"))) return true;
    if (storage.hideGift && /\bgift\b|\bnitro\b/.test(text)) return true;
    if (storage.hideEmoji && scope === "rightActions" && (/\bemoji\b|\bexpression\b/.test(text) || text.includes("expressionpicker") || text.includes("smiley"))) return true;
    if (storage.hideMicrophone && (/\bvoice message\b|\bmicrophone\b|\brecord voice\b/.test(text) || text.includes("microphoneicon") || text.includes("voice-message-button"))) return true;
    if (storage.hideApps && (/\bapps?\b|\bcommands?\b|\bapp launcher\b/.test(text) || text.includes("chatinputactionbuttonapps") || text.includes("appsicon"))) return true;
    if (storage.hideThread && (/\bnew thread\b|\bstart thread\b|\bthread\b/.test(text) || text.includes("threadplusicon"))) return true;
    return false;
  }

  function cleanTree(node, scope) {
    if (Array.isArray(node)) {
      return node.map(child => cleanTree(child, scope)).filter(Boolean);
    }

    if (!React.isValidElement(node)) return node;
    if (shouldHide(node, scope)) return null;

    const children = node.props?.children;
    if (children === undefined || typeof children === "function") return node;

    const next = cleanTree(children, scope);
    if (next === children) return node;

    try {
      return React.cloneElement(node, undefined, next);
    } catch {
      return node;
    }
  }

  function transformTree(node) {
    if (Array.isArray(node)) return node.map(transformTree);
    if (!React.isValidElement(node)) return node;

    const name = elementName(node);
    const overrides = {};

    if (name === "ChatInputActions") {
      if (storage.hideApps) overrides.isAppLauncherEnabled = false;
      if (storage.hideThread) overrides.canStartThreads = false;
    } else if (name === "ChatInputRightActions" && storage.hideGift) {
      overrides.shouldShowGiftButton = false;
    } else if (name === "ChatInputSendButton" && storage.hideMicrophone) {
      overrides.canSendVoiceMessage = false;
    }

    const children = node.props?.children;
    const next = children === undefined || typeof children === "function"
      ? children
      : transformTree(children);
    const changed = next !== children;

    if (!Object.keys(overrides).length && !changed) return node;

    try {
      return changed
        ? React.cloneElement(node, overrides, next)
        : React.cloneElement(node, overrides);
    } catch {
      return node;
    }
  }

  function CleanerRoot({ result }) {
    useRefresh();
    return runtime.active ? transformTree(result) : result;
  }

  function CleanerOutput({ result, scope }) {
    useRefresh();
    return runtime.active ? cleanTree(result, scope) : result;
  }

  function patch(name, flag, component) {
    if (runtime.patched[flag]) return true;
    const found = renderTarget(name);
    if (!found) return false;

    const [target, method] = found;
    runtime.patches.push(
      after(method, target, (_, result) =>
        React.createElement(component, {
          result,
          scope: flag,
          key: `composer-cleaner-${flag}`,
        }),
      ),
    );
    runtime.patched[flag] = true;
    return true;
  }

  function findTree(node, predicate, seen = new Set(), depth = 0) {
    if (node == null || depth > 60) return null;

    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findTree(child, predicate, seen, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);

    try {
      if (predicate(node)) return node;
    } catch {}

    const children = node.props?.children;
    if (children === undefined || typeof children === "function") return null;
    return findTree(children, predicate, seen, depth + 1);
  }

  function cancelRefresh() {
    try {
      if (runtime.frame != null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(runtime.frame);
      }
    } catch {}

    if (runtime.timer != null) {
      try { clearTimeout(runtime.timer); } catch {}
    }

    runtime.frame = null;
    runtime.timer = null;
  }

  function startupRefresh(ref) {
    if (!ref || typeof ref.showSideActions !== "function") return;
    cancelRefresh();

    const run = () => {
      runtime.frame = null;
      runtime.timer = null;
      try { ref.showSideActions(); } catch {}
    };

    if (typeof requestAnimationFrame === "function") {
      runtime.frame = requestAnimationFrame(run);
    } else {
      runtime.timer = setTimeout(run, 0);
    }
  }

  function patchGuard() {
    if (runtime.patched.guard) return true;

    let wrapper = null;
    try {
      wrapper = findByName("ChatInputGuardWrapper", false)
        ?? findByName("ChatInputGuardWrapper");
    } catch {}
    if (!wrapper) return false;

    let target = null;
    let method = null;
    if (typeof wrapper.default === "function") {
      target = wrapper;
      method = "default";
    } else if (wrapper.default?.type && typeof wrapper.default.type.render === "function") {
      target = wrapper.default.type;
      method = "render";
    } else if (wrapper?.type && typeof wrapper.type.render === "function") {
      target = wrapper.type;
      method = "render";
    }
    if (!target) return false;

    runtime.patches.push(
      after(method, target, (_, result) => {
        const node = findTree(result, value => value?.props?.chatInputRef?.current);
        const ref = node?.props?.chatInputRef?.current;
        if (ref) {
          runtime.liveChatInput = ref;
          if (runtime.initialRefreshPending) {
            runtime.initialRefreshPending = false;
            startupRefresh(ref);
          }
        }
        return result;
      }),
    );

    runtime.patched.guard = true;
    return true;
  }

  function install() {
    ensureDefaults();
    return [
      patch("ChatInput", "chatInput", CleanerRoot),
      patch("ChatInputActions", "actions", CleanerOutput),
      patch("ChatInputRightActions", "rightActions", CleanerOutput),
      patch("ChatInputSendButton", "sendButton", CleanerOutput),
      patchGuard(),
    ];
  }

  const rows = [
    ["Hide attachment / media (+)", "Removes Discord's attachment/media button from the composer.", "hideAttachment"],
    ["Hide Gift", "Removes Discord's gift/Nitro button.", "hideGift"],
    ["Hide Emoji / Expression", "Removes the smiley/expression picker button.", "hideEmoji"],
    ["Hide Microphone", "Removes the voice-message microphone when Discord shows it.", "hideMicrophone"],
    ["Hide Apps & Commands", "Removes Discord's app/command launcher button where present.", "hideApps"],
    ["Hide New Thread", "Removes the new-thread composer action where present.", "hideThread"],
  ];

  function SettingRow({ title, description, storageKey, render }) {
    return React.createElement(
      RN.View,
      {
        style: {
          paddingVertical: 13,
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
        React.createElement(RN.Switch, {
          value: storage[storageKey] === true,
          onValueChange: value => {
            storage[storageKey] = value;
            render();
            notify();
          },
        }),
      ),
      React.createElement(
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
      ),
    );
  }

  function ActionButton({ label, onPress }) {
    return React.createElement(
      RN.Pressable,
      {
        onPress,
        style: {
          flex: 1,
          minHeight: 42,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#4E5058",
          paddingHorizontal: 10,
        },
      },
      React.createElement(
        RN.Text,
        { style: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" } },
        label,
      ),
    );
  }

  function Settings() {
    const [, render] = React.useReducer(value => value + 1, 0);

    const setAll = value => {
      for (const key of Object.keys(DEFAULTS)) storage[key] = value;
      render();
      notify();
    };

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
        "Composer Cleaner",
      ),
      React.createElement(
        RN.Text,
        {
          style: {
            color: "#B5BAC1",
            fontSize: 13,
            lineHeight: 18,
            marginBottom: 10,
          },
        },
        "Hide Discord's native message composer buttons. Third-party composer buttons are left alone.",
      ),
      ...rows.map(([title, description, storageKey]) =>
        React.createElement(SettingRow, {
          key: storageKey,
          title,
          description,
          storageKey,
          render,
        }),
      ),
      React.createElement(
        RN.View,
        { style: { flexDirection: "row", gap: 10, marginTop: 18 } },
        React.createElement(ActionButton, {
          label: "Hide all",
          onPress: () => setAll(true),
        }),
        React.createElement(ActionButton, {
          label: "Show all",
          onPress: () => setAll(false),
        }),
      ),
      React.createElement(
        RN.Text,
        {
          style: {
            color: "#80848E",
            fontSize: 12,
            lineHeight: 17,
            marginTop: 14,
          },
        },
        "Changes apply immediately without typing or switching channels.",
      ),
    );
  }

  function cleanup() {
    runtime.active = false;
    notify();
    cancelRefresh();

    while (runtime.patches.length) {
      try { runtime.patches.pop()?.(); } catch {}
    }

    runtime.patched = {};
    runtime.liveChatInput = null;

    if (globalThis[KEY] === runtime) {
      try { delete globalThis[KEY]; } catch { globalThis[KEY] = null; }
    }
  }

  runtime.cleanup = cleanup;
  const early = install();

  return {
    onLoad() {
      runtime.active = true;
      const current = install();
      if (![...early, ...current].some(Boolean)) {
        throw new Error("Discord composer components were not found");
      }
      notify();
    },
    onUnload: cleanup,
    settings: Settings,
  };
})()
