export const DESKTOP_NOTIFICATION_SHOW_CHANNEL = "arkme:desktop-notification:show";
export const DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL = "arkme:desktop-notification:activated";
export const DESKTOP_NOTIFICATION_READY_CHANNEL = "arkme:desktop-notification:ready";

export interface DesktopNotificationRequest {
  eventUid: string;
  sourceRef: string;
  sourceKind: "private_chat" | "group_chat";
  title: string;
  body: string;
  eventAtMillis: number;
}

export interface NativeNotification {
  show(): void;
  close(): void;
  onClick(listener: () => void): void;
  onShow(listener: () => void): void;
  onFailed(listener: (error: string) => void): void;
  onClose?(listener: () => void): void;
}

export interface HarnessNotificationWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  send(channel: string, sourceRef: string): void;
}

interface DesktopNotificationCoordinatorOptions {
  getHarnessOrigin(): string | null;
  getWindow(): HarnessNotificationWindow | null;
  createNotification(options: { title: string; body: string }): NativeNotification | undefined;
  diagnostic?(
    event: "notification_shown" | "notification_activated" | "notification_failed",
    details: { eventUid: string; error?: string }
  ): void;
  maxActiveNotifications?: number;
  maxPendingActivations?: number;
  maxRememberedEventUids?: number;
}

export class DesktopNotificationCoordinator {
  private readonly active = new Map<string, NativeNotification>();
  private readonly rememberedEventUids = new Set<string>();
  private readonly pendingActivations: string[] = [];
  private readonly maxActiveNotifications: number;
  private readonly maxPendingActivations: number;
  private readonly maxRememberedEventUids: number;
  private harnessReady = false;

  constructor(private readonly options: DesktopNotificationCoordinatorOptions) {
    this.maxActiveNotifications = positiveLimit(options.maxActiveNotifications, 100);
    this.maxPendingActivations = positiveLimit(options.maxPendingActivations, 20);
    this.maxRememberedEventUids = positiveLimit(options.maxRememberedEventUids, 2_048);
  }

  show(senderUrl: string, candidate: unknown): { shown: boolean } {
    const request = notificationRequest(candidate);
    if (!this.isCurrentHarnessPage(senderUrl) || request === undefined) return { shown: false };
    if (this.rememberedEventUids.has(request.eventUid)) return { shown: false };

    let notification: NativeNotification | undefined;
    try {
      notification = this.options.createNotification({ title: request.title, body: request.body });
    } catch {
      return { shown: false };
    }
    if (notification === undefined) return { shown: false };

    this.remember(request.eventUid);
    this.makeRoomForNotification();
    this.active.set(request.eventUid, notification);
    notification.onClick(() => {
      this.active.delete(request.eventUid);
      this.restoreAndFocusWindow();
      this.options.diagnostic?.("notification_activated", { eventUid: request.eventUid });
      this.activateOrQueue(request.sourceRef);
    });
    notification.onShow(() => {
      this.options.diagnostic?.("notification_shown", { eventUid: request.eventUid });
    });
    notification.onFailed(error => {
      this.active.delete(request.eventUid);
      this.options.diagnostic?.("notification_failed", { eventUid: request.eventUid, error });
    });
    notification.onClose?.(() => { this.active.delete(request.eventUid); });
    try {
      notification.show();
    } catch {
      this.active.delete(request.eventUid);
      return { shown: false };
    }
    return { shown: true };
  }

  markHarnessReady(senderUrl: string): boolean {
    if (!this.isCurrentHarnessPage(senderUrl)) return false;
    this.harnessReady = true;
    this.flushPendingActivations();
    return true;
  }

  markHarnessLoading(): void {
    this.harnessReady = false;
  }

  private isCurrentHarnessPage(senderUrl: string): boolean {
    const currentOrigin = this.options.getHarnessOrigin();
    if (currentOrigin === null) return false;
    try {
      return new URL(senderUrl).origin === currentOrigin;
    } catch {
      return false;
    }
  }

  private remember(eventUid: string): void {
    this.rememberedEventUids.add(eventUid);
    while (this.rememberedEventUids.size > this.maxRememberedEventUids) {
      const oldest = this.rememberedEventUids.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.rememberedEventUids.delete(oldest);
    }
  }

  private makeRoomForNotification(): void {
    while (this.active.size >= this.maxActiveNotifications) {
      const oldest = this.active.entries().next().value as [string, NativeNotification] | undefined;
      if (oldest === undefined) break;
      this.active.delete(oldest[0]);
      oldest[1].close();
    }
  }

  private restoreAndFocusWindow(): void {
    const window = this.options.getWindow();
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private activateOrQueue(sourceRef: string): void {
    if (this.harnessReady && this.deliver(sourceRef)) return;
    this.pendingActivations.push(sourceRef);
    while (this.pendingActivations.length > this.maxPendingActivations) this.pendingActivations.shift();
  }

  private flushPendingActivations(): void {
    while (this.harnessReady && this.pendingActivations.length > 0) {
      const sourceRef = this.pendingActivations[0];
      if (sourceRef === undefined || !this.deliver(sourceRef)) return;
      this.pendingActivations.shift();
    }
  }

  private deliver(sourceRef: string): boolean {
    const window = this.options.getWindow();
    if (window === null || window.isDestroyed()) return false;
    window.send(DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL, sourceRef);
    return true;
  }
}

function notificationRequest(candidate: unknown): DesktopNotificationRequest | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  if (
    !boundedString(value.eventUid, 128)
    || !boundedString(value.sourceRef, 4_096)
    || (value.sourceKind !== "private_chat" && value.sourceKind !== "group_chat")
    || !boundedString(value.title, 128)
    || !boundedString(value.body, 512)
    || typeof value.eventAtMillis !== "number"
    || !Number.isSafeInteger(value.eventAtMillis)
    || value.eventAtMillis <= 0
  ) return undefined;
  return {
    eventUid: value.eventUid,
    sourceRef: value.sourceRef,
    sourceKind: value.sourceKind,
    title: value.title,
    body: value.body,
    eventAtMillis: value.eventAtMillis
  };
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}
