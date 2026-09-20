import { BrowserWindow, ipcMain, screen, shell } from "electron";
import { acceptsPreviewPopup, previewBounds } from "./attachment-preview-window.js";
let savedBounds: Electron.Rectangle | undefined;

/** One restricted, nonmodal DOM child. The opener owns all account/media state. */
export function installAttachmentPreviewNative(main: BrowserWindow, origin: () => string | null) {
  let child: BrowserWindow | undefined;
  const close = () => { if (child && !child.isDestroyed()) child.destroy(); child = undefined; };
  const focus = () => {
    if (!child || child.isDestroyed()) return;
    const area = screen.getDisplayMatching(child.getNormalBounds()).workArea;
    if (!child.isMaximized()) child.setBounds(previewBounds(child.getNormalBounds(), area));
    if (child.isMinimized()) child.restore();
    child.show(); child.focus();
  };
  const request = (event: Electron.IpcMainEvent, action: unknown) => {
    if (event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) return;
    if (action === "close") close();
    if (action === "focus") focus();
  };
  ipcMain.on("arkme-attachment-preview", request);
  main.webContents.on("did-create-window", (window, details) => {
    if (!acceptsPreviewPopup(details.url, details.frameName, main.webContents.getURL(), origin())) return;
    if (child && !child.isDestroyed()) child.destroy();
    child = window;
    window.setMenu(null);
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("will-redirect", event => event.preventDefault());
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.setWindowOpenHandler(({url}) => {
      try { if (["http:", "https:"].includes(new URL(url).protocol)) void shell.openExternal(url); } catch {}
      return {action: "deny"};
    });
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key.toLowerCase() === "w" && (process.platform === "darwin" ? input.meta : input.control)) {
        event.preventDefault(); window.close();
      }
    });
    const remember = () => { if (!window.isDestroyed() && !window.isMinimized()) savedBounds = window.getNormalBounds(); };
    window.on("move", remember); window.on("resize", remember); window.on("close", remember);
    window.on("closed", () => { if (child === window) child = undefined; });
    window.webContents.on("render-process-gone", close);
  });
  main.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
  main.webContents.on("render-process-gone", close);
  main.on("closed", () => { close(); ipcMain.removeListener("arkme-attachment-preview", request); });
  return {
    handle(details: {url: string; frameName: string}): Electron.WindowOpenHandlerResponse | undefined {
      if (!acceptsPreviewPopup(details.url, details.frameName, main.webContents.getURL(), origin())) return undefined;
      if (child && !child.isDestroyed()) { focus(); return {action: "deny"}; }
      const area = screen.getDisplayMatching(savedBounds ?? main.getBounds()).workArea;
      return {action: "allow", outlivesOpener: false, overrideBrowserWindowOptions: {
        ...previewBounds(savedBounds, area), minWidth: Math.min(560, area.width), minHeight: Math.min(400, area.height),
        title: "Arkme · 文件预览", frame: true, titleBarStyle: "default", autoHideMenuBar: true,
        modal: false, alwaysOnTop: false, resizable: true, minimizable: true, maximizable: true,
        backgroundColor: "#ffffff", fullscreen: false,
      }};
    },
  };
}
