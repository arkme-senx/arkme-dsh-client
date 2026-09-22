import {EventEmitter} from 'node:events';
import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({handlers:new Map<string,Function>(),register:vi.fn((_key:string,_callback:()=>void)=>true),unregister:vi.fn(),write:vi.fn(),rename:vi.fn(),focused:null as any,windows:[] as any[],quit:vi.fn(),capture:vi.fn(async(_owner:any)=>{}),error:vi.fn()}));
vi.mock('electron',()=>({dialog:{showErrorBox:m.error},app:{getPath:()=>'/tmp',once:m.quit},BrowserWindow:{getFocusedWindow:()=>m.focused,getAllWindows:()=>m.windows},globalShortcut:{register:m.register,unregister:m.unregister},ipcMain:{handle:(k:string,fn:Function)=>m.handlers.set(k,fn)}}));
vi.mock('node:fs',()=>({readFileSync:()=>'{"accelerator":"Control+Shift+A"}',writeFileSync:m.write,renameSync:m.rename}));
import {installScreenshotShortcut} from '../src/screenshot-shortcut-ipc.js';
let owner:any;
const call=(name:string,e:any,...args:any[])=>m.handlers.get('arkme-screenshot:shortcut-'+name)!(e,...args);
const event=()=>({sender:owner.webContents,senderFrame:owner.webContents.mainFrame});
beforeEach(()=>{vi.clearAllMocks();m.register.mockReturnValue(true);const wc:any=new EventEmitter();wc.id=1;wc.mainFrame={url:'http://localhost:1234/'};wc.send=vi.fn();owner={webContents:wc,isDestroyed:()=>false};m.windows=[owner];m.focused=null;installScreenshotShortcut({main:()=>owner,origin:()=> 'http://localhost:1234',allowed:id=>id===1,capture:m.capture});});
it('routes background trigger to the main window without activating it',()=>{m.register.mock.calls[0]![1]!();expect(m.capture).toHaveBeenCalledWith(owner);expect(owner.webContents.send).not.toHaveBeenCalled()});
it('rejects untrusted and iframe writes',()=>{expect(()=>call('set',{...event(),senderFrame:{url:'https://evil.test'}},'Control+B')).toThrow();expect(m.write).not.toHaveBeenCalled()});
it('releases recording after navigation and removes listeners after cancel',()=>{call('record',event(),true);owner.webContents.emit('did-start-navigation');expect(m.register).toHaveBeenCalledTimes(2);for(let i=0;i<15;i++){call('record',event(),true);call('record',event(),false)}expect(owner.webContents.listenerCount('destroyed')).toBe(0)});
it('persists and broadcasts confirmed changes',()=>{call('set',event(),'Control+Alt+B');expect(m.rename).toHaveBeenCalled();expect(owner.webContents.send).toHaveBeenCalledWith('arkme-screenshot:shortcut-changed',{accelerator:'Control+Alt+B',available:true,recording:false})});

it('broadcasts recording pause and resume to all screenshot entry points',()=>{
 call('record',event(),true);expect(call('get',event())).toMatchObject({recording:true});
 m.register.mock.calls[0]![1]!();expect(m.capture).not.toHaveBeenCalled();
 call('record',event(),false);expect(call('get',event())).toMatchObject({recording:false});
});

it('uses a focused trusted window without depending on its composer',()=>{
 m.focused=owner;m.register.mock.calls[0]![1]!();expect(m.capture).toHaveBeenCalledWith(owner);
 expect(owner.webContents.send).not.toHaveBeenCalled();
});
it('falls back from an unrelated focused window to the main window',()=>{
 m.focused={webContents:{id:99}};m.register.mock.calls[0]![1]!();expect(m.capture).toHaveBeenCalledWith(owner);
});
it('reports capture startup failures instead of leaving an unhandled rejection',async()=>{
 m.capture.mockRejectedValueOnce(new Error('请允许屏幕录制'));m.register.mock.calls[0]![1]!();
 await Promise.resolve();expect(m.error).toHaveBeenCalledWith('截图失败','请允许屏幕录制');
});
