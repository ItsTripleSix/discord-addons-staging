(() => {
  "use strict";

  const { before, after } = vendetta.patcher;
  const { find, findByProps } = vendetta.metro;
  const { React, ReactNative: RN } = vendetta.metro.common;

  const KEY = "__itsTripleSixHiddenChannelsRuntime";
  const SHOW = 4;
  const COLLAPSED = 3;

  try { globalThis[KEY]?.cleanup?.(); } catch {}

  const rt = {
    active: true,
    patches: [],
    patched: {},
    originals: new Map(),
    categories: new Set(),
    guildLists: new Set(),
    channelStore: null,
    permissionStore: null,
    realCan: null,
    viewChannel: null,
    obfuscationModuleFound: false,
    nativePreferenceSet: false,
    rowRenders: 0,
    rowNamed: 0,
    rowArgInjections: 0,
    rowTextReplacements: 0,
    modeSubstitutions: 0,
    helperSubstitutions: 0,
    cleanup: null,
  };
  globalThis[KEY] = rt;

  const safePatch = (flag, make) => {
    if (rt.patched[flag]) return true;
    try {
      const unpatch = make();
      if (typeof unpatch !== "function") return false;
      rt.patches.push(unpatch);
      rt.patched[flag] = true;
      return true;
    } catch {
      return false;
    }
  };

  const channelStore = () => rt.channelStore ??= (
    findByProps("getMutableGuildChannelsForGuild", "getChannel")
    ?? findByProps("getChannel", "getDMFromUserId")
    ?? findByProps("getChannel")
  );

  const guildId = channel => {
    try { return channel?.guild_id ?? channel?.guildId ?? channel?.getGuildId?.() ?? null; }
    catch { return channel?.guild_id ?? channel?.guildId ?? null; }
  };

  const unwrap = value => {
    if (!value) return null;
    if (typeof value !== "object") return value;
    return value.channel ?? value.record ?? value;
  };

  function getCanonical(id) {
    if (id == null) return null;
    try { return channelStore()?.getChannel?.(id) ?? null; }
    catch { return null; }
  }

  function getMutable(gid, id) {
    if (gid == null || id == null) return null;
    try {
      const channels = channelStore()?.getMutableGuildChannelsForGuild?.(gid);
      if (!channels || typeof channels !== "object") return null;
      if (typeof channels.get === "function") return channels.get(id) ?? null;
      if (Object.prototype.hasOwnProperty.call(channels, id)) return channels[id] ?? null;
      for (const channel of Object.values(channels)) {
        if (channel?.id === id) return channel;
      }
    } catch {}
    return null;
  }

  function candidates(value) {
    const directValue = unwrap(value);
    const direct = typeof directValue === "object" ? directValue : null;
    const id = typeof directValue === "string" ? directValue : direct?.id;
    const canonical = getCanonical(id);
    const gid = guildId(direct) ?? guildId(canonical);
    const mutable = getMutable(gid, id);
    return { direct, canonical, mutable, id, gid };
  }

  const isGuildChannel = channel => (
    !!channel && typeof channel.type === "number" && guildId(channel) != null
  );

  const isObfuscated = channel => {
    try { return channel?.isObfuscated?.() === true; }
    catch { return false; }
  };

  function lacksView(channel) {
    if (!isGuildChannel(channel)) return false;

    if (!rt.permissionStore) {
      rt.permissionStore = findByProps("getChannelPermissions", "can");
      if (rt.permissionStore?.can) rt.realCan = rt.permissionStore.can.bind(rt.permissionStore);
    }

    if (rt.viewChannel == null) {
      const constants = findByProps("Permissions", "ChannelTypes") ?? findByProps("Permissions");
      rt.viewChannel = vendetta.metro.common?.constants?.Permissions?.VIEW_CHANNEL
        ?? constants?.Permissions?.VIEW_CHANNEL
        ?? null;
    }

    if (!rt.realCan || rt.viewChannel == null) return false;
    try { return rt.realCan(rt.viewChannel, channel) === false; }
    catch { return false; }
  }

  function isHidden(value) {
    const { direct, canonical, mutable } = candidates(value);
    for (const channel of [direct, canonical, mutable]) {
      if (!isGuildChannel(channel)) continue;
      if (isObfuscated(channel) || lacksView(channel)) return true;
    }
    return false;
  }

  const isPlaceholder = value => (
    typeof value === "string"
    && /^(?:\s*no[\s_-]*access\s*|_+hidden_+)$/i.test(value.trim())
  );

  function usableName(channel) {
    const value = channel?.name;
    if (typeof value !== "string") return null;
    const name = value.trim();
    return name && !isPlaceholder(name) ? name : null;
  }

  function rawName(value) {
    const { mutable, canonical, direct } = candidates(value);
    return usableName(mutable) ?? usableName(canonical) ?? usableName(direct) ?? null;
  }

  function findChannelDeep(value, depth = 0, seen = new Set()) {
    if (value == null || depth > 5) return null;

    const direct = unwrap(value);
    if (isGuildChannel(direct) && direct?.id) return direct;
    if (typeof direct === "string") {
      const canonical = getCanonical(direct);
      if (isGuildChannel(canonical)) return canonical;
    }

    if (typeof value !== "object" || React.isValidElement(value)) return null;
    if (seen.has(value)) return null;
    seen.add(value);

    for (const key of ["channel", "record", "item", "data", "row", "props", "channelRecord"]) {
      if (!(key in value)) continue;
      const found = findChannelDeep(value[key], depth + 1, seen);
      if (found) return found;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findChannelDeep(child, depth + 1, seen);
        if (found) return found;
      }
    }
    return null;
  }

  function namedView(channel, name) {
    if (!channel || typeof channel !== "object" || !name) return channel;
    try {
      return new Proxy(channel, {
        get(target, prop, receiver) {
          if (prop === "name") return name;
          if (prop === "isObfuscated") return () => false;
          return Reflect.get(target, prop, receiver);
        },
      });
    } catch {
      try { return { ...channel, name, isObfuscated: () => false }; }
      catch { return channel; }
    }
  }

  function injectChannel(value, target, replacement, depth = 0, seen = new Set()) {
    if (value == null || depth > 5) return value;
    if (value === target || (isGuildChannel(value) && value?.id === target?.id)) return replacement;
    if (typeof value !== "object" || React.isValidElement(value)) return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map(child => {
        const result = injectChannel(child, target, replacement, depth + 1, seen);
        changed ||= result !== child;
        return result;
      });
      return changed ? next : value;
    }

    let changed = false;
    const next = { ...value };
    for (const key of ["channel", "record", "item", "data", "row", "props", "channelRecord"]) {
      if (!(key in value)) continue;
      const result = injectChannel(value[key], target, replacement, depth + 1, seen);
      if (result !== value[key]) {
        next[key] = result;
        changed = true;
      }
    }
    return changed ? next : value;
  }

  function rewriteRendered(node, sourceChannel, name, depth = 0) {
    if (!name || depth > 14) return node;
    if (isPlaceholder(node)) {
      rt.rowTextReplacements += 1;
      return name;
    }

    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map(child => {
        const value = rewriteRendered(child, sourceChannel, name, depth + 1);
        changed ||= value !== child;
        return value;
      });
      return changed ? next : node;
    }

    if (!React.isValidElement(node)) return node;

    const props = node.props ?? {};
    const overrides = {};
    let changed = false;

    for (const key of ["accessibilityLabel", "label", "text", "title", "name", "channelName"]) {
      if (isPlaceholder(props[key])) {
        overrides[key] = name;
        changed = true;
        rt.rowTextReplacements += 1;
      }
    }

    for (const key of ["channel", "record", "channelRecord"]) {
      const candidate = unwrap(props[key]);
      if (!candidate || candidate?.id !== sourceChannel?.id) continue;
      const replacement = namedView(candidate, name);
      if (props[key]?.channel === candidate) overrides[key] = { ...props[key], channel: replacement };
      else if (props[key]?.record === candidate) overrides[key] = { ...props[key], record: replacement };
      else overrides[key] = replacement;
      changed = true;
    }

    const children = props.children;
    const nextChildren = children === undefined
      ? children
      : rewriteRendered(children, sourceChannel, name, depth + 1);
    const childrenChanged = nextChildren !== children;
    changed ||= childrenChanged;

    if (!changed) return node;
    try {
      return childrenChanged
        ? React.cloneElement(node, overrides, nextChildren)
        : React.cloneElement(node, overrides);
    } catch {
      return node;
    }
  }

  function revealCategory(category) {
    if (!category?.channels || typeof category.channels !== "object") return false;
    const level = category.isCollapsed === true ? COLLAPSED : SHOW;
    let changed = false;

    for (const item of Object.values(category.channels)) {
      const channel = item?.record ?? item?.channel ?? item;
      if (!isHidden(channel)) continue;
      if (!rt.originals.has(item)) rt.originals.set(item, item.renderLevel);
      if (item.renderLevel !== level) {
        item.renderLevel = level;
        changed = true;
      }
    }

    if (changed) {
      try { category.shownChannelIds = null; } catch {}
      rt.categories.add(category);
    }
    return changed;
  }

  function revealGuildList(list) {
    if (!list || typeof list !== "object") return list;
    const categories = [];
    if (list.noParentCategory) categories.push(list.noParentCategory);
    if (list.categories && typeof list.categories === "object") categories.push(...Object.values(list.categories));
    if (list.voiceChannelsCategory) categories.push(list.voiceChannelsCategory);

    let changed = false;
    for (const category of categories) changed = revealCategory(category) || changed;

    if (changed) {
      try {
        list.rows = null;
        list.sections = null;
        list.allChannelsById = null;
        list.firstVoiceChannel = undefined;
        if (typeof list.version === "number") list.version += 1;
      } catch {}
      rt.guildLists.add(list);
    }
    return list;
  }

  function patchChannelList() {
    let module = null;
    try {
      module = find(value => (
        typeof value?.default === "function"
        && typeof value.default?.prototype?.getGuild === "function"
        && typeof value.default?.prototype?.getGuildChannelRowsOnly === "function"
      ));
    } catch {}

    const proto = module?.default?.prototype;
    if (!proto) return false;

    const a = safePatch("channelListGuild", () => after("getGuild", proto, (_args, result) => (
      rt.active ? revealGuildList(result) : result
    )));
    const b = safePatch("channelListRows", () => after("getGuildChannelRowsOnly", proto, (_args, result) => (
      rt.active ? revealGuildList(result) : result
    )));
    return a || b;
  }

  function channelItemTarget() {
    const module = findByProps("getChannelMode");
    if (!module) return null;
    if (typeof module.default === "function") return [module, "default"];
    if (typeof module.default?.type === "function") return [module.default, "type"];
    if (typeof module.default?.type?.render === "function") return [module.default.type, "render"];
    if (typeof module.default?.render === "function") return [module.default, "render"];
    return null;
  }

  function visiblePeer(channel) {
    const gid = guildId(channel);
    if (!gid) return null;
    try {
      const channels = channelStore()?.getMutableGuildChannelsForGuild?.(gid);
      if (!channels || typeof channels !== "object") return null;
      const values = channels instanceof Map ? [...channels.values()] : Object.values(channels);
      return values.find(candidate => (
        isGuildChannel(candidate)
        && candidate?.id !== channel?.id
        && candidate?.type === channel?.type
        && !isObfuscated(candidate)
        && !lacksView(candidate)
      )) ?? null;
    } catch { return null; }
  }

  function patchChannelMode() {
    const module = findByProps("getChannelMode");
    if (!module || typeof module.getChannelMode !== "function") return false;

    return safePatch("channelMode", () => after("getChannelMode", module, (args, result) => {
      if (!rt.active) return result;
      const channel = findChannelDeep(args);
      if (!channel || !isHidden(channel) || !rawName(channel)) return result;
      const peer = visiblePeer(channel);
      if (!peer) return result;
      try {
        const peerMode = module.getChannelMode(peer);
        if (peerMode != null) {
          rt.modeSubstitutions += 1;
          return peerMode;
        }
      } catch {}
      return result;
    }));
  }

  function patchChannelRows() {
    const found = channelItemTarget();
    if (!found) return false;
    const [target, method] = found;

    const pre = safePatch("channelRowsBefore", () => before(method, target, args => {
      if (!rt.active) return;
      const channel = findChannelDeep(args);
      if (!channel || !isHidden(channel)) return;
      const name = rawName(channel);
      if (!name) return;

      const replacement = namedView(channel, name);
      for (let i = 0; i < args.length; i += 1) {
        const next = injectChannel(args[i], channel, replacement);
        if (next !== args[i]) {
          args[i] = next;
          rt.rowArgInjections += 1;
        }
      }
    }));

    const post = safePatch("channelRowsAfter", () => after(method, target, (args, result) => {
      if (!rt.active) return result;
      rt.rowRenders += 1;
      const channel = findChannelDeep(args);
      if (!channel || !isHidden(channel)) return result;
      const name = rawName(channel);
      if (!name) return result;
      rt.rowNamed += 1;
      return rewriteRendered(result, channel, name);
    }));

    rt.patched.channelRows = pre || post;
    return rt.patched.channelRows;
  }

  function patchNameHelpers() {
    const modules = [
      findByProps("computeChannelName", "escapeChannelName"),
      findByProps("getChannelName"),
    ].filter(Boolean);

    let changed = false;
    for (const module of modules) {
      for (const key of ["computeChannelName", "getChannelName", "default"]) {
        if (typeof module?.[key] !== "function") continue;
        changed = safePatch(`nameHelper:${key}:${changed}`, () => after(key, module, (args, result) => {
          if (!rt.active || !isPlaceholder(result)) return result;
          const channel = findChannelDeep(args);
          if (!channel || !isHidden(channel)) return result;
          const name = rawName(channel);
          if (name) rt.helperSubstitutions += 1;
          return name ?? result;
        })) || changed;
      }
    }
    return changed;
  }

  function patchObfuscation() {
    let module = null;
    try {
      module = findByProps(
        "isChannelMetadataObfuscationEnabled",
        "useIsChannelMetadataObfuscationEnabled",
      );
    } catch {}

    if (!module) return false;
    rt.obfuscationModuleFound = true;
    let changed = false;

    for (const key of [
      "isChannelMetadataObfuscationEnabled",
      "useIsChannelMetadataObfuscationEnabled",
      "isChannelMetadataIntegrityCheckEnabled",
      "getCachedPrivateChannelObfuscation",
    ]) {
      if (typeof module[key] !== "function") continue;
      changed = safePatch(`obfuscation:${key}`, () => after(key, module, () => false)) || changed;
    }

    try {
      const nativePreference = findByProps("setUseChannelObfuscation", "setUseAltGateway")
        ?? findByProps("setUseChannelObfuscation");
      if (typeof nativePreference?.setUseChannelObfuscation === "function") {
        nativePreference.setUseChannelObfuscation(false);
        rt.nativePreferenceSet = true;
      }
    } catch {}

    return changed;
  }

  function inspect() {
    const guildStore = findByProps("getGuilds", "getGuild") ?? findByProps("getGuild");
    let hidden = 0;
    let named = 0;
    let missing = 0;
    const examples = [];

    try {
      const guilds = guildStore?.getGuilds?.() ?? {};
      for (const gid of Object.keys(guilds)) {
        const channels = channelStore()?.getMutableGuildChannelsForGuild?.(gid);
        if (!channels || typeof channels !== "object") continue;
        const values = channels instanceof Map ? [...channels.values()] : Object.values(channels);
        for (const channel of values) {
          if (!isHidden(channel)) continue;
          hidden += 1;
          const name = rawName(channel);
          if (name) {
            named += 1;
            if (examples.length < 8) examples.push(`#${name}`);
          } else missing += 1;
        }
      }
    } catch {}

    const message = [
      `Hidden/obfuscated loaded: ${hidden}`,
      `Real names available: ${named}`,
      `Names still sanitized: ${missing}`,
      "",
      `Obfuscation module patched: ${rt.obfuscationModuleFound ? "yes" : "no"}`,
      `Fast-connect preference set off: ${rt.nativePreferenceSet ? "yes" : "no"}`,
      `Channel-mode patch active: ${rt.patched.channelMode ? "yes" : "no"}`,
      `Channel-row before patch active: ${rt.patched.channelRowsBefore ? "yes" : "no"}`,
      `Channel-row after patch active: ${rt.patched.channelRowsAfter ? "yes" : "no"}`,
      `Row argument injections: ${rt.rowArgInjections}`,
      `Row renders seen / named: ${rt.rowRenders} / ${rt.rowNamed}`,
      `Rendered text replacements: ${rt.rowTextReplacements}`,
      `Mode substitutions: ${rt.modeSubstitutions}`,
      `Name-helper substitutions: ${rt.helperSubstitutions}`,
      examples.length ? `\nExamples:\n${examples.join("\n")}` : "",
      "",
      "Rendering only. No channel-message access is granted.",
    ].filter(Boolean).join("\n");

    try { RN.Alert.alert("Hidden Channels", message); } catch {}
  }

  function install() {
    channelStore();
    return [
      patchObfuscation(),
      patchChannelList(),
      patchChannelMode(),
      patchChannelRows(),
      patchNameHelpers(),
    ];
  }

  function Settings() {
    return React.createElement(
      RN.ScrollView,
      { contentContainerStyle: { padding: 16, paddingBottom: 32 } },
      React.createElement(RN.Text, {
        style: { color: "#F2F3F5", fontSize: 20, fontWeight: "700", marginBottom: 8 },
      }, "Hidden Channels"),
      React.createElement(RN.Text, {
        style: { color: "#B5BAC1", fontSize: 14, lineHeight: 20, marginBottom: 16 },
      }, "Shows inaccessible channels and restores their names when Discord still has that metadata locally. This build now injects the recovered name before Discord renders each channel row, then applies a final rendered-text fallback."),
      React.createElement(RN.Pressable, {
        onPress: inspect,
        style: {
          minHeight: 46,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#5865F2",
          paddingHorizontal: 14,
        },
      }, React.createElement(RN.Text, {
        style: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
      }, "Inspect hidden channel state")),
    );
  }

  function cleanup() {
    rt.active = false;
    while (rt.patches.length) {
      try { rt.patches.pop()?.(); } catch {}
    }

    for (const [item, level] of rt.originals) {
      try { item.renderLevel = level; } catch {}
    }
    for (const category of rt.categories) {
      try { category.shownChannelIds = null; } catch {}
    }
    for (const list of rt.guildLists) {
      try {
        list.rows = null;
        list.sections = null;
        list.allChannelsById = null;
        list.firstVoiceChannel = undefined;
        if (typeof list.version === "number") list.version += 1;
      } catch {}
    }

    rt.originals.clear();
    rt.categories.clear();
    rt.guildLists.clear();

    if (globalThis[KEY] === rt) {
      try { delete globalThis[KEY]; }
      catch { globalThis[KEY] = null; }
    }
  }

  rt.cleanup = cleanup;
  const early = install();

  return {
    onLoad() {
      rt.active = true;
      const current = install();
      if (![...early, ...current].some(Boolean)) {
        throw new Error("Discord hidden-channel modules were not found");
      }
    },
    onUnload: cleanup,
    settings: Settings,
  };
})();
