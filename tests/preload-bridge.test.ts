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

async function executePreload(
  harnessVersion: unknown,
  options: { snapshot?: unknown | Promise<unknown> } = {}
): Promise<{
  document: FakeDocument;
  emit(channel: string, value: unknown): void;
  exposed: Record<string, unknown>;
  invokeCalls: Array<{ channel: string; args: unknown[] }>;
  syncChannels: string[];
}> {
  const source = await readFile(path.join(process.cwd(), "src", "preload.cts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exposed: Record<string, unknown> = {};
  const document = new FakeDocument();
  const invokeCalls: Array<{ channel: string; args: unknown[] }> = [];
  const ipcListeners = new Map<string, Array<(event: unknown, value: unknown) => void>>();
  const syncChannels: string[] = [];
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
        return true;
      },
      on: (channel: string, listener: (event: unknown, value: unknown) => void) => {
        const listeners = ipcListeners.get(channel) ?? [];
        listeners.push(listener);
        ipcListeners.set(channel, listeners);
      },
      removeListener: (channel: string, listener: (event: unknown, value: unknown) => void) => {
        ipcListeners.set(channel, (ipcListeners.get(channel) ?? []).filter(candidate => candidate !== listener));
      },
      send: () => undefined,
      sendSync(channel: string) {
        syncChannels.push(channel);
        return harnessVersion;
      }
    }
  };
  vm.runInNewContext(compiled, {
    document,
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
    invokeCalls,
    syncChannels
  };
}

describe("desktop notification preload", () => {
  it("exposes only the bounded notification API and announces activation readiness", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "preload.cts"), "utf8");

    expect(source).toContain('contextBridge.exposeInMainWorld("arkmeDesktopNotifications"');
    expect(source).toContain("show(request");
    expect(source).toContain("onActivated(listener");
    expect(source).toContain('ipcRenderer.send("arkme:desktop-notification:ready")');
    expect(source).not.toContain("exposeInMainWorld(\"ipcRenderer\"");
  });

  it("exposes the active Release Set Harness version as a read-only desktop capability", async () => {
    const { exposed, syncChannels } = await executePreload("0.1.0-rc.8");
    const desktop = exposed.arkmeDesktop as { harnessVersion?: string };

    expect(syncChannels).toEqual(["arkme-runtime:harness-version"]);
    expect(desktop.harnessVersion).toBe("0.1.0-rc.8");
    expect(Object.isFrozen(desktop)).toBe(true);
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
