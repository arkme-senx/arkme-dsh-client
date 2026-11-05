import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, screen, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ScreenshotSession, decodeScreenshotPng } from './desktop-screenshot-session.js';
import {encodeOpaqueBgraPng} from './screenshot-fast-png.js';
import {createScreenshotWindowReader} from './native-screenshot-windows.js';
import {windowsInFrame} from './screenshot-window-geometry.js';
const SCREENSHOT_EDITOR_PATH='/arkme-self/screenshot';
const prefix = 'arkme-screenshot:';
type ScreenshotTrace = (stage: string, windowId?: number) => void;
type Result = {status:'cancelled'} | {status:'captured'; contentBase64:string; mimeType:'image/png'; fileName:string};
interface Active {
 reusable:boolean; cleanups:Array<()=>void>; trace: ScreenshotTrace; destination: 'attachment' | 'clipboard'; lease: ScreenshotSession; owner: BrowserWindow; windows: Map<number,BrowserWindow>; ready: Set<number>;
 cancelAsk?: (()=>void) | undefined; askAttempt?: {digest:string;id:string};
 finish(result?: Result, error?: Error): void; timer: ReturnType<typeof setTimeout> | undefined; saving: boolean;
}
export function installScreenshotIpc(options: {
 main(): BrowserWindow | null; origin(): string | null; scope(): string; preload(): string;
 allowed(id: number): boolean; blocked?(): boolean; editorPreload?(): string;
}) {
 const readWindows=createScreenshotWindowReader();
 let standaloneRegistration: {origin:string;owner:number;reuse:boolean} | undefined;
 type WarmEditor = {window:BrowserWindow;display:number;key:string;load:Promise<void>;context?:((value:unknown)=>void);detach:()=>void};
 const warmEditors=new Map<number,WarmEditor>();
 let warmTimer:ReturnType<typeof setTimeout>|undefined;
 let quitting=false;
 const geometryKey=(d:Electron.Display)=>JSON.stringify([d.id,d.bounds,d.scaleFactor]);
 const dropWarm=()=>{
  clearTimeout(warmTimer);warmTimer=undefined;
  for(const warm of warmEditors.values()) {warm.context?.(null);if(!warm.window.isDestroyed())warm.window.destroy();}
  warmEditors.clear();
 };
 const makeWindow=(display:Electron.Display,session:Electron.Session,preload:string)=>{
  const window=new BrowserWindow({...display.bounds,show:false,frame:false,resizable:false,movable:false,skipTaskbar:true,alwaysOnTop:true,
   ...(process.platform==='darwin'?{type:'panel' as const}:{}),
   fullscreenable:false,enableLargerThanScreen:true,backgroundColor:'#111111',hasShadow:false,
   webPreferences:{session,preload,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
  window.setAlwaysOnTop(true,'screen-saver');
  window.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.on('will-redirect',event=>event.preventDefault());
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  return window;
 };
 const prepareWarm=()=>{
  warmTimer=undefined;
  const main=options.main(),registration=standaloneRegistration;
  if(quitting||active||!main||main.isDestroyed()||!registration||!options.editorPreload
   ||registration.owner!==main.webContents.id||registration.origin!==options.origin())return;
  for(const display of screen.getAllDisplays()) {
   if([...warmEditors.values()].some(w=>w.key===geometryKey(display)))continue;
   const window=makeWindow(display,main.webContents.session,options.editorPreload());
   const id=window.webContents.id;
   const warm:WarmEditor={window,display:display.id,key:geometryKey(display),load:Promise.resolve(),detach:()=>{window.removeListener('closed',discard);window.webContents.removeListener('render-process-gone',discard);}};
   warmEditors.set(id,warm);
   const discard=()=>{if(warmEditors.get(id)!==warm)return;warmEditors.delete(id);warm.context?.(null);if(!window.isDestroyed())window.destroy();};
   window.once('closed',discard);window.webContents.once('render-process-gone',discard);
   warm.load=window.loadURL(`${registration.origin}${SCREENSHOT_EDITOR_PATH}?arkmeScreenshot=1`).catch(error=>{discard();throw error;});
   // A failed warm-up is not a capture failure; the next request creates a fresh editor.
   void warm.load.catch(()=>{});
  }
 };
 const scheduleWarm=()=>{clearTimeout(warmTimer);if(!quitting)warmTimer=setTimeout(prepareWarm,100);};
 app.on('before-quit',()=>{quitting=true;dropWarm();});
 let active: Active | undefined;
 let askPending: {session:Active;target:BrowserWindow;requestId:string;settle(error?:Error):void} | undefined;
 const trusted = (e: IpcMainInvokeEvent) => {
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return false;
  try { return new URL(e.senderFrame.url).origin === options.origin(); } catch { return false; }
 };
 const valid = (s: Active) => active === s && s.lease.scope === options.scope() && !s.owner.isDestroyed() && options.allowed(s.lease.owner);
 const editor = (e: IpcMainInvokeEvent,token?:unknown) => trusted(e) && active && (!active.reusable || token===active.lease.requestId) && valid(active) && active.lease.context(e.sender.id, options.scope()) ? active : undefined;
 const cancel = () => active?.finish();
 // A display change invalidates pixel mapping; never export using stale coordinates.
 const displaysChanged=()=>{cancel();dropWarm();scheduleWarm();};
 screen.on('display-added', displaysChanged); screen.on('display-removed', displaysChanged); screen.on('display-metrics-changed', displaysChanged);
 const capture = async (owner: BrowserWindow, requestId: string, destination: Active['destination']): Promise<Result> => {
  if (owner.isDestroyed() || !options.allowed(owner.webContents.id)) throw new Error('截图来源已失效');
  const started=performance.now();
  const trace: ScreenshotTrace = process.env.ARKME_SCREENSHOT_PROFILE === '1'
   ? (stage, windowId) => console.info('[arkme-screenshot-profile]', JSON.stringify({requestId,stage,elapsedMs:Math.round((performance.now()-started)*100)/100,...(windowId===undefined?{}:{windowId})}))
   : () => {};
  trace('capture-start');
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
   const s: Active = { reusable:false,cleanups:[],trace, destination, lease:new ScreenshotSession(ownerId,requestId,options.scope()), owner, windows:new Map(), ready:new Set(), timer:undefined, saving:false,
    finish(result={status:'cancelled'},error) {
     if (active!==s) return;
     const current=valid(s);
     s.cancelAsk?.();
     trace(error?'failed':'finished');
     active=undefined; s.lease.close(); clearInterval(watch); clearTimeout(s.timer);
     sender.removeListener('destroyed',abort); sender.removeListener('did-start-navigation',abort);
     for(const cleanup of s.cleanups)cleanup();
     for(const window of s.windows.values()) if(!window.isDestroyed()) {
      if(s.reusable && current && !quitting && standaloneRegistration?.origin===options.origin()) {
       const display=screen.getAllDisplays().find(d=>(['x','y','width','height'] as const).every(key=>d.bounds[key]===window.getBounds()[key]));
       if(display) {
        window.hide();
        const id=window.webContents.id;
        const discard=()=>{const w=warmEditors.get(id);if(!w)return;warmEditors.delete(id);w.context?.(null);if(!window.isDestroyed())window.destroy();};
        warmEditors.set(id,{window,display:display.id,key:geometryKey(display),load:Promise.resolve(),detach:()=>{window.removeListener('closed',discard);window.webContents.removeListener('render-process-gone',discard);}});
        window.once('closed',discard);window.webContents.once('render-process-gone',discard);
        window.webContents.send(prefix+'reset');
        continue;
       }
      }
      window.destroy();
     }
     s.windows.clear();
     scheduleWarm();
     // On macOS, activating the opener can switch Spaces on another display.
     // Closing the non-activating panel lets macOS restore focus naturally.
     if(destination==='attachment' && process.platform!=='darwin' && current && !owner.isDestroyed() && owner.isVisible()) owner.focus();
     if(error) reject(error); else resolve(current ? result : {status:'cancelled'});
    }
   };
   active=s;
   sender.once('destroyed',abort); sender.once('did-start-navigation',abort);
   void (async()=> {
    const screenAccess = () => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
    const needsPermission = () => ['not-determined', 'denied', 'restricted'].includes(screenAccess());
    const permissionGuidance = async () => {
     const {response}=await dialog.showMessageBox({
      type:'info',title:'需要开启录屏权限',message:'需要开启录屏权限',
      detail:`截图需要“录屏与系统录音”权限。请在系统设置 → 隐私与安全性 → 录屏与系统录音中允许“${app.getName()}”录制屏幕。\n\n列表中没有当前应用时，可点击“+”添加。开启后，若系统提示退出并重新打开，请按提示操作，然后再次使用截图快捷键。`,
      buttons:['暂不开启','打开系统设置'],defaultId:1,cancelId:0,noLink:true,
     });
     if(!valid(s))return;
     if(response===1) {
      try { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); }
      catch { throw new Error('无法打开系统设置。请手动前往系统设置 → 隐私与安全性 → 录屏与系统录音，允许当前应用录制屏幕后重试'); }
     }
    };
    if(needsPermission()) { await permissionGuidance(); s.finish(); return; }
    // Permission guidance is user-paced; only time the actual capture/editor load.
    s.timer=setTimeout(()=>s.finish(undefined,new Error('截图加载超时，请更新 Arkme 插件后重试')),20_000);
    try {
    // Capture the visible desktop as-is, including the opener; do not hide or transform the app.
    if(!valid(s)) { s.finish(); return; }
    // The loaded main-window plugin announces support; no network probe on the shortcut path.
    const standalone=!!options.editorPreload && standaloneRegistration?.origin===url.origin
     && standaloneRegistration.owner===options.main()?.webContents.id;
    s.reusable=standalone && standaloneRegistration?.reuse===true;
    const displays=screen.getAllDisplays();
    trace('native-windows-start');
    const nativeWindowsPromise=readWindows().then(windows=>{trace('native-windows-end');return windows;});
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
      trace(`get-sources-start:${key}`);
      capture=desktopCapturer.getSources({types:['screen'],thumbnailSize}).then(sources=>{trace(`get-sources-end:${key}`);return sources;});
      captures.set(key,capture);
     }
     const sources=await capture;
     if(!valid(s)) { s.finish(); return; }
     const source=sources.find(source=>source.display_id===String(d.id)) ?? (displays.length===1 && sources.length===1 ? sources[0] : undefined);
     if(!source || source.thumbnail.isEmpty()) throw new Error('无法读取屏幕，请重试');
     const size=source.thumbnail.getSize();
     // Win32 uses physical desktop pixels; Quartz uses logical desktop points.
     const nativeBounds=process.platform==='win32'?screen.dipToScreenRect(null,d.bounds):d.bounds;
     trace('png-start',d.id);
     const png=(process.platform==='darwin' && typeof source.thumbnail.toBitmap==='function'
      ? encodeOpaqueBgraPng(source.thumbnail.toBitmap(),size.width,size.height) : null) ?? source.thumbnail.toPNG();
     trace('png-end',d.id);
     const contentBase64=png.toString('base64');
     trace('base64-end',d.id);
     const nativeWindows=await nativeWindowsPromise;
     return {display:d,frame:{contentBase64,width:size.width,height:size.height,
      windows:windowsInFrame(nativeWindows,nativeBounds,size)}};
    }));
    if(!valid(s)) { s.finish(); return; }
    const editorUrl=new URL(url.href);
    if(standalone)editorUrl.pathname=SCREENSHOT_EDITOR_PATH;
    const preload=standalone ? options.editorPreload!() : options.preload();
    trace(standalone?'entry-standalone':'entry-legacy');
    // Capture all screens before constructing overlays, then load every editor concurrently.
    await Promise.all(frames.map(async entry=> {
     if(!entry)return;
     const {display,frame}=entry;
     trace('window-create-start',display.id);
     const warm=standalone?[...warmEditors.values()].find(w=>w.key===geometryKey(display)&&!w.window.isDestroyed()):undefined;
     if(warm){warmEditors.delete(warm.window.webContents.id);warm.detach();}
     const window=warm?.window ?? makeWindow(display,sender.session,preload);
     const id=window.webContents.id; trace(warm?'window-warm':'window-created',id);
     // Reused editors never navigate. Load listeners would retain this capture's
     // closure (and frames) forever; new-load listeners also need cancellation cleanup.
     if(!warm) {
      const contents=window.webContents;
      const domReady=()=>trace('dom-ready',id),loaded=()=>trace('did-finish-load',id);
      contents.once('dom-ready',domReady);contents.once('did-finish-load',loaded);
      s.cleanups.push(()=>{contents.removeListener('dom-ready',domReady);contents.removeListener('did-finish-load',loaded);});
     }
     s.windows.set(id,window); s.lease.add(id,frame);
     warm?.context?.({...frame,requestId:s.lease.requestId,destination:s.destination,...(process.env.ARKME_SCREENSHOT_PROFILE==='1'?{profileEnabled:true}:{})});
     const gone=()=>s.finish(undefined,new Error('截图编辑器异常关闭，请重试'));
     const closed=()=>{if(s.windows.has(id))s.finish();};
     window.webContents.on('render-process-gone',gone);window.on('closed',closed);
     s.cleanups.push(()=>{
      // Selecting one display destroys its peers before the capture finishes.
      // Electron rejects webContents access on those destroyed BrowserWindows.
      if(!window.isDestroyed())window.webContents.removeListener('render-process-gone',gone);
      window.removeListener('closed',closed);
     });
     trace('load-url-start',id);
     if(warm)await warm.load;else await window.loadURL(editorUrl.href);
     trace('load-url-end',id);
    }));
    if(!valid(s)) { s.finish(); return; }
    } catch(error) {
     if(valid(s) && needsPermission()) {
      clearTimeout(s.timer);s.timer=undefined;
      await permissionGuidance();s.finish();return;
     }
     throw error;
    }
   })().catch(error=>s.finish(undefined,error instanceof Error ? error : new Error('截图失败')));
  });
 };
 ipcMain.handle(prefix+'enable-standalone',(e,capability:unknown)=>{
  const origin=options.origin();
  if(!origin || !trusted(e) || e.sender.id!==options.main()?.webContents.id)return false;
  if(standaloneRegistration?.owner!==e.sender.id || standaloneRegistration.origin!==origin) {
   dropWarm();
   const navigating=(details?:{isSameDocument?:boolean;isMainFrame?:boolean})=>{
    if(details?.isSameDocument || details?.isMainFrame===false)return;
    e.sender.removeListener('did-start-navigation',navigating);
    standaloneRegistration=undefined;dropWarm();
   };
   e.sender.on('did-start-navigation',navigating);
   e.sender.once('destroyed',()=>{standaloneRegistration=undefined;dropWarm();});
  }
  standaloneRegistration={origin,owner:e.sender.id,reuse:capability==='reset-v1'};
  scheduleWarm();
  if(process.env.ARKME_SCREENSHOT_PROFILE==='1')console.info('[arkme-screenshot-entry]', 'standalone registered');
  return true;
 });
 ipcMain.handle(prefix+'capture', async (e, requestId: unknown) => {
  if (!trusted(e) || !options.allowed(e.sender.id)) throw new Error('截图来源已失效');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error('无效的截图请求');
  const owner=BrowserWindow.fromWebContents(e.sender);
  if (!owner) throw new Error('截图窗口已关闭');
  return await capture(owner, requestId, 'attachment');
 });
 ipcMain.handle(prefix+'cancel',(e,id:unknown)=> { if(trusted(e) && active?.lease.ownedBy(e.sender.id,id)) active.finish(); });
 ipcMain.handle(prefix+'context',e=> {
  const warm=trusted(e)?warmEditors.get(e.sender.id):undefined;
  if(warm) {
   // Blank editors wait without receiving pixels or any account/business state.
   return new Promise<unknown>(resolve=>{warm.context?.(null);warm.context=resolve;});
  }
  const s=editor(e,active?.lease.requestId), frame=s?.lease.context(e.sender.id,options.scope());
  s?.trace('context-request',e.sender.id);
  return frame && s ? {...frame,requestId:s.lease.requestId,destination:s.destination,...(process.env.ARKME_SCREENSHOT_PROFILE==='1'?{profileEnabled:true}:{})} : null;
 });
 ipcMain.handle(prefix+'profile',(e,stage:unknown,token:unknown)=>{
  if(typeof stage!=='string'||!['context-decoded','image-decoded','canvas-painted'].includes(stage))return;
  editor(e,token)?.trace(stage,e.sender.id);
 });
 ipcMain.handle(prefix+'ready',(e,token:unknown)=> {
  const s=editor(e,token); if(!s) return false; s.ready.add(e.sender.id); s.trace('editor-ready',e.sender.id);
  // All displays must be captured and all renderers must be ready before showing any.
  if(s.windows.size===screen.getAllDisplays().length && s.ready.size===s.windows.size) {
   clearTimeout(s.timer); s.timer=undefined;
   s.trace('show-start');
   for(const window of s.windows.values()) window.showInactive();
   s.trace('show-called');
   const pointer=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
   const window=[...s.windows.values()].find(w=>screen.getDisplayMatching(w.getBounds()).id===pointer.id);
   (window ?? s.windows.values().next().value)?.focus();
  }
  return true;
 });
 ipcMain.handle(prefix+'select',(e,token:unknown)=> {
  const s=editor(e,token); if(!s || !s.lease.select(e.sender.id,options.scope())) return false;
  for(const [id,window] of s.windows) if(id!==e.sender.id) { s.windows.delete(id); window.destroy(); }
  return true;
 });
 ipcMain.handle(prefix+'close',(e,token:unknown)=> { editor(e,token)?.finish(); });
 const png=(value:unknown) => {
  const bytes=decodeScreenshotPng(value), decoded=nativeImage.createFromBuffer(bytes);
  if(decoded.isEmpty()) throw new Error('无法解码截图');
  return bytes;
 };
 ipcMain.handle(prefix+'complete',(e,value:unknown,token:unknown)=> {
  const s=editor(e,token); if(!s || s.saving) return false;
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
 ipcMain.handle(prefix+'ask-dsh',async(e,value:unknown,token:unknown)=> {
  const s=editor(e,token);if(!s || s.saving)return false;
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
 ipcMain.handle(prefix+'save',async(e,value:unknown,token:unknown)=> {
  const s=editor(e,token), window=s?.windows.get(e.sender.id); if(!s || !window || s.saving) return false;
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
