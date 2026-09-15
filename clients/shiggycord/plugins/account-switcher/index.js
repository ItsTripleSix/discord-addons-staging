(() => {
  "use strict";

  const V = vendetta;
  if (!V?.metro?.common) return {};

  const { React, ReactNative: RN } = V.metro.common;
  const { instead } = V.patcher;
  const { storage } = V.plugin;
  const VERSION = "2.3.0-shiggy";

  storage.onlyActiveNotifications ??= true;

  const runtime = {
    multiAccountStore: null,
    userStore: null,
    actions: null,
    pushActions: null,
    notificationTokenManager: null,
    pushUnpatch: null,
    notificationStatus: "starting",
    lastNativeSyncAt: 0,
    lastNativeSyncKey: "",
    lastSuccessfulKey: "",
    syncInFlight: null,
    pendingSync: false,
    pendingForce: false,
    startupTimer: null,
    switchFallbackTimer: null,
    loaded: false,
  };

  const C = {
    bg: "#111214",
    card: "#1e1f22",
    card2: "#2b2d31",
    text: "#f2f3f5",
    muted: "#b5bac1",
    green: "#23a55a",
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function toast(text) {
    try { V.ui?.toasts?.showToast?.(String(text)); } catch {}
  }

  function find(...props) {
    try { return V.metro?.findByProps?.(...props); } catch { return undefined; }
  }

  function findStore(name) {
    try { return V.metro?.findByStoreName?.(name); } catch { return undefined; }
  }

  function findModule(predicate) {
    try { return V.metro?.find?.(predicate); } catch { return undefined; }
  }

  function unwrapDefault(value) {
    if (value?.default && (typeof value.default === "object" || typeof value.default === "function")) {
      return value.default;
    }
    return value;
  }

  function resolveRuntime() {
    runtime.multiAccountStore ??= (
      findStore("MultiAccountStore")
      ?? find("getUsers", "getValidUsers", "getHasLoggedInAccounts")
      ?? find("getUsers", "getValidUsers")
    );
    runtime.userStore ??= findStore("UserStore") ?? find("getCurrentUser", "getUser");
    runtime.actions ??= (
      find("switchAccount", "removeAccount", "moveAccount")
      ?? find("switchAccount", "removeAccount")
      ?? find("switchAccount")
    );
    return runtime;
  }

  function resolveNotifications() {
    resolveRuntime();

    runtime.pushActions ??= unwrapDefault(
      find("registerDevice", "syncDevice", "unregisterDevice")
    );

    runtime.notificationTokenManager ??= unwrapDefault(
      find("registerToken", "getToken", "handleSyncWithMultiAccount")
      ?? findModule(module => {
        const value = unwrapDefault(module);
        return !!value
          && typeof value.getToken === "function"
          && typeof value.registerToken === "function"
          && typeof value.handleSyncWithMultiAccount === "function";
      })
    );

    return runtime;
  }

  function currentId() {
    resolveRuntime();
    try { return String(runtime.userStore?.getCurrentUser?.()?.id ?? ""); }
    catch { return ""; }
  }

  function entryId(entry) {
    return String(entry?.id ?? entry?.user?.id ?? "");
  }

  function getPushToken() {
    resolveNotifications();
    try { return runtime.notificationTokenManager?.getToken?.() ?? null; }
    catch { return null; }
  }

  function validUserIds() {
    resolveRuntime();
    try {
      const users = runtime.multiAccountStore?.getValidUsers?.();
      return Array.isArray(users)
        ? users.map(entryId).filter(Boolean).sort()
        : [];
    } catch {
      return [];
    }
  }

  function desiredSyncKey(activeOnly = storage.onlyActiveNotifications === true, token = getPushToken()) {
    const accounts = activeOnly ? [currentId()].filter(Boolean) : validUserIds();
    return `${activeOnly ? "active" : "default"}:${accounts.join(",")}:${String(token ?? "")}`;
  }

  function activePushSyncTokenReady() {
    resolveRuntime();
    const active = currentId();
    if (!active) return false;
    try {
      const users = runtime.multiAccountStore?.getValidUsers?.();
      const account = Array.isArray(users) ? users.find(user => entryId(user) === active) : null;
      return !!account?.pushSyncToken;
    } catch {
      return false;
    }
  }

  function syncResultSucceeded(result) {
    if (result == null) return true;
    if (result?.ok === false) return false;
    const status = Number(result?.status ?? result?.statusCode ?? NaN);
    if (Number.isFinite(status)) return status >= 200 && status < 400;
    return true;
  }

  function syncFailureText(result) {
    const status = Number(result?.status ?? result?.statusCode ?? NaN);
    return Number.isFinite(status) ? `sync failed: HTTP ${status}` : "sync failed";
  }

  function uninstallPushPatch() {
    if (!runtime.pushUnpatch) return;
    try { runtime.pushUnpatch(); } catch {}
    runtime.pushUnpatch = null;
  }

  function installPushPatch() {
    if (storage.onlyActiveNotifications !== true) {
      uninstallPushPatch();
      return false;
    }
    if (runtime.pushUnpatch) return true;

    resolveNotifications();
    const pushActions = runtime.pushActions;
    const store = runtime.multiAccountStore;
    if (typeof pushActions?.syncDevice !== "function" || typeof store?.getValidUsers !== "function") {
      runtime.notificationStatus = "waiting for Discord push modules";
      return false;
    }

    runtime.pushUnpatch = instead("syncDevice", pushActions, (args, original) => {
      if (storage.onlyActiveNotifications !== true) return original(...args);

      const active = currentId();
      if (!active) return original(...args);

      const originalGetter = store.getValidUsers;
      const ownDescriptor = Object.getOwnPropertyDescriptor(store, "getValidUsers");
      let result;

      try {
        Object.defineProperty(store, "getValidUsers", {
          configurable: true,
          writable: true,
          value: function getOnlyActiveUser() {
            const users = originalGetter.call(store);
            return Array.isArray(users)
              ? users.filter(user => entryId(user) === active)
              : users;
          },
        });

        // Discord reads getValidUsers synchronously before its first await.
        result = original(...args);
      } finally {
        try {
          if (ownDescriptor) Object.defineProperty(store, "getValidUsers", ownDescriptor);
          else delete store.getValidUsers;
        } catch {}
      }

      const key = desiredSyncKey(true, args?.[0]);
      runtime.lastNativeSyncAt = Date.now();
      runtime.lastNativeSyncKey = key;

      Promise.resolve(result)
        .then(response => {
          if (storage.onlyActiveNotifications !== true) return;
          const tokenReady = !runtime.multiAccountStore?.canUseMultiAccountNotifications || activePushSyncTokenReady();
          if (syncResultSucceeded(response) && tokenReady) {
            runtime.lastSuccessfulKey = key;
            runtime.notificationStatus = "active account only";
          } else if (!tokenReady) {
            runtime.notificationStatus = "waiting for account push token";
          } else {
            runtime.notificationStatus = syncFailureText(response);
          }
        })
        .catch(error => {
          if (storage.onlyActiveNotifications === true) {
            runtime.notificationStatus = `sync failed: ${error?.message ?? error}`;
          }
        });

      return result;
    });

    return true;
  }

  function applyPatchForMode() {
    if (storage.onlyActiveNotifications === true) return installPushPatch();
    uninstallPushPatch();
    return true;
  }

  async function performSync(force) {
    resolveNotifications();
    applyPatchForMode();

    const activeOnly = storage.onlyActiveNotifications === true;
    const manager = runtime.notificationTokenManager;
    const pushActions = runtime.pushActions;
    const token = getPushToken();

    if (!token) {
      runtime.notificationStatus = "waiting for Android push token";
      return false;
    }

    const key = desiredSyncKey(activeOnly, token);
    if (!force && runtime.lastSuccessfulKey === key) {
      runtime.notificationStatus = activeOnly ? "active account only" : "Discord default";
      return true;
    }

    try {
      let result;
      if (
        typeof pushActions?.syncDevice === "function"
        && runtime.multiAccountStore?.canUseMultiAccountNotifications
      ) {
        result = await Promise.resolve(pushActions.syncDevice(token, false));
      } else if (typeof manager?.registerToken === "function") {
        result = await Promise.resolve(manager.registerToken());
      } else {
        runtime.notificationStatus = "push registration unavailable";
        return false;
      }

      if (!syncResultSucceeded(result)) {
        runtime.notificationStatus = syncFailureText(result);
        return false;
      }

      if (
        activeOnly
        && runtime.multiAccountStore?.canUseMultiAccountNotifications
        && !activePushSyncTokenReady()
      ) {
        runtime.notificationStatus = "waiting for account push token";
        return false;
      }

      runtime.lastSuccessfulKey = key;
      runtime.notificationStatus = activeOnly ? "active account only" : "Discord default";
      return true;
    } catch (error) {
      runtime.notificationStatus = `sync failed: ${error?.message ?? error}`;
      return false;
    }
  }

  function requestSync(force = false) {
    runtime.pendingSync = true;
    runtime.pendingForce ||= force;

    if (runtime.syncInFlight) return runtime.syncInFlight;

    runtime.syncInFlight = (async () => {
      let result = false;
      while (runtime.pendingSync) {
        const runForce = runtime.pendingForce;
        const beforeKey = desiredSyncKey();
        runtime.pendingSync = false;
        runtime.pendingForce = false;
        result = await performSync(runForce);

        // If mode/account/token changed while the request was running,
        // do one final coalesced sync for the newest state.
        if (beforeKey !== desiredSyncKey()) runtime.pendingSync = true;
      }
      return result;
    })().finally(() => {
      runtime.syncInFlight = null;
    });

    return runtime.syncInFlight;
  }

  async function initializeNotificationProtection() {
    const waits = [0, 250, 750, 1500, 3000];
    for (const wait of waits) {
      if (wait) await sleep(wait);
      resolveNotifications();
      applyPatchForMode();
      if (runtime.pushActions && getPushToken()) break;
    }

    if (storage.onlyActiveNotifications === true) {
      if (getPushToken()) await requestSync(true);
      else runtime.notificationStatus = "waiting for Android push token";
    } else {
      runtime.notificationStatus = "Discord default";
    }
  }

  function armSwitchFallback(targetId) {
    if (runtime.switchFallbackTimer) clearTimeout(runtime.switchFallbackTimer);
    const startedAt = Date.now();

    runtime.switchFallbackTimer = setTimeout(() => {
      runtime.switchFallbackTimer = null;
      if (!runtime.loaded || storage.onlyActiveNotifications !== true) return;
      if (currentId() !== String(targetId)) return;

      const key = desiredSyncKey(true);
      const nativeSyncHappened = runtime.lastNativeSyncAt >= startedAt;
      if (!nativeSyncHappened || runtime.lastSuccessfulKey !== key) {
        requestSync(true).catch(() => {});
      }
    }, 8000);
  }

  function restoreDiscordNotifications() {
    uninstallPushPatch();
    resolveNotifications();

    const manager = runtime.notificationTokenManager;
    const pushActions = runtime.pushActions;
    const token = getPushToken();
    if (!token) return;

    try {
      if (
        typeof pushActions?.syncDevice === "function"
        && runtime.multiAccountStore?.canUseMultiAccountNotifications
      ) {
        Promise.resolve(pushActions.syncDevice(token, false)).catch(() => {});
      } else if (typeof manager?.registerToken === "function") {
        Promise.resolve(manager.registerToken()).catch(() => {});
      }
    } catch {}
  }

  function normalizeAccount(entry) {
    const base = entry?.user ?? entry;
    if (!base?.id) return null;

    let user = base;
    try { user = runtime.userStore?.getUser?.(String(base.id)) ?? base; } catch {}

    return {
      id: String(base.id),
      username: String(user?.username ?? base?.username ?? base.id),
      displayName: String(
        user?.globalName
        ?? user?.global_name
        ?? user?.displayName
        ?? base?.globalName
        ?? base?.global_name
        ?? base?.username
        ?? base.id,
      ),
    };
  }

  function accountList() {
    resolveRuntime();
    const found = [];
    const store = runtime.multiAccountStore;

    for (const getter of ["getValidUsers", "getUsers"]) {
      try {
        const raw = store?.[getter]?.();
        const list = Array.isArray(raw)
          ? raw
          : raw && typeof raw === "object"
            ? Object.values(raw)
            : [];

        for (const entry of list) {
          const account = normalizeAccount(entry);
          if (account) found.push(account);
        }
      } catch {}
    }

    try {
      const current = normalizeAccount(runtime.userStore?.getCurrentUser?.());
      if (current) found.push(current);
    } catch {}

    const active = currentId();
    return [...new Map(found.map(account => [account.id, account])).values()]
      .sort((a, b) => {
        if (a.id === active) return -1;
        if (b.id === active) return 1;
        return a.displayName.localeCompare(b.displayName);
      });
  }

  async function switchAccount(id) {
    resolveRuntime();
    const target = String(id ?? "");
    if (!target || target === currentId()) return;

    const fn = runtime.actions?.switchAccount;
    if (typeof fn !== "function") {
      throw new Error("Discord's multi-account switch action was not found");
    }

    await Promise.resolve(fn(target, undefined));

    // Discord normally re-syncs push registration on POST_CONNECTION_OPEN.
    // This is only a bounded repair path if that native sync never happens.
    if (storage.onlyActiveNotifications === true) armSwitchFallback(target);
  }

  function NotificationToggle({ refresh }) {
    const enabled = storage.onlyActiveNotifications === true;

    return React.createElement(RN.View, {
      style: {
        backgroundColor: C.card,
        padding: 14,
        borderRadius: 12,
        flexDirection: "row",
        alignItems: "center",
      },
    }, [
      React.createElement(RN.View, { key: "copy", style: { flex: 1, paddingRight: 12 } }, [
        React.createElement(RN.Text, {
          key: "title",
          style: { color: C.text, fontSize: 15, fontWeight: "700" },
        }, "Only notify active account"),
        React.createElement(RN.Text, {
          key: "desc",
          style: { color: C.muted, marginTop: 4, fontSize: 12, lineHeight: 17 },
        }, "Keeps Android push registration on the active account while preserving Discord's native notification behavior."),
        React.createElement(RN.Text, {
          key: "status",
          style: {
            color: enabled ? C.green : C.muted,
            marginTop: 5,
            fontSize: 11,
            lineHeight: 16,
          },
        }, `Status: ${runtime.notificationStatus}`),
      ]),
      React.createElement(RN.Switch, {
        key: "switch",
        value: enabled,
        onValueChange: value => {
          storage.onlyActiveNotifications = value;
          applyPatchForMode();
          refresh();

          requestSync(true)
            .then(ok => {
              toast(ok
                ? (value ? "Only active account will notify" : "Multi-account notifications restored")
                : "Notification sync is waiting for Discord");
              refresh();
            })
            .catch(() => {});
        },
      }),
    ]);
  }

  function Settings() {
    const [, refresh] = React.useReducer(value => value + 1, 0);
    const [switching, setSwitching] = React.useState("");

    const accounts = accountList();
    const active = currentId();
    const canSwitch = typeof runtime.actions?.switchAccount === "function";
    const Pressable = RN.Pressable ?? RN.TouchableOpacity;

    const children = [
      React.createElement(RN.View, {
        key: "intro",
        style: { backgroundColor: C.card, padding: 14, borderRadius: 12 },
      }, [
        React.createElement(RN.Text, {
          key: "title",
          style: { color: C.text, fontSize: 18, fontWeight: "700" },
        }, "Account Switcher"),
        React.createElement(RN.Text, {
          key: "desc",
          style: { color: C.muted, marginTop: 6, fontSize: 12, lineHeight: 17 },
        }, "Uses Discord's saved accounts and native switch action. Active-account notification filtering is enabled by default."),
      ]),
      React.createElement(NotificationToggle, { key: "notifications", refresh }),
      React.createElement(RN.Text, {
        key: "accounts-title",
        style: { color: C.text, fontSize: 16, fontWeight: "700" },
      }, "Accounts"),
    ];

    if (!accounts.length) {
      children.push(React.createElement(RN.View, {
        key: "empty",
        style: { backgroundColor: C.card2, padding: 13, borderRadius: 10 },
      }, React.createElement(RN.Text, {
        style: { color: C.muted, fontSize: 13, lineHeight: 18 },
      }, "No saved Discord accounts were found.")));
    } else {
      for (const account of accounts) {
        const isCurrent = account.id === active;
        const busy = switching === account.id;

        children.push(React.createElement(Pressable, {
          key: account.id,
          disabled: isCurrent || !!switching || !canSwitch,
          onPress: async () => {
            setSwitching(account.id);
            try {
              await switchAccount(account.id);
              setSwitching("");
              refresh();
            } catch (error) {
              toast(`Account switch failed: ${error?.message ?? error}`);
              setSwitching("");
              refresh();
            }
          },
          style: {
            backgroundColor: C.card,
            padding: 13,
            borderRadius: 10,
            opacity: isCurrent ? 0.7 : 1,
          },
        }, [
          React.createElement(RN.Text, {
            key: "name",
            style: { color: C.text, fontSize: 15, fontWeight: "700" },
          }, account.displayName),
          React.createElement(RN.Text, {
            key: "user",
            style: { color: isCurrent ? C.green : C.muted, fontSize: 13, marginTop: 2 },
          }, `@${account.username}${isCurrent ? " • Current" : busy ? " • Switching…" : " • Tap to switch"}`),
        ]));
      }
    }

    children.push(React.createElement(Pressable, {
      key: "refresh",
      onPress: () => {
        runtime.multiAccountStore = null;
        runtime.userStore = null;
        runtime.actions = null;
        refresh();
      },
      style: {
        backgroundColor: C.card2,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderRadius: 9,
        alignItems: "center",
      },
    }, React.createElement(RN.Text, {
      style: { color: C.text, fontWeight: "700", fontSize: 14 },
    }, "Refresh Accounts")));

    children.push(React.createElement(RN.Text, {
      key: "version",
      style: { color: C.muted, fontSize: 12, lineHeight: 17 },
    }, `v${VERSION} • switch:${canSwitch ? "yes" : "no"} • notifications:${storage.onlyActiveNotifications === true ? "active-only" : "default"}`));

    return React.createElement(
      RN.ScrollView ?? RN.View,
      {
        style: { flex: 1, backgroundColor: C.bg },
        contentContainerStyle: { padding: 16, paddingBottom: 40, gap: 12 },
      },
      children,
    );
  }

  return {
    onLoad() {
      runtime.loaded = true;
      runtime.startupTimer = setTimeout(() => {
        initializeNotificationProtection().catch(() => {});
      }, 500);
    },
    onUnload() {
      runtime.loaded = false;
      if (runtime.startupTimer) clearTimeout(runtime.startupTimer);
      if (runtime.switchFallbackTimer) clearTimeout(runtime.switchFallbackTimer);

      // Removing the plugin must not leave Discord registered in active-only mode.
      if (storage.onlyActiveNotifications === true) restoreDiscordNotifications();
      else uninstallPushPatch();
    },
    settings: Settings,
  };
})()
