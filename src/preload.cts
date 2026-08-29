import { contextBridge, ipcRenderer } from "electron";

interface DesktopNotificationRequest {
  eventUid: string;
  sourceRef: string;
  sourceKind: "private_chat" | "group_chat";
  title: string;
  body: string;
  eventAtMillis: number;
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

const RUNTIME_UPDATE_NOTICE_ROOT_ID = "arkme-runtime-update-notice";

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
      actions.append(
        runtimeUpdateNoticeButton(documentRef, "立即重启", () => {
          const button = actions.children[0] as HTMLButtonElement | undefined;
          if (button !== undefined) button.disabled = true;
          void bridge.restart(snapshot.messageId).then(accepted => {
            if (!accepted && button !== undefined) button.disabled = false;
          }).catch(() => { if (button !== undefined) button.disabled = false; });
        }, true),
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
    documentRef.documentElement.append(root);
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

contextBridge.exposeInMainWorld(
  "arkmeDesktop",
  Object.freeze({
    startupAuthGate: true as const,
    appUpdate: true as const,
    runtimeManaged: true as const,
    ...(harnessVersion === undefined ? {} : { harnessVersion }),
    update: Object.freeze({
      status: async () => await ipcRenderer.invoke("arkme-app-update:status"),
      check: async () => await ipcRenderer.invoke("arkme-app-update:check"),
      download: async () => await ipcRenderer.invoke("arkme-app-update:download"),
      showInFolder: async () => await ipcRenderer.invoke("arkme-app-update:show-in-folder")
    })
  })
);

contextBridge.exposeInMainWorld("arkmeDesktopNotifications", {
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
  }
});

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

installRuntimeUpdateNoticeRenderer(Object.freeze({
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
