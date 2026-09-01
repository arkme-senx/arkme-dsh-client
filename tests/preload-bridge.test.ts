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
    attention?: unknown;
    notificationPermission?: NotificationPermission;
    requestedNotificationPermission?: NotificationPermission;
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
        if (channel === "arkme:runtime-update-notice:snapshot") return options.snapshot ?? {
          schemaVersion: 1,
          messageId: "attempt-preload:installing",
          kind: "installing",
          visible: true
        };
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
        if (channel === "arkme-desktop:attention-capabilities") return options.attention ?? {
          schemaVersion: 1,
          notificationShow: true,
          notificationPermission,
          badgeMode: "dot"
        };
        return harnessVersion;
      }
    }
  };
  vm.runInNewContext(compiled, {
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++preloadUuidSequence).padStart(12, "0")}`
    },
    document,
    Notification: {
      get permission() { return notificationPermission; },
      async requestPermission() {
        notificationPermission = options.requestedNotificationPermission ?? "granted";
        return notificationPermission;
      }
    },
    exports: {},
    module: { exports: {} },
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
      "arkme-runtime:harness-version",
      "arkme:desktop-notification:permission-state",
      "arkme-desktop:attention-capabilities"
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
