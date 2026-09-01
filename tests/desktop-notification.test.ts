import { describe, expect, it, vi } from "vitest";
import {
  desktopNativeNotificationAvailable,
  desktopNotificationSettingsUrl,
  DesktopNotificationCoordinator,
  desktopNotificationDocumentNavigationInvalidatesConsumer,
  isMacNotificationsNotAllowedError,
  parseDesktopNotificationActivationV2Result,
  parseDesktopNotificationConsumerV2,
  parseDesktopNotificationPermissionState,
  rendererReportedDesktopNotificationPermission,
  parseDesktopNotificationSubmission,
  sanitizeNativeNotificationText,
  type DesktopNotificationRequest,
  type DesktopNotificationSubmission,
  type HarnessNotificationWindow,
  type NativeNotification
} from "../src/desktop-notification.js";

describe("desktop notification permission state", () => {
  it("maps real permission state into a truthful native capability", () => {
    expect(parseDesktopNotificationPermissionState("granted")).toBe("granted");
    expect(parseDesktopNotificationPermissionState("system-managed")).toBeUndefined();
    expect(desktopNativeNotificationAvailable("darwin", true, "default")).toBe(false);
    expect(desktopNativeNotificationAvailable("darwin", true, "granted")).toBe(true);
    expect(desktopNativeNotificationAvailable("darwin", true, "denied")).toBe(false);
    expect(desktopNativeNotificationAvailable("darwin", true, "granted", false)).toBe(false);
    expect(desktopNativeNotificationAvailable("win32", true, "granted")).toBe(true);
    expect(desktopNativeNotificationAvailable("linux", false, "granted")).toBe(false);
    expect(isMacNotificationsNotAllowedError("未能完成操作。（UNErrorDomain错误1。）")).toBe(true);
    expect(isMacNotificationsNotAllowedError("The operation couldn’t be completed. (UNErrorDomain error 1.)")).toBe(true);
    expect(isMacNotificationsNotAllowedError("native notification failed")).toBe(false);
    expect(desktopNotificationSettingsUrl("darwin")).toBe("x-apple.systempreferences:com.apple.preference.notifications");
    expect(desktopNotificationSettingsUrl("win32")).toBe("ms-settings:notifications");
    expect(desktopNotificationSettingsUrl("linux")).toBeUndefined();
    expect(rendererReportedDesktopNotificationPermission("darwin", "default", "granted")).toBe("default");
    expect(rendererReportedDesktopNotificationPermission("darwin", "denied", "granted")).toBe("denied");
    expect(rendererReportedDesktopNotificationPermission("darwin", "granted", "default")).toBe("granted");
    expect(rendererReportedDesktopNotificationPermission("darwin", "default", "denied")).toBe("default");
    expect(rendererReportedDesktopNotificationPermission("win32", "default", "granted")).toBe("granted");
  });
});

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
  now?: () => number;
  maxNotificationsPerWindow?: number;
  notificationRateWindowMs?: number;
  activationPendingTtlMs?: number;
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
  const createNotification = vi.fn(options => {
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
    expect(options === undefined ? options : Object.keys(options).sort()).toEqual(["body", "title"]);
    return notification;
  });
  const coordinator = new DesktopNotificationCoordinator({
    getHarnessOrigin: () => "http://127.0.0.1:4173",
    getWindow: () => window,
    createNotification,
    diagnostic,
    ...coordinatorLimits
  });
  return { clickListeners, coordinator, createNotification, diagnostic, notifications, window };
}

const submission: DesktopNotificationSubmission = {
  idempotencyKey: request.eventUid,
  kind: "chat.message",
  occurredAtMillis: request.eventAtMillis,
  expiresAtMillis: request.eventAtMillis + 60_000,
  presentation: { title: request.title, body: request.body },
  activation: {
    kind: "chat-source",
    sourceRef: request.sourceRef,
    sourceKey: "group:stable-id"
  }
};

describe("DesktopNotificationCoordinator", () => {
  it("invalidates a V2 consumer only for a new main-frame document", () => {
    expect(desktopNotificationDocumentNavigationInvalidatesConsumer(false, true)).toBe(true);
    expect(desktopNotificationDocumentNavigationInvalidatesConsumer(true, true)).toBe(false);
    expect(desktopNotificationDocumentNavigationInvalidatesConsumer(false, false)).toBe(false);
  });
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
    const { coordinator, createNotification } = fixture({ throwOnShow: true });

    expect(() => coordinator.show("http://127.0.0.1:4173", request)).not.toThrow();
    expect(coordinator.show("http://127.0.0.1:4173", request)).toEqual({ shown: false });
    expect(createNotification).toHaveBeenCalledTimes(2);
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

  it("returns accepted/duplicate/expired outcomes without claiming the OS showed it", () => {
    const { coordinator } = fixture({ now: () => request.eventAtMillis });

    expect(coordinator.submit(submission)).toEqual({ accepted: true, outcome: "accepted" });
    expect(coordinator.submit(submission)).toEqual({ accepted: false, outcome: "duplicate" });
    expect(coordinator.submit({
      ...submission,
      idempotencyKey: "expired",
      occurredAtMillis: 1,
      expiresAtMillis: 2
    }))
      .toEqual({ accepted: false, outcome: "expired" });
  });

  it("rate limits unique notification IDs while leaving duplicates non-consuming", () => {
    let now = request.eventAtMillis;
    const { coordinator, notifications } = fixture({
      now: () => now,
      maxNotificationsPerWindow: 1,
      notificationRateWindowMs: 1_000
    });

    expect(coordinator.submit(submission).outcome).toBe("accepted");
    expect(coordinator.submit(submission).outcome).toBe("duplicate");
    expect(coordinator.submit({ ...submission, idempotencyKey: "event-2" }))
      .toEqual({ accepted: false, outcome: "rate-limited" });
    now += 1_001;
    expect(coordinator.submit({ ...submission, idempotencyKey: "event-2" }).outcome).toBe("accepted");
    expect(notifications).toHaveLength(2);
  });

  it("delivers a typed activation alongside the legacy sourceRef channel", () => {
    const { clickListeners, coordinator, window } = fixture();
    window.sendActivation = vi.fn();
    coordinator.markHarnessReady("http://127.0.0.1:4173");
    coordinator.show("http://127.0.0.1:4173", request);
    clickListeners[0]?.();

    expect(window.sendActivation).toHaveBeenCalledWith(
      "arkme:desktop-notification:activated-v1",
      { kind: "chat-source", sourceRef: request.sourceRef }
    );
  });

  it("preserves a bounded sourceKey supplied through the legacy Browser fallback", () => {
    const { clickListeners, coordinator, window } = fixture();
    window.sendActivation = vi.fn();
    coordinator.markHarnessReady("http://127.0.0.1:4173");
    expect(coordinator.show("http://127.0.0.1:4173", {
      ...request,
      eventUid: "legacy-source-key",
      sourceKey: "group:stable-id"
    })).toEqual({ shown: true });
    clickListeners[0]?.();

    expect(window.sendActivation).toHaveBeenCalledWith(
      "arkme:desktop-notification:activated-v1",
      {
        kind: "chat-source",
        sourceRef: request.sourceRef,
        sourceKey: "group:stable-id"
      }
    );
    expect(coordinator.show("http://127.0.0.1:4173", {
      ...request,
      eventUid: "blank-source-key",
      sourceKey: " "
    })).toEqual({ shown: false });
    expect(coordinator.show("http://127.0.0.1:4173", {
      ...request,
      eventUid: "oversized-source-key",
      sourceKey: "x".repeat(513)
    })).toEqual({ shown: false });
  });

  it("preserves an optional stable sourceKey in the typed activation queue", () => {
    const { clickListeners, coordinator, window } = fixture({ now: () => request.eventAtMillis });
    window.sendActivation = vi.fn();
    coordinator.markHarnessReady("http://127.0.0.1:4173");
    expect(coordinator.submit(submission)).toEqual({ accepted: true, outcome: "accepted" });
    clickListeners[0]?.();

    expect(window.sendActivation).toHaveBeenCalledWith(
      "arkme:desktop-notification:activated-v1",
      submission.activation
    );
    expect(window.send).toHaveBeenCalledWith(
      "arkme:desktop-notification:activated",
      submission.activation.sourceRef
    );
  });

  it("keeps V2 activation pending after delivery and removes it only after a matching ACK", () => {
    const { clickListeners, coordinator, window } = fixture({ now: () => request.eventAtMillis });
    window.sendActivation = vi.fn();
    window.sendActivationV2 = vi.fn();
    expect(coordinator.markReadyV2("http://127.0.0.1:4173/chat", {
      consumerId: "consumer-1"
    })).toBe(true);
    expect(coordinator.submit(submission)).toEqual({ accepted: true, outcome: "accepted" });
    clickListeners[0]?.();

    expect(window.sendActivationV2).toHaveBeenCalledWith(
      "arkme:desktop-notification:activated-v2",
      {
        activationId: submission.idempotencyKey,
        ...submission.activation
      }
    );
    expect(window.send).not.toHaveBeenCalled();
    expect(window.sendActivation).not.toHaveBeenCalled();

    expect(coordinator.markReadyV2("http://127.0.0.1:4173/chat", {
      consumerId: "consumer-2"
    })).toBe(true);
    expect(window.sendActivationV2).toHaveBeenCalledTimes(2);
    expect(coordinator.completeV2("http://127.0.0.1:4173/chat", {
      consumerId: "consumer-2",
      activationId: submission.idempotencyKey,
      outcome: "resolved"
    })).toBe(true);
    expect(coordinator.markReadyV2("http://127.0.0.1:4173/chat", {
      consumerId: "consumer-3"
    })).toBe(true);
    expect(window.sendActivationV2).toHaveBeenCalledTimes(2);
  });

  it("rejects stale, forged, and duplicate V2 results without deleting pending delivery", () => {
    const { clickListeners, coordinator, window } = fixture({ now: () => request.eventAtMillis });
    window.sendActivationV2 = vi.fn();
    coordinator.markReadyV2("http://127.0.0.1:4173", { consumerId: "consumer-old" });
    coordinator.submit(submission);
    clickListeners[0]?.();
    coordinator.markReadyV2("http://127.0.0.1:4173", { consumerId: "consumer-current" });

    expect(coordinator.completeV2("http://127.0.0.1:4173", {
      consumerId: "consumer-old",
      activationId: submission.idempotencyKey,
      outcome: "resolved"
    })).toBe(false);
    expect(coordinator.completeV2("https://attacker.test", {
      consumerId: "consumer-current",
      activationId: submission.idempotencyKey,
      outcome: "resolved"
    })).toBe(false);
    expect(coordinator.completeV2("http://127.0.0.1:4173", {
      consumerId: "consumer-current",
      activationId: submission.idempotencyKey,
      outcome: "resolved",
      extra: true
    })).toBe(false);
    expect(coordinator.completeV2("http://127.0.0.1:4173", {
      consumerId: "consumer-current",
      activationId: submission.idempotencyKey,
      outcome: "failed"
    })).toBe(true);
    expect(coordinator.completeV2("http://127.0.0.1:4173", {
      consumerId: "consumer-current",
      activationId: submission.idempotencyKey,
      outcome: "failed"
    })).toBe(false);
  });

  it("retains pending V2 activations across unready/loading and replays them to a new document", () => {
    const { clickListeners, coordinator, window } = fixture({ now: () => request.eventAtMillis });
    window.sendActivationV2 = vi.fn();
    coordinator.markReadyV2("http://127.0.0.1:4173", { consumerId: "consumer-1" });
    coordinator.submit(submission);
    clickListeners[0]?.();
    expect(window.sendActivationV2).toHaveBeenCalledTimes(1);

    expect(coordinator.markUnreadyV2("http://127.0.0.1:4173", {
      consumerId: "not-current"
    })).toBe(false);
    expect(coordinator.markUnreadyV2("http://127.0.0.1:4173", {
      consumerId: "consumer-1"
    })).toBe(true);
    coordinator.markHarnessLoading();
    expect(coordinator.markReadyV2("http://127.0.0.1:4173", {
      consumerId: "consumer-2"
    })).toBe(true);
    expect(window.sendActivationV2).toHaveBeenCalledTimes(2);
  });

  it("expires unacknowledged V2 activations after a bounded TTL before replay", () => {
    let now = request.eventAtMillis;
    const { clickListeners, coordinator, diagnostic, window } = fixture({
      now: () => now,
      activationPendingTtlMs: 30_000
    });
    window.sendActivationV2 = vi.fn();
    coordinator.markReadyV2("http://127.0.0.1:4173", { consumerId: "consumer-1" });
    coordinator.submit(submission);
    clickListeners[0]?.();
    expect(window.sendActivationV2).toHaveBeenCalledTimes(1);

    now += 30_001;
    coordinator.markHarnessLoading();
    coordinator.markReadyV2("http://127.0.0.1:4173", { consumerId: "consumer-2" });
    expect(window.sendActivationV2).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith("activation_v2_expired", {
      eventUid: submission.idempotencyKey,
      outcome: "superseded",
      hasSourceKey: true
    });
    expect(coordinator.completeV2("http://127.0.0.1:4173", {
      consumerId: "consumer-2",
      activationId: submission.idempotencyKey,
      outcome: "resolved"
    })).toBe(false);
  });

  it("keeps V1 and legacy delivery when no V2 consumer is registered", () => {
    const { clickListeners, coordinator, window } = fixture();
    window.sendActivation = vi.fn();
    coordinator.markHarnessReady("http://127.0.0.1:4173");
    coordinator.show("http://127.0.0.1:4173", request);
    clickListeners[0]?.();

    expect(window.send).toHaveBeenCalledWith(
      "arkme:desktop-notification:activated",
      request.sourceRef
    );
    expect(window.sendActivation).toHaveBeenCalledWith(
      "arkme:desktop-notification:activated-v1",
      { kind: "chat-source", sourceRef: request.sourceRef }
    );
  });

  it("strictly parses bounded V2 consumer and result envelopes", () => {
    expect(parseDesktopNotificationConsumerV2({ consumerId: "consumer-1" })).toEqual({
      consumerId: "consumer-1"
    });
    expect(parseDesktopNotificationConsumerV2({ consumerId: " " })).toBeUndefined();
    expect(parseDesktopNotificationConsumerV2({ consumerId: "consumer-1", extra: true })).toBeUndefined();
    expect(parseDesktopNotificationActivationV2Result({
      consumerId: "consumer-1",
      activationId: "activation-1",
      outcome: "superseded"
    })).toEqual({
      consumerId: "consumer-1",
      activationId: "activation-1",
      outcome: "superseded"
    });
    expect(parseDesktopNotificationActivationV2Result({
      consumerId: "consumer-1",
      activationId: "activation-1",
      outcome: "retry"
    })).toBeUndefined();
  });

  it("strictly parses canonical payloads and rejects blank or expanded schemas", () => {
    expect(parseDesktopNotificationSubmission(submission)).toEqual(submission);
    expect(parseDesktopNotificationSubmission({ ...submission, accountId: "secret" })).toBeUndefined();
    expect(parseDesktopNotificationSubmission({
      ...submission,
      presentation: { ...submission.presentation, extra: true }
    })).toBeUndefined();
    expect(parseDesktopNotificationSubmission({
      ...submission,
      presentation: { title: "\u202e", body: "\u0000" }
    })).toBeUndefined();
    expect(parseDesktopNotificationSubmission({
      ...submission,
      activation: { ...submission.activation, sourceKey: "   " }
    })).toBeUndefined();
    expect(parseDesktopNotificationSubmission({
      ...submission,
      activation: { ...submission.activation, sourceKey: "x".repeat(513) }
    })).toBeUndefined();
  });

  it("strips control and bidi characters and truncates only on UTF-8 boundaries", () => {
    expect(sanitizeNativeNotificationText("  群\u202e\u0000\n聊  ", 64, true)).toBe("群 聊");
    const truncated = sanitizeNativeNotificationText("你🙂好", 7, false);
    expect(truncated).toBe("你🙂");
    expect(Buffer.byteLength(truncated, "utf8")).toBe(7);
  });
});
