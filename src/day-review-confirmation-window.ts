import type { BrowserWindow, WindowOpenHandlerResponse } from "electron";
import { fileURLToPath } from "node:url";

/** Only the active Harness may open its script-free confirmation document. */
export function acceptsDayReviewConfirmation(target: string, source: string, origin: string | null): boolean {
  try {
    const url = new URL(target);
    return origin !== null && new URL(source).origin === origin && url.origin === origin
      && !url.username && !url.password && !url.hash
      && url.pathname === "/arkme-self/api"
      && /^[a-f0-9-]{36}$/.test(url.searchParams.get("dayReviewConfirmation") ?? "")
      && ["create", "resume", "reconcile"].includes(url.searchParams.get("action") ?? "")
      && url.searchParams.has("intent") && (url.searchParams.get("intent")?.length ?? 0) <= 24000;
  } catch { return false; }
}

export function isDayReviewConfirmationReceipt(target: string, request: string): boolean {
  try {
    const url = new URL(target), original = new URL(request);
    return url.origin === original.origin && url.pathname === original.pathname
      && url.searchParams.get("dayReviewConfirmation") === original.searchParams.get("dayReviewConfirmation")
      && url.searchParams.get("receipt") === "complete" && !url.searchParams.has("intent");
  } catch { return false; }
}

export function installDayReviewConfirmationWindow(main: BrowserWindow, origin: () => string | null) {
  let child: BrowserWindow | undefined;
  const close = () => { if (child && !child.isDestroyed()) child.destroy(); child = undefined; };
  main.webContents.on("did-create-window", (window, details) => {
    if (!acceptsDayReviewConfirmation(details.url, main.webContents.getURL(), origin())) return;
    child = window;
    window.setMenu(null);
    // The form may POST only to the document that displayed its one-use nonce.
    window.webContents.on("will-navigate", (event, url) => { if (url !== details.url) event.preventDefault(); });
    window.webContents.on("will-redirect", (event, url) => {
      event.preventDefault();
      if (isDayReviewConfirmationReceipt(url, details.url)) window.close();
    });
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && (input.key === "Escape" || (input.key.toLowerCase() === "w" && (input.meta || input.control)))) {
        event.preventDefault(); window.close();
      }
    });
    window.on("closed", () => { if (child === window) child = undefined; });
    window.webContents.on("render-process-gone", close);
  });
  main.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
  main.webContents.on("render-process-gone", close);
  main.on("closed", close);
  return {
    handle(details: { url: string }): WindowOpenHandlerResponse | undefined {
      if (!acceptsDayReviewConfirmation(details.url, main.webContents.getURL(), origin())) return undefined;
      if (child && !child.isDestroyed()) { child.show(); child.focus(); return { action: "deny" }; }
      return { action: "allow", outlivesOpener: false, overrideBrowserWindowOptions: {
        parent: main, modal: true, width: 480, height: 460, minWidth: 360, minHeight: 380, title: "日回顾",
        minimizable: false, maximizable: false, fullscreenable: false,
        autoHideMenuBar: true, titleBarStyle: "default",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
          preload: fileURLToPath(new URL("./day-review-confirmation-preload.cjs", import.meta.url)), javascript: false },
      } };
    },
  };
}
