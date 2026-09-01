export const DESKTOP_NOTIFICATION_SHOW_CHANNEL = "arkme:desktop-notification:show";
export const DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL = "arkme:desktop-notification:activated";
export const DESKTOP_NOTIFICATION_ACTIVATED_V1_CHANNEL = "arkme:desktop-notification:activated-v1";
export const DESKTOP_NOTIFICATION_READY_CHANNEL = "arkme:desktop-notification:ready";
export const DESKTOP_NOTIFICATION_READY_V2_CHANNEL = "arkme:desktop-notification:ready-v2";
export const DESKTOP_NOTIFICATION_UNREADY_V2_CHANNEL = "arkme:desktop-notification:unready-v2";
export const DESKTOP_NOTIFICATION_ACTIVATED_V2_CHANNEL = "arkme:desktop-notification:activated-v2";
export const DESKTOP_NOTIFICATION_RESULT_V2_CHANNEL = "arkme:desktop-notification:result-v2";
export const DESKTOP_NOTIFICATION_PERMISSION_STATE_CHANNEL = "arkme:desktop-notification:permission-state";
export const DESKTOP_NOTIFICATION_OPEN_SETTINGS_CHANNEL = "arkme:desktop-notification:open-settings";
export const DESKTOP_NOTIFICATION_REFRESH_PERMISSION_CHANNEL = "arkme:desktop-notification:refresh-permission";
export const DESKTOP_NOTIFICATION_PERMISSION_CHANGED_CHANNEL = "arkme:desktop-notification:permission-changed";

export type DesktopNotificationPermissionState = NotificationPermission | "unavailable";

/** Only a new top-level document invalidates the preload-owned V2 consumer. */
export function desktopNotificationDocumentNavigationInvalidatesConsumer(
  isInPlace: boolean,
  isMainFrame: boolean
): boolean {
  return isMainFrame && !isInPlace;
}

export function parseDesktopNotificationPermissionState(
  value: unknown
): DesktopNotificationPermissionState | undefined {
  return value === "default" || value === "granted" || value === "denied" || value === "unavailable"
    ? value
    : undefined;
}

export function desktopNativeNotificationAvailable(
  platform: NodeJS.Platform,
  supported: boolean,
  permission: DesktopNotificationPermissionState,
  packaged = true
): boolean {
  if (!supported || permission === "unavailable" || permission === "denied") return false;
  if (platform === "darwin" && !packaged) return false;
  return platform !== "darwin" || permission === "granted";
}

export function isMacNotificationsNotAllowedError(error: string | undefined): boolean {
  return typeof error === "string" && /UNErrorDomain(?:\s+error|错误)\s*1\b/iu.test(error);
}

export function desktopNotificationSettingsUrl(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return "x-apple.systempreferences:com.apple.preference.notifications";
  if (platform === "win32") return "ms-settings:notifications";
  return undefined;
}

export function rendererReportedDesktopNotificationPermission(
  platform: NodeJS.Platform,
  current: DesktopNotificationPermissionState,
  reported: DesktopNotificationPermissionState
): DesktopNotificationPermissionState {
  if (platform !== "darwin") return reported;
  // Chromium's origin permission is not the macOS UNUserNotificationCenter
  // authorization state. Renderer reports must never mutate native truth.
  return current;
}

export interface DesktopNotificationRequest {
  eventUid: string;
  sourceRef: string;
  sourceKey?: string;
  sourceKind: "private_chat" | "group_chat";
  title: string;
  body: string;
  eventAtMillis: number;
}

export interface DesktopNotificationActivation {
  kind: "chat-source";
  sourceRef: string;
  sourceKey?: string;
}

export interface DesktopNotificationActivationV2 extends DesktopNotificationActivation {
  activationId: string;
}

export interface DesktopNotificationConsumerV2 {
  consumerId: string;
}

export type DesktopNotificationActivationV2Outcome =
  | "resolved"
  | "not-found"
  | "failed"
  | "superseded";

export interface DesktopNotificationActivationV2Result extends DesktopNotificationConsumerV2 {
  activationId: string;
  outcome: DesktopNotificationActivationV2Outcome;
}

interface PendingDesktopNotificationActivationV2 {
  delivery: DesktopNotificationActivationV2;
  expiresAtMillis: number;
}

export interface DesktopNotificationSubmission {
  idempotencyKey: string;
  kind: "chat.message";
  occurredAtMillis: number;
  expiresAtMillis: number;
  presentation: {
    title: string;
    body: string;
  };
  activation: DesktopNotificationActivation;
}

export type DesktopNotificationSubmissionResult =
  | { accepted: true; outcome: "accepted" }
  | {
    accepted: false;
    outcome: "duplicate" | "unsupported" | "expired" | "native-failed" | "rate-limited";
  };

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
  sendActivation?(channel: string, activation: DesktopNotificationActivation): void;
  sendActivationV2?(channel: string, activation: DesktopNotificationActivationV2): void;
}

type DesktopNotificationDiagnosticEvent =
  | "notification_shown"
  | "notification_activated"
  | "notification_failed"
  | "activation_v2_ready"
  | "activation_v2_unready"
  | "activation_v2_sent"
  | "activation_v2_completed"
  | "activation_v2_expired";

interface DesktopNotificationDiagnosticDetails {
  eventUid?: string;
  error?: string;
  consumerGeneration?: number;
  outcome?: DesktopNotificationActivationV2Outcome;
  hasSourceKey?: boolean;
}

interface DesktopNotificationCoordinatorOptions {
  getHarnessOrigin(): string | null;
  getWindow(): HarnessNotificationWindow | null;
  createNotification(options: { title: string; body: string }): NativeNotification | undefined;
  diagnostic?(
    event: DesktopNotificationDiagnosticEvent,
    details: DesktopNotificationDiagnosticDetails
  ): void;
  maxActiveNotifications?: number;
  maxPendingActivations?: number;
  maxRememberedEventUids?: number;
  now?(): number;
  maxNotificationsPerWindow?: number;
  notificationRateWindowMs?: number;
  activationPendingTtlMs?: number;
}

export class DesktopNotificationCoordinator {
  private readonly active = new Map<string, NativeNotification>();
  private readonly rememberedEventUids = new Set<string>();
  private readonly pendingActivations: PendingDesktopNotificationActivationV2[] = [];
  private readonly maxActiveNotifications: number;
  private readonly maxPendingActivations: number;
  private readonly maxRememberedEventUids: number;
  private readonly maxNotificationsPerWindow: number;
  private readonly notificationRateWindowMs: number;
  private readonly activationPendingTtlMs: number;
  private readonly acceptedAtMillis: number[] = [];
  private harnessReady = false;
  private activationConsumerV2: { consumerId: string; generation: number } | undefined;
  private activationConsumerGeneration = 0;

  constructor(private readonly options: DesktopNotificationCoordinatorOptions) {
    this.maxActiveNotifications = positiveLimit(options.maxActiveNotifications, 100);
    this.maxPendingActivations = positiveLimit(options.maxPendingActivations, 20);
    this.maxRememberedEventUids = positiveLimit(options.maxRememberedEventUids, 2_048);
    this.maxNotificationsPerWindow = positiveLimit(options.maxNotificationsPerWindow, 20);
    this.notificationRateWindowMs = positiveLimit(options.notificationRateWindowMs, 60_000);
    this.activationPendingTtlMs = positiveLimit(options.activationPendingTtlMs, 30_000);
  }

  show(senderUrl: string, candidate: unknown): { shown: boolean } {
    const request = notificationRequest(candidate);
    if (!this.isCurrentHarnessPage(senderUrl) || request === undefined) return { shown: false };
    const result = this.submit({
      idempotencyKey: request.eventUid,
      kind: "chat.message",
      occurredAtMillis: request.eventAtMillis,
      // The legacy renderer contract did not carry a TTL. Keep it compatible
      // while all new Host-originated requests use an explicit expiry.
      expiresAtMillis: Number.MAX_SAFE_INTEGER,
      presentation: { title: request.title, body: request.body },
      activation: {
        kind: "chat-source",
        sourceRef: request.sourceRef,
        ...(request.sourceKey === undefined ? {} : { sourceKey: request.sourceKey })
      }
    });
    return { shown: result.accepted };
  }

  submit(candidate: unknown): DesktopNotificationSubmissionResult {
    const request = parseDesktopNotificationSubmission(candidate);
    if (request === undefined) return { accepted: false, outcome: "native-failed" };
    const now = this.options.now?.() ?? Date.now();
    if (now > request.expiresAtMillis) {
      return { accepted: false, outcome: "expired" };
    }
    if (this.rememberedEventUids.has(request.idempotencyKey)) {
      return { accepted: false, outcome: "duplicate" };
    }
    if (!this.notificationRateAvailable(now)) {
      return { accepted: false, outcome: "rate-limited" };
    }

    let notification: NativeNotification | undefined;
    try {
      notification = this.options.createNotification({
        title: sanitizeNativeNotificationText(request.presentation.title, 256, true),
        body: sanitizeNativeNotificationText(request.presentation.body, 1_024, false)
      });
    } catch {
      return { accepted: false, outcome: "native-failed" };
    }
    if (notification === undefined) return { accepted: false, outcome: "unsupported" };

    this.remember(request.idempotencyKey);
    this.acceptedAtMillis.push(now);
    this.makeRoomForNotification();
    this.active.set(request.idempotencyKey, notification);
    notification.onClick(() => {
      this.active.delete(request.idempotencyKey);
      this.restoreAndFocusWindow();
      this.options.diagnostic?.("notification_activated", { eventUid: request.idempotencyKey });
      this.activateOrQueue({
        activationId: request.idempotencyKey,
        ...request.activation
      });
    });
    notification.onShow(() => {
      this.options.diagnostic?.("notification_shown", { eventUid: request.idempotencyKey });
    });
    notification.onFailed(error => {
      this.active.delete(request.idempotencyKey);
      this.options.diagnostic?.("notification_failed", { eventUid: request.idempotencyKey, error });
    });
    notification.onClose?.(() => { this.active.delete(request.idempotencyKey); });
    try {
      notification.show();
    } catch {
      this.active.delete(request.idempotencyKey);
      this.rememberedEventUids.delete(request.idempotencyKey);
      this.releaseRateReservation(now);
      return { accepted: false, outcome: "native-failed" };
    }
    return { accepted: true, outcome: "accepted" };
  }

  markHarnessReady(senderUrl: string): boolean {
    if (!this.isCurrentHarnessPage(senderUrl)) return false;
    this.harnessReady = true;
    this.pruneExpiredPendingActivations();
    if (this.activationConsumerV2 === undefined) this.flushPendingActivationsV1();
    return true;
  }

  markHarnessLoading(): void {
    this.harnessReady = false;
    if (this.activationConsumerV2 !== undefined) {
      this.options.diagnostic?.("activation_v2_unready", {
        consumerGeneration: this.activationConsumerV2.generation
      });
    }
    this.activationConsumerV2 = undefined;
  }

  markReadyV2(senderUrl: string, candidate: unknown): boolean {
    if (!this.isCurrentHarnessPage(senderUrl)) return false;
    const consumer = parseDesktopNotificationConsumerV2(candidate);
    if (consumer === undefined) return false;
    if (this.activationConsumerV2?.consumerId === consumer.consumerId) return true;

    this.pruneExpiredPendingActivations();

    this.activationConsumerGeneration += 1;
    this.activationConsumerV2 = {
      consumerId: consumer.consumerId,
      generation: this.activationConsumerGeneration
    };
    this.options.diagnostic?.("activation_v2_ready", {
      consumerGeneration: this.activationConsumerGeneration
    });
    this.replayPendingActivationsV2();
    return true;
  }

  markUnreadyV2(senderUrl: string, candidate: unknown): boolean {
    if (!this.isCurrentHarnessPage(senderUrl)) return false;
    const consumer = parseDesktopNotificationConsumerV2(candidate);
    if (consumer === undefined || consumer.consumerId !== this.activationConsumerV2?.consumerId) {
      return false;
    }
    this.options.diagnostic?.("activation_v2_unready", {
      consumerGeneration: this.activationConsumerV2.generation
    });
    this.activationConsumerV2 = undefined;
    return true;
  }

  completeV2(senderUrl: string, candidate: unknown): boolean {
    if (!this.isCurrentHarnessPage(senderUrl)) return false;
    const result = parseDesktopNotificationActivationV2Result(candidate);
    const consumer = this.activationConsumerV2;
    if (result === undefined || consumer === undefined || result.consumerId !== consumer.consumerId) {
      return false;
    }
    this.pruneExpiredPendingActivations();
    const pendingIndex = this.pendingActivations.findIndex(
      pending => pending.delivery.activationId === result.activationId
    );
    if (pendingIndex < 0) return false;

    const [completed] = this.pendingActivations.splice(pendingIndex, 1);
    this.options.diagnostic?.("activation_v2_completed", {
      eventUid: result.activationId,
      consumerGeneration: consumer.generation,
      outcome: result.outcome,
      hasSourceKey: completed?.delivery.sourceKey !== undefined
    });
    return true;
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

  private notificationRateAvailable(now: number): boolean {
    const cutoff = now - this.notificationRateWindowMs;
    while ((this.acceptedAtMillis[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
      this.acceptedAtMillis.shift();
    }
    return this.acceptedAtMillis.length < this.maxNotificationsPerWindow;
  }

  private releaseRateReservation(atMillis: number): void {
    const index = this.acceptedAtMillis.lastIndexOf(atMillis);
    if (index >= 0) this.acceptedAtMillis.splice(index, 1);
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

  private activateOrQueue(activation: DesktopNotificationActivationV2): void {
    const consumer = this.activationConsumerV2;
    if (consumer !== undefined) {
      this.enqueuePendingActivation(activation);
      this.deliverV2(activation, consumer);
      return;
    }
    if (this.harnessReady && this.deliverV1(activation)) return;
    this.enqueuePendingActivation(activation);
  }

  private enqueuePendingActivation(activation: DesktopNotificationActivationV2): void {
    const now = this.now();
    this.pruneExpiredPendingActivations(now);
    this.pendingActivations.push({
      delivery: activation,
      expiresAtMillis: now + this.activationPendingTtlMs
    });
    while (this.pendingActivations.length > this.maxPendingActivations) this.pendingActivations.shift();
  }

  private flushPendingActivationsV1(): void {
    while (
      this.activationConsumerV2 === undefined
      && this.harnessReady
      && this.pendingActivations.length > 0
    ) {
      const pending = this.pendingActivations[0];
      if (pending === undefined || !this.deliverV1(pending.delivery)) return;
      this.pendingActivations.shift();
    }
  }

  private replayPendingActivationsV2(): void {
    const consumer = this.activationConsumerV2;
    if (consumer === undefined) return;
    for (const pending of this.pendingActivations) {
      if (!this.deliverV2(pending.delivery, consumer)) return;
    }
  }

  private pruneExpiredPendingActivations(now = this.now()): void {
    for (let index = this.pendingActivations.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingActivations[index];
      if (pending === undefined || pending.expiresAtMillis > now) continue;
      this.pendingActivations.splice(index, 1);
      this.options.diagnostic?.("activation_v2_expired", {
        eventUid: pending.delivery.activationId,
        ...(this.activationConsumerV2 === undefined
          ? {}
          : { consumerGeneration: this.activationConsumerV2.generation }),
        outcome: "superseded",
        hasSourceKey: pending.delivery.sourceKey !== undefined
      });
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private deliverV1(activation: DesktopNotificationActivation): boolean {
    const window = this.options.getWindow();
    if (window === null || window.isDestroyed()) return false;
    window.send(DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL, activation.sourceRef);
    window.sendActivation?.(DESKTOP_NOTIFICATION_ACTIVATED_V1_CHANNEL, {
      kind: "chat-source",
      sourceRef: activation.sourceRef,
      ...(activation.sourceKey === undefined ? {} : { sourceKey: activation.sourceKey })
    });
    return true;
  }

  private deliverV2(
    activation: DesktopNotificationActivationV2,
    consumer: { consumerId: string; generation: number }
  ): boolean {
    if (this.activationConsumerV2?.consumerId !== consumer.consumerId) return false;
    const window = this.options.getWindow();
    if (window === null || window.isDestroyed() || window.sendActivationV2 === undefined) return false;
    try {
      window.sendActivationV2(DESKTOP_NOTIFICATION_ACTIVATED_V2_CHANNEL, activation);
      this.options.diagnostic?.("activation_v2_sent", {
        eventUid: activation.activationId,
        consumerGeneration: consumer.generation,
        hasSourceKey: activation.sourceKey !== undefined
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function parseDesktopNotificationConsumerV2(
  candidate: unknown
): DesktopNotificationConsumerV2 | undefined {
  const value = objectRecord(candidate);
  if (value === undefined || !hasExactKeys(value, ["consumerId"]) || !boundedNonBlankString(
    value.consumerId,
    128
  )) return undefined;
  return { consumerId: value.consumerId };
}

export function parseDesktopNotificationActivationV2Result(
  candidate: unknown
): DesktopNotificationActivationV2Result | undefined {
  const value = objectRecord(candidate);
  if (
    value === undefined
    || !hasExactKeys(value, ["consumerId", "activationId", "outcome"])
    || !boundedNonBlankString(value.consumerId, 128)
    || !boundedNonBlankString(value.activationId, 128)
    || !isDesktopNotificationActivationV2Outcome(value.outcome)
  ) return undefined;
  return {
    consumerId: value.consumerId,
    activationId: value.activationId,
    outcome: value.outcome
  };
}

function isDesktopNotificationActivationV2Outcome(
  value: unknown
): value is DesktopNotificationActivationV2Outcome {
  return value === "resolved"
    || value === "not-found"
    || value === "failed"
    || value === "superseded";
}

export function parseDesktopNotificationSubmission(candidate: unknown): DesktopNotificationSubmission | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  const presentation = objectRecord(value.presentation);
  const activation = objectRecord(value.activation);
  const activationHasSourceKey = activation !== undefined
    && Object.prototype.hasOwnProperty.call(activation, "sourceKey");
  if (
    !hasExactKeys(value, [
      "idempotencyKey",
      "kind",
      "occurredAtMillis",
      "expiresAtMillis",
      "presentation",
      "activation"
    ])
    || !boundedNonBlankString(value.idempotencyKey, 128)
    || value.kind !== "chat.message"
    || !positiveSafeInteger(value.occurredAtMillis)
    || !positiveSafeInteger(value.expiresAtMillis)
    || value.expiresAtMillis < value.occurredAtMillis
    || presentation === undefined
    || !hasExactKeys(presentation, ["title", "body"])
    || !boundedString(presentation.title, 128)
    || !boundedString(presentation.body, 512)
    || sanitizeNativeNotificationText(presentation.title, 256, true).length === 0
    || sanitizeNativeNotificationText(presentation.body, 1_024, false).length === 0
    || activation === undefined
    || (!hasExactKeys(activation, ["kind", "sourceRef"])
      && !hasExactKeys(activation, ["kind", "sourceRef", "sourceKey"]))
    || activation.kind !== "chat-source"
    || !boundedString(activation.sourceRef, 4_096)
    || (activationHasSourceKey && !boundedNonBlankString(activation.sourceKey, 512))
  ) return undefined;
  return {
    idempotencyKey: value.idempotencyKey,
    kind: "chat.message",
    occurredAtMillis: value.occurredAtMillis,
    expiresAtMillis: value.expiresAtMillis,
    presentation: {
      title: presentation.title,
      body: presentation.body
    },
    activation: {
      kind: "chat-source",
      sourceRef: activation.sourceRef,
      ...(activationHasSourceKey ? { sourceKey: activation.sourceKey as string } : {})
    }
  };
}

export function sanitizeNativeNotificationText(
  value: string,
  maxUtf8Bytes: number,
  singleLine: boolean
): string {
  const withoutControls = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\r\n?/gu, "\n");
  const normalized = singleLine
    ? withoutControls.replace(/\s+/gu, " ").trim()
    : withoutControls.trim();
  let result = "";
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxUtf8Bytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function notificationRequest(candidate: unknown): DesktopNotificationRequest | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  const hasSourceKey = Object.prototype.hasOwnProperty.call(value, "sourceKey");
  if (
    !boundedNonBlankString(value.eventUid, 128)
    || !boundedString(value.sourceRef, 4_096)
    || (hasSourceKey && !boundedNonBlankString(value.sourceKey, 512))
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
    ...(hasSourceKey ? { sourceKey: value.sourceKey as string } : {}),
    sourceKind: value.sourceKind,
    title: value.title,
    body: value.body,
    eventAtMillis: value.eventAtMillis
  };
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function boundedNonBlankString(value: unknown, maxLength: number): value is string {
  return boundedString(value, maxLength) && value.trim().length > 0;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}
