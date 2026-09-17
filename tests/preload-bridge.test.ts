import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

class FakeElement {
  id = "";
  className = "";
  textContent = "";
  type = "";
  disabled = false;
  parent: FakeElement | undefined;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();

  append(...children: FakeElement[]): void {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  click(): void { for (const listener of this.listeners.get("click") ?? []) listener(); }
  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

function findByText(root: FakeElement, text: string): FakeElement | undefined {
  if (root.textContent === text) return root;
  for (const child of root.children) {
    const match = findByText(child, text);
    if (match !== undefined) return match;
  }
  return undefined;
}

class FakeDocument {
  readonly readyState = "complete";
  readonly documentElement = new FakeElement();
  createElement(): FakeElement { return new FakeElement(); }
  addEventListener(): void {}
  removeEventListener(): void {}
  getElementById(id: string): FakeElement | null {
    const visit = (element: FakeElement): FakeElement | undefined => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const match = visit(child);
        if (match !== undefined) return match;
      }
      return undefined;
    };
    return visit(this.documentElement) ?? null;
  }
}

let preloadUuidSequence = 0;

async function executePreload(
  harnessVersion: unknown,
  options: {
    snapshot?: unknown | Promise<unknown>;
    sessionSelection?: unknown;
    selectionSave?: (value: unknown) => Promise<boolean>;
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    appSnapshot?: unknown | Promise<unknown>;
    attention?: unknown;
    harnessReadyNonce?: unknown;
    notificationPermission?: NotificationPermission;
    requestedNotificationPermission?: NotificationPermission;
    now?: () => number;
    platform?: NodeJS.Platform;
    userActivation?: () => boolean;
    runtimeRestart?: unknown | Promise<unknown>;
  } = {}
): Promise<{
  document: FakeDocument;
  emit(channel: string, value: unknown): void;
  exposed: Record<string, unknown>;
  invokeCalls: Array<{ channel: string; args: unknown[] }>;
  ipcOperations: string[];
  sendCalls: Array<{ channel: string; args: unknown[] }>;
  syncCalls: Array<{ channel: string; args: unknown[] }>;
  syncChannels: string[];
}> {
  const source = await readFile(path.join(process.cwd(), "src", "preload.cts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exposed: Record<string, unknown> = {};
  const document = new FakeDocument();
  const invokeCalls: Array<{ channel: string; args: unknown[] }> = [];
  const ipcOperations: string[] = [];
  const sendCalls: Array<{ channel: string; args: unknown[] }> = [];
  const ipcListeners = new Map<string, Array<(event: unknown, value: unknown) => void>>();
  const syncChannels: string[] = [];
  const syncCalls: Array<{ channel: string; args: unknown[] }> = [];
  let notificationPermission = options.notificationPermission ?? "default";
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: unknown) { exposed[name] = value; }
    },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        invokeCalls.push({ channel, args });
        if (channel === "arkme-session-selection:save" && options.selectionSave) return options.selectionSave(args[0]);
        if (channel === "arkme-app-update:notice") return options.appSnapshot ?? null;
        if (channel === "arkme:runtime-update-notice:snapshot") return options.snapshot ?? {
          schemaVersion: 1,
          messageId: "attempt-preload:installing",
          kind: "installing",
          visible: true
        };
        if (channel === "arkme:runtime-update-notice:restart") return options.runtimeRestart ?? true;
        if (channel === "arkme:desktop-notification:refresh-permission") return notificationPermission;
        return true;
      },
      on: (channel: string, listener: (event: unknown, value: unknown) => void) => {
        ipcOperations.push(`on:${channel}`);
        const listeners = ipcListeners.get(channel) ?? [];
        listeners.push(listener);
        ipcListeners.set(channel, listeners);
      },
      removeListener: (channel: string, listener: (event: unknown, value: unknown) => void) => {
        ipcOperations.push(`remove:${channel}`);
        ipcListeners.set(channel, (ipcListeners.get(channel) ?? []).filter(candidate => candidate !== listener));
      },
      send: (channel: string, ...args: unknown[]) => {
        ipcOperations.push(`send:${channel}`);
        sendCalls.push({ channel, args });
      },
      sendSync(channel: string, ...args: unknown[]) {
        syncChannels.push(channel);
        syncCalls.push({ channel, args });
        if (channel === "arkme:desktop-notification:permission-state") {
          const permission = args[0];
          if (permission === "default" || permission === "granted" || permission === "denied") {
            notificationPermission = permission;
          }
          return true;
        }
        if (channel === "arkme-session-selection:bootstrap") return options.sessionSelection ?? null;
        if (channel === "arkme-runtime:page-ready-nonce") return options.harnessReadyNonce ?? null;
        if (channel === "arkme-desktop:attention-capabilities") return options.attention ?? {
          schemaVersion: 1,
          notificationShow: true,
          notificationPermission,
          badgeMode: "dot"
        };
        if (channel === "arkme-app-update:app-version") return "1.2.0";
        return harnessVersion;
      }
    }
  };
  vm.runInNewContext(compiled, {
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++preloadUuidSequence).padStart(12, "0")}`
    },
    Date: { now: options.now ?? Date.now },
    document,
    localStorage: options.storage,
    Notification: {
      get permission() { return notificationPermission; },
      async requestPermission() {
        notificationPermission = options.requestedNotificationPermission ?? "granted";
        return notificationPermission;
      }
    },
    exports: {},
    module: { exports: {} },
    navigator: {
      userActivation: {
        get isActive() { return options.userActivation?.() ?? false; }
      }
    },
    process: { platform: options.platform ?? "darwin" },
    require: (specifier: string) => {
      if (specifier === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    }
  });
  return {
    document,
    emit(channel, value) {
      for (const listener of ipcListeners.get(channel) ?? []) listener({}, value);
    },
    exposed,
    ipcOperations,
    invokeCalls,
    sendCalls,
    syncCalls,
    syncChannels
  };
}

describe("desktop notification preload", () => {
  it("forwards only the directory badge count through the dedicated bridge", async () => {
    const { exposed, invokeCalls } = await executePreload("0.1.0-rc.8");
    const bridge = exposed.arkmeDesktopNotifications as { applyDirectoryBadge(count: number): Promise<boolean> };
    await bridge.applyDirectoryBadge(3);
    await bridge.applyDirectoryBadge(0);
    expect(invokeCalls.filter(call => call.channel === "arkme-desktop:directory-badge"))
      .toEqual([{ channel: "arkme-desktop:directory-badge", args: [3] }, { channel: "arkme-desktop:directory-badge", args: [0] }]);
  });
  it("exposes only the bounded notification API and announces activation readiness", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "preload.cts"), "utf8");

    expect(source).toContain('contextBridge.exposeInMainWorld("arkmeDesktopNotifications"');
    expect(source).toContain("show(request");
    expect(source).toContain("permission()");
    expect(source).toContain("requestPermission()");
    expect(source).toContain("refreshPermission()");
    expect(source).toContain("openSettings()");
    expect(source).toContain("onPermissionChanged(listener");
    expect(source).toContain("onActivated(listener");
    expect(source).toContain("onActivation(listener");
    expect(source).toContain("onActivationV2(listener");
    expect(source).toContain("completeActivationV2(");
    expect(source).toContain('ipcRenderer.send("arkme:desktop-notification:ready")');
    expect(source).not.toContain("exposeInMainWorld(\"ipcRenderer\"");
  });

  it("exposes the active Release Set Harness version as a read-only desktop capability", async () => {
    const { exposed, syncChannels } = await executePreload("0.1.0-rc.8");
    const desktop = exposed.arkmeDesktop as {
      harnessVersion?: string;
      attention: { notificationShow: boolean; notificationPermission: string; badgeMode: string };
    };

    expect(syncChannels).toEqual([
      "arkme-session-selection:bootstrap",
      "arkme-runtime:harness-version",
      "arkme:desktop-notification:permission-state",
      "arkme-desktop:attention-capabilities",
      "arkme-runtime:page-ready-nonce",
      "arkme-app-update:app-version"
    ]);
    expect(desktop.harnessVersion).toBe("0.1.0-rc.8");
    expect(desktop.attention).toEqual({
      schemaVersion: 1,
      notificationShow: true,
      notificationPermission: "default",
      badgeMode: "dot"
    });
    expect(Object.isFrozen(desktop.attention)).toBe(true);
    expect(Object.isFrozen(desktop)).toBe(true);
  });

  it("treats the renderer's first legacy update check as a status read and preserves later manual checks", async () => {
    const { exposed, invokeCalls } = await executePreload("0.1.0-rc.8");
    const desktop = exposed.arkmeDesktop as {
      update: { check(): Promise<unknown> };
    };

    await desktop.update.check();
    await desktop.update.check();

    expect(invokeCalls.filter(call => call.channel === "arkme-app-update:status" || call.channel === "arkme-app-update:check")).toEqual([
      { channel: "arkme-app-update:status", args: [] },
      { channel: "arkme-app-update:check", args: [] }
    ]);
  });

  it("exposes restart-and-install only through the frozen desktop update bridge", async () => {
    const { exposed, invokeCalls } = await executePreload("0.1.0-rc.8");
    const desktop = exposed.arkmeDesktop as {
      update: { install(): Promise<unknown> };
    };

    await desktop.update.install();

    expect(invokeCalls).toContainEqual({ channel: "arkme-app-update:install", args: [] });
    expect(Object.isFrozen(desktop.update)).toBe(true);
  });

  it("freezes the notification facade and validates typed activation events", async () => {
    const { emit, exposed, invokeCalls, sendCalls, syncCalls } = await executePreload("0.1.0-rc.8", {
      notificationPermission: "default",
      requestedNotificationPermission: "granted"
    });
    const notifications = exposed.arkmeDesktopNotifications as {
      show(value: unknown): Promise<unknown>;
      onActivation(listener: (value: unknown) => void): () => void;
      permission(): NotificationPermission | "unavailable";
      requestPermission(): Promise<NotificationPermission | "unavailable">;
      refreshPermission(): Promise<NotificationPermission | "unavailable">;
      openSettings(): Promise<boolean>;
      onPermissionChanged(listener: (permission: NotificationPermission | "unavailable") => void): () => void;
    };
    const listener = vi.fn();
    const dispose = notifications.onActivation(listener);

    expect(Object.isFrozen(notifications)).toBe(true);
    expect(notifications.permission()).toBe("default");
    await expect(notifications.requestPermission()).resolves.toBe("granted");
    await expect(notifications.refreshPermission()).resolves.toBe("granted");
    await expect(notifications.openSettings()).resolves.toBe(true);
    const permissionListener = vi.fn();
    const stopPermission = notifications.onPermissionChanged(permissionListener);
    emit("arkme:desktop-notification:permission-changed", "denied");
    expect(permissionListener).toHaveBeenCalledWith("denied");
    stopPermission();
    expect(syncCalls).toContainEqual({
      channel: "arkme:desktop-notification:permission-state",
      args: ["granted"]
    });
    expect(invokeCalls).toContainEqual({
      channel: "arkme:desktop-notification:open-settings",
      args: []
    });
    expect(invokeCalls).toContainEqual({
      channel: "arkme:desktop-notification:refresh-permission",
      args: []
    });
    const legacyRequest = {
      eventUid: "legacy-event",
      sourceRef: "opaque-source",
      sourceKey: "group:stable-id",
      sourceKind: "group_chat",
      title: "群聊",
      body: "新消息",
      eventAtMillis: 1_700_000_000_000
    };
    await notifications.show(legacyRequest);
    expect(invokeCalls).toContainEqual({
      channel: "arkme:desktop-notification:show",
      args: [legacyRequest]
    });
    expect(sendCalls).toContainEqual({ channel: "arkme:desktop-notification:ready", args: [] });
    emit("arkme:desktop-notification:activated-v1", {
      kind: "chat-source",
      sourceRef: "opaque-source",
      sourceKey: "group:stable-id"
    });
    emit("arkme:desktop-notification:activated-v1", {
      kind: "chat-source",
      sourceRef: "opaque-source",
      arbitraryUrl: "https://attacker.test"
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
    expect(listener).toHaveBeenCalledWith({
      kind: "chat-source",
      sourceRef: "opaque-source",
      sourceKey: "group:stable-id"
    });

    emit("arkme:desktop-notification:activated-v1", {
      kind: "chat-source",
      sourceRef: "opaque-source",
      sourceKey: " ",
    });
    expect(listener).toHaveBeenCalledOnce();

    dispose();
  });

  it("provides a strict acknowledged V2 activation lifecycle for each preload document", async () => {
    const { emit, exposed, ipcOperations, sendCalls } = await executePreload("0.1.0-rc.8");
    const notifications = exposed.arkmeDesktopNotifications as {
      onActivationV2(listener: (value: unknown) => void): () => void;
      completeActivationV2(activationId: string, outcome: string): boolean;
    };
    const listener = vi.fn();
    const dispose = notifications.onActivationV2(listener);
    const readyCall = sendCalls.find(call => call.channel === "arkme:desktop-notification:ready-v2");
    expect(readyCall?.args).toHaveLength(1);
    const readyEnvelope = readyCall?.args[0] as { consumerId: string };
    expect(readyEnvelope.consumerId).toMatch(/^preload-[a-zA-Z0-9-]+$/u);
    expect(readyEnvelope.consumerId.length).toBeLessThanOrEqual(128);
    expect(Object.isFrozen(readyEnvelope)).toBe(true);
    expect(ipcOperations.indexOf("on:arkme:desktop-notification:activated-v2"))
      .toBeLessThan(ipcOperations.indexOf("send:arkme:desktop-notification:ready-v2"));

    emit("arkme:desktop-notification:activated-v2", {
      activationId: "activation-1",
      kind: "chat-source",
      sourceRef: "opaque-source",
      sourceKey: "group:stable-id"
    });
    emit("arkme:desktop-notification:activated-v2", {
      activationId: "activation-expanded",
      kind: "chat-source",
      sourceRef: "opaque-source",
      sourceKey: "group:stable-id",
      arbitraryUrl: "https://attacker.test"
    });
    emit("arkme:desktop-notification:activated-v2", {
      activationId: " ",
      kind: "chat-source",
      sourceRef: "opaque-source"
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      activationId: "activation-1",
      kind: "chat-source",
      sourceRef: "opaque-source",
      sourceKey: "group:stable-id"
    });
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);

    expect(notifications.completeActivationV2("activation-1", "resolved")).toBe(true);
    expect(notifications.completeActivationV2(" ", "resolved")).toBe(false);
    expect(notifications.completeActivationV2("activation-1", "retry")).toBe(false);
    expect(sendCalls).toContainEqual({
      channel: "arkme:desktop-notification:result-v2",
      args: [{
        consumerId: readyEnvelope.consumerId,
        activationId: "activation-1",
        outcome: "resolved"
      }]
    });

    dispose();
    dispose();
    expect(ipcOperations.indexOf("remove:arkme:desktop-notification:activated-v2"))
      .toBeLessThan(ipcOperations.indexOf("send:arkme:desktop-notification:unready-v2"));
    expect(sendCalls.filter(call => call.channel === "arkme:desktop-notification:unready-v2"))
      .toEqual([{
        channel: "arkme:desktop-notification:unready-v2",
        args: [{ consumerId: readyEnvelope.consumerId }]
      }]);
    emit("arkme:desktop-notification:activated-v2", {
      activationId: "activation-after-dispose",
      kind: "chat-source",
      sourceRef: "opaque-source"
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("uses a different bounded V2 consumer ID for each preload document", async () => {
    const first = await executePreload("0.1.0-rc.8");
    const second = await executePreload("0.1.0-rc.8");
    const firstNotifications = first.exposed.arkmeDesktopNotifications as {
      onActivationV2(listener: (value: unknown) => void): () => void;
    };
    const secondNotifications = second.exposed.arkmeDesktopNotifications as {
      onActivationV2(listener: (value: unknown) => void): () => void;
    };
    const stopFirst = firstNotifications.onActivationV2(() => undefined);
    const stopSecond = secondNotifications.onActivationV2(() => undefined);
    const firstId = (first.sendCalls.find(call => call.channel.endsWith("ready-v2"))?.args[0] as {
      consumerId: string;
    }).consumerId;
    const secondId = (second.sendCalls.find(call => call.channel.endsWith("ready-v2"))?.args[0] as {
      consumerId: string;
    }).consumerId;
    expect(firstId).not.toBe(secondId);
    expect(firstId.length).toBeLessThanOrEqual(128);
    expect(secondId.length).toBeLessThanOrEqual(128);
    stopFirst();
    stopSecond();
  });

  it("installs the private runtime update renderer without exposing it to the Arkme plugin", async () => {
    const { document, emit, exposed, invokeCalls } = await executePreload("0.1.0-rc.8");

    await vi.waitFor(() => expect(document.getElementById("arkme-runtime-update-notice")).not.toBeNull());
    const installing = document.getElementById("arkme-runtime-update-notice")!;
    expect(findByText(installing, "已检测到新版，正在后台安装…")).toBeDefined();
    findByText(installing, "×")?.click();
    await vi.waitFor(() => expect(invokeCalls).toContainEqual({
      channel: "arkme:runtime-update-notice:dismiss",
      args: ["attempt-preload:installing"]
    }));

    emit("arkme:runtime-update-notice:changed", {
      schemaVersion: 1,
      messageId: "attempt-preload:installed",
      kind: "installed",
      visible: true
    });
    const installed = document.getElementById("arkme-runtime-update-notice")!;
    expect(findByText(installed, "新版本已安装，重启后激活。")).toBeDefined();
    findByText(installed, "立即重启")?.click();
    await vi.waitFor(() => expect(invokeCalls).toContainEqual({
      channel: "arkme:runtime-update-notice:restart",
      args: ["attempt-preload:installed"]
    }));
    expect(invokeCalls.some(call => call.channel === "arkme:runtime-update-notice:snapshot")).toBe(true);
    expect(exposed.arkmeRuntimeUpdateNotice).toBeUndefined();
  });

  it("hides the private notice for malformed and explicitly hidden snapshots", async () => {
    const { document, emit } = await executePreload("0.1.0-rc.8");
    await vi.waitFor(() => expect(document.getElementById("arkme-runtime-update-notice")).not.toBeNull());

    emit("arkme:runtime-update-notice:changed", {
      schemaVersion: 2,
      messageId: "malformed",
      kind: "installed",
      visible: true
    });
    expect(document.getElementById("arkme-runtime-update-notice")).toBeNull();
    emit("arkme:runtime-update-notice:changed", {
      schemaVersion: 1,
      messageId: "attempt-preload:failed",
      kind: "failed",
      visible: false
    });
    expect(document.getElementById("arkme-runtime-update-notice")).toBeNull();
  });

  it("does not let a stale startup snapshot overwrite a newer changed event", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    const snapshot = new Promise<unknown>(resolve => { resolveSnapshot = resolve; });
    const { document, emit } = await executePreload("0.1.0-rc.8", { snapshot });

    emit("arkme:runtime-update-notice:changed", {
      schemaVersion: 1,
      messageId: "attempt-preload:installed",
      kind: "installed",
      visible: true
    });
    expect(findByText(document.documentElement, "新版本已安装，重启后激活。")).toBeDefined();

    resolveSnapshot({
      schemaVersion: 1,
      messageId: "attempt-preload:installing",
      kind: "installing",
      visible: true
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(findByText(document.documentElement, "新版本已安装，重启后激活。")).toBeDefined();
    expect(findByText(document.documentElement, "已检测到新版，正在后台安装…")).toBeUndefined();
  });
});

describe("desktop location preload", () => {
  it("exposes the fixed read/request/settings contract", async () => {
    const { exposed } = await executePreload("0.1.0-rc.8");
    const bridge = exposed.arkmeDesktopLocation as Record<string, unknown>;

    expect(Object.keys(bridge).sort()).toEqual([
      "openSettings",
      "permissionState",
      "requestPermission"
    ]);
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  it("does not shadow the existing browser location path outside macOS", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const { exposed } = await executePreload("0.1.0-rc.8", { platform });
      expect(exposed.arkmeDesktopLocation).toBeUndefined();
    }
  });

  it("allows status without activation but blocks permission mutations", async () => {
    const { exposed, invokeCalls } = await executePreload("0.1.0-rc.8");
    const bridge = exposed.arkmeDesktopLocation as {
      permissionState(): Promise<unknown>;
      requestPermission(): Promise<unknown>;
      openSettings(): Promise<boolean>;
    };

    await bridge.permissionState();
    await expect(bridge.requestPermission()).resolves.toEqual({
      schemaVersion: 1,
      state: "unavailable"
    });
    await expect(bridge.openSettings()).resolves.toBe(false);
    expect(invokeCalls.filter(call => call.channel.startsWith("arkme:desktop-location"))).toEqual([
      { channel: "arkme:desktop-location:permission-state", args: [] }
    ]);
  });

  it("carries one real activation across the status IPC roundtrip and consumes the lease", async () => {
    let active = true;
    let now = 1_000;
    const { exposed, invokeCalls } = await executePreload("0.1.0-rc.8", {
      now: () => now,
      userActivation: () => active
    });
    const bridge = exposed.arkmeDesktopLocation as {
      permissionState(): Promise<unknown>;
      requestPermission(): Promise<unknown>;
    };

    await bridge.permissionState();
    active = false;
    now += 100;
    await bridge.requestPermission();
    await expect(bridge.requestPermission()).resolves.toEqual({
      schemaVersion: 1,
      state: "unavailable"
    });
    expect(invokeCalls).toContainEqual({
      channel: "arkme:desktop-location:request-permission",
      args: [{ userActivation: true }]
    });
    expect(invokeCalls.filter(call => call.channel === "arkme:desktop-location:request-permission"))
      .toHaveLength(1);
  });

  it("expires the activation lease after a bounded IPC allowance", async () => {
    let active = true;
    let now = 10_000;
    const { exposed, invokeCalls } = await executePreload("0.1.0-rc.8", {
      now: () => now,
      userActivation: () => active
    });
    const bridge = exposed.arkmeDesktopLocation as {
      permissionState(): Promise<unknown>;
      requestPermission(): Promise<unknown>;
    };

    await bridge.permissionState();
    active = false;
    now += 2_001;
    await expect(bridge.requestPermission()).resolves.toEqual({
      schemaVersion: 1,
      state: "unavailable"
    });
    expect(invokeCalls.some(call => call.channel === "arkme:desktop-location:request-permission"))
      .toBe(false);
  });

  it("allows a directly activated settings request", async () => {
    const { exposed, invokeCalls } = await executePreload("0.1.0-rc.8", {
      userActivation: () => true
    });
    const bridge = exposed.arkmeDesktopLocation as { openSettings(): Promise<boolean> };

    await expect(bridge.openSettings()).resolves.toBe(true);
    expect(invokeCalls).toContainEqual({
      channel: "arkme:desktop-location:open-settings",
      args: [{ userActivation: true }]
    });
  });
});


describe("independent APP update preload UI", () => {
  const state = (status: string, extras = {}) => ({
    schemaVersion: 1, revision: 1, expanded: true, websiteOpening: false,
    state: { status, currentVersion: '1.2.0', currentVersionCode: 1, canAutoInstall: true, latestVersion: '1.3.0', latestVersionCode: 2, ...extras },
  });
  it('renders download/install/website actions without loading a plugin', async () => {
    const f = await executePreload(undefined, { appSnapshot: state('downloading') });
    await vi.waitFor(() => expect(findByText(f.document.documentElement, '正在后台下载')).toBeDefined());
    expect(findByText(f.document.documentElement, '下载更新')).toBeUndefined();
    f.emit('arkme-app-update:changed', { ...state('downloaded'), revision: 2 });
    findByText(f.document.documentElement, '重启并安装')?.click();
    expect(f.invokeCalls).toContainEqual({ channel: 'arkme-app-update:install', args: [] });
    f.emit('arkme-app-update:changed', { ...state('failed', { error: 'offline' }), revision: 3 });
    findByText(f.document.documentElement, '下载最新版本')?.click();
    expect(f.invokeCalls).toContainEqual({ channel: 'arkme-app-update:open-website', args: [] });
  });
  it('shows Linux website action and removes the whole notice after closing', async () => {
    const f = await executePreload(undefined, { appSnapshot: state('available', { canAutoInstall: false }) });
    await vi.waitFor(() => expect(findByText(f.document.documentElement, '下载最新版本')).toBeDefined());
    f.emit('arkme-app-update:changed', { ...state('available'), revision: 2, expanded: false });
    expect(f.document.getElementById('arkme-app-update-notice')).toBeNull();
    expect(findByText(f.document.documentElement, 'APP 更新')).toBeUndefined();
    const desktop = f.exposed.arkmeDesktop as { update: { open(): Promise<boolean> } };
    await desktop.update.open();
    expect(f.invokeCalls).toContainEqual({ channel: 'arkme-app-update:open', args: [] });
    f.emit('arkme-app-update:changed', { ...state('downloaded'), revision: 3 });
    expect(findByText(f.document.documentElement, '重启并安装')).toBeDefined();
  });
  it.each(['idle', 'checking', 'current', 'failed'])('renders nothing for %s without a confirmed newer release', async status => {
    const f = await executePreload(undefined, { appSnapshot: state(status, { latestVersion: undefined, latestVersionCode: undefined }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.document.getElementById('arkme-app-update-notice')).toBeNull();
    f.emit('arkme-app-update:changed', { ...state(status), revision: 2, expanded: false });
    expect(f.document.getElementById('arkme-app-update-notice')).toBeNull();
  });
  it('retains the website fallback when a previously incomplete installation is ready from cache', async () => {
    const f = await executePreload(undefined, { appSnapshot: state('downloaded', { installWarning: '上次安装未完成' }) });
    await vi.waitFor(() => expect(findByText(f.document.documentElement, '上次安装未完成')).toBeDefined());
    expect(findByText(f.document.documentElement, '下载最新版本')).toBeDefined();
  });
  it('shows a known target version while downloading and after download or install failure', async () => {
    const f = await executePreload(undefined, { appSnapshot: state('downloading') });
    await vi.waitFor(() => expect(findByText(f.document.documentElement, '检测到新版本 v1.3.0')).toBeDefined());

    f.emit('arkme-app-update:changed', { ...state('failed', { failureStage: 'download', error: 'checksum mismatch' }), revision: 2 });
    expect(findByText(f.document.documentElement, 'v1.3.0 更新未完成')).toBeDefined();

    f.emit('arkme-app-update:changed', { ...state('failed', { failureStage: 'install', error: '上次安装未完成，请重新尝试' }), revision: 3 });
    expect(findByText(f.document.documentElement, 'v1.3.0 更新未完成')).toBeDefined();
  });
  it('keeps runtime restart disabled when APP installing renders before or after runtime', async () => {
    const f = await executePreload(undefined, {
      snapshot: { schemaVersion: 1, messageId: 'runtime-ready', kind: 'installed', visible: true },
      appSnapshot: state('available')
    });
    await vi.waitFor(() => expect(findByText(f.document.documentElement, '立即重启')).toBeDefined());

    f.emit('arkme-app-update:changed', { ...state('installing'), revision: 2 });
    expect(findByText(f.document.documentElement, '立即重启')?.disabled).toBe(true);

    f.emit('arkme:runtime-update-notice:changed', {
      schemaVersion: 1, messageId: 'runtime-repaint', kind: 'installed', visible: true
    });
    expect(findByText(f.document.documentElement, '立即重启')?.disabled).toBe(true);
  });
  it('does not re-enable runtime restart after rejection while APP is installing', async () => {
    let rejectRestart!: (error: Error) => void;
    const runtimeRestart = new Promise<unknown>((_resolve, reject) => { rejectRestart = reject; });
    const f = await executePreload(undefined, {
      snapshot: { schemaVersion: 1, messageId: 'runtime-ready', kind: 'installed', visible: true },
      appSnapshot: state('available'), runtimeRestart
    });
    await vi.waitFor(() => expect(findByText(f.document.documentElement, '立即重启')).toBeDefined());
    findByText(f.document.documentElement, '立即重启')?.click();
    f.emit('arkme-app-update:changed', { ...state('installing'), revision: 2 });
    rejectRestart(new Error('restart rejected'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(findByText(f.document.documentElement, '立即重启')?.disabled).toBe(true);
  });
  it('keeps runtime restart disabled across APP updates until a false restart result clears pending', async () => {
    let resolveRestart!: (accepted: boolean) => void;
    const runtimeRestart = new Promise<boolean>(resolve => { resolveRestart = resolve; });
    const f = await executePreload(undefined, {
      snapshot: { schemaVersion: 1, messageId: 'runtime-ready', kind: 'installed', visible: true },
      appSnapshot: state('available'), runtimeRestart
    });
    await vi.waitFor(() => expect(findByText(f.document.documentElement, '立即重启')).toBeDefined());
    findByText(f.document.documentElement, '立即重启')?.click();

    f.emit('arkme-app-update:changed', { ...state('checking'), revision: 2 });
    expect(findByText(f.document.documentElement, '立即重启')?.disabled).toBe(true);
    f.emit('arkme-app-update:changed', { ...state('downloading'), revision: 3 });
    expect(findByText(f.document.documentElement, '立即重启')?.disabled).toBe(true);

    resolveRestart(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(findByText(f.document.documentElement, '立即重启')?.disabled).toBe(false);
  });
  it('ignores a late snapshot and stale events, keeps APP and runtime in a common stack', async () => {
    let finish!: (value: unknown) => void;
    const f = await executePreload(undefined, { appSnapshot: new Promise(resolve => { finish = resolve; }) });
    f.emit('arkme-app-update:changed', { ...state('downloaded'), revision: 5 });
    finish(state('available'));
    await Promise.resolve(); await Promise.resolve();
    f.emit('arkme-app-update:changed', { ...state('available'), revision: 4 });
    expect(findByText(f.document.documentElement, '重启并安装')).toBeDefined();
    await vi.waitFor(() => expect(f.document.getElementById('arkme-runtime-update-notice')).not.toBeNull());
    const app = f.document.getElementById('arkme-app-update-notice');
    const runtime = f.document.getElementById('arkme-runtime-update-notice');
    expect(app?.parent?.id).toBe('arkme-desktop-update-notices');
    expect(runtime?.parent).toBe(app?.parent);
  });
  it('exposes read-only status subscriptions and no folder-opening bridge', async () => {
    const f = await executePreload(undefined);
    const desktop = f.exposed.arkmeDesktop as { appUpdateUi: boolean; appVersion: string; update: { onChanged(listener: (state: unknown) => void): () => void; showInFolder?: unknown } };
    expect(desktop.appUpdateUi).toBe(true);
    expect(desktop.appVersion).toBe('1.2.0');
    expect(desktop.update.showInFolder).toBeUndefined();
    const listener = vi.fn(); const stop = desktop.update.onChanged(listener);
    f.emit('arkme-app-update:changed', state('available'));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'available' }));
    stop(); f.emit('arkme-app-update:changed', { ...state('downloaded'), revision: 2 });
    expect(listener).toHaveBeenCalledOnce();
  });
});


it("readiness bridge uses the main-owned document nonce and exposes no nonce argument", async () => {
  const first = await executePreload("0.1.1-rc.2", {harnessReadyNonce:"document-one"});
  const second = await executePreload("0.1.1-rc.2", {harnessReadyNonce:"document-two"});
  for (const result of [first, second]) {
    const bridge = result.exposed.arkmeDesktop as {notifyHarnessReady: (...args: unknown[]) => void};
    bridge.notifyHarnessReady("spoofed-nonce");
    bridge.notifyHarnessReady();
  }
  expect(first.sendCalls.filter(call => call.channel === "arkme-runtime:page-ready")).toEqual([{channel:"arkme-runtime:page-ready",args:["document-one"]}]);
  expect(second.sendCalls.filter(call => call.channel === "arkme-runtime:page-ready")).toEqual([{channel:"arkme-runtime:page-ready",args:["document-two"]}]);
  const unauthorized = await executePreload("0.1.1-rc.2");
  (unauthorized.exposed.arkmeDesktop as {notifyHarnessReady:()=>void}).notifyHarnessReady();
  expect(unauthorized.sendCalls.some(call => call.channel === "arkme-runtime:page-ready")).toBe(false);
});
describe("desktop device preload", () => {
  it("exposes the device snapshot through the bounded main-process reader", async () => {
    const { exposed, invokeCalls } = await executePreload("test");
    const desktop = exposed.arkmeDesktop as { device: { snapshot(): Promise<unknown> } };
    await desktop.device.snapshot();
    expect(invokeCalls).toContainEqual({ channel: "arkme-desktop:device-snapshot", args: [] });
    const main = await readFile(path.join(process.cwd(), "src", "main.ts"), "utf8");
    expect(main).toContain('isCurrentAppUpdateSender(event) ? readDesktopDevice() : null');
  });
});


describe("account session selection preload", () => {
  it("seeds the official restore key before page scripts and binds saves to this document lease", async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const preload = await executePreload("0.1.5-rc.2", { storage, sessionSelection: { lease: "document-A", sessionId: "session-A" } });
    expect(JSON.parse(values.get("dsh.sessions.current")!)).toEqual({ sessionId: "session-A" });
    const bridge = (preload.exposed.arkmeDesktop as { sessionSelection: { restore(): string | null; save(sessionId: string): Promise<boolean> } }).sessionSelection;
    // The outer runtime may clear the underlying key before the iframe boots.
    values.set("dsh.sessions.current", "{}");
    expect(bridge.restore()).toBe('{"sessionId":"session-A"}');
    expect(await bridge.save("session-B")).toBe(true);
    expect(bridge.restore()).toBe('{"sessionId":"session-B"}');
    expect(preload.invokeCalls.at(-1)).toEqual({ channel: "arkme-session-selection:save", args: [{ lease: "document-A", sessionId: "session-B" }] });
  });

  it("clears a previous origin selection for a fresh account but leaves unrelated storage alone", async () => {
    const values = new Map([["dsh.sessions.current", '{"sessionId":"other-account"}'], ["theme", "dark"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    await executePreload("0.1.5-rc.2", { storage, sessionSelection: { lease: "document-B", sessionId: null } });
    expect(values.has("dsh.sessions.current")).toBe(false);
    expect(values.get("theme")).toBe("dark");
  });

  it("does not enable persistence on status, guest or trial pages", async () => {
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    for (const sessionSelection of [null, { lease: null, sessionId: null }, { lease: null, sessionId: "trial" }]) {
      const preload = await executePreload("0.1.5-rc.2", { storage, sessionSelection });
      const bridge = (preload.exposed.arkmeDesktop as { sessionSelection?: { restore(): string | null; save(id: string): Promise<boolean> } }).sessionSelection;
      if (sessionSelection === null) expect(bridge).toBeUndefined();
      else {
        expect(await bridge!.save("must-not-persist")).toBe(false);
        expect(bridge!.restore()).toBe(sessionSelection.sessionId === null ? null : '{"sessionId":"trial"}');
      }
      expect(preload.invokeCalls.some(call => call.channel === "arkme-session-selection:save")).toBe(false);
    }
  });
});


it("retains the latest acknowledged restore value when a newer save fails", async () => {
  let resolveB!: (value: boolean) => void;
  let rejectC!: (error: Error) => void;
  const b = new Promise<boolean>(resolve => { resolveB = resolve; });
  const c = new Promise<boolean>((_resolve, reject) => { rejectC = reject; });
  const preload = await executePreload("0.1.5-rc.2", {
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionSelection: { lease: "doc", sessionId: "A" },
    selectionSave: value => (value as { sessionId: string }).sessionId === "B" ? b : c
  });
  const bridge = (preload.exposed.arkmeDesktop as { sessionSelection: { restore(): string | null; save(id: string): Promise<boolean> } }).sessionSelection;
  const saveB = bridge.save("B");
  const saveC = bridge.save("C").catch(() => false);
  resolveB(true);
  await saveB;
  expect(bridge.restore()).toBe('{"sessionId":"B"}');
  rejectC(new Error("disk full"));
  await saveC;
  expect(bridge.restore()).toBe('{"sessionId":"B"}');
});
