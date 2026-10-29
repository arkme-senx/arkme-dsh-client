// Restart a packaged app using only the disposable profile from reset acceptance.
// Usage: node scripts/runtime-reset-postcheck.mjs <win-unpacked> <evidence-directory> <owned-profile>
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { hasCompletedPackagedRuntimeStartup } from './packaged-smoke-lib.mjs';

assert.equal(process.platform, 'win32', 'Run this acceptance probe on Windows');
const executable = path.resolve(process.argv[2], 'arkme.exe');
const evidence = path.resolve(process.argv[3]);
await mkdir(evidence, { recursive: true });
// Native Windows helpers still require executable paths below MAX_PATH.
// A deep TEMP profile can make an otherwise valid runtime impossible to launch.
const reuseProfile = process.argv[4];
const appData = reuseProfile ? path.resolve(reuseProfile) : await mkdtemp(path.join(path.parse(executable).root, 'arkme-reset-'));
assert.equal(path.dirname(appData), path.parse(executable).root);
assert.match(path.basename(appData), /^arkme-reset-[A-Za-z0-9]+$/);
const ownership = path.join(appData, 'reset-smoke-owned.json');
if (reuseProfile) assert.equal(JSON.parse(await readFile(ownership, 'utf8')).purpose, 'runtime-reset-acceptance');
else await writeFile(ownership, JSON.stringify({purpose:'runtime-reset-acceptance'}));
const userData = path.join(appData, 'Arkme Harness');
const cache = path.join(userData, 'runtime-manager/electron-v1/cache-epoch-1');
const logPath = path.join(userData, 'logs/desktop-startup.log');
const report = { executable, appData, startedAt: new Date().toISOString(), checks: [] };
let child;
let port;
let logOffset = 0;
let requireFreshCommit = false;
const connections = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function waitFor(label, predicate, timeout = 900_000) {
  const started = Date.now(); let lastProgress = started;
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    if (child && child.exitCode !== null) throw new Error(`${label}: app exited ${child.exitCode}`);
    if (Date.now() - lastProgress > 30_000) { console.log(`Waiting: ${label}`); lastProgress = Date.now(); }
    await sleep(300);
  }
  throw new Error(`Timed out: ${label}`);
}
async function optionalJson(file) {
  try { return await json(file); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return; throw e; }
}
async function log() { try { return await readFile(logPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
async function ready() {
  const state = await optionalJson(path.join(cache, 'state.json'));
  if (!state?.activeReleaseId) return false;
  const release = await optionalJson(path.join(cache, 'releases', state.activeReleaseId, 'release.json'));
  const completeLog = await log();
  return hasCompletedPackagedRuntimeStartup({state, release, log: requireFreshCommit ? completeLog.slice(logOffset) : completeLog})
    && completeLog.slice(logOffset).includes('render-ready ') && release;
}
async function start() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    env: {...process.env, ARKME_APP_DATA_PATH: appData, ARKME_UPDATE_CHECK_ENABLED: '0'}, stdio: 'ignore'
  });
  child.on('error', error => { console.error(error); });
}
async function pages() {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { return []; }
}
async function cdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  connections.add(socket);
  let next = 0; const pending = new Map();
  socket.onmessage = ({data}) => {
    const message = JSON.parse(data); const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
  };
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`CDP timeout: ${method}`));}, 15_000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
}
async function screenshot(send, name) {
  const result = await send('Page.captureScreenshot');
  await writeFile(path.join(evidence, name), Buffer.from(result.data, 'base64'));
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const targets = await pages();
  for (const target of targets.filter(p => p.type === 'page')) {
    try { const send = await cdp(target); await send('Runtime.evaluate', {expression: 'window.close()'}); } catch { /* Target may close before response. */ }
  }
  const deadline = Date.now() + 20_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(200);
  assert.notEqual(child.exitCode, null, 'App must exit gracefully before damaging its isolated runtime');
  for (const socket of connections) socket.close();
  connections.clear();
}

try {
 const groups=execFileSync('whoami.exe',['/groups'],{encoding:'utf8'});
 assert.ok(groups.includes('S-1-16-8192') && !groups.includes('S-1-16-12288'));
 const mode=execFileSync('reg.exe',['query','HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock','/v','AllowDevelopmentWithoutDevLicense'],{encoding:'utf8'});
 assert.match(mode,/REG_DWORD\s+0x0\b/);
 report.checks.push('restart under medium integrity with developer mode disabled');
 logOffset=(await log()).length;
 await start();
 await waitFor('restored runtime restart ready',ready);
 await waitFor('application login initialization completed',async()=>{
  const target=(await pages()).find(p=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url));
  if(!target)return false;
  try {
   const send=await cdp(target);
   const value=await send('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true});
   const text=value.result?.value || '';
   if(text.trim().length<50 || /Loading plugins|Loading workspace/i.test(text) || text.includes('\u6b63\u5728\u786e\u8ba4\u767b\u5f55'))return false;
   await screenshot(send,'04-restarted-stable.png');
   return true;
  }catch{return false;}
 },120000);
 const before=await json(path.join(evidence,'protected-files-before.json'));
 const after=[];
 for(const entry of before){const sha256=digest(await readFile(entry.file));assert.equal(sha256,entry.sha256);after.push({file:entry.file,sha256,matchesBefore:true});}
 await writeFile(path.join(evidence,'protected-files-after-restart.json'),JSON.stringify(after,null,2));
 report.passed=true;
} catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{await stop();report.completedAt=new Date().toISOString();await writeFile(path.join(evidence,'restart-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
