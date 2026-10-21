// Opt-in native macOS chooser smoke test. Opens no account and uploads/reads no selected files.
// A fresh Electron process is required for each mode to exercise the first dialog after startup.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { appendFileSync } = require('node:fs');
const mode = process.argv.find(value => value.startsWith('--mode='))?.split('=')[1] ?? 'wide';
const logFile = process.argv.find(value => value.startsWith('--log='))?.slice(6);
const manual = process.argv.includes('--manual');
let owner, temporary;
const emit = value => {
  const line = '[native-picker-smoke] ' + JSON.stringify(value);
  console.log(line);
  if (logFile) appendFileSync(logFile, line + '\n');
};
const pause = millis => new Promise(resolve => setTimeout(resolve, millis));
app.on('window-all-closed', () => {});
(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'arkme-native-picker-'));
  app.setPath('userData', path.join(temporary, 'profile'));
  await app.whenReady();
  const { NativeRecordingPicker } = await import(pathToFileURL(path.resolve(__dirname, '../../dist/recording-file-picker.js')));
  owner = new BrowserWindow({ width: mode === 'narrow' ? 420 : 1280, height: 820, minWidth: 310,
    minHeight: 640, show: false, titleBarStyle: 'hiddenInset', title: '即我 · 文件选择隔离验证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      ...(manual ? { preload: path.join(__dirname, 'recording-picker-native-preload.cjs') } : {}) } });
  const picker = new NativeRecordingPicker(window => dialog.showOpenDialog(window, {
    properties: ['openFile', 'multiSelections'], filters: [{ name: '录音', extensions: ['wav', 'mp3', 'm4a'] }],
  }), details => emit({ mode, ...details }));
  if (manual) {
    ipcMain.handle('native-picker-smoke:pick', async event => {
      if (event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw new Error('Invalid test window');
      if (!owner.isFocused()) throw new Error('请先点击此测试窗口，再试一次');
      const started = performance.now();
      const result = await picker.pick(owner, () => !owner.isDestroyed());
      return { canceled: result.canceled, count: result.filePaths.length, elapsedMillis: Math.round(performance.now() - started) };
    });
    owner.on('closed', () => { void finish(0); });
  }
  await owner.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="font:18px system-ui;padding:60px;line-height:1.7"><h2>即我 · 文件选择隔离验证</h2><p>此窗口不连接账号，不读取或上传文件。</p>${manual ? '<p>点击下方按钮，观察系统选文件窗口是否稳定停留至少 8 秒，然后手动取消。可改变窗口大小后重复检查。</p><button id="pick" style="padding:12px 24px;font:inherit">打开系统选文件窗口</button><p id="status" role="status">等待开始</p><p>关闭此测试窗口即可结束。</p>' : '<p>请暂不操作，验证窗口将在 8 秒后自动关闭。</p>'}</body>`));
  owner.show();
  app.focus({ steal: true });
  owner.focus();
  if (manual) { emit({ mode, event: 'manual-ready' }); return; }
  await pause(1500);
  if (mode === 'fullscreen') {
    const entered = new Promise(resolve => owner.once('enter-full-screen', resolve));
    owner.setFullScreen(true);
    await Promise.race([entered, pause(5000)]);
    if (!owner.isFullScreen()) throw new Error('Full screen did not activate');
  }
  if (!owner.isVisible() || !owner.isFocused()) throw new Error('Test window must be visible and focused before opening the chooser');
  let settled = false;
  const started = performance.now();
  void picker.pick(owner, () => !owner.isDestroyed()).then(
    result => { settled = true; emit({ mode, event: 'early-result', canceled: result.canceled, count: result.filePaths.length }); },
    error => { settled = true; emit({ mode, event: 'error', message: error.message }); });
  await pause(8000);
  if (settled) throw new Error('Chooser settled before the 8 second observation completed; inspect cancellation/user action');
  emit({ mode, result: 'held-open', elapsedMillis: Math.round(performance.now() - started), electron: process.versions.electron,
    chromium: process.versions.chrome, fullscreen: owner.isFullScreen(), bounds: owner.getBounds() });
})().then(() => { if (!manual) return finish(0); }, error => { emit({ mode, result: 'failed', message: error.message }); void finish(1); });
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  if (owner && !owner.isDestroyed()) owner.destroy();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  app.exit(code);
}
