// Exercise a packaged app using only disposable data; never use a real user profile.
// Usage: node scripts/runtime-reset-smoke.mjs <win-unpacked> <evidence-directory> [owned-profile]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, lstat, readlink, symlink, readdir } from 'node:fs/promises';
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
  logOffset = (await log()).length;
  await start();
  console.log('Installing and launching the production runtime in disposable userData');
  const manifest = await waitFor('initial production runtime ready', ready);
  report.initialReleaseId = manifest.releaseId;
  report.checks.push('initial authenticated plugin health and page readiness');
  await stop();
  const historical = process.env.ARKME_SMOKE_HISTORICAL === '1';
  if (historical) {
    const groups = execFileSync('whoami.exe', ['/groups'], {encoding:'utf8'});
    assert.ok(groups.includes('S-1-16-8192'), 'Must run with medium integrity');
    assert.ok(!groups.includes('S-1-16-12288'), 'Must not run elevated');
    const developerMode = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock', '/v', 'AllowDevelopmentWithoutDevLicense'], {encoding:'utf8'});
    assert.match(developerMode, /REG_DWORD\s+0x0\b/);
    await writeFile(path.join(evidence, 'ordinary-token.txt'), groups + '\n' + developerMode);
    report.checks.push('medium integrity token; Windows developer mode disabled');
  }
  const registry = await json(path.join(userData, 'dsh-account-scopes.json'));
  const container = path.join(userData, 'dsh-containers', registry.activeContainerRef);
  const sentinels = [
    path.join(container, 'dsh/arkme-self/prod/files/reset-acceptance/attachment.bin'),
    path.join(container, 'dsh/arkme-self/prod/reset-acceptance-conversation.json'),
    path.join(container, 'dsh/profiles/web/node_modules/reset-acceptance-marketplace/keep.txt'),
    path.join(userData, 'workspace/reset-acceptance-document.txt'),
    path.join(appData, 'Arkme Harness Test/runtime-manager/electron-v1/cache-epoch-1/keep.txt'),
    path.join(userData, 'runtime-manager/electron-v1/cache-epoch-0/keep.txt')
  ];
  for (const file of sentinels) { await mkdir(path.dirname(file), {recursive:true}); await writeFile(file, `preserve:${file}`); }
  let historicalTarget;
  if (historical) {
    // New Harness versions no longer project this SDK into the Profile. Use
    // an owned historical junction so the test remains independent of that layout.
    const sdk = path.join(container, 'dsh/profiles/node_modules/reset-historical-sdk');
    await mkdir(path.dirname(sdk), {recursive:true});
    try {
      assert.ok((await lstat(sdk)).isSymbolicLink(), 'Only replace an owned historical fixture link');
      assert.equal(path.resolve(await readlink(sdk)), path.join(cache, 'releases', 'old-historical-release', 'harness/node_modules/@agentclientprotocol/sdk'));
      await rm(sdk);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    historicalTarget = path.join(cache, 'releases', 'old-historical-release', 'harness/node_modules/@agentclientprotocol/sdk');
    await mkdir(historicalTarget, {recursive:true});
    await symlink(historicalTarget, sdk, 'junction');
    await rm(path.join(cache, 'releases', 'old-historical-release'), {recursive:true});
    historicalTarget = await readlink(sdk);
    const external = path.join(appData, 'historical-external-project');
    await mkdir(external, {recursive:true});
    const externalFile = path.join(external, 'keep.txt');
    await writeFile(externalFile, 'historical project content must survive');
    sentinels.push(externalFile);
    const externalLink = path.join(container, 'dsh/legacy-project-link');
    try {
      const info = await lstat(externalLink);
      assert.ok(info.isSymbolicLink(), 'Only replace an owned fixture link');
      await rm(externalLink);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await symlink(external, externalLink, 'junction');
    const committedPath = path.join(userData, 'runtime-data-transactions/prod/committed-containers.json');
    const committed = await json(committedPath);
    const home = path.join(container, 'dsh');
    assert.ok(committed.containers[home], 'Fixture must have a committed container');
    delete committed.containers[home]; // Model pre-transaction historical user data.
    await writeFile(committedPath, JSON.stringify(committed));
    report.historicalTarget = historicalTarget;
    report.checks.push('historical profile junction points to a removed release; legacy data has no commit marker');
  }
  const existingProtected = [path.join(container, 'settings.json'), path.join(userData, 'dsh-account-scopes.json')];
  for (const file of existingProtected) { try { await stat(file); sentinels.push(file); } catch(e) {if(e.code!=='ENOENT') throw e;} }
  const before = await Promise.all(sentinels.map(async file => ({file, sha256:digest(await readFile(file)), mtimeMs:(await stat(file)).mtimeMs})));
  report.protectedFiles = before;
  await writeFile(path.join(evidence, 'protected-files-before.json'), JSON.stringify(before,null,2));
  const releaseRoot = path.join(cache, 'releases', manifest.releaseId);
  const ali = path.join(releaseRoot, 'harness/node_modules/ali-oss');
  const aliPackage = digest(await readFile(path.join(ali, 'package.json')));
  const download = path.join(cache, 'downloads', `${manifest.artifacts.harness.sha256}.tar.zst`);
  const oldDownloadMtime = (await stat(download)).mtimeMs;
  const harnessLogPath = path.join(container, 'logs/harness.log');
  let harnessLogBefore = '';
  try { harnessLogBefore = await readFile(harnessLogPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Keep the package directory and lib/client.js, but remove its entry metadata.
  // Node then falls back to ali-oss/index.js, matching the reported failure.
  await rm(path.join(ali, 'package.json'));
  report.faultInjection = {type:'missing-package-manifest', file:'harness/node_modules/ali-oss/package.json'};
  await writeFile(path.join(releaseRoot, 'reset-acceptance-damaged-marker'), 'must disappear');
  logOffset = (await log()).length;
  await start();
  const failed = await waitFor('real missing dependency failure page', async () => (await pages()).find(p => p.url.includes('kind=failed')));
  const send = await cdp(failed);
  // A CDP target URL can change before the new page script initializes.
  const ui = await waitFor('failure page reset action initialized', async () => {
    try {
      const result = await send('Runtime.evaluate', {expression: `({visible:document.readyState === 'complete' && document.querySelector('#reload-runtime-action')?.hidden === false, hint:document.querySelector('#runtime-reset-hint')?.textContent, text:document.body.innerText})`, returnByValue:true});
      return result.result?.value?.visible ? result : false;
    } catch (error) {
      if (/context.*destroyed|Cannot find context|Not attached/.test(String(error))) return false;
      throw error;
    }
  }, 30_000);
  assert.equal(ui.result.value.visible, true);
  assert.match(ui.result.value.hint, /保留会话、附件、设置和工作区/);
  let harnessLogAfter = '';
  try { harnessLogAfter = await readFile(harnessLogPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Harness 0.2 can keep the import error in harness.log and expose only a
  // failed plugin-health probe to the shell. Preserve and match this launch's
  // tail, also handling a log file replaced rather than appended at startup.
  const harnessFailure = harnessLogAfter.startsWith(harnessLogBefore)
    ? harnessLogAfter.slice(harnessLogBefore.length) : harnessLogAfter;
  await writeFile(path.join(evidence, 'harness-failure.log'), harnessFailure);
  assert.match((await log()).slice(logOffset) + '\n' + harnessFailure, /ali-oss|ERR_MODULE_NOT_FOUND/);
  await screenshot(send, '01-dependency-failure.png');
  report.checks.push('damaged ali-oss reproduces actual startup failure; reset button visible');
  logOffset = (await log()).length;
  requireFreshCommit = true;
  try {
    await send('Runtime.evaluate', {expression: `document.querySelector('#reload-runtime-action').click(); document.querySelector('#reload-runtime-action').click();`});
  } catch (error) {
    if (!/Not attached|context.*destroyed|Target.*closed|CDP timeout/.test(String(error))) throw error;
    // Navigation may destroy the old CDP execution context before its reply.
    // Observe the real main-process transition; never click again here.
  }
  await waitFor('reset download page', async () => {
    const downloading = (await pages()).find(p => p.url.includes('kind=runtime-installing'));
    if (!downloading) return false;
    try { await screenshot(await cdp(downloading), '02-redownloading.png'); return true; }
    catch { return false; }
  }, 60_000);
  const restored = await waitFor('rebuilt runtime ready', ready);
  assert.equal(digest(await readFile(path.join(cache,'releases',restored.releaseId,'harness/node_modules/ali-oss/package.json'))), aliPackage);
  assert.ok((await stat(download)).mtimeMs > oldDownloadMtime, 'Harness archive must be downloaded again');
  assert.equal(((await log()).slice(logOffset).match(/runtime-manual-reload /g) ?? []).length, 1, 'Rapid double-click must trigger one reset');
  await assert.rejects(stat(path.join(releaseRoot, 'reset-acceptance-damaged-marker')), {code:'ENOENT'});
  for (const original of before) {
    assert.equal(digest(await readFile(original.file)), original.sha256, `Data changed: ${original.file}`);
    // Registry can be atomically rewritten during normal account reconciliation.
    if (!existingProtected.includes(original.file)) assert.ok(Math.abs((await stat(original.file)).mtimeMs - original.mtimeMs) < 1, `Timestamp changed beyond filesystem copy precision: ${original.file}`);
  }
  if (historical) {
    const txRoot = path.join(userData, 'runtime-data-transactions/prod');
    let preserved = 0;
    for (const name of await readdir(txRoot)) {
      const sdk = path.join(txRoot, name, 'snapshot/dsh-home/profiles/node_modules/reset-historical-sdk');
      try { if ((await lstat(sdk)).isSymbolicLink() && await readlink(sdk) === historicalTarget) preserved++; }
      catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
    }
    assert.ok(preserved > 0, 'Historical dangling junction must survive actual snapshot creation');
    report.historicalSnapshots = preserved;
    report.checks.push('actual historical dangling junction preserved in data snapshots without elevation');
  }
  const after = await Promise.all(before.map(async entry => ({file:entry.file, sha256:digest(await readFile(entry.file)), mtimeMs:(await stat(entry.file)).mtimeMs})));
  await writeFile(path.join(evidence, 'protected-files-after.json'), JSON.stringify(after,null,2));
  await waitFor('recovered application page stable', async () => {
    const target = (await pages()).find(p => p.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url));
    if (!target) return false;
    try {
      const send = await cdp(target);
      const result = await send('Runtime.evaluate', {expression:'document.body.innerText', returnByValue:true});
      const text = result.result?.value ?? '';
      if (text.trim().length < 50 || /Loading plugins|Loading workspace|正在确认登录/.test(text)) return false;
      await screenshot(send, '03-recovered.png');
      return true;
    } catch { return false; } // Trial-window teardown can invalidate a CDP target.
  }, 180_000);
  report.checks.push('reset navigates to download page', 'whole Harness archive redownloaded and ali-oss restored', 'double click causes exactly one reset', 'authenticated readiness passes after reset', `${before.length} data files retain SHA-256; fixture mtimes preserved within 1 ms copy precision`);
  report.finalReleaseId = restored.releaseId;
  report.protectedFiles = before;
  await stop();
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
  console.error(error);
} finally {
  try { await stop(); } catch (error) {
    report.shutdownError = String(error); report.passed = false; process.exitCode = 1;
    // Only the child spawned by this disposable probe and its descendants.
    if (child?.pid && child.exitCode === null) execFileSync('taskkill.exe', ['/PID',String(child.pid),'/T','/F']);
  }
  for (const socket of connections) socket.close();
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(evidence, 'reset-acceptance.json'), JSON.stringify(report,null,2));
  await writeFile(path.join(evidence, 'desktop-startup.log'), await log());
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,evidence,appData}));
}
