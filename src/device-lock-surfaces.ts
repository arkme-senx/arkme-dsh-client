import { app, BrowserWindow, ipcMain, WebContentsView } from "electron";
import type { DesktopDeviceLockOwner, DeviceLockSnapshot } from "./device-lock-owner.js";

type ProtectedWindow = {
  visible: boolean; title: string; contentProtected?: boolean;
  show: () => void; showInactive: () => void; hide: () => void; focus: () => void;
  setTitle: (title: string) => void;
};

/** Native visibility is the privacy boundary, including the OS accessibility tree.
 * BrowserWindow's primary view is a native sibling of contentView, so an opaque
 * child alone cannot hide its accessibility content. Keep business windows
 * hidden and show one trusted lock window; restore the same windows on unlock.
 */
export class DeviceLockSurfaces {
  private readonly windows = new Map<BrowserWindow, ProtectedWindow>();
  private readonly covers = new Map<BrowserWindow, WebContentsView>();
  private guard: BrowserWindow | undefined;
  private creatingGuard = false;
  private source: BrowserWindow | undefined;
  private protected = false;
  constructor(private readonly owner: DesktopDeviceLockOwner, private readonly preload: string, private readonly html: string) {
    app.on("web-contents-created", (_event, contents) => {
      const setWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
      contents.setWindowOpenHandler = handler => setWindowOpenHandler(details => owner.protected ? { action: "deny" } : handler(details));
      contents.on("will-attach-webview", event => { if (owner.protected) event.preventDefault(); });
      contents.on("before-input-event", event => {
        if (owner.protected && contents.id !== this.guard?.webContents.id) event.preventDefault();
      });
    });
    app.on("browser-window-created", (_event, window) => { if (!this.creatingGuard) this.attach(window); });
    ipcMain.handle("arkme-device-lock:snapshot", event => this.allowed(event.sender.id) ? owner.snapshot() : null);
    ipcMain.handle("arkme-device-lock:unlock", async event => {
      if (!this.allowed(event.sender.id)) return null;
      try { await owner.requestUnlock(); } catch { /* The owner keeps protection and feedback. */ }
      return owner.snapshot();
    });
    for (const window of BrowserWindow.getAllWindows()) this.attach(window);
    this.update(owner.snapshot());
  }
  private allowed(id: number): boolean { return this.guard?.webContents.id === id; }
  private get title(): string { return this.owner.snapshot().sessionEnded ? "正在退出登录…" : "即我已锁定"; }
  revealOnActivate(window: BrowserWindow | null): void {
    if (window === null || window.isDestroyed() || !this.windows.has(window)
      || BrowserWindow.getAllWindows().some(item => item.isVisible())) return;
    // Only an explicit application activation may reopen windows that were
    // hidden while the guard was closed or unlocked in the background.
    window.show(); window.focus();
  }
  private attach(window: BrowserWindow): void {
    if (this.windows.has(window)) return;
    const state: ProtectedWindow = { visible: window.isVisible(), title: window.getTitle(),
      show: window.show.bind(window), showInactive: window.showInactive.bind(window),
      hide: window.hide.bind(window), focus: window.focus.bind(window), setTitle: window.setTitle.bind(window) };
    this.windows.set(window, state);
    window.show = () => {
      state.visible = true;
      if (this.owner.protected) { this.protect(window); this.showGuard(window); } else state.show();
    };
    window.showInactive = () => {
      state.visible = true;
      if (this.owner.protected) { this.protect(window); this.showGuard(window, false); } else state.showInactive();
    };
    window.hide = () => { state.visible = false; state.hide(); };
    window.focus = () => { if (this.owner.protected) this.showGuard(window); else state.focus(); };
    window.setTitle = title => { state.title = title; state.setTitle(this.owner.protected ? this.title : title); };
    window.on("page-title-updated", (event, title) => {
      if (this.owner.protected) { event.preventDefault(); state.title = title; state.setTitle(this.title); }
    });
    window.on("show", () => {
      if (this.owner.protected) { state.visible = true; this.protect(window); this.showGuard(window); }
    });
    window.on("focus", () => { if (this.owner.protected) { this.protect(window); this.showGuard(window); } });
    window.on("resize", () => this.resizeCover(window));
    window.webContents.on("devtools-opened", () => { if (this.owner.protected) window.webContents.closeDevTools(); });
    window.webContents.on("dom-ready", () => { if (this.owner.protected) this.protect(window); });
    window.once("closed", () => { this.windows.delete(window); this.removeCover(window); });
    if (this.owner.protected) this.protect(window);
  }
  private protect(window: BrowserWindow): void {
    const state = this.windows.get(window); if (state === undefined || window.isDestroyed()) return;
    if (window.getTitle() !== this.title) state.setTitle(this.title);
    if (this.covers.has(window) && !window.isVisible()) return;
    // An opaque native child also protects any synchronous show during window
    // construction; hide removes the underlying view from native accessibility.
    if (!this.covers.has(window)) {
      state.contentProtected = window.isContentProtected();
      const cover = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      cover.setBackgroundColor("#eeeeee"); this.covers.set(window, cover);
      window.contentView.addChildView(cover); this.resizeCover(window);
    }
    window.setContentProtection(true); window.webContents.closeDevTools();
    state.hide();
    if (process.platform === "darwin") window.closeFilePreview();
  }
  private resizeCover(window: BrowserWindow): void {
    const cover = this.covers.get(window); if (cover === undefined || window.isDestroyed()) return;
    const [width = 0, height = 0] = window.getContentSize(); cover.setBounds({ x: 0, y: 0, width, height });
  }
  private showGuard(source: BrowserWindow, activate = true): void {
    if (!this.owner.protected || source.isDestroyed()) return;
    this.source = source;
    if (this.guard === undefined || this.guard.isDestroyed()) {
      this.creatingGuard = true;
      let guard: BrowserWindow;
      try {
        guard = new BrowserWindow({ ...source.getBounds(), show: false, title: this.title,
          minWidth: 420, minHeight: 400, backgroundColor: "#eeeeee",
          webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      } finally { this.creatingGuard = false; }
      this.guard = guard;
      guard.setMenu(null);
      guard.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      guard.webContents.on("will-navigate", event => event.preventDefault());
      guard.webContents.on("render-process-gone", () => {
        // A failed lock renderer never restores hidden business windows.
        if (this.owner.protected && this.guard === guard) void guard.loadFile(this.html).catch(() => undefined);
      });
      guard.once("closed", () => {
        if (this.guard !== guard) return;
        this.guard = undefined;
        // Closing the lock window is a visibility choice, never an unlock.
        // Background snapshots must not reopen it or resurrect private windows.
        for (const state of this.windows.values()) state.visible = false;
      });
      void guard.loadFile(this.html).catch(() => undefined);
    }
    if (activate) { this.guard.show(); this.guard.focus(); } else this.guard.showInactive();
  }
  update(snapshot: DeviceLockSnapshot): void {
    const changed = this.protected !== snapshot.locked;
    this.protected = snapshot.locked;
    if (snapshot.locked) {
      let visible: BrowserWindow | undefined;
      let focused: BrowserWindow | undefined;
      for (const [window, state] of this.windows) {
        if (window.isDestroyed()) continue;
        if (changed) state.visible = state.visible || window.isVisible();
        if (state.visible) visible = window;
        if (window.isFocused()) focused = window;
        this.protect(window);
      }
      if (changed && visible !== undefined && this.guard === undefined) this.showGuard(focused ?? visible, focused !== undefined);
      if (this.guard !== undefined && this.guard.getTitle() !== this.title) this.guard.setTitle(this.title);
      this.guard?.webContents.send("arkme-device-lock:changed", snapshot);
      return;
    }
    // A report acknowledgement is not a visibility transition. In particular,
    // never show/minimize/activate windows on routine unlocked refreshes.
    if (!changed) return;
    const guard = this.guard; this.guard = undefined;
    const restore = guard !== undefined && !guard.isDestroyed() && guard.isVisible() && !guard.isMinimized();
    const activate = restore && guard.isFocused();
    if (guard !== undefined && !guard.isDestroyed()) {
      if (this.source !== undefined && !this.source.isDestroyed()) this.source.setBounds(guard.getBounds());
      guard.destroy();
    }
    for (const [window, state] of this.windows) {
      if (window.isDestroyed()) continue;
      if (this.covers.has(window)) {
        this.removeCover(window); window.setContentProtection(state.contentProtected ?? false);
        delete state.contentProtected;
      }
      state.setTitle(state.title);
      if (state.visible && restore) state.showInactive();
      else state.visible = false;
    }
    if (activate && this.source !== undefined && !this.source.isDestroyed() && this.windows.get(this.source)?.visible) this.windows.get(this.source)!.focus();
    this.source = undefined;
  }
  private removeCover(window: BrowserWindow): void {
    const cover = this.covers.get(window); if (cover === undefined) return;
    this.covers.delete(window);
    if (!window.isDestroyed()) window.contentView.removeChildView(cover);
    if (!cover.webContents.isDestroyed()) cover.webContents.close();
  }
}
