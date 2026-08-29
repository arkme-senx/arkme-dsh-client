import { describe, expect, it, vi } from "vitest";
import {
  DesktopNotificationCoordinator,
  type DesktopNotificationRequest,
  type HarnessNotificationWindow,
  type NativeNotification
} from "../src/desktop-notification.js";

const request: DesktopNotificationRequest = {
  eventUid: "event-1",
  sourceRef: "arkme-source-v1.payload.signature",
  sourceKind: "private_chat",
  title: "林溪",
  body: "你好",
  eventAtMillis: 1_700_000_000_000
};

function fixture(limits: {
  maxActiveNotifications?: number;
  maxPendingActivations?: number;
  failOnShow?: string;
  throwOnShow?: boolean;
} = {}) {
  const { failOnShow, throwOnShow = false, ...coordinatorLimits } = limits;
  const clickListeners: Array<() => void> = [];
  const notifications: NativeNotification[] = [];
  const diagnostic = vi.fn();
  const window: HarnessNotificationWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    send: vi.fn()
  };
  const coordinator = new DesktopNotificationCoordinator({
    getHarnessOrigin: () => "http://127.0.0.1:4173",
    getWindow: () => window,
    createNotification: vi.fn(options => {
      let showListener: (() => void) | undefined;
      let failedListener: ((error: string) => void) | undefined;
      const notification = {
        show: vi.fn(() => {
          if (throwOnShow) throw new Error("notifications unavailable");
          if (failOnShow === undefined) showListener?.();
          else failedListener?.(failOnShow);
        }),
        close: vi.fn(),
        onClick(listener: () => void) { clickListeners.push(listener); },
        onShow(listener: () => void) { showListener = listener; },
        onFailed(listener: (error: string) => void) { failedListener = listener; }
      } as NativeNotification & {
        onShow(listener: () => void): void;
        onFailed(listener: (error: string) => void): void;
      };
      notifications.push(notification);
      expect(options).toEqual({ title: request.title, body: request.body });
      return notification;
    }),
    diagnostic,
    ...coordinatorLimits
  });
  return { clickListeners, coordinator, diagnostic, notifications, window };
}

describe("DesktopNotificationCoordinator", () => {
  it("accepts only the active Harness origin and bounded notification payloads", () => {
    const { coordinator, diagnostic, notifications } = fixture();

    expect(coordinator.show("https://attacker.test/page", request)).toEqual({ shown: false });
    expect(coordinator.show("not a URL", request)).toEqual({ shown: false });
    expect(coordinator.show("http://127.0.0.1:4173/chat", { ...request, title: "x".repeat(129) }))
      .toEqual({ shown: false });
    expect(coordinator.show("http://127.0.0.1:4173/chat", request)).toEqual({ shown: true });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.show).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("notification_shown", { eventUid: request.eventUid });
  });

  it("deduplicates event UIDs before creating native notifications", () => {
    const { coordinator, notifications } = fixture();

    expect(coordinator.show("http://127.0.0.1:4173", request)).toEqual({ shown: true });
    expect(coordinator.show("http://127.0.0.1:4173", request)).toEqual({ shown: false });
    expect(notifications).toHaveLength(1);
  });

  it("silently degrades when the operating system rejects display", () => {
    const { coordinator } = fixture({ throwOnShow: true });

    expect(() => coordinator.show("http://127.0.0.1:4173", request)).not.toThrow();
    expect(coordinator.show("http://127.0.0.1:4173", request)).toEqual({ shown: false });
  });

  it("reports an asynchronous native notification failure instead of claiming it was shown", () => {
    const { coordinator, diagnostic } = fixture({
      failOnShow: "Notifications require a code-signed application"
    });

    expect(coordinator.show("http://127.0.0.1:4173", request)).toEqual({ shown: true });
    expect(diagnostic).toHaveBeenCalledWith("notification_failed", {
      eventUid: request.eventUid,
      error: "Notifications require a code-signed application"
    });
    expect(diagnostic).not.toHaveBeenCalledWith("notification_shown", expect.anything());
  });

  it("restores and focuses the window, then queues activation until the Harness listener is ready", () => {
    const { clickListeners, coordinator, diagnostic, window } = fixture();
    coordinator.show("http://127.0.0.1:4173", request);

    clickListeners[0]?.();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("notification_activated", { eventUid: request.eventUid });
    expect(window.send).not.toHaveBeenCalled();

    expect(coordinator.markHarnessReady("https://attacker.test")).toBe(false);
    expect(coordinator.markHarnessReady("http://127.0.0.1:4173/chat")).toBe(true);
    expect(window.send).toHaveBeenCalledWith("arkme:desktop-notification:activated", request.sourceRef);
  });

  it("delivers activation immediately while ready and returns to queueing on navigation", () => {
    const { clickListeners, coordinator, window } = fixture();
    coordinator.markHarnessReady("http://127.0.0.1:4173");
    coordinator.show("http://127.0.0.1:4173", request);
    clickListeners[0]?.();
    expect(window.send).toHaveBeenCalledTimes(1);

    coordinator.markHarnessLoading();
    coordinator.show("http://127.0.0.1:4173", { ...request, eventUid: "event-2" });
    clickListeners[1]?.();
    expect(window.send).toHaveBeenCalledTimes(1);
    coordinator.markHarnessReady("http://127.0.0.1:4173");
    expect(window.send).toHaveBeenCalledTimes(2);
  });

  it("bounds active notifications and retains only the newest queued activation", () => {
    const { clickListeners, coordinator, notifications, window } = fixture({
      maxActiveNotifications: 1,
      maxPendingActivations: 1
    });
    const second = { ...request, eventUid: "event-2", sourceRef: "source-2" };

    coordinator.show("http://127.0.0.1:4173", request);
    coordinator.show("http://127.0.0.1:4173", second);
    expect(notifications[0]?.close).toHaveBeenCalledOnce();
    clickListeners[0]?.();
    clickListeners[1]?.();
    coordinator.markHarnessReady("http://127.0.0.1:4173");
    expect(window.send).toHaveBeenCalledOnce();
    expect(window.send).toHaveBeenCalledWith("arkme:desktop-notification:activated", second.sourceRef);
  });
});
