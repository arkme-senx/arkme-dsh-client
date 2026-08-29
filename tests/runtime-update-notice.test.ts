import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RUNTIME_UPDATE_NOTICE_CHANGED_CHANNEL,
  RUNTIME_UPDATE_NOTICE_DISMISS_CHANNEL,
  RUNTIME_UPDATE_NOTICE_RESTART_CHANNEL,
  RUNTIME_UPDATE_NOTICE_SNAPSHOT_CHANNEL,
  RuntimeUpdateNoticeCoordinator,
  installRuntimeUpdateNoticeStyles,
  registerRuntimeUpdateNoticeIpc,
  stageRuntimeUpdateInBackground,
  type RuntimeUpdateNativeNotification,
  type RuntimeUpdateNoticeWindow
} from "../src/runtime-update-notice.js";

const harnessOrigin = "http://127.0.0.1:4173";

function fixture(options: { focused?: boolean } = {}) {
  const sent: unknown[] = [];
  const notifications: RuntimeUpdateNativeNotification[] = [];
  const clickListeners: Array<() => void> = [];
  const diagnostic = vi.fn();
  const relaunch = vi.fn();
  const quit = vi.fn();
  const window: RuntimeUpdateNoticeWindow = {
    getCurrentUrl: () => `${harnessOrigin}/workspace`,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => options.focused ?? true,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    send: vi.fn((channel, snapshot) => {
      expect(channel).toBe(RUNTIME_UPDATE_NOTICE_CHANGED_CHANNEL);
      sent.push(snapshot);
    })
  };
  const coordinator = new RuntimeUpdateNoticeCoordinator({
    getHarnessOrigin: () => harnessOrigin,
    getWindow: () => window,
    createNotification: vi.fn(({ title, body }) => {
      expect(title).toBe("arkme");
      expect(body.length).toBeGreaterThan(0);
      const notification: RuntimeUpdateNativeNotification = {
        show: vi.fn(),
        onClick(listener) { clickListeners.push(listener); },
        onFailed: vi.fn()
      };
      notifications.push(notification);
      return notification;
    }),
    relaunch,
    quit,
    diagnostic
  });
  return { clickListeners, coordinator, diagnostic, notifications, quit, relaunch, sent, window };
}

describe("RuntimeUpdateNoticeCoordinator", () => {
  it("keeps a dismissed installation hidden until completion creates a new message", () => {
    const { coordinator, sent } = fixture();

    const installing = coordinator.beginInstallation("attempt-1");
    expect(installing).toEqual({
      schemaVersion: 1,
      messageId: "attempt-1:installing",
      kind: "installing",
      visible: true
    });
    coordinator.beginInstallation("attempt-1");
    expect(sent).toHaveLength(1);

    expect(coordinator.dismiss("https://attacker.test", installing.messageId)).toBe(false);
    expect(coordinator.dismiss(`${harnessOrigin}/workspace`, "wrong-message")).toBe(false);
    expect(coordinator.dismiss(`${harnessOrigin}/workspace`, installing.messageId)).toBe(true);
    expect(coordinator.snapshot(`${harnessOrigin}/workspace`)).toMatchObject({
      messageId: installing.messageId,
      visible: false
    });

    coordinator.beginInstallation("attempt-1");
    expect(coordinator.snapshot(`${harnessOrigin}/workspace`)).toMatchObject({ visible: false });

    const installed = coordinator.completeInstallation("attempt-1");
    expect(installed).toMatchObject({
      messageId: "attempt-1:installed",
      kind: "installed",
      visible: true
    });
    expect(sent).toHaveLength(3);
  });

  it("rejects unauthorized snapshots and restart requests that are stale or not installed", () => {
    const { coordinator, quit, relaunch } = fixture();
    expect(coordinator.snapshot("file:///tmp/status.html")).toBeNull();
    const installing = coordinator.beginInstallation("attempt-2");

    expect(coordinator.restart(`${harnessOrigin}/workspace`, installing.messageId)).toBe(false);
    const installed = coordinator.completeInstallation("attempt-2");
    expect(coordinator.restart("https://attacker.test", installed.messageId)).toBe(false);
    expect(coordinator.restart(`${harnessOrigin}/workspace`, "attempt-1:installed")).toBe(false);
    expect(coordinator.restart(`${harnessOrigin}/workspace`, installed.messageId)).toBe(true);
    expect(coordinator.restart(`${harnessOrigin}/workspace`, installed.messageId)).toBe(false);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("shows native notifications only when the Harness window is not focused", () => {
    const { clickListeners, coordinator, notifications, window } = fixture({ focused: false });

    coordinator.beginInstallation("attempt-3");
    coordinator.completeInstallation("attempt-3");
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.show).toHaveBeenCalledOnce();
    clickListeners[0]?.();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();

    const foreground = fixture({ focused: true });
    foreground.coordinator.beginInstallation("attempt-4");
    expect(foreground.notifications).toHaveLength(0);
  });
});

describe("runtime update notice IPC and styles", () => {
  it("maps only bounded snapshot, dismiss and restart handlers to the coordinator", async () => {
    const { coordinator, quit, relaunch } = fixture();
    const handlers = new Map<string, (event: { senderFrame?: { url: string } | null }, value?: unknown) => unknown>();
    registerRuntimeUpdateNoticeIpc({
      handle(channel, handler) { handlers.set(channel, handler); }
    }, coordinator);

    expect([...handlers.keys()].sort()).toEqual([
      RUNTIME_UPDATE_NOTICE_DISMISS_CHANNEL,
      RUNTIME_UPDATE_NOTICE_RESTART_CHANNEL,
      RUNTIME_UPDATE_NOTICE_SNAPSHOT_CHANNEL
    ].sort());
    const installing = coordinator.beginInstallation("attempt-ipc");
    expect(await handlers.get(RUNTIME_UPDATE_NOTICE_SNAPSHOT_CHANNEL)?.({ senderFrame: { url: `${harnessOrigin}/` } }))
      .toMatchObject({ messageId: installing.messageId });
    expect(await handlers.get(RUNTIME_UPDATE_NOTICE_DISMISS_CHANNEL)?.(
      { senderFrame: { url: "https://attacker.test" } },
      installing.messageId
    )).toBe(false);
    const installed = coordinator.completeInstallation("attempt-ipc");
    expect(await handlers.get(RUNTIME_UPDATE_NOTICE_RESTART_CHANNEL)?.(
      { senderFrame: { url: `${harnessOrigin}/workspace` } },
      installed.messageId
    )).toBe(true);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("inserts fixed styles only into the active Harness page", async () => {
    const insertCSS = vi.fn(async (_css: string) => "style-key");
    const target = {
      getCurrentUrl: () => `${harnessOrigin}/workspace`,
      insertCSS
    };

    await expect(installRuntimeUpdateNoticeStyles(target, harnessOrigin)).resolves.toBe(true);
    expect(insertCSS).toHaveBeenCalledOnce();
    const insertedCss = insertCSS.mock.calls[0]?.[0] ?? "";
    expect(insertedCss).toContain("#arkme-runtime-update-notice");
    expect(insertedCss).toMatch(/width:\s*fit-content;/);
    expect(insertedCss).toMatch(/max-width:\s*min\(520px,\s*calc\(100% - 32px\)\);/);

    insertCSS.mockClear();
    await expect(installRuntimeUpdateNoticeStyles({
      ...target,
      getCurrentUrl: () => "file:///Applications/arkme.app/status.html"
    }, harnessOrigin)).resolves.toBe(false);
    expect(insertCSS).not.toHaveBeenCalled();
  });
});

describe("stageRuntimeUpdateInBackground", () => {
  it("keeps the lightweight background update flow out of manual environment reload", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "main.ts"), "utf8");
    const reloadStart = source.indexOf("async function reloadCurrentRuntimeEnvironment");
    const reloadEnd = source.indexOf("async function showActionError", reloadStart);

    expect(reloadStart).toBeGreaterThan(-1);
    expect(reloadEnd).toBeGreaterThan(reloadStart);
    expect(source.slice(reloadStart, reloadEnd)).not.toContain("finishRuntimeBootstrap");
    expect(source.slice(reloadStart, reloadEnd)).not.toContain("stageRuntimeUpdateInBackground");
  });

  it("emits installation and completion only after stageLatest starts a newer release install", async () => {
    const { coordinator } = fixture();
    await expect(stageRuntimeUpdateInBackground({
      attemptId: "attempt-5",
      coordinator,
      stageLatest: async progress => {
        progress({ kind: "runtime-installing", phase: "download", harnessPercent: 0, pluginPercent: 0 });
        progress({ kind: "runtime-installing", phase: "verify", harnessPercent: 100, pluginPercent: 100 });
        return "staged";
      }
    })).resolves.toBe("staged");

    expect(coordinator.snapshot(`${harnessOrigin}/workspace`)).toMatchObject({
      kind: "installed",
      visible: true
    });
  });

  it("does not show the lightweight notice when no background installation starts", async () => {
    for (const result of ["current", "stale", "bad", "deferred"] as const) {
      const { coordinator } = fixture();
      await expect(stageRuntimeUpdateInBackground({
        attemptId: `attempt-${result}`,
        coordinator,
        stageLatest: async () => result
      })).resolves.toBe(result);
      expect(coordinator.snapshot(`${harnessOrigin}/workspace`)).toBeNull();
    }

    const { coordinator } = fixture();
    await expect(stageRuntimeUpdateInBackground({
      attemptId: "attempt-manifest-failure",
      coordinator,
      stageLatest: async () => { throw new Error("manifest unavailable"); }
    })).rejects.toThrow("manifest unavailable");
    expect(coordinator.snapshot(`${harnessOrigin}/workspace`)).toBeNull();
  });

  it("turns a failure after installation begins into a new visible message", async () => {
    const { coordinator } = fixture();
    await expect(stageRuntimeUpdateInBackground({
      attemptId: "attempt-6",
      coordinator,
      stageLatest: async progress => {
        progress({ kind: "runtime-installing", phase: "download", harnessPercent: 1, pluginPercent: 0 });
        coordinator.dismiss(`${harnessOrigin}/workspace`, "attempt-6:installing");
        throw new Error("disk full");
      }
    })).rejects.toThrow("disk full");

    expect(coordinator.snapshot(`${harnessOrigin}/workspace`)).toMatchObject({
      messageId: "attempt-6:failed",
      kind: "failed",
      visible: true
    });
  });
});
