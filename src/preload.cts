import { contextBridge, ipcRenderer } from "electron";

interface DesktopNotificationRequest {
  eventUid: string;
  sourceRef: string;
  sourceKey?: string;
  sourceKind: "private_chat" | "group_chat";
  title: string;
  body: string;
  eventAtMillis: number;
}

interface DesktopNotificationActivation {
  kind: "chat-source";
  sourceRef: string;
  sourceKey?: string;
}

interface DesktopNotificationActivationV2 extends DesktopNotificationActivation {
  activationId: string;
}

type DesktopNotificationActivationV2Outcome =
  | "resolved"
  | "not-found"
  | "failed"
  | "superseded";

interface DesktopAttentionCapabilities {
  schemaVersion: 1;
  notificationShow: boolean;
  notificationPermission: DesktopNotificationPermission;
  badgeMode: "count" | "dot" | "unsupported";
}

type DesktopNotificationPermission = NotificationPermission | "unavailable";
const DESKTOP_NOTIFICATION_PERMISSION_STATE_CHANNEL = "arkme:desktop-notification:permission-state";
const DESKTOP_NOTIFICATION_OPEN_SETTINGS_CHANNEL = "arkme:desktop-notification:open-settings";
const DESKTOP_NOTIFICATION_REFRESH_PERMISSION_CHANNEL = "arkme:desktop-notification:refresh-permission";
const DESKTOP_NOTIFICATION_PERMISSION_CHANGED_CHANNEL = "arkme:desktop-notification:permission-changed";
const DESKTOP_NOTIFICATION_READY_V2_CHANNEL = "arkme:desktop-notification:ready-v2";
const DESKTOP_NOTIFICATION_UNREADY_V2_CHANNEL = "arkme:desktop-notification:unready-v2";
const DESKTOP_NOTIFICATION_ACTIVATED_V2_CHANNEL = "arkme:desktop-notification:activated-v2";
const DESKTOP_NOTIFICATION_RESULT_V2_CHANNEL = "arkme:desktop-notification:result-v2";
const desktopNotificationConsumerId = createDesktopNotificationConsumerId();
const desktopNotificationActivationV2Listeners = new Set<(
  activation: Readonly<DesktopNotificationActivationV2>
) => void>();
let desktopNotificationActivationV2HandlerInstalled = false;
const desktopNotificationActivationV2Handler = (
  _event: Electron.IpcRendererEvent,
  value: unknown
) => {
  const activation = parseDesktopNotificationActivationV2(value);
  if (activation === undefined) return;
  const frozenActivation = Object.freeze(activation);
  for (const listener of desktopNotificationActivationV2Listeners) listener(frozenActivation);
};

function currentDesktopNotificationPermission(): DesktopNotificationPermission {
  if (typeof Notification === "undefined") return "unavailable";
  const permission = Notification.permission;
  return permission === "default" || permission === "granted" || permission === "denied"
    ? permission
    : "unavailable";
}

function reportDesktopNotificationPermission(
  permission: DesktopNotificationPermission
): DesktopNotificationPermission {
  ipcRenderer.sendSync(DESKTOP_NOTIFICATION_PERMISSION_STATE_CHANNEL, permission);
  return permission;
}

async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
    return reportDesktopNotificationPermission("unavailable");
  }
  try {
    const permission = await Notification.requestPermission();
    reportDesktopNotificationPermission(permission);
    return parseDesktopNotificationPermission(
      await ipcRenderer.invoke(DESKTOP_NOTIFICATION_REFRESH_PERMISSION_CHANNEL)
    );
  } catch {
    return reportDesktopNotificationPermission("unavailable");
  }
}

interface RuntimeInstallProgress {
  kind: "runtime-installing";
  phase: "download" | "verify" | "install";
  harnessPercent: number;
  pluginPercent: number;
}

interface RuntimeUpdateNoticeRendererBridge {
  snapshot(): Promise<unknown>;
  dismiss(messageId: string): Promise<boolean>;
  restart(messageId: string): Promise<boolean>;
  onChanged(listener: (value: unknown) => void): () => void;
}

interface RuntimeUpdateNoticeSnapshot {
  schemaVersion: 1;
  messageId: string;
  kind: "installing" | "installed" | "failed";
  visible: boolean;
}

type DesktopLocationPermissionState =
  | "granted"
  | "prompt"
  | "denied"
  | "restricted"
  | "services-disabled"
  | "unavailable";

interface DesktopLocationPermissionSnapshot {
  readonly schemaVersion: 1;
  readonly state: DesktopLocationPermissionState;
}

const DESKTOP_LOCATION_ACTIVATION_LEASE_MILLIS = 2_000;
const DESKTOP_LOCATION_UNAVAILABLE: DesktopLocationPermissionSnapshot = Object.freeze({
  schemaVersion: 1,
  state: "unavailable"
});
let desktopLocationActivationAt = Number.NEGATIVE_INFINITY;

function rememberDesktopLocationUserActivation(): boolean {
  let active = false;
  try {
    active = navigator.userActivation?.isActive === true;
  } catch {
    active = false;
  }
  if (active) desktopLocationActivationAt = Date.now();
  return active;
}

function hasDesktopLocationUserActivation(): boolean {
  if (rememberDesktopLocationUserActivation()) return true;
  const leased = Date.now() - desktopLocationActivationAt <= DESKTOP_LOCATION_ACTIVATION_LEASE_MILLIS;
  desktopLocationActivationAt = Number.NEGATIVE_INFINITY;
  return leased;
}

interface AppUpdateState {
  status: "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "failed";
  currentVersion: string;
  currentVersionCode: number;
  canAutoInstall: boolean;
  latestVersion?: string;
  latestVersionCode?: number;
  releaseNotes?: string;
  error?: string;
  failureStage?: "check" | "download" | "install";
  downloadedBytes?: number;
  totalBytes?: number;
  installWarning?: string;
}
interface AppUpdateNotice {
  schemaVersion: 1;
  revision: number;
  expanded: boolean;
  state: AppUpdateState | null;
  websiteOpening: boolean;
  actionError?: string;
  actionMessage?: string;
}

let appUpdateInstalling = false;
let runtimeRestartPending = false;

function desktopUpdateNoticeStack(documentRef: Document): HTMLElement {
  const existing = documentRef.getElementById("arkme-desktop-update-notices");
  if (existing !== null) return existing;
  const root = documentRef.createElement("div");
  root.id = "arkme-desktop-update-notices";
  documentRef.documentElement.append(root);
  return root;
}

function parseAppUpdateNotice(value: unknown): AppUpdateNotice | null {
  if (value === null || typeof value !== "object") return null;
  const notice = value as Partial<AppUpdateNotice>;
  if (notice.schemaVersion !== 1 || !Number.isSafeInteger(notice.revision) || (notice.revision ?? -1) < 0
    || typeof notice.expanded !== "boolean" || typeof notice.websiteOpening !== "boolean") return null;
  const state = notice.state;
  if (state !== null && (state === undefined || typeof state !== "object"
    || !["idle", "checking", "current", "available", "downloading", "downloaded", "installing", "failed"].includes(state.status)
    || typeof state.currentVersion !== "string" || !Number.isSafeInteger(state.currentVersionCode)
    || typeof state.canAutoInstall !== "boolean")) return null;
  return notice as AppUpdateNotice;
}

function installAppUpdateNoticeRenderer(documentRef: Document = document): () => void {
  let latest: AppUpdateNotice | null = null;
  let disposed = false;
  let domReady = documentRef.readyState !== "loading";
  const rootId = "arkme-app-update-notice";
  const invoke = (operation: string) => {
    void ipcRenderer.invoke(`arkme-app-update:${operation}`).catch(() => {
      const message = documentRef.getElementById("arkme-app-update-action-error");
      if (message !== null) message.textContent = "操作未完成，请重试";
    });
  };
  const render = () => {
    if (!domReady || disposed) return;
    documentRef.getElementById(rootId)?.remove();
    const notice = latest;
    const state = notice?.state;
    // The envelope exists before a version is discovered. It is not a reason to
    // show UI, and dismissing a real update must not leave a floating launcher.
    if (!notice?.expanded || !state?.latestVersion?.trim()
      || typeof state.latestVersionCode !== "number" || state.latestVersionCode <= state.currentVersionCode
      || !["available", "downloading", "downloaded", "installing", "failed"].includes(state.status)) return;
    const status = state.status;
    const root = documentRef.createElement("aside");
    root.id = rootId;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    const button = (text: string, operation: string, primary = false) => {
      const result = runtimeUpdateNoticeButton(documentRef, text, () => invoke(operation), primary);
      result.disabled = status === "installing" || notice.websiteOpening;
      return result;
    };
    const card = documentRef.createElement("div");
    card.className = "arkme-app-update-card";
    const icon = documentRef.createElement("span");
    icon.className = "arkme-app-update-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = status === "downloaded" ? "✓" : status === "failed" ? "!" : status === "installing" ? "↻" : "↓";
    const content = documentRef.createElement("div");
    content.className = "arkme-app-update-content";
    const title = documentRef.createElement("strong");
    title.textContent = status === "downloaded" ? `客户端 v${state.latestVersion} 已就绪`
      : status === "installing" ? "正在安装更新，即将重新启动…"
      : status === "failed" ? `v${state.latestVersion} 更新未完成`
      : `检测到新版本 v${state.latestVersion}`;
    content.append(title);
    const detail = documentRef.createElement("p");
    detail.textContent = status === "failed" ? state.error ?? "请重试或前往官网下载最新版本"
      : status === "available" ? state.canAutoInstall ? "正在准备更新包" : "请前往官网下载最新版本"
      : status === "downloading" ? "正在后台下载" : "";
    content.append(detail);
    if (status === "downloading" && typeof state.totalBytes === "number" && Number.isFinite(state.totalBytes) && state.totalBytes > 0) {
      const percent = Math.min(100, Math.max(0, Math.round((state.downloadedBytes ?? 0) / state.totalBytes * 100)));
      detail.textContent += ` · ${percent}%`;
      const progress = documentRef.createElement("progress");
      progress.setAttribute("max", "100");
      progress.setAttribute("value", String(percent));
      progress.setAttribute("aria-label", "APP 更新下载进度");
      content.append(progress);
    }
    if (state.installWarning && status !== "installing") {
      const warning = documentRef.createElement("p");
      warning.setAttribute("role", "alert");
      warning.textContent = state.installWarning;
      content.append(warning);
    }
    if (state.releaseNotes && (status === "available" || status === "downloading")) {
      const notes = documentRef.createElement("p");
      notes.className = "arkme-app-update-notes";
      notes.textContent = state.releaseNotes;
      content.append(notes);
    }
    const feedback = documentRef.createElement("p");
    feedback.id = "arkme-app-update-action-error";
    feedback.setAttribute("role", notice.actionError ? "alert" : "status");
    feedback.textContent = notice.actionError ?? notice.actionMessage ?? "";
    content.append(feedback);
    const actions = documentRef.createElement("div");
    actions.className = "arkme-app-update-actions";
    if (status === "available" && !state.canAutoInstall) {
      actions.append(button("稍后", "collapse"), button("下载最新版本", "open-website", true));
    } else if (status === "downloaded") {
      if (state.installWarning) actions.append(button("下载最新版本", "open-website"));
      actions.append(button("稍后安装", "collapse"), button("重启并安装", "install", true));
    } else if (status === "failed") {
      actions.append(button("重试", "retry"), button("下载最新版本", "open-website", true), button("关闭", "collapse"));
    } else if (status !== "installing") {
      actions.append(button("关闭", "collapse"));
    }
    card.append(icon, content, actions); root.append(card);
    desktopUpdateNoticeStack(documentRef).append(root);
    applyAppInstallingState(documentRef);
  };
  const accept = (value: unknown) => {
    const parsed = parseAppUpdateNotice(value);
    if (parsed === null || (latest !== null && parsed.revision <= latest.revision)) return;
    latest = parsed;
    appUpdateInstalling = parsed.state?.status === "installing";
    render();
    applyAppInstallingState(documentRef);
  };
  const onChange = (_event: Electron.IpcRendererEvent, value: unknown) => { accept(value); };
  const onReady = () => { domReady = true; render(); };
  ipcRenderer.on("arkme-app-update:changed", onChange);
  if (!domReady) documentRef.addEventListener("DOMContentLoaded", onReady, { once: true });
  void ipcRenderer.invoke("arkme-app-update:notice").then(accept).catch(() => undefined);
  return () => {
    disposed = true;
    ipcRenderer.removeListener("arkme-app-update:changed", onChange);
    documentRef.removeEventListener("DOMContentLoaded", onReady);
    documentRef.getElementById(rootId)?.remove();
  };
}

const RUNTIME_UPDATE_NOTICE_ROOT_ID = "arkme-runtime-update-notice";
const RUNTIME_UPDATE_NOTICE_RESTART_ID = "arkme-runtime-update-restart";

function applyAppInstallingState(documentRef: Document): void {
  const runtime = documentRef.getElementById(RUNTIME_UPDATE_NOTICE_ROOT_ID);
  if (runtime !== null) runtime.setAttribute("data-app-installing", String(appUpdateInstalling));
  const restart = documentRef.getElementById(RUNTIME_UPDATE_NOTICE_RESTART_ID) as HTMLButtonElement | null;
  if (restart !== null) restart.disabled = appUpdateInstalling || runtimeRestartPending;
}

// Keep this renderer in the preload entry: sandboxed Electron preloads cannot
// require local relative modules unless the preload is bundled first.
function installRuntimeUpdateNoticeRenderer(
  bridge: RuntimeUpdateNoticeRendererBridge,
  documentRef: Document = document
): () => void {
  let disposed = false;
  let domReady = documentRef.readyState !== "loading";
  let latest: RuntimeUpdateNoticeSnapshot | null = null;
  let renderedMessageId: string | undefined;
  let changeRevision = 0;

  const hide = () => {
    documentRef.getElementById(RUNTIME_UPDATE_NOTICE_ROOT_ID)?.remove();
    renderedMessageId = undefined;
  };
  const dismiss = (messageId: string) => {
    void bridge.dismiss(messageId).then(accepted => {
      if (accepted && renderedMessageId === messageId) hide();
    }).catch(() => undefined);
  };
  const render = () => {
    if (!domReady || disposed) return;
    hide();
    if (latest === null || !latest.visible) return;
    const snapshot = latest;
    const root = documentRef.createElement("aside");
    root.id = RUNTIME_UPDATE_NOTICE_ROOT_ID;
    root.setAttribute("data-kind", snapshot.kind);
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");

    const card = documentRef.createElement("div");
    card.className = "arkme-runtime-update-notice__card";
    const icon = documentRef.createElement("span");
    icon.className = "arkme-runtime-update-notice__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = snapshot.kind === "installing" ? "↻" : snapshot.kind === "installed" ? "✓" : "!";
    const message = documentRef.createElement("span");
    message.className = "arkme-runtime-update-notice__message";
    message.textContent = runtimeUpdateNoticeMessage(snapshot.kind);
    const actions = documentRef.createElement("span");
    actions.className = "arkme-runtime-update-notice__actions";

    if (snapshot.kind === "installed") {
      const restart = runtimeUpdateNoticeButton(documentRef, "立即重启", () => {
        runtimeRestartPending = true;
        applyAppInstallingState(documentRef);
        void bridge.restart(snapshot.messageId).then(accepted => {
          if (!accepted) {
            runtimeRestartPending = false;
            applyAppInstallingState(documentRef);
          }
        }).catch(() => {
          runtimeRestartPending = false;
          applyAppInstallingState(documentRef);
        });
      }, true);
      restart.id = RUNTIME_UPDATE_NOTICE_RESTART_ID;
      restart.disabled = appUpdateInstalling || runtimeRestartPending;
      actions.append(
        restart,
        runtimeUpdateNoticeButton(documentRef, "稍后", () => { dismiss(snapshot.messageId); })
      );
    } else if (snapshot.kind === "failed") {
      actions.append(runtimeUpdateNoticeButton(documentRef, "知道了", () => { dismiss(snapshot.messageId); }));
    }

    const close = runtimeUpdateNoticeButton(documentRef, "×", () => { dismiss(snapshot.messageId); });
    close.className = "arkme-runtime-update-notice__close";
    close.setAttribute("aria-label", "关闭更新提示");
    card.append(icon, message, actions, close);
    root.append(card);
    desktopUpdateNoticeStack(documentRef).append(root);
    applyAppInstallingState(documentRef);
    renderedMessageId = snapshot.messageId;
  };
  const accept = (value: unknown) => {
    latest = parseRuntimeUpdateNoticeSnapshot(value);
    render();
  };
  const acceptChange = (value: unknown) => {
    changeRevision += 1;
    accept(value);
  };
  const onDomReady = () => {
    domReady = true;
    render();
  };

  if (!domReady) documentRef.addEventListener("DOMContentLoaded", onDomReady, { once: true });
  const stopChanges = bridge.onChanged(acceptChange);
  const snapshotRevision = changeRevision;
  void bridge.snapshot().then(value => {
    if (changeRevision === snapshotRevision) accept(value);
  }).catch(() => {
    if (changeRevision === snapshotRevision) accept(null);
  });

  return () => {
    disposed = true;
    stopChanges();
    documentRef.removeEventListener("DOMContentLoaded", onDomReady);
    hide();
  };
}

function runtimeUpdateNoticeButton(
  documentRef: Document,
  label: string,
  action: () => void,
  primary = false
): HTMLButtonElement {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (primary) button.setAttribute("data-primary", "true");
  button.addEventListener("click", action);
  return button;
}

function parseRuntimeUpdateNoticeSnapshot(value: unknown): RuntimeUpdateNoticeSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.messageId !== "string"
    || candidate.messageId.length === 0
    || candidate.messageId.length > 256
    || (candidate.kind !== "installing" && candidate.kind !== "installed" && candidate.kind !== "failed")
    || typeof candidate.visible !== "boolean"
  ) return null;
  return {
    schemaVersion: 1,
    messageId: candidate.messageId,
    kind: candidate.kind,
    visible: candidate.visible
  };
}

function runtimeUpdateNoticeMessage(kind: RuntimeUpdateNoticeSnapshot["kind"]): string {
  if (kind === "installing") return "已检测到新版，正在后台安装…";
  if (kind === "installed") return "新版本已安装，重启后激活。";
  return "更新失败，当前版本可继续使用，下次启动自动重试。";
}

const harnessVersionValue = ipcRenderer.sendSync("arkme-runtime:harness-version") as unknown;
const harnessVersion = typeof harnessVersionValue === "string" && harnessVersionValue.trim() !== ""
  ? harnessVersionValue.trim()
  : undefined;
reportDesktopNotificationPermission(currentDesktopNotificationPermission());
const attentionCapabilities = parseDesktopAttentionCapabilities(
  ipcRenderer.sendSync("arkme-desktop:attention-capabilities") as unknown
);
let initialAppUpdateCheck = true;
const harnessReadyNonce = ipcRenderer.sendSync("arkme-runtime:page-ready-nonce") as unknown;
let harnessReadyNotified = false;

contextBridge.exposeInMainWorld(
  "arkmeDesktop",
  Object.freeze({
    notifyHarnessReady(): void {
      if (harnessReadyNotified || typeof harnessReadyNonce !== "string" || harnessReadyNonce === "") return;
      harnessReadyNotified = true;
      ipcRenderer.send("arkme-runtime:page-ready", harnessReadyNonce);
    },
    startupAuthGate: true as const,
    appUpdate: true as const,
    appUpdateUi: true as const,
    appVersion: ipcRenderer.sendSync("arkme-app-update:app-version") as string,
    runtimeManaged: true as const,
    ...(harnessVersion === undefined ? {} : { harnessVersion }),
    attention: Object.freeze(attentionCapabilities),
    update: Object.freeze({
      status: async () => await ipcRenderer.invoke("arkme-app-update:status"),
      check: async () => {
        if (initialAppUpdateCheck) {
          initialAppUpdateCheck = false;
          return await ipcRenderer.invoke("arkme-app-update:status");
        }
        return await ipcRenderer.invoke("arkme-app-update:check");
      },
      download: async () => await ipcRenderer.invoke("arkme-app-update:download"),
      install: async () => await ipcRenderer.invoke("arkme-app-update:install"),
      open: async () => await ipcRenderer.invoke("arkme-app-update:open") as boolean,
      onChanged(listener: (state: AppUpdateState | null) => void): () => void {
        let revision = -1;
        const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
          const notice = parseAppUpdateNotice(value);
          if (notice !== null && notice.revision > revision) { revision = notice.revision; listener(notice.state); }
        };
        ipcRenderer.on("arkme-app-update:changed", handler);
        return () => { ipcRenderer.removeListener("arkme-app-update:changed", handler); };
      }
    })
  })
);

contextBridge.exposeInMainWorld("arkmeDesktopNotifications", Object.freeze({
  permission(): DesktopNotificationPermission {
    return parseDesktopAttentionCapabilities(
      ipcRenderer.sendSync("arkme-desktop:attention-capabilities") as unknown
    ).notificationPermission;
  },
  async requestPermission(): Promise<DesktopNotificationPermission> {
    const current = parseDesktopAttentionCapabilities(
      ipcRenderer.sendSync("arkme-desktop:attention-capabilities") as unknown
    );
    if (current.notificationPermission !== "default") return current.notificationPermission;
    await requestDesktopNotificationPermission();
    return parseDesktopAttentionCapabilities(
      ipcRenderer.sendSync("arkme-desktop:attention-capabilities") as unknown
    ).notificationPermission;
  },
  async refreshPermission(): Promise<DesktopNotificationPermission> {
    return parseDesktopNotificationPermission(
      await ipcRenderer.invoke(DESKTOP_NOTIFICATION_REFRESH_PERMISSION_CHANNEL)
    );
  },
  async openSettings(): Promise<boolean> {
    return await ipcRenderer.invoke(DESKTOP_NOTIFICATION_OPEN_SETTINGS_CHANNEL) as boolean;
  },
  onPermissionChanged(listener: (permission: DesktopNotificationPermission) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(parseDesktopNotificationPermission(value));
    };
    ipcRenderer.on(DESKTOP_NOTIFICATION_PERMISSION_CHANGED_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(DESKTOP_NOTIFICATION_PERMISSION_CHANGED_CHANNEL, handler); };
  },
  show(request: DesktopNotificationRequest): Promise<{ shown: boolean }> {
    return ipcRenderer.invoke("arkme:desktop-notification:show", request) as Promise<{ shown: boolean }>;
  },
  onActivated(listener: (sourceRef: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, sourceRef: unknown) => {
      if (typeof sourceRef === "string") listener(sourceRef);
    };
    ipcRenderer.on("arkme:desktop-notification:activated", handler);
    ipcRenderer.send("arkme:desktop-notification:ready");
    return () => { ipcRenderer.removeListener("arkme:desktop-notification:activated", handler); };
  },
  onActivation(listener: (activation: Readonly<DesktopNotificationActivation>) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const activation = parseDesktopNotificationActivation(value);
      if (activation !== undefined) listener(Object.freeze(activation));
    };
    ipcRenderer.on("arkme:desktop-notification:activated-v1", handler);
    ipcRenderer.send("arkme:desktop-notification:ready");
    return () => { ipcRenderer.removeListener("arkme:desktop-notification:activated-v1", handler); };
  },
  onActivationV2(listener: (activation: Readonly<DesktopNotificationActivationV2>) => void): () => void {
    let disposed = false;
    desktopNotificationActivationV2Listeners.add(listener);
    if (!desktopNotificationActivationV2HandlerInstalled) {
      ipcRenderer.on(DESKTOP_NOTIFICATION_ACTIVATED_V2_CHANNEL, desktopNotificationActivationV2Handler);
      desktopNotificationActivationV2HandlerInstalled = true;
      ipcRenderer.send(
        DESKTOP_NOTIFICATION_READY_V2_CHANNEL,
        Object.freeze({ consumerId: desktopNotificationConsumerId })
      );
    }
    return () => {
      if (disposed) return;
      disposed = true;
      desktopNotificationActivationV2Listeners.delete(listener);
      if (!desktopNotificationActivationV2HandlerInstalled
        || desktopNotificationActivationV2Listeners.size > 0) return;
      ipcRenderer.removeListener(
        DESKTOP_NOTIFICATION_ACTIVATED_V2_CHANNEL,
        desktopNotificationActivationV2Handler
      );
      desktopNotificationActivationV2HandlerInstalled = false;
      ipcRenderer.send(
        DESKTOP_NOTIFICATION_UNREADY_V2_CHANNEL,
        Object.freeze({ consumerId: desktopNotificationConsumerId })
      );
    };
  },
  completeActivationV2(
    activationId: string,
    outcome: DesktopNotificationActivationV2Outcome
  ): boolean {
    if (!boundedNonBlankString(activationId, 128) || !isDesktopNotificationActivationV2Outcome(outcome)) {
      return false;
    }
    ipcRenderer.send(DESKTOP_NOTIFICATION_RESULT_V2_CHANNEL, Object.freeze({
      consumerId: desktopNotificationConsumerId,
      activationId,
      outcome
    }));
    return true;
  }
}));

if (process.platform === "darwin") {
  contextBridge.exposeInMainWorld("arkmeDesktopLocation", Object.freeze({
    async permissionState(): Promise<DesktopLocationPermissionSnapshot> {
      // A real activation observed here creates a short, isolated-world lease so
      // click -> await permissionState() -> requestPermission() stays authorized.
      rememberDesktopLocationUserActivation();
      return await ipcRenderer.invoke(
        "arkme:desktop-location:permission-state"
      ) as DesktopLocationPermissionSnapshot;
    },
    async requestPermission(): Promise<DesktopLocationPermissionSnapshot> {
      if (!hasDesktopLocationUserActivation()) return DESKTOP_LOCATION_UNAVAILABLE;
      return await ipcRenderer.invoke(
        "arkme:desktop-location:request-permission",
        { userActivation: true }
      ) as DesktopLocationPermissionSnapshot;
    },
    async openSettings(): Promise<boolean> {
      if (!hasDesktopLocationUserActivation()) return false;
      return await ipcRenderer.invoke(
        "arkme:desktop-location:open-settings",
        { userActivation: true }
      ) as boolean;
    }
  }));
}

contextBridge.exposeInMainWorld("arkmeRuntimeStatus", Object.freeze({
  onProgress(listener: (progress: RuntimeInstallProgress) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const progress = parseRuntimeInstallProgress(value);
      if (progress !== undefined) listener(progress);
    };
    ipcRenderer.on("arkme:runtime-status:progress", handler);
    return () => { ipcRenderer.removeListener("arkme:runtime-status:progress", handler); };
  }
}));

const stopRuntimeUpdateNotice = installRuntimeUpdateNoticeRenderer(Object.freeze({
  snapshot: async () => await ipcRenderer.invoke("arkme:runtime-update-notice:snapshot") as unknown,
  dismiss: async (messageId: string) => await ipcRenderer.invoke(
    "arkme:runtime-update-notice:dismiss",
    messageId
  ) as boolean,
  restart: async (messageId: string) => await ipcRenderer.invoke(
    "arkme:runtime-update-notice:restart",
    messageId
  ) as boolean,
  onChanged(listener: (value: unknown) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { listener(value); };
    ipcRenderer.on("arkme:runtime-update-notice:changed", handler);
    return () => { ipcRenderer.removeListener("arkme:runtime-update-notice:changed", handler); };
  }
}));

const stopAppUpdateNotice = installAppUpdateNoticeRenderer();
if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
  stopAppUpdateNotice();
  stopRuntimeUpdateNotice();
}, { once: true });

function parseRuntimeInstallProgress(value: unknown): RuntimeInstallProgress | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<Record<keyof RuntimeInstallProgress, unknown>>;
  if (
    candidate.kind !== "runtime-installing"
    || (candidate.phase !== "download" && candidate.phase !== "verify" && candidate.phase !== "install")
    || typeof candidate.harnessPercent !== "number"
    || !Number.isFinite(candidate.harnessPercent)
    || typeof candidate.pluginPercent !== "number"
    || !Number.isFinite(candidate.pluginPercent)
  ) return undefined;
  return {
    kind: "runtime-installing",
    phase: candidate.phase,
    harnessPercent: clampPercent(candidate.harnessPercent),
    pluginPercent: clampPercent(candidate.pluginPercent)
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function parseDesktopAttentionCapabilities(value: unknown): DesktopAttentionCapabilities {
  if (typeof value !== "object" || value === null) {
    return {
      schemaVersion: 1,
      notificationShow: false,
      notificationPermission: "unavailable",
      badgeMode: "unsupported"
    };
  }
  const candidate = value as Record<string, unknown>;
  const notificationPermission = candidate.notificationPermission;
  return {
    schemaVersion: 1,
    notificationShow: candidate.schemaVersion === 1 && candidate.notificationShow === true,
    notificationPermission: candidate.schemaVersion === 1
      && (notificationPermission === "default" || notificationPermission === "granted"
        || notificationPermission === "denied" || notificationPermission === "unavailable")
      ? notificationPermission
      : "unavailable",
    badgeMode: candidate.schemaVersion === 1
      && (candidate.badgeMode === "count" || candidate.badgeMode === "dot")
      ? candidate.badgeMode
      : "unsupported"
  };
}

function parseDesktopNotificationPermission(value: unknown): DesktopNotificationPermission {
  return value === "default" || value === "granted" || value === "denied" || value === "unavailable"
    ? value
    : "unavailable";
}

function parseDesktopNotificationActivation(value: unknown): DesktopNotificationActivation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const hasSourceKey = Object.prototype.hasOwnProperty.call(candidate, "sourceKey");
  if (
    (Object.keys(candidate).length !== 2 && Object.keys(candidate).length !== 3)
    || candidate.kind !== "chat-source"
    || typeof candidate.sourceRef !== "string"
    || candidate.sourceRef.length === 0
    || candidate.sourceRef.length > 4_096
    || (hasSourceKey && (
      typeof candidate.sourceKey !== "string"
      || candidate.sourceKey.trim().length === 0
      || candidate.sourceKey.length > 512
    ))
    || (!hasSourceKey && Object.keys(candidate).length !== 2)
  ) return undefined;
  return {
    kind: "chat-source",
    sourceRef: candidate.sourceRef,
    ...(hasSourceKey ? { sourceKey: candidate.sourceKey as string } : {})
  };
}

function parseDesktopNotificationActivationV2(
  value: unknown
): DesktopNotificationActivationV2 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const hasSourceKey = Object.prototype.hasOwnProperty.call(candidate, "sourceKey");
  const expectedKeyCount = hasSourceKey ? 4 : 3;
  if (
    Object.keys(candidate).length !== expectedKeyCount
    || !boundedNonBlankString(candidate.activationId, 128)
    || candidate.kind !== "chat-source"
    || !boundedNonBlankString(candidate.sourceRef, 4_096)
    || (hasSourceKey && !boundedNonBlankString(candidate.sourceKey, 512))
  ) return undefined;
  return {
    activationId: candidate.activationId,
    kind: "chat-source",
    sourceRef: candidate.sourceRef,
    ...(hasSourceKey ? { sourceKey: candidate.sourceKey as string } : {})
  };
}

function createDesktopNotificationConsumerId(): string {
  try {
    const value = globalThis.crypto?.randomUUID?.();
    if (boundedNonBlankString(value, 96)) return `preload-${value}`;
  } catch {
    // Fall through to the document-local entropy source below.
  }
  const timestamp = Date.now().toString(36);
  const entropy = Math.random().toString(36).slice(2, 18);
  return `preload-${timestamp}-${entropy}`;
}

function isDesktopNotificationActivationV2Outcome(
  value: unknown
): value is DesktopNotificationActivationV2Outcome {
  return value === "resolved"
    || value === "not-found"
    || value === "failed"
    || value === "superseded";
}

function boundedNonBlankString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim().length > 0;
}
