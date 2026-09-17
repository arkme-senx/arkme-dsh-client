// Opt-in real Electron boundary test. Uses only temporary account/browser data.
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const clientRoot = path.resolve(__dirname, '../..');
const pluginRoot = process.env.ARKME_PLUGIN_PATH ?? path.resolve(clientRoot, '../arkme-dsh-plugin');
let win, temp, servers = [];
(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'arkme-selection-electron-'));
  app.setPath('userData', path.join(temp, 'browser'));
  await app.whenReady();
  const { DesktopSessionSelection } = await import(pathToFileURL(path.join(clientRoot, 'dist/session-selection.js')));
  const source = await readFile(path.join(pluginRoot, 'src/harness-session-restore-script.ts'), 'utf8');
  const { HARNESS_SESSION_RESTORE_SCRIPT } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let selections = new DesktopSessionSelection();
  const sender = event => ({ webContentsId: event.sender.id, isMainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? '' });
  ipcMain.on('arkme-session-selection:bootstrap', event => { event.returnValue = selections.bootstrap(sender(event)); });
  ipcMain.handle('arkme-session-selection:save', (event, value) => selections.save(sender(event), value));
  for (const channel of ['arkme-runtime:harness-version', 'arkme:desktop-notification:permission-state', 'arkme-desktop:attention-capabilities', 'arkme-runtime:page-ready-nonce', 'arkme-app-update:app-version']) {
    ipcMain.on(channel, event => { event.returnValue = channel === 'arkme-runtime:harness-version' ? '0.1.5-rc.2' : null; });
  }
  for (const channel of ['arkme-app-update:notice', 'arkme-app-update:status', 'arkme:runtime-update-notice:snapshot']) ipcMain.handle(channel, () => null);
  const server = async () => {
    const s = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.url === '/frame' ? `<html><head><script>${HARNESS_SESSION_RESTORE_SCRIPT}</script><script>window.restored = localStorage.getItem('dsh.sessions.current');</script></head><body>frame</body></html>` : `<html><head><script>window.preloadSeed = localStorage.getItem('dsh.sessions.current'); localStorage.setItem('dsh.sessions.current', '{}');</script></head><body><iframe src="/frame"></iframe></body></html>`);
    });
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    servers.push(s);
    return `http://127.0.0.1:${s.address().port}/`;
  };
  const scope = name => ({ containerRef: name, dshHome: path.join(temp, name, 'dsh'), settingsPath: path.join(temp, name, 'settings.json'), owner: { kind: 'account', accountRef: name } });
  const a = scope('account-A'), b = scope('account-B');
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(clientRoot, 'dist/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('preload-error', (_event, file, error) => errors.push(`${file}: ${error.message}`));
  const url1 = await server();
  await selections.prepare(win.webContents.id, url1, a);
  await win.loadURL(url1);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('iframe').contentWindow.restored"), null);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('iframe').contentWindow.parent.arkmeDesktop.sessionSelection.save('A-last')"), true);
  assert.equal(JSON.parse(await readFile(path.join(temp, 'account-A/session-selection.json'))).sessionId, 'A-last');
  // Fresh authority instance + different local origin simulates desktop restart.
  selections.invalidate();
  await selections.flush();
  selections = new DesktopSessionSelection();
  const url2 = await server();
  assert.notEqual(url1, url2);
  await selections.prepare(win.webContents.id, url2, a);
  await win.loadURL(url2);
  assert.equal(await win.webContents.executeJavaScript('window.preloadSeed'), '{"sessionId":"A-last"}');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('iframe').contentWindow.restored"), '{"sessionId":"A-last"}');
  // The same port now hosts another account; old browser storage must not leak.
  selections.invalidate();
  await selections.prepare(win.webContents.id, url2, b);
  await win.loadURL(url2);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('iframe').contentWindow.restored"), null);
  assert.equal(await win.webContents.executeJavaScript("arkmeDesktop.sessionSelection.save('B-last')"), true);
  await selections.prepare(win.webContents.id, url2, a);
  await win.loadURL(url2);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('iframe').contentWindow.restored"), '{"sessionId":"A-last"}');
  assert.deepEqual(errors, []);
  console.log('PASS: real Electron sandbox/preload/iframe IPC, changed-port restart, shared-storage race and account A/B isolation');
})().then(() => cleanup(0), error => { console.error(error); cleanup(1); });
async function cleanup(code) {
  if (win && !win.isDestroyed()) win.destroy();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (temp) await rm(temp, { recursive: true, force: true });
  app.exit(code);
}
