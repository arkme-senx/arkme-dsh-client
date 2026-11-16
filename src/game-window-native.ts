import { BrowserWindow, dialog, screen } from 'electron';
import { acceptsGameDocument, acceptsGamePopup } from './game-window-policy.js';

// Shared by main and all conversation windows. No call-window state or IPC.
let active: BrowserWindow | undefined;
export function installGameWindowNative(opener: BrowserWindow, origin: () => string | null) {
  let owned: BrowserWindow | undefined;
  const close = () => { if (owned && !owned.isDestroyed()) owned.destroy(); owned = undefined; };
  opener.webContents.on('did-create-window', (child, details) => {
    if (!acceptsGamePopup(details.url, details.frameName, opener.webContents.getURL(), origin())) return;
    active = child; owned = child; child.setMenu(null);
    let documentLoaded = false;
    child.webContents.on('will-navigate', (event, url) => {
      if (documentLoaded || !acceptsGameDocument(url, origin())) event.preventDefault();
    });
    child.webContents.on('did-navigate', (_event, url) => { if (acceptsGameDocument(url, origin())) documentLoaded = true; });
    child.webContents.on('will-redirect', event => event.preventDefault());
    child.webContents.on('will-attach-webview', event => event.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    child.webContents.on('will-prevent-unload', event => {
      if (dialog.showMessageBoxSync(child, {type:'question', buttons:['留在游戏','退出游戏'], defaultId:0, cancelId:0,
        message:'确定退出游戏？', detail:'参与者将离开本局；房主退出将结束整个房间。'}) === 1) event.preventDefault();
    });
    child.webContents.on('render-process-gone', close);
    child.on('closed', () => { if (active === child) active = undefined; if (owned === child) owned = undefined; });
  });
  opener.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
  opener.on('closed', close);
  return {
    handle(details: {url:string;frameName:string}): Electron.WindowOpenHandlerResponse | undefined {
      if (!acceptsGamePopup(details.url,details.frameName,opener.webContents.getURL(),origin())) return undefined;
      if (active && !active.isDestroyed()) { if(active.isMinimized())active.restore();active.show();active.focus();return {action:'deny'}; }
      const area=screen.getDisplayMatching(opener.getBounds()).workArea;
      return {action:'allow',outlivesOpener:false,overrideBrowserWindowOptions:{
        width:Math.min(1100,area.width),height:Math.min(760,area.height),minWidth:Math.min(900,area.width),minHeight:Math.min(640,area.height),
        title:'Arkme · 游戏',autoHideMenuBar:true,modal:false,resizable:true,backgroundColor:'#f6f7fb',
        webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false},
      }};
    },
  };
}
