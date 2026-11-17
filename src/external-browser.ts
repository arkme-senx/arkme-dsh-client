import { dialog, shell, type BrowserWindow } from "electron";

export async function showRecordingLinkError(window: BrowserWindow, expired: boolean): Promise<void> {
  if (window.isDestroyed()) return;
  await dialog.showMessageBox(window, {
    type: "info",
    message: expired ? "录音删除计划已失效或来自其他实例" : "录音删除计划暂时无法打开",
    detail: "请在当前设备的 DSH 会话中重新生成计划后打开。",
  }).catch(() => undefined);
}

/** Call after the owning window has admitted this URL for browser handoff. */
export async function openExternalBrowser(window: BrowserWindow, url: string): Promise<void> {
  try {
    await shell.openExternal(url);
  } catch {
    if (window.isDestroyed()) return;
    await dialog.showMessageBox(window, {
      type: "error",
      message: "无法打开链接",
      detail: "请检查系统默认浏览器设置，或复制链接到浏览器打开。",
    }).catch(() => undefined);
  }
}
