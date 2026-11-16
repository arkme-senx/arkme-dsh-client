// Isolated native popup smoke. GAME_NATIVE_MODULE is the compiled adapter URL.
import {app,BrowserWindow} from 'electron';
import {createServer} from 'node:http';
app.setPath('userData', '/tmp/arkme-game-native/profile');
async function run(){
const {installGameWindowNative}=await import(process.env.GAME_NATIVE_MODULE);
await app.whenReady();
let origin;const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/arkme-self/api/game/index.html'?'<title>Game fixture</title><p>独立游戏窗口</p><script>opener.postMessage("game-ready",location.origin)</script>':'<title>Opener fixture</title><script>window.received=false;addEventListener("message",e=>{if(e.origin===location.origin&&e.data==="game-ready")window.received=true})</script>')});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));origin='http://127.0.0.1:'+server.address().port;
const main=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
const game=installGameWindowNative(main,()=>origin);main.webContents.setWindowOpenHandler(d=>game.handle(d)??{action:'deny'});
let child;main.webContents.on('did-create-window',w=>{child=w});
try{
 await main.loadURL(origin);
 await main.webContents.executeJavaScript(`window.child=window.open('about:blank','arkme-game-12345678-1234-1234-1234-123456789012','popup,width=1100,height=760'); if(!child)throw Error('blocked');child.location.replace('${origin}/arkme-self/api/game/index.html')`,true);
 for(let i=0;i<50&&!await main.webContents.executeJavaScript('window.received');i++)await new Promise(r=>setTimeout(r,100));
 if(!await main.webContents.executeJavaScript('window.received'))throw Error('opener bridge failed');
 if(!child||child.webContents.getURL()!==origin+'/arkme-self/api/game/index.html')throw Error('wrong game document');
 const prior=child.id;await main.webContents.executeJavaScript(`window.open('about:blank','arkme-game-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')`,true);
 if(child.id!==prior||BrowserWindow.getAllWindows().length!==2)throw Error('duplicate native game window');
 await child.webContents.executeJavaScript(`location.href='${origin}/outside'`).catch(()=>{});await new Promise(r=>setTimeout(r,200));
 if(child.webContents.getURL()!==origin+'/arkme-self/api/game/index.html')throw Error('navigation escaped');
 console.log('PASS: native game popup, opener bridge, same-origin document, singleton, navigation fence');
 main.destroy();server.close();app.quit();
}catch(e){console.error(e);main.destroy();server.close();app.exit(1)}

}
void run().catch(e=>{console.error(e);app.exit(1)});
