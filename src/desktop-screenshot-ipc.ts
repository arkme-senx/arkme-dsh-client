import { BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, screen, type IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ScreenshotSession, decodeScreenshotPng } from './desktop-screenshot-session.js';
import {readScreenshotWindows} from './native-screenshot-windows.js';
import {windowsInFrame} from './screenshot-window-geometry.js';
const prefix = 'arkme-screenshot:';
type Result = {status:'cancelled'} | {status:'captured'; contentBase64:string; mimeType:'image/png'; fileName:string};
interface Active {
 destination: 'attachment' | 'clipboard'; lease: ScreenshotSession; owner: BrowserWindow; windows: Map<number,BrowserWindow>; ready: Set<number>;
 cancelAsk?: (()=>void) | undefined; askAttempt?: {digest:string;id:string};
 finish(result?: Result, error?: Error): void; timer: ReturnType<typeof setTimeout> | undefined; saving: boolean;
}
export function installScreenshotIpc(options: {
 main(): BrowserWindow | null; origin(): string | null; scope(): string; preload(): string;
 allowed(id: number): boolean; blocked?(): boolean;
}) {
 let active: Active | undefined;
 let askPending: {session:Active;target:BrowserWindow;requestId:string;settle(error?:Error):void} | undefined;
 const trusted = (e: IpcMainInvokeEvent) => {
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return false;
  try { return new URL(e.senderFrame.url).origin === options.origin(); } catch { return false; }
 };
 const valid = (s: Active) => active === s && s.lease.scope === options.scope() && !s.owner.isDestroyed() && options.allowed(s.lease.owner);
 const editor = (e: IpcMainInvokeEvent) => trusted(e) && active && valid(active) && active.lease.context(e.sender.id, options.scope()) ? active : undefined;
 const cancel = () => active?.finish();
 // A display change invalidates pixel mapping; never export using stale coordinates.
 screen.on('display-added', cancel); screen.on('display-removed', cancel); screen.on('display-metrics-changed', cancel);
 const capture = async (owner: BrowserWindow, requestId: string, destination: Active['destination']): Promise<Result> => {
  if (owner.isDestroyed() || !options.allowed(owner.webContents.id)) throw new Error('截图来源已失效');
  const sender=owner.webContents;
  const url = new URL(sender.getURL());
  if (url.origin !== options.origin()) throw new Error('截图来源已失效');
  if (options.blocked?.()) throw new Error('正在设置截图快捷键，请关闭设置弹窗后再截图');
  if (active) throw new Error('正在截屏，请先完成或取消');
  url.search='?arkmeScreenshot=1'; url.hash='';
  return await new Promise<Result>((resolve,reject) => {
   const ownerId=sender.id;
   const abort=()=>s.finish();
   const watch=setInterval(()=> { if (!valid(s)) s.finish(); },250);
   const s: Active = { destination, lease:new ScreenshotSession(ownerId,requestId,options.scope()), owner, windows:new Map(), ready:new Set(), timer:undefined, saving:false,
    finish(result={status:'cancelled'},error) {
     if (active!==s) return;
     const current=valid(s);
     s.cancelAsk?.();
     active=undefined; s.lease.close(); clearInterval(watch); clearTimeout(s.timer);
     sender.removeListener('destroyed',abort); sender.removeListener('did-start-navigation',abort);
     for(const window of s.windows.values()) if(!window.isDestroyed()) window.destroy();
     s.windows.clear();
     // On macOS, activating the opener can switch Spaces on another display.
     // Closing the non-activating panel lets macOS restore focus naturally.
     if(destination==='attachment' && process.platform!=='darwin' && current && !owner.isDestroyed() && owner.isVisible()) owner.focus();
     if(error) reject(error); else resolve(current ? result : {status:'cancelled'});
    }
   };
   active=s;
   sender.once('destroyed',abort); sender.once('did-start-navigation',abort);
   s.timer=setTimeout(()=>s.finish(undefined,new Error('截图加载超时，请更新 Arkme 插件后重试')),20_000);
   void (async()=> {
    // Capture the visible desktop as-is, including the opener; do not hide or transform the app.
    if(!valid(s)) { s.finish(); return; }
    const displays=screen.getAllDisplays();
    const nativeWindows=readScreenshotWindows();
    const captures=new Map<string, ReturnType<typeof desktopCapturer.getSources>>();
    const frames=await Promise.all(displays.map(async d=> {
     // A shared maximum thumbnail size upsamples smaller/differently shaped screens.
     // Request each display's backing pixels so preview does not resample them twice.
     const width=Math.round(d.size.width*d.scaleFactor),height=Math.round(d.size.height*d.scaleFactor);
     const scale=Math.min(1,16384/width,16384/height,Math.sqrt(64_000_000/(width*height)));
     const thumbnailSize={width:Math.floor(width*scale),height:Math.floor(height*scale)};
     const key=`${thumbnailSize.width}x${thumbnailSize.height}`;
     let capture=captures.get(key);
     if(!capture) {
      capture=desktopCapturer.getSources({types:['screen'],thumbnailSize});
      captures.set(key,capture);
     }
     const sources=await capture;
     if(!valid(s)) { s.finish(); return; }
     const source=sources.find(source=>source.display_id===String(d.id)) ?? (displays.length===1 && sources.length===1 ? sources[0] : undefined);
     if(!source || source.thumbnail.isEmpty()) throw new Error('无法读取屏幕，请检查系统屏幕录制权限后重试');
     const size=source.thumbnail.getSize();
     // Win32 uses physical desktop pixels; Quartz uses logical desktop points.
     const nativeBounds=process.platform==='win32'?screen.dipToScreenRect(null,d.bounds):d.bounds;
     return {display:d,frame:{contentBase64:source.thumbnail.toPNG().toString('base64'),width:size.width,height:size.height,
      windows:windowsInFrame(nativeWindows,nativeBounds,size)}};
    }));
    if(!valid(s)) { s.finish(); return; }
    // Capture all screens before constructing overlays, then load every editor concurrently.
    await Promise.all(frames.map(async entry=> {
     if(!entry)return;
     const {display,frame}=entry;
     const window=new BrowserWindow({...display.bounds,show:false,frame:false,resizable:false,movable:false,skipTaskbar:true,alwaysOnTop:true,
      // A panel accepts keyboard focus without activating the app and switching Spaces.
      ...(process.platform==='darwin' ? {type:'panel' as const} : {}),
      fullscreenable:false,enableLargerThanScreen:true,backgroundColor:'#111111',hasShadow:false,
      webPreferences:{session:sender.session,preload:options.preload(),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
     const id=window.webContents.id; s.windows.set(id,window); s.lease.add(id,frame);
     window.setAlwaysOnTop(true,'screen-saver');
     // macOS's default workspace transition transforms the entire app and briefly hides its Dock icon.
     // Screenshot overlays must keep Arkme's existing foreground application identity.
     window.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true});
     window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
     window.webContents.on('will-navigate',event=>event.preventDefault()); window.webContents.on('will-redirect',event=>event.preventDefault());
     window.webContents.on('will-attach-webview',event=>event.preventDefault());
     window.webContents.on('render-process-gone',()=>s.finish(undefined,new Error('截图编辑器异常关闭，请重试')));
     window.on('closed',()=> { if(s.windows.has(id)) s.finish(); });
     await window.loadURL(url.href);
    }));
    if(!valid(s)) { s.finish(); return; }
   })().catch(error=>s.finish(undefined,error instanceof Error ? error : new Error('截图失败')));
  });
 };
 ipcMain.handle(prefix+'capture', async (e, requestId: unknown) => {
  if (!trusted(e) || !options.allowed(e.sender.id)) throw new Error('截图来源已失效');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error('无效的截图请求');
  const owner=BrowserWindow.fromWebContents(e.sender);
  if (!owner) throw new Error('截图窗口已关闭');
  return await capture(owner, requestId, 'attachment');
 });
 ipcMain.handle(prefix+'cancel',(e,id:unknown)=> { if(trusted(e) && active?.lease.ownedBy(e.sender.id,id)) active.finish(); });
 ipcMain.handle(prefix+'context',e=> {
  const s=editor(e), frame=s?.lease.context(e.sender.id,options.scope());
  return frame && s ? {...frame,destination:s.destination} : null;
 });
 ipcMain.handle(prefix+'ready',e=> {
  const s=editor(e); if(!s) return false; s.ready.add(e.sender.id);
  // All displays must be captured and all renderers must be ready before showing any.
  if(s.windows.size===screen.getAllDisplays().length && s.ready.size===s.windows.size) {
   clearTimeout(s.timer); s.timer=undefined;
   for(const window of s.windows.values()) window.showInactive();
   const pointer=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
   const window=[...s.windows.values()].find(w=>screen.getDisplayMatching(w.getBounds()).id===pointer.id);
   (window ?? s.windows.values().next().value)?.focus();
  }
  return true;
 });
 ipcMain.handle(prefix+'select',e=> {
  const s=editor(e); if(!s || !s.lease.select(e.sender.id,options.scope())) return false;
  for(const [id,window] of s.windows) if(id!==e.sender.id) { s.windows.delete(id); window.destroy(); }
  return true;
 });
 ipcMain.handle(prefix+'close',e=> { editor(e)?.finish(); });
 const png=(value:unknown) => {
  const bytes=decodeScreenshotPng(value), decoded=nativeImage.createFromBuffer(bytes);
  if(decoded.isEmpty()) throw new Error('无法解码截图');
  return bytes;
 };
 ipcMain.handle(prefix+'complete',(e,value:unknown)=> {
  const s=editor(e); if(!s || s.saving) return false;
  const bytes=png(value);
  // Clipboard-only sessions never return an image to a renderer/composer.
  if (s.destination === 'clipboard') {
   clipboard.writeImage(nativeImage.createFromBuffer(bytes));
   s.finish(); return true;
  }
  s.finish({status:'captured',contentBase64:bytes.toString('base64'),mimeType:'image/png',fileName:`截图-${Date.now()}.png`}); return true;
 });
 ipcMain.handle(prefix+'ask-dsh-result',(e,value:unknown)=> {
  const p=askPending;
  if(!p || !trusted(e) || e.sender.id!==p.target.webContents.id || options.main()!==p.target || !options.allowed(e.sender.id) || !valid(p.session))return false;
  if(!value || typeof value!=='object')return false;
  const reply=value as {requestId?:unknown;ok?:unknown;error?:unknown};
  if(reply.requestId!==p.requestId || typeof reply.ok!=='boolean')return false;
  p.settle(reply.ok?undefined:new Error(typeof reply.error==='string'?reply.error.slice(0,1000):'DSH 附件准备失败，请重试'));
  return true;
 });
 ipcMain.handle(prefix+'ask-dsh',async(e,value:unknown)=> {
  const s=editor(e);if(!s || s.saving)return false;
  const bytes=png(value),target=options.main();
  if(!target || target.isDestroyed() || !options.allowed(target.webContents.id) || new URL(target.webContents.getURL()).origin!==options.origin())throw new Error('DSH 主窗口尚未就绪，请重试');
  const digest=createHash('sha256').update(bytes).digest('hex');
  if(s.askAttempt?.digest!==digest)s.askAttempt={digest,id:randomUUID()};
  const operationId=s.askAttempt.id,requestId=randomUUID();
  s.saving=true;
  try {
   await new Promise<void>((resolve,reject)=> {
    const cancel=()=>settle(new Error('截图或 DSH 窗口已变化，请重试'));
    const timer=setTimeout(()=>settle(new Error('DSH 附件准备超时，请重试')),180_000);
    const settle=(error?:Error)=> {
     if(askPending?.requestId!==requestId)return;
     askPending=undefined;s.cancelAsk=undefined;clearTimeout(timer);
     target.webContents.removeListener('destroyed',cancel);target.webContents.removeListener('did-start-navigation',cancel);
     if(error){if(!target.isDestroyed())target.webContents.send(prefix+'ask-dsh-cancel',{requestId});reject(error)}else resolve();
    };
    askPending={session:s,target,requestId,settle};s.cancelAsk=cancel;
    target.webContents.once('destroyed',cancel);target.webContents.once('did-start-navigation',cancel);
    try{target.webContents.send(prefix+'ask-dsh-request',{requestId,operationId,contentBase64:bytes.toString('base64'),fileName:`截图-${Date.now()}.png`})}catch(error){settle(error instanceof Error?error:new Error('DSH 请求失败'))}
   });
   if(!valid(s))return false;
   s.finish();
   // Only activate after the editor is closed, so navigation cannot cancel its attachment request.
   target.webContents.send(prefix+'ask-dsh-activate',{requestId});
   if(target.isMinimized())target.restore();target.show();target.focus();
   return true;
  }finally{s.saving=false}
 });
 ipcMain.handle(prefix+'save',async(e,value:unknown)=> {
  const s=editor(e), window=s?.windows.get(e.sender.id); if(!s || !window || s.saving) return false;
  const bytes=png(value); s.saving=true;
  try {
   // Native save panels must be above the capture overlay.
   window.setAlwaysOnTop(false);
   const chosen=await dialog.showSaveDialog(window,{title:'保存截图',defaultPath:`截图-${Date.now()}.png`,filters:[{name:'PNG 图片',extensions:['png']}]});
   if(!valid(s) || chosen.canceled || !chosen.filePath) return false;
   await writeFile(chosen.filePath,bytes); return true;
  } finally { s.saving=false; if(valid(s) && !window.isDestroyed()) window.setAlwaysOnTop(true,'screen-saver'); }
 });
 return {cancel, async captureClipboard(owner: BrowserWindow): Promise<void> {
  // Held/repeated shortcuts must not interrupt an editor or an attachment capture.
  if (active) return;
  await capture(owner, randomUUID(), 'clipboard');
 }};
}
