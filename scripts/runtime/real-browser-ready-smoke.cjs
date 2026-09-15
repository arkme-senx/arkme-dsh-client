// Opt-in desktop integration: Electron43 main process, all user data in temp.
// Usage: electron scripts/runtime/real-browser-ready-smoke.cjs [prepared-runtime]
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const project = path.resolve(__dirname, '../..');
const runtime = path.resolve(process.argv[2] || path.join(project, '.runtime/dsh-arm64'));
if (process.versions.electron !== '43.2.0' || process.versions.modules !== '148') throw new Error('Browser smoke requires Electron 43.2.0 / ABI 148');
const runtimeVersion = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
if (runtimeVersion !== '0.1.5-rc.2') throw new Error('Browser smoke requires the prepared official Harness 0.1.5-rc.2 runtime');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkme-rc2-browser-'));
app.setPath('userData', path.join(root, 'user-data'));
app.setPath('sessionData', path.join(root, 'session-data'));
const sourceOutput = path.join(root, 'compiled');
fs.mkdirSync(sourceOutput);
fs.writeFileSync(path.join(sourceOutput, 'package.json'), '{"type":"module"}');
fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'dir');
function compileTree(dir, relative = '') {
  for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) compileTree(dir, next);
    else if (/\.(ts|cts)$/.test(next)) {
      const destination = path.join(sourceOutput, next.replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, ts.transpileModule(fs.readFileSync(path.join(dir, next), 'utf8'), {
        fileName: next,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: next.endsWith('.cts') ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext, esModuleInterop: true }
      }).outputText);
    }
  }
}
compileTree(path.join(project, 'src'));
let supervisor;
let trial;
let display;
let report;
const diagnostics = [];
let exitCode = 1;
const deadline = setTimeout(() => {
  console.error('Browser smoke timed out; isolated root:', root);
  Promise.resolve(supervisor?.stop('quit')).finally(() => app.exit(1));
}, 90_000);
app.whenReady().then(async () => {
  const load = name => import(pathToFileURL(path.join(sourceOutput, name + '.js')).href);
  const [{ HarnessProcessSupervisor }, { HarnessPageReadiness }, { HarnessCookieInstaller }, { provisionArkmeWebProfile }, { AppUpdateNoticeCoordinator, registerAppUpdateNoticeIpc }] = await Promise.all([
    load('harness-supervisor'), load('harness-page-ready'), load('harness-cookie-install'), load('plugin-profile'), load('app-update-notice')
  ]);
  const dshHome = path.join(root, 'dsh-home');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await Promise.all([fsp.mkdir(home), fsp.mkdir(workspace)]);
  await provisionArkmeWebProfile({ dshHome, pluginDir: path.join(runtime, 'node_modules/@senguoyun/dsh-arkme'), dshVersion: '0.1.5-rc.2' });
  await fsp.writeFile(path.join(dshHome, 'profiles/web/cordis.patch.yml'), '- id: arkme-self\n  config:\n    updateCheckEnabled: false\n');
  const browserSession = session.fromPartition('rc2-browser-smoke');
  const cookieInstaller = new HarnessCookieInstaller(browserSession.cookies);
  let authenticated;
  supervisor = new HarnessProcessSupervisor({
    execPath: process.execPath,
    dshBinPath: path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    dshHome, logPath: path.join(root, 'harness.log'),
    packageManagerBinPath: path.join(runtime, 'node_modules/.bin'),
    packageManagerCliPath: path.join(runtime, 'node_modules/pnpm/bin/pnpm.cjs'),
    inheritedEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8' },
    onAuthenticated: async value => { await cookieInstaller.install(value); authenticated = value; }
  });
  await supervisor.start(workspace, { timeoutMs: 45_000, pollIntervalMs: 200 });
  if (supervisor.getState()?.kind !== 'ready' || !authenticated) throw new Error('Real supervisor did not become authenticated and ready');
  const origin = new URL(authenticated.url).origin;
  const readiness = new HarnessPageReadiness();
  const sender = event => ({ webContentsId: event.sender.id, isMainFrame: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url || '' });
  let readySignals = 0;
  let readyAccepted = 0;
  ipcMain.on('arkme-runtime:page-ready-nonce', event => { event.returnValue = readiness.nonce(sender(event)); });
  ipcMain.on('arkme-runtime:page-ready', (event, nonce) => { readySignals++; if (readiness.accept(sender(event), nonce)) readyAccepted++; });
  ipcMain.on('arkme-runtime:harness-version', event => { event.returnValue = '0.1.5-rc.2'; });
  ipcMain.on('arkme-app-update:app-version', event => { event.returnValue = '0.2.9-smoke'; });
  ipcMain.on('arkme:desktop-notification:permission-state', event => { event.returnValue = false; });
  ipcMain.on('arkme-desktop:attention-capabilities', event => { event.returnValue = { schemaVersion: 1, notificationShow: false, notificationPermission: 'unavailable', badgeMode: 'unsupported' }; });
  ipcMain.handle('arkme:runtime-update-notice:snapshot', () => null);
  // The real coordinator authorizes the display window, never the trial page.
  display = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const statusPath = path.join(root, 'status.html');
  await fsp.writeFile(statusPath, '<title>Isolated status</title>');
  const statusPageUrl = pathToFileURL(statusPath).href;
  await display.loadURL(statusPageUrl);
  let privilegedActions = 0;
  const coordinator = new AppUpdateNoticeCoordinator({ statusPageUrl, getHarnessOrigin: () => origin,
    getWindow: () => ({ webContentsId: display.webContents.id, getCurrentUrl: () => display.webContents.getURL(), send: () => {} }),
    openExternal: async () => { privilegedActions++; throw new Error('Unexpected external action'); }
  });
  const state = { status: 'current', currentVersion: '0.2.9-smoke', currentVersionCode: 6, canAutoInstall: false };
  coordinator.attach({ snapshotNow: () => state, subscribe: () => () => {}, prepareNow: async () => { privilegedActions++; }, download: async () => { privilegedActions++; }, install: async () => { privilegedActions++; } });
  registerAppUpdateNoticeIpc({ handle: (channel, handler) => ipcMain.handle(channel, event => handler(sender(event))) }, coordinator);
  trial = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: path.join(sourceOutput, 'preload.cjs') } });
  const abort = new AbortController();
  const probe = readiness.arm(trial.webContents.id, authenticated.url, AbortSignal.any([authenticated.signal, abort.signal]), 30_000);
  void probe.ready.catch(() => undefined);
  trial.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) readiness.navigation(trial.webContents.id); });
  trial.webContents.on('preload-error', (_event, _preload, error) => { diagnostics.push('preload: ' + error.message); abort.abort(); });
  trial.webContents.on('render-process-gone', (_event, details) => { diagnostics.push('renderer: ' + details.reason); abort.abort(); });
  trial.webContents.on('console-message', details => { if (details.level === 'error') diagnostics.push(String(details.message).slice(0, 1200)); });
  trial.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trial.webContents.on('will-attach-webview', event => event.preventDefault());
  try {
    await Promise.all([trial.loadURL(authenticated.url), probe.ready]);
    const result = await trial.webContents.executeJavaScript(`(async () => ({
      bridgeFrozen: Object.isFrozen(window.arkmeDesktop),
      readinessBridge: typeof window.arkmeDesktop?.notifyHarnessReady === 'function',
      requireAbsent: typeof window.require === 'undefined',
      processAbsent: typeof window.process === 'undefined',
      authCookieHidden: !document.cookie.includes('dsh-auth-'),
      urlClean: location.search === '',
      deniedStatus: await window.arkmeDesktop.update.status() === null,
      deniedCheck: await window.arkmeDesktop.update.check() === null,
      deniedDownload: await window.arkmeDesktop.update.download() === null,
      deniedInstall: await window.arkmeDesktop.update.install() === null,
      deniedOpen: await window.arkmeDesktop.update.open() === false,
      title: document.title
    }))()`);
    await trial.webContents.executeJavaScript('window.arkmeDesktop.notifyHarnessReady(); window.arkmeDesktop.notifyHarnessReady("forged");');
    if (Object.entries(result).some(([key, value]) => key !== 'title' && value !== true)) throw new Error('Renderer isolation checks failed: ' + JSON.stringify(result));
    if (readySignals !== 1 || readyAccepted !== 1 || privilegedActions !== 0) throw new Error('Readiness/privilege count mismatch');
    report = { electron: process.versions.electron, abi: process.versions.modules, arch: process.arch, authenticatedLoad: true, realPluginReady: true, readySignals, readyAccepted, privilegedActions, checks: result, diagnostics, isolatedRoot: root };
    await fsp.writeFile('/tmp/arkme-rc2-browser-ready-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    exitCode = 0;
  } finally { probe.dispose(); }
}).catch(error => {
  console.error(error.stack || error.message);
  console.error(JSON.stringify({ isolatedRoot: root, diagnostics }));
}).finally(async () => {
  if (trial && !trial.isDestroyed()) trial.destroy();
  if (display && !display.isDestroyed()) display.destroy();
  if (supervisor) await supervisor.stop('quit').catch(error => console.error(error.message));
  clearTimeout(deadline);
  app.exit(exitCode);
});
