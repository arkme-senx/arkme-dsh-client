import { BrowserWindow, ipcMain, shell } from "electron";
import { LongArticleWindows } from "./long-article-windows.js";
const prefix = "arkme-long-article:";
export function installLongArticleWindowIpc(options: {
  main(): BrowserWindow | null;
  origin(): string | null;
  scope(): string;
  preload(): string;
  conversationSender?(id: number): boolean;
  changed?(): void;
}): LongArticleWindows {
  const sameOrigin = (url: string) => { try { return new URL(url).origin === options.origin(); } catch { return false; } };
  const childOrigins = new Map<number, string>();
  const manager = new LongArticleWindows({
    scope: options.scope,
    notify: value => { options.changed?.(); const main = options.main(); if (main && !main.isDestroyed()) main.webContents.send(prefix + "created", value); },
    create: () => {
      const main = options.main();
      if (!main || main.isDestroyed() || !sameOrigin(main.webContents.getURL())) throw new Error("Arkme is not ready");
      const url = new URL(main.webContents.getURL()); url.search = "?arkmeLongArticle=1"; url.hash = "";
      const window = new BrowserWindow({ width: 960, height: 800, minWidth: 640, minHeight: 520, show: false,
        title: "Arkme", backgroundColor: "#ffffff", autoHideMenuBar: true,
        webPreferences: { session: main.webContents.session, preload: options.preload(), contextIsolation: true,
          nodeIntegration: false, sandbox: true, webSecurity: true },
      });
      childOrigins.set(window.webContents.id, url.origin);
      const childId = window.webContents.id;
      window.on("closed", () => childOrigins.delete(childId));
      window.webContents.on("will-attach-webview", event => event.preventDefault());
      // The editor must stay on its boot page. Links are handled in a system browser.
      window.webContents.on("will-navigate", (event, destination) => { if (destination !== url.href) event.preventDefault(); });
      window.webContents.on("will-redirect", event => event.preventDefault());
      window.webContents.setWindowOpenHandler(({ url: destination }) => {
        try { if (["https:", "http:"].includes(new URL(destination).protocol)) void shell.openExternal(destination); } catch {}
        return { action: "deny" };
      });
      window.webContents.on("render-process-gone", () => { manager.cancelClose(); manager.finishClose(window.webContents.id); });
      return {
        id: window.webContents.id, show: () => window.show(), focus: () => window.focus(), restore: () => window.restore(),
        isMinimized: () => window.isMinimized(), close: () => window.close(), load: () => window.loadURL(url.href),
        send: (event, value) => { if (!window.isDestroyed()) window.webContents.send(prefix + event, value); },
        on: (event: "close" | "closed", listener: (...args: any[]) => void) => { window.on(event as "close", listener); },
      };
    },
  });
  const trusted = (event: Electron.IpcMainInvokeEvent) => event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame && sameOrigin(event.senderFrame.url);
  const mainSender = (event: Electron.IpcMainInvokeEvent) => trusted(event) && event.sender.id === options.main()?.webContents.id;
  const childSender = (event: Electron.IpcMainInvokeEvent) => {
    if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame || !manager.context(event.sender.id)) return false;
    try { return new URL(event.senderFrame.url).origin === childOrigins.get(event.sender.id); } catch { return false; }
  };
  ipcMain.handle(prefix + "account", (event, account: unknown) => {
    if (!mainSender(event) || (account !== null && (typeof account !== "string" || account.length > 256))) return false;
    manager.setAccount(account as string | null); return true;
  });
  ipcMain.handle(prefix + "open", async (event, value: unknown) => {
    if (!mainSender(event) && !(trusted(event) && options.conversationSender?.(event.sender.id))) throw new Error("Untrusted article opener");
    await manager.open(value); return true;
  });
  ipcMain.handle(prefix + "context", event => childSender(event) ? manager.context(event.sender.id) : null);
  ipcMain.handle(prefix + "ready", event => { if (childSender(event)) manager.ready(event.sender.id); });
  ipcMain.handle(prefix + "active", event => childSender(event) && manager.isActive(event.sender.id));
  ipcMain.handle(prefix + "close", event => { if (childSender(event)) manager.finishClose(event.sender.id); });
  ipcMain.handle(prefix + "cancel-close", event => { if (childSender(event)) manager.cancelClose(); });
  ipcMain.handle(prefix + "published", (event, item: unknown) => childSender(event) && manager.created(event.sender.id, item));
  return manager;
}
