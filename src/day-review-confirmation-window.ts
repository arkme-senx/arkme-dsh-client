import type { BrowserWindow, WindowOpenHandlerResponse } from "electron";
import { fileURLToPath } from "node:url";

/** Only the active Harness may open its script-free confirmation document. */
export function acceptsDayReviewConfirmation(target: string, source: string, origin: string | null): boolean {
  try {
    const url = new URL(target);
    return origin !== null && new URL(source).origin === origin && url.origin === origin
      && !url.username && !url.password && !url.hash
      && url.pathname === "/arkme-self/api"
      && !url.searchParams.has("recordingDeletionConfirmation")
      && /^[a-f0-9-]{36}$/.test(url.searchParams.get("dayReviewConfirmation") ?? "")
      && ["create", "resume", "reconcile"].includes(url.searchParams.get("action") ?? "")
      && url.searchParams.has("intent") && (url.searchParams.get("intent")?.length ?? 0) <= 24000;
  } catch { return false; }
}

export function acceptsRecordingDeletionConfirmation(target: string, source: string, origin: string | null): boolean {
  try {
    const url = new URL(target);
    const planId = url.searchParams.get("recordingDeletionConfirmation") ?? "";
    return origin !== null && new URL(source).origin === origin && url.origin === origin
      && !url.username && !url.password && !url.hash
      && url.pathname === "/arkme-self/api"
      && url.searchParams.size === 1
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(planId);
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

type ConfirmationKind = "day-review" | "recording-deletion";

export function installDayReviewConfirmationWindow(
  main: BrowserWindow,
  origin: () => string | null,
  showRecordingError?: (window: BrowserWindow, expired: boolean) => void,
) {
  let child: { window: BrowserWindow; url: string; kind: ConfirmationKind } | undefined;
  const close = () => {
    const window = child?.window;
    child = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  };
  const kindFor = (url: string): ConfirmationKind | undefined => {
    const source = main.webContents.getURL();
    const activeOrigin = origin();
    if (acceptsDayReviewConfirmation(url, source, activeOrigin)) return "day-review";
    if (acceptsRecordingDeletionConfirmation(url, source, activeOrigin)) return "recording-deletion";
  };

  main.webContents.on("did-create-window", (window, details) => {
    const kind = kindFor(details.url);
    if (!kind) return;
    child = { window, url: details.url, kind };
    window.setMenu(null);
    // The form may POST only to the document that displayed its one-use nonce.
    window.webContents.on("will-navigate", (event, url) => { if (url !== details.url) event.preventDefault(); });
    window.webContents.on("will-redirect", (event, url) => {
      event.preventDefault();
      if (kind === "day-review" && isDayReviewConfirmationReceipt(url, details.url)) window.close();
    });
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (kind === "recording-deletion") {
      window.webContents.on("did-navigate", (_event, url, statusCode) => {
        if (url === details.url && statusCode >= 400) showRecordingError?.(window, statusCode === 403);
      });
      window.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
        if (code !== -3 && isMainFrame && url === details.url) showRecordingError?.(window, false);
      });
    }
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && (input.key === "Escape" || (input.key.toLowerCase() === "w" && (input.meta || input.control)))) {
        event.preventDefault(); window.close();
      }
    });
    window.on("closed", () => { if (child?.window === window) child = undefined; });
    window.webContents.on("render-process-gone", () => { if (child?.window === window) close(); });
  });
  main.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
  main.webContents.on("render-process-gone", close);
  main.on("closed", close);
  return {
    handle(details: { url: string; postBody?: unknown }): WindowOpenHandlerResponse | undefined {
      const kind = kindFor(details.url);
      if (!kind) {
        try {
          const url = new URL(details.url);
          if (origin() !== null && new URL(main.webContents.getURL()).origin === origin()
            && ["http:", "https:"].includes(url.protocol)
            && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            && url.pathname === "/arkme-self/api" && url.searchParams.has("recordingDeletionConfirmation")) {
            showRecordingError?.(main, true);
            return { action: "deny" };
          }
        } catch { /* Let the navigation policy reject malformed URLs. */ }
        return undefined;
      }
      if (details.postBody !== undefined) return { action: "deny" };
      if (child && !child.window.isDestroyed()) {
        if (child.kind === kind && (kind === "day-review" || child.url === details.url)) {
          child.window.show(); child.window.focus();
          return { action: "deny" };
        }
        close();
      }

      const deletion = kind === "recording-deletion";
      return { action: "allow", outlivesOpener: false, overrideBrowserWindowOptions: {
        parent: main, modal: true, width: deletion ? 700 : 480, height: deletion ? 600 : 460,
        minWidth: 360, minHeight: 380, title: deletion ? "确认删除录音" : "日回顾",
        minimizable: false, maximizable: false, fullscreenable: false,
        autoHideMenuBar: true, titleBarStyle: "default",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
          preload: fileURLToPath(new URL("./day-review-confirmation-preload.cjs", import.meta.url)), javascript: false },
      } };
    },
  };
}
