import { BrowserWindow, ipcMain, WebContentsView, type Rectangle, type WebContents } from 'electron';

const callBackground = '#101216';

interface CallSession {
  id: string;
  view: WebContentsView;
  basePath: string;
  window?: BrowserWindow;
  regularBounds?: Rectangle;
  compact: boolean;
  shellReady: boolean;
  wantsVisible: boolean;
  error: string;
}

// The receiver needs a live SDK document, but no native window until a call is visible.
// Attach that same view for incoming calls so its pending SDK invitation survives.
export function installCallWindow(options: {
  main: () => BrowserWindow | null;
  origin: () => string | null;
  preload: string;
}) {
  let active: CallSession | undefined;
  const trusted = (event: Electron.IpcMainEvent) => {
    const origin = options.origin();
    return !!origin && event.sender === options.main()?.webContents && !!event.senderFrame &&
      event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(origin + '/');
  };
  function notify(call: CallSession, kind: string, value = '') {
    const main = options.main();
    if (call === active && main && !main.isDestroyed()) main.webContents.send('arkme-call:event', call.id, kind, value);
  }
  function dispose() {
    const previous = active;
    active = undefined;
    if (!previous) return;
    previous.window?.destroy();
    if (!previous.view.webContents.isDestroyed()) previous.view.webContents.close();
  }
  function create(id: string, owner: WebContents, origin: string, basePath: string) {
    dispose();
    const view = new WebContentsView({webPreferences: {
      session: owner.session, preload: options.preload, sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false
    }});
    view.setBackgroundColor(callBackground);
    const call: CallSession = { id, view, basePath, compact: false, shellReady: false, wantsVisible: false, error: '' };
    active = call;
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('before-input-event', (event, input) => {
      if (call.window?.isVisible() && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        notify(call, 'cancel');
      }
    });
    const failed = () => notify(call, 'message', JSON.stringify({ type: 'fatal_error', message: '通话界面加载失败，请重试' }));
    contents.on('render-process-gone', failed);
    void contents.loadURL(origin + basePath + '/index.html?callRequestId=' + encodeURIComponent(id)).catch(failed);
    return call;
  }
  function open(call: CallSession) {
    const win = new BrowserWindow({
      width: 960, height: 640, frame: false, show: false, autoHideMenuBar: true,
      backgroundColor: callBackground, title: '通话', webPreferences: {sandbox: true, nodeIntegration: false, contextIsolation: true}
    });
    call.window = win;
    win.setMenu(null);
    win.contentView.addChildView(call.view);
    const layout = () => {
      const [width = 960, height = 640] = win.getContentSize();
      call.view.setBounds({ x: 0, y: 0, width, height });
    };
    win.on('resize', layout);
    win.on('close', event => {
      if (active !== call) return;
      event.preventDefault();
      notify(call, 'cancel');
    });
    layout();

    return win;
  }
  function reveal(call: CallSession) {
    if (!call.wantsVisible || !call.window || call.window.isVisible() || (!call.shellReady && !call.error)) return;
    call.window.show();
    call.view.webContents.focus();
  }
  function resize(call: CallSession, win: BrowserWindow, compact: boolean, fullscreen: boolean) {
    if (win.isFullScreen() !== fullscreen) win.setFullScreen(fullscreen);
    if (call.compact === compact) return;
    call.compact = compact;
    if (compact) {
      call.regularBounds = win.getNormalBounds();
      win.setSize(160, 280);
    } else if (call.regularBounds) {
      win.setBounds(call.regularBounds);
    }
  }

  ipcMain.on('arkme-call:sync', (event, id, basePath, visible, compact, fullscreen, error) => {
    const origin = options.origin();
    if (!trusted(event) || !origin || typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*call$/.test(basePath) || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) ||
        [visible, compact, fullscreen].some(flag => typeof flag !== 'boolean') || typeof error !== 'string') return;
    const call = active?.id === id && active.basePath === basePath ? active : create(id, event.sender, origin, basePath);
    call.wantsVisible = visible;
    if (visible) {
      const win = call.window ?? open(call);
      resize(call, win, compact, fullscreen);
    } else call.window?.hide();
    if (call.error !== error) {
      call.error = error.slice(0, 500);
      call.view.webContents.send('arkme-call:error', call.error);
    }
    reveal(call);
  });
  ipcMain.on('arkme-call:release', (event, id) => { if (trusted(event) && active?.id === id) dispose(); });
  const commands = new Set(['bootstrap','call','hangup','terminate','logout','media_permission_result']);
  ipcMain.on('arkme-call:command', (event, id, type, payload) => {
    if (!trusted(event) || !active || id !== active.id || !commands.has(type)) return;
    active.view.webContents.send('arkme-call:deliver', JSON.stringify({ type, payload }));
  });
  const fromView = (event: Electron.IpcMainEvent) => active && event.sender === active.view.webContents &&
    event.senderFrame && event.senderFrame === event.sender.mainFrame;
  ipcMain.on('arkme-call:loaded', event => {
    if (!active || !fromView(event)) return;
    notify(active, 'loaded');
    if (active.error) active.view.webContents.send('arkme-call:error', active.error);
  });
  ipcMain.on('arkme-call:message', (event, value) => {
    if (!active || !fromView(event) || typeof value !== 'string' || value.length > 65536) return;
    if (!active.shellReady) {
      try {
        // The call UI emits state after mounting its existing loading screen, before SDK login.
        if (JSON.parse(value)?.type === 'state') {
          active.shellReady = true;
          reveal(active);
        }
      } catch { return; }
    }
    notify(active, 'message', value);
  });
  ipcMain.on('arkme-call:dismiss', event => { if (active && fromView(event)) notify(active, 'cancel'); });
  return { dispose };
}
