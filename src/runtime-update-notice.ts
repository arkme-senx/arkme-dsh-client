import type { RuntimeInstallProgress } from "./runtime/manager.js";

export const RUNTIME_UPDATE_NOTICE_SNAPSHOT_CHANNEL = "arkme:runtime-update-notice:snapshot";
export const RUNTIME_UPDATE_NOTICE_CHANGED_CHANNEL = "arkme:runtime-update-notice:changed";
export const RUNTIME_UPDATE_NOTICE_DISMISS_CHANNEL = "arkme:runtime-update-notice:dismiss";
export const RUNTIME_UPDATE_NOTICE_RESTART_CHANNEL = "arkme:runtime-update-notice:restart";

export type RuntimeUpdateNoticeKind = "installing" | "installed" | "failed";

export interface RuntimeUpdateNoticeSnapshot {
  schemaVersion: 1;
  messageId: string;
  kind: RuntimeUpdateNoticeKind;
  visible: boolean;
}

export interface RuntimeUpdateNativeNotification {
  show(): void;
  onClick(listener: () => void): void;
  onFailed(listener: (error: string) => void): void;
}

export interface RuntimeUpdateNoticeWindow {
  getCurrentUrl(): string;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  send(channel: string, snapshot: RuntimeUpdateNoticeSnapshot): void;
}

interface RuntimeUpdateNoticeCoordinatorOptions {
  getHarnessOrigin(): string | null;
  getWindow(): RuntimeUpdateNoticeWindow | null;
  createNotification(options: { title: string; body: string }): RuntimeUpdateNativeNotification | undefined;
  relaunch(): void;
  quit(): void;
  applicationName?: string;
  diagnostic?(
    event: "installing" | "dismissed" | "installed" | "failed" | "restart-requested" | "native-notification-failed",
    details: { messageId: string; error?: string }
  ): void;
}

export type RuntimeStageLatestResult = "current" | "stale" | "bad" | "deferred" | "staged";

interface RuntimeUpdateNoticeIpcEvent {
  senderFrame?: { url: string } | null;
}

interface RuntimeUpdateNoticeIpcMain {
  handle(
    channel: string,
    handler: (event: RuntimeUpdateNoticeIpcEvent, value?: unknown) => unknown
  ): void;
}

interface RuntimeUpdateNoticeStyleTarget {
  getCurrentUrl(): string;
  insertCSS(css: string): Promise<unknown>;
}

export class RuntimeUpdateNoticeCoordinator {
  private currentAttemptId: string | undefined;
  private current: RuntimeUpdateNoticeSnapshot | undefined;
  private restartRequested = false;

  constructor(private readonly options: RuntimeUpdateNoticeCoordinatorOptions) {}

  snapshot(senderUrl: string): RuntimeUpdateNoticeSnapshot | null {
    if (!this.isCurrentHarnessPage(senderUrl) || this.current === undefined) return null;
    return { ...this.current };
  }

  beginInstallation(attemptId: string): RuntimeUpdateNoticeSnapshot {
    if (this.currentAttemptId === attemptId && this.current !== undefined) return { ...this.current };
    this.currentAttemptId = attemptId;
    this.restartRequested = false;
    return this.transition(attemptId, "installing");
  }

  completeInstallation(attemptId: string): RuntimeUpdateNoticeSnapshot {
    this.assertCurrentAttempt(attemptId);
    return this.transition(attemptId, "installed");
  }

  failInstallation(attemptId: string): RuntimeUpdateNoticeSnapshot {
    this.assertCurrentAttempt(attemptId);
    return this.transition(attemptId, "failed");
  }

  dismiss(senderUrl: string, messageId: unknown): boolean {
    if (!this.isCurrentHarnessPage(senderUrl) || typeof messageId !== "string") return false;
    if (this.current?.messageId !== messageId || !this.current.visible) return false;
    this.current = { ...this.current, visible: false };
    this.publish();
    this.options.diagnostic?.("dismissed", { messageId });
    return true;
  }

  restart(senderUrl: string, messageId: unknown): boolean {
    if (!this.isCurrentHarnessPage(senderUrl) || typeof messageId !== "string") return false;
    if (
      this.current?.kind !== "installed"
      || this.current.messageId !== messageId
      || this.restartRequested
    ) return false;
    this.restartRequested = true;
    this.options.diagnostic?.("restart-requested", { messageId });
    this.options.relaunch();
    this.options.quit();
    return true;
  }

  private transition(attemptId: string, kind: RuntimeUpdateNoticeKind): RuntimeUpdateNoticeSnapshot {
    this.current = {
      schemaVersion: 1,
      messageId: `${attemptId}:${kind}`,
      kind,
      visible: true
    };
    this.publish();
    this.options.diagnostic?.(kind, { messageId: this.current.messageId });
    this.showNativeNotificationIfNeeded(this.current);
    return { ...this.current };
  }

  private publish(): void {
    const window = this.options.getWindow();
    if (
      this.current === undefined
      || window === null
      || window.isDestroyed()
      || !this.isCurrentHarnessPage(window.getCurrentUrl())
    ) return;
    window.send(RUNTIME_UPDATE_NOTICE_CHANGED_CHANNEL, { ...this.current });
  }

  private showNativeNotificationIfNeeded(snapshot: RuntimeUpdateNoticeSnapshot): void {
    const window = this.options.getWindow();
    if (
      window !== null
      && !window.isDestroyed()
      && window.isVisible()
      && !window.isMinimized()
      && window.isFocused()
    ) return;
    let notification: RuntimeUpdateNativeNotification | undefined;
    try {
      notification = this.options.createNotification({
        title: this.options.applicationName ?? "arkme",
        body: notificationBody(snapshot.kind)
      });
    } catch (error) {
      this.nativeNotificationFailed(snapshot.messageId, error);
      return;
    }
    if (notification === undefined) return;
    notification.onClick(() => { this.restoreAndFocusWindow(); });
    notification.onFailed(error => { this.nativeNotificationFailed(snapshot.messageId, error); });
    try {
      notification.show();
    } catch (error) {
      this.nativeNotificationFailed(snapshot.messageId, error);
    }
  }

  private nativeNotificationFailed(messageId: string, error: unknown): void {
    this.options.diagnostic?.("native-notification-failed", {
      messageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  private restoreAndFocusWindow(): void {
    const window = this.options.getWindow();
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private isCurrentHarnessPage(senderUrl: string): boolean {
    const origin = this.options.getHarnessOrigin();
    if (origin === null) return false;
    try {
      return new URL(senderUrl).origin === origin;
    } catch {
      return false;
    }
  }

  private assertCurrentAttempt(attemptId: string): void {
    if (this.currentAttemptId !== attemptId || this.current === undefined) {
      throw new Error("Runtime update notice attempt is not active");
    }
  }
}

export async function stageRuntimeUpdateInBackground(options: {
  attemptId: string;
  coordinator: RuntimeUpdateNoticeCoordinator;
  stageLatest(progress: (state: RuntimeInstallProgress) => void): Promise<RuntimeStageLatestResult>;
}): Promise<RuntimeStageLatestResult> {
  let installationStarted = false;
  try {
    const result = await options.stageLatest(() => {
      if (installationStarted) return;
      installationStarted = true;
      options.coordinator.beginInstallation(options.attemptId);
    });
    if (installationStarted && result === "staged") {
      options.coordinator.completeInstallation(options.attemptId);
    }
    return result;
  } catch (error) {
    if (installationStarted) options.coordinator.failInstallation(options.attemptId);
    throw error;
  }
}

export function registerRuntimeUpdateNoticeIpc(
  ipc: RuntimeUpdateNoticeIpcMain,
  coordinator: RuntimeUpdateNoticeCoordinator
): void {
  ipc.handle(RUNTIME_UPDATE_NOTICE_SNAPSHOT_CHANNEL, event => (
    coordinator.snapshot(event.senderFrame?.url ?? "")
  ));
  ipc.handle(RUNTIME_UPDATE_NOTICE_DISMISS_CHANNEL, (event, messageId) => (
    coordinator.dismiss(event.senderFrame?.url ?? "", messageId)
  ));
  ipc.handle(RUNTIME_UPDATE_NOTICE_RESTART_CHANNEL, (event, messageId) => (
    coordinator.restart(event.senderFrame?.url ?? "", messageId)
  ));
}

export async function installRuntimeUpdateNoticeStyles(
  target: RuntimeUpdateNoticeStyleTarget,
  harnessOrigin: string | null
): Promise<boolean> {
  if (harnessOrigin === null || !sameOrigin(target.getCurrentUrl(), harnessOrigin)) return false;
  await target.insertCSS(RUNTIME_UPDATE_NOTICE_CSS);
  return true;
}

function sameOrigin(candidateUrl: string, expectedOrigin: string): boolean {
  try {
    return new URL(candidateUrl).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function notificationBody(kind: RuntimeUpdateNoticeKind): string {
  if (kind === "installing") return "已检测到新版，正在后台安装…";
  if (kind === "installed") return "新版本已安装，重启后激活。";
  return "更新失败，当前版本可继续使用，下次启动自动重试。";
}

export const RUNTIME_UPDATE_NOTICE_CSS = `
#arkme-runtime-update-notice {
  position: fixed;
  z-index: 2147483646;
  top: 36px;
  left: 50%;
  transform: translateX(-50%);
  width: fit-content;
  max-width: min(520px, calc(100% - 32px));
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#arkme-runtime-update-notice .arkme-runtime-update-notice__card {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  box-sizing: border-box;
  padding: 7px 9px 7px 13px;
  border: 1px solid rgba(109, 126, 163, 0.22);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.97);
  color: #20283b;
  box-shadow: 0 8px 24px rgba(33, 41, 63, 0.14);
  pointer-events: auto;
  animation: arkme-runtime-update-notice-in 160ms ease-out;
}
#arkme-runtime-update-notice .arkme-runtime-update-notice__icon { color: #496ee8; font-weight: 700; }
#arkme-runtime-update-notice[data-kind="installed"] .arkme-runtime-update-notice__icon { color: #16845b; }
#arkme-runtime-update-notice[data-kind="failed"] .arkme-runtime-update-notice__icon { color: #b25a1b; }
#arkme-runtime-update-notice .arkme-runtime-update-notice__message {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
#arkme-runtime-update-notice .arkme-runtime-update-notice__actions { display: flex; align-items: center; gap: 6px; }
#arkme-runtime-update-notice button {
  appearance: none;
  border: 0;
  border-radius: 7px;
  padding: 5px 8px;
  background: transparent;
  color: #4f5c75;
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
}
#arkme-runtime-update-notice button:hover { background: #eef2ff; color: #2f50c7; }
#arkme-runtime-update-notice button[data-primary="true"] { background: #496ee8; color: #fff; }
#arkme-runtime-update-notice button:disabled { cursor: default; opacity: 0.65; }
#arkme-runtime-update-notice .arkme-runtime-update-notice__close { padding: 4px 7px; font-size: 17px; line-height: 1; }
@keyframes arkme-runtime-update-notice-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  #arkme-runtime-update-notice .arkme-runtime-update-notice__card { animation: none; }
}
`;
