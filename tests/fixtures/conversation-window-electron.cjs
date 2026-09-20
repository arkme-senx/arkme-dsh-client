// Real native windows + production preload + actual plugin surfaces, isolated fake backend.
const {app,BrowserWindow,ipcMain} = require('electron');
const {createServer} = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'../..');
const assets = process.env.ARKME_CONVERSATION_SMOKE_ASSETS || '/private/tmp/arkme-conversation-smoke-assets';
let main,server,manager; const errors=[]; const sends=[]; const unknown=new Set();
const sources=[
 {kind:'private_chat',sourceRef:'private-A',sourceKey:'chat:A',displayName:'张三',activeAtMillis:Date.now(),unreadCount:0,latestSequence:1,latestPreview:"测试消息"},
 {kind:'group_chat',sourceRef:'group-B',sourceKey:'chat:B',displayName:'产品讨论群',activeAtMillis:Date.now(),unreadCount:0,latestSequence:1,latestPreview:"测试消息"},
 {kind:'send_to_self',sourceRef:'self-C',displayName:'我发给自己',activeAtMillis:Date.now(),unreadCount:0,latestSequence:1,latestPreview:"测试消息"},
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){ for(let n=0;n<100;n++){ if(await fn())return; await sleep(50); } throw new Error('Timeout '+label); }
async function checkPopovers(window, self = false) {
 const button = self ? '按日期查看发给自己' : '按日期查看聊天记录';
 await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(x=>(x.getAttribute('aria-label')||'').startsWith(${JSON.stringify(button)})).click()`);
 await until(()=>window.webContents.executeJavaScript(`!!document.querySelector('[role="dialog"][aria-label="${self ? '发给自己日历' : '会话日历'}"]')`),'calendar open');
 assert.equal(await window.webContents.executeJavaScript(`(()=>{const p=document.querySelector('[role="dialog"][aria-label="${self ? '发给自己日历' : '会话日历'}"]');const r=p.getBoundingClientRect();return r.width>0&&r.height>0&&p.contains(document.elementFromPoint(r.left+r.width/2,r.top+30))})()`),true,'calendar must be hit-test visible');
 await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="${self ? '关闭发给自己日历' : '关闭会话日历'}"]').click()`);
 await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(x=>['群聊设置','更多私聊操作','更多发给自己操作'].includes(x.getAttribute('aria-label'))).click()`);
 await until(()=>window.webContents.executeJavaScript(`!!document.querySelector('[role="menu"]')`),'menu open');
 await until(()=>window.webContents.executeJavaScript(`(()=>{const p=document.querySelector('[role="menu"]');const r=p.getBoundingClientRect();return r.width>0&&r.height>0&&p.contains(document.elementFromPoint(r.left+r.width/2,r.top+Math.min(15,r.height/2)))})()`),'menu must be hit-test visible');
 await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
}
function value(op,p={}) {
 const source=sources.find(s=>s.sourceRef===p.sourceRef)||sources[0];
 if(op==='auth.status')return {status:'authenticated',environment:'test',userId:42};
 if(op==='auth.config')return {callAssetBasePath:'/call',recordingWorkbenchEnabled:false,environment:'test'};
 if(op==='provider.capabilities')return {features:{},limits:{}};
 if(op==='provider.instance')return {instanceId:'fixture'};
 if(op==='sources.list')return {directory:p.directory||'root',items:sources,hasMore:false,projection:{sendToSelf:sources[2],bots:[],visibility:sources.slice(0,2).map(source=>({entryKind:"source",entryRef:source.sourceRef,hidden:false}))}};
 if(op==='chat.member.private.open')return {source:sources[0]};
 if(op==='source.timeline')return {source,items:[{itemUid:source.sourceRef+'-m1',senderName:'张三',memberRef:'member-A',isMe:false,sendAtMillis:Date.now(),title:'',textContent:'这是独立窗口中的会话内容',status:1,templateKind:1,version:1}],hasMore:false};
 if(op==='files.send.tasks'||op==='source.ai-polish.notices')return [];
 if(op==='topic.dissolve.active'||op==='source.members.cached')return null;
 if(op==='source.members.page')return {kind:'membership',source,selfRole:'member',items:[{memberRef:'member-A',displayName:'张三',role:'member',status:'active',isSelf:false,isOwner:false,joinedAtMillis:1,recordCount:1,mentionCount:0}],joinEvents:[],removedMemberRefs:[],hasMore:false};
 if(op==='source.members.presentation')return {kind:'presentation',source,items:[{memberRef:'member-A',displayName:'张三',role:'member',status:'active',isSelf:false,isOwner:false,joinedAtMillis:1,recordCount:1,mentionCount:0}],removedMemberRefs:[],unavailableProfileMemberRefs:[]};
 if(op==='source.ai-polish.settings')return {enabled:false};
 if(op==='arko.profile')return {displayName:'Arko',version:1};
 if(op==='arko.history')return {items:[],hasMore:false};
 if(op==='user.profile'||op==='user.profile.refresh')return {userId:42,displayName:'测试用户',nickname:'测试用户',avatarRef:'',arkmeId:'test42',accountType:0,createdAt:1,bindings:{apple:false,wechat:false,google:false},contact:{}};
 if(op==='bots.private-chat.directory')return {items:[]};
 if(op==='conversation.directory.visibility.query')return {items:sources.slice(0,2).map(source=>({entryKind:'source',entryRef:source.sourceRef,hidden:false}))};
 if(op==='source.members')return {source,items:[],total:0,activeCount:0};
 if(op==='source.interwoven-moments')return {state:'disabled',moments:[],preparedAtMillis:1};
 if(op==='files.capabilities')return {version:1,maxFileBytes:100000,maxImageBytes:100000,maxAttachments:9};
 if(op==='files.tasks')return {tasks:[]};
 if(op==='source.record-reedit.submissions')return [];
 if(op==='records.tags.list'||op==='group.bots'||op==='source.related-quick-notes.from-message')return {items:[],total:0};
 if(op==='profile.get'||op==='profile.user')return {displayName:'测试用户',nickname:'测试用户',userId:42};
 unknown.add(op); return {__unsupported:true};
}
(async()=>{
 const temp=await fs.mkdtemp('/private/tmp/arkme-conversation-electron-'); app.setPath('userData',path.join(temp,'browser')); await app.whenReady();
 ipcMain.on('arkme-session-selection:bootstrap', event => { event.returnValue = null; });
 for(const channel of ['arkme-desktop:attention-capabilities','arkme-runtime:page-ready-nonce','arkme-app-update:app-version','arkme:desktop-notification:permission-state']) ipcMain.on(channel,event=>{event.returnValue=null});
 for(const channel of ['arkme:runtime-update-notice:snapshot','arkme-app-update:notice','arkme:desktop-notification:refresh-permission']) ipcMain.handle(channel,()=>null);
 ipcMain.on('arkme-runtime:harness-version', event => { event.returnValue = '0.1.5-rc.2'; });
 app.on('web-contents-created',(_e,w)=>{w.on('console-message',(_e,level,message)=>{if(level>=3&&!message.includes('WebSocket')&&!message.includes('404'))errors.push(message)});});
 server=createServer(async(req,res)=>{
  if(req.url==='/smoke-send'){let body='';for await(const c of req)body+=c;sends.push(JSON.parse(body));res.end('{}');return;}
  if(req.method==='POST'){let body='';for await(const c of req)body+=c;const {operation,params}=JSON.parse(body);res.setHeader('Content-Type','application/json');const result=value(operation,params);res.end(JSON.stringify(result?.__unsupported ? {ok:false,error:{code:'fixture-unsupported',message:'fixture unsupported '+operation,retryable:false}} : {ok:true,value:result}));return;}
  const name=req.url.split('?')[0];
  if(name==='/'||name===''){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/conversation.js"></script></body></html>');return;}
  try{const file=await fs.readFile(path.join(assets,path.basename(name)));res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(file);}catch{res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`;
 const {installConversationWindowIpc}=await import(pathToFileURL(path.join(root,'dist/conversation-window-ipc.js')));
 main=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{preload:path.join(root,'dist/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 manager=installConversationWindowIpc({main:()=>main,origin:()=>origin,scope:()=>origin,preload:()=>path.join(root,'dist/preload.cjs')});
 await main.loadURL(origin); await until(()=>main.webContents.executeJavaScript('typeof smokeOpen === "function"'),'main boot');
 await until(()=>main.webContents.executeJavaScript('!!Array.from(document.querySelectorAll("[data-arkme-directory-row=source]")).find(x=>x.innerText.includes("张三"))'),'actual directory');
 await main.webContents.executeJavaScript('smokeDraft(0,"共享草稿"); Array.from(document.querySelectorAll("[data-arkme-directory-row=source]")).find(x=>x.innerText.includes("张三")).dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
 await until(()=>manager.size===1,'child open'); const child=BrowserWindow.getAllWindows().find(w=>w!==main);
 await until(()=>child.webContents.executeJavaScript('typeof smokeRead === "function" && smokeRead(0)==="共享草稿"'),'draft boot');
 await until(()=>child.webContents.executeJavaScript('document.body.innerText.includes("这是独立窗口中的会话内容")'),'actual conversation surface');
 assert.equal(await child.webContents.executeJavaScript('document.body.innerText.includes("回到主窗口")'),false);
 await main.webContents.executeJavaScript('smokeOpen(0)'); assert.equal(manager.size,1);
 await child.webContents.executeJavaScript('smokeDraft(0,"来自独立窗口")'); await until(()=>main.webContents.executeJavaScript('smokeRead(0)==="来自独立窗口"'),'reverse sync');
 await main.webContents.executeJavaScript('smokeSelect(1)'); assert.equal(await child.webContents.executeJavaScript('document.title'),'张三 · Arkme');
 await Promise.all([main.webContents.executeJavaScript('smokeSend(0)'),child.webContents.executeJavaScript('smokeSend(0)')]); assert.equal(sends.length,1);
 await checkPopovers(child);
 await checkPopovers(main);
 await main.webContents.executeJavaScript('smokeOpen(1); smokeOpen(2)'); await until(()=>manager.size===3,'three types');
 const group=BrowserWindow.getAllWindows().find(w=>manager.context(w.webContents.id)?.source.kind==='group_chat');
 async function sendFromAvatar() {
  await until(()=>group.webContents.executeJavaScript(`!!document.querySelector('button[aria-label="查看 张三"]')`),'group member avatar');
  await group.webContents.executeJavaScript(`document.querySelector('button[aria-label="查看 张三"]').click()`);
  await until(()=>group.webContents.executeJavaScript(`!!document.querySelector('[data-arkme-profile-send-state]')`),'member profile');
  await group.webContents.executeJavaScript(`document.querySelector('[data-arkme-profile-send-state]').click()`);
 }
 await sendFromAvatar();
 await until(()=>child.isFocused(),'existing target focused'); assert.equal(manager.size,3);
 assert.equal(await group.webContents.executeJavaScript('document.title'),'产品讨论群 · Arkme');
 assert.equal(await group.webContents.executeJavaScript(`arkmeConversation.account('test:99')`),false);
 assert.equal(await group.webContents.executeJavaScript(`arkmeConversation.open({accountKey:'test:99',sourceKey:'chat:A',source:smokeSources[0]}).then(()=>false,()=>true)`),true);
 assert.equal(await group.webContents.executeJavaScript(`arkmeConversation.focusMain({accountKey:'test:42',sourceKey:'self-C',source:smokeSources[2]})`),true);
 await until(()=>main.webContents.executeJavaScript('smokeSelected()==="send_to_self"'),'fallback target activated in main');
 await child.webContents.executeJavaScript('smokeDraft(0,"关闭保留")'); await until(()=>main.webContents.executeJavaScript('smokeRead(0)==="关闭保留"'),'persist before close');
 await until(()=>child.webContents.executeJavaScript('Array.from(document.querySelectorAll("[contenteditable=true]")).some(x=>x.innerText.includes("关闭保留"))'),'visible composer draft');
 await fs.writeFile(path.join(assets,'private-window.png'),(await child.webContents.capturePage()).toPNG());
 for(const w of BrowserWindow.getAllWindows()) if(w!==main) { await until(()=>w.webContents.executeJavaScript('document.body.innerText.includes("这是独立窗口中的会话内容")'),'each type timeline'); await checkPopovers(w,manager.context(w.webContents.id).source.kind==='send_to_self'); await fs.writeFile(path.join(assets,manager.context(w.webContents.id).source.kind+'.png'),(await w.webContents.capturePage()).toPNG()); }
 await child.webContents.executeJavaScript('arkmeConversation.close()'); await until(()=>manager.size===2,'close');
 await sendFromAvatar(); await until(()=>manager.size===3,'reopen via avatar');
 const reopened=BrowserWindow.getAllWindows().find(w=>w!==main&&manager.context(w.webContents.id)?.sourceKey==='chat:A');
 await until(()=>reopened.webContents.executeJavaScript('typeof smokeRead === "function" && smokeRead(0)==="关闭保留"'),'restored draft');
 await main.webContents.executeJavaScript('arkmeConversation.account(null)'); await until(()=>manager.size===0,'logout closes children');
 console.log('UNKNOWN_FIXTURE_OPERATIONS',JSON.stringify([...unknown])); console.log('RENDER_ERRORS',JSON.stringify(errors));
 assert.equal(errors.filter(e=>e.includes('Minified React error')||e.includes('Uncaught')).length,0);
 console.log('PASS avatar new window/dedup/fallback/account isolation/visible calendar/menu on shared main+child surfaces/native window create/deduplicate/three conversation types/draft sync/send exclusion/close-reopen/logout');
})().then(()=>finish(0),e=>{console.error(e);console.log('UNKNOWN',JSON.stringify([...unknown]));console.log('ERRORS',JSON.stringify(errors)); if(main&&!main.isDestroyed()) main.webContents.executeJavaScript('document.body.innerText').then(text=>{console.log('MAIN_DOM',text);finish(1)}); else finish(1)});
function finish(code){manager?.closeAll();for(const w of BrowserWindow.getAllWindows())w.destroy();server?.closeAllConnections();server?.close();app.exit(code);}
