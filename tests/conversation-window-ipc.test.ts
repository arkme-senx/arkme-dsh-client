import {beforeEach, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
vi.mock('electron', async () => {
 const {EventEmitter}=await import('node:events');
 return {ipcMain:Object.assign(new EventEmitter(),{handle:vi.fn()}),BrowserWindow:{getAllWindows:vi.fn(()=>[])},dialog:{showErrorBox:vi.fn()},shell:{openExternal:vi.fn()}};
});
import {ipcMain, BrowserWindow} from 'electron';
import {ConversationDraftSaveError, installConversationWindowIpc} from '../src/conversation-window-ipc.js';
beforeEach(()=>{ipcMain.removeAllListeners();vi.clearAllMocks();});
function setup() {
 const frame={url:'http://127.0.0.1:1111/'};
 const contents=Object.assign(new EventEmitter(),{id:7,mainFrame:frame,send:vi.fn()});
 const main={webContents:contents,isDestroyed:()=>false};
 vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([main as any]);
 const manager=installConversationWindowIpc({main:()=>main as any,origin:()=> 'http://127.0.0.1:1111',scope:()=> 'profile',preload:()=> 'unused'});
 const event={sender:contents,senderFrame:frame};
 const ready=(value:boolean)=>ipcMain.emit('arkme-conversation:flush-ready',event,value);
 const acknowledge=(ok:boolean)=>ipcMain.emit('arkme-conversation:flushed',event,contents.send.mock.calls.at(-1)![1],ok);
 return {contents,manager,event,ready,acknowledge};
}
it('keeps one destruction listener across repeated module mounts and releases close-barrier listeners',async()=>{
 const {contents,manager,ready,acknowledge}=setup();
 for(let i=0;i<30;i++){ready(true);ready(false);}
 expect(contents.listenerCount('destroyed')).toBe(1);
 ready(true);const closing=manager.prepareToClose();expect(contents.send).toHaveBeenCalledWith('arkme-conversation:flush',expect.any(String));
 acknowledge(true);await closing;expect(ipcMain.listenerCount('arkme-conversation:flushed')).toBe(0);
 contents.emit('destroyed');contents.send.mockClear();await manager.prepareToClose();expect(contents.send).not.toHaveBeenCalled();
});
it('rejects failed flushes without consuming the window and permits a later successful retry',async()=>{
 const {contents,manager,event,ready,acknowledge}=setup();ready(true);
 const failed=manager.prepareToClose();acknowledge(false);await expect(failed).rejects.toBeInstanceOf(ConversationDraftSaveError);
 expect(ipcMain.listenerCount('arkme-conversation:flushed')).toBe(0);
 const retried=manager.prepareToClose();let completed=false;void retried.then(()=>{completed=true});
 // A same-origin child frame must not acknowledge its main frame's pending write.
 ipcMain.emit('arkme-conversation:flushed',{...event,senderFrame:{url:event.senderFrame.url}},contents.send.mock.calls.at(-1)![1],true);
 await Promise.resolve();expect(completed).toBe(false);
 acknowledge(true);await retried;expect(ipcMain.listenerCount('arkme-conversation:flushed')).toBe(0);
});
