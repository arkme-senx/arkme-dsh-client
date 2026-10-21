// Manual, cold-process comparison of the three picker paths. No account, upload or file reads.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { createServer } = require('node:http');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { appendFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const methods = ['input', 'browser', 'native'];
const backend = process.argv.find(arg => arg.startsWith('--backend='))?.slice(10) || 'input';
if (!methods.includes(backend)) throw new Error('Unknown comparison backend');
const log = process.argv.find(arg => arg.startsWith('--log='))?.slice(6);
if (!log || !path.isAbsolute(log)) throw new Error('An absolute --log path is required');
const runId = randomUUID();
const emit = details => appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), runId, pid: process.pid, backend, ...details }) + '\n');
// Capture only the Chromium classes relevant to visibility cancellation, in this test process.
app.commandLine.appendSwitch('enable-logging', 'file');
app.commandLine.appendSwitch('log-file', `${log}.${runId}.chromium.log`);
app.commandLine.appendSwitch('vmodule', 'web_contents_based_canceller=1,file_system_chooser=1');
let owner, temporary, server, finishing = false;
const finish = async (restart = false) => {
  if (finishing) return;
  finishing = true;
  if (restart) {
    const next = methods[(methods.indexOf(backend) + 1) % methods.length];
    emit({ event: 'restart', next });
    app.relaunch({ args: [__filename, `--backend=${next}`, `--log=${log}`] });
  }
  if (owner && !owner.isDestroyed()) owner.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  if (temporary) await rm(temporary, { force: true, recursive: true });
  app.exit(0);
};
app.on('window-all-closed', () => { void finish(); });
(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'arkme-picker-comparison-'));
  app.setPath('userData', path.join(temporary, 'profile'));
  await app.whenReady();
  const { NativeRecordingPicker } = await import(pathToFileURL(path.resolve(__dirname, '../../dist/recording-file-picker.js')));
  const html = await readFile(path.join(__dirname, 'recording-picker-comparison.html'));
  const js = await readFile(path.join(__dirname, 'recording-picker-comparison-renderer.js'));
  server = createServer((request, response) => {
    const script = request.url === '/comparison.js';
    if (!script && request.url !== '/') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'" });
    response.end(script ? js : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  owner = new BrowserWindow({ width: 1280, height: 820, minWidth: 310, minHeight: 640,
    titleBarStyle: 'hiddenInset', title: '即我 · 选文件新旧对照',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'recording-picker-comparison-preload.cjs') } });
  const trusted = event => event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame;
  const picker = new NativeRecordingPicker(window => dialog.showOpenDialog(window, {
    properties: ['openFile', 'multiSelections'], filters: [{ name: '录音', extensions: ['wav', 'mp3', 'm4a'] }],
  }), details => emit({ scope: 'native', ...details }));
  ipcMain.handle('picker-comparison:method', event => trusted(event) ? backend : null);
  ipcMain.handle('picker-comparison:native', async event => {
    if (!trusted(event) || backend !== 'native') throw new Error('Invalid test frame');
    const result = await picker.pick(owner, () => !owner.isDestroyed());
    return { canceled: result.canceled, count: result.filePaths.length };
  });
  ipcMain.handle('picker-comparison:restart', event => { if (trusted(event)) setImmediate(() => { void finish(true); }); });
  ipcMain.on('picker-comparison:log', (event, details) => {
    if (!trusted(event) || !details || typeof details !== 'object') return;
    const allowed = ['event', 'elapsedMillis', 'visibility', 'focused', 'activation', 'errorName', 'count', 'judgment', 'secureContext'];
    const clean = Object.fromEntries(Object.entries(details).filter(([key, value]) => allowed.includes(key)
      && (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' && value.length < 100)));
    emit({ scope: 'renderer', ...clean });
  });
  for (const name of ['blur', 'focus', 'show', 'hide', 'resize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    owner.on(name, () => { if (!owner.isDestroyed()) emit({ scope: 'window', event: name, visible: owner.isVisible(), focused: owner.isFocused(), bounds: owner.getBounds() }); });
  }
  emit({ event: 'startup', electron: process.versions.electron, chromium: process.versions.chrome });
  await owner.loadURL(`http://127.0.0.1:${server.address().port}/`);
  emit({ event: 'ready' });
})().catch(error => { emit({ event: 'failed', errorName: error.name, message: error.message }); void finish(); });
