// Isolated native compositor acceptance. No login, production network or user data.
const { app, BrowserWindow } = require('electron');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
let temporary;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 80; i++) { if (await predicate()) return; await pause(50); } throw new Error('lock surface readiness timed out'); }
app.setName('即我锁定验收');
(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'arkme-device-lock-electron-'));
  app.setPath('userData', path.join(temporary, 'user-data'));
  await app.whenReady();
  const { DeviceLockSurfaces } = await import(pathToFileURL(path.join(root, 'dist/device-lock-surfaces.js')).href);
  // Preserve content protection owned by an existing window feature.
  const alreadyProtected = new BrowserWindow({ show: false });
  alreadyProtected.setContentProtection(true);
  let locked = true;
  let surfaces;
  const owner = {
    get protected() { return locked; },
    snapshot: () => ({ supported: true, locked, sessionEnded: false, needsCredentials: false, platform: process.platform === 'win32' ? 'windows' : 'macos', message: '你可以在手机即我首页的设备状态栏解锁。' }),
    requestUnlock: async () => { locked = false; surfaces.update(owner.snapshot()); return owner.snapshot(); }
  };
  surfaces = new DeviceLockSurfaces(owner, path.join(root, 'dist/device-lock-preload.cjs'), path.join(root, 'dist/ui/device-lock.html'));
  const create = async title => {
    const window = new BrowserWindow({ width: 960, height: 700, show: false, title, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,<html><body style="background:rgb(255,0,0)"><h1>PRIVATE CONTENT</h1><input value="private selection"></body></html>');
    window.setTitle(title);
    window.show();
    assert.equal(window.isVisible(), false, 'private windows must be hidden from native accessibility');
    await until(() => BrowserWindow.getAllWindows().some(item => item.webContents.getURL().includes('/ui/device-lock.html')));
    const lockWindow = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/ui/device-lock.html'));
    const overlay = { webContents: lockWindow.webContents, getBounds: () => lockWindow.getBounds() };
    await until(async () => !overlay.webContents.isLoading() && await overlay.webContents.executeJavaScript('document.querySelector("#title")?.textContent.includes("即我已锁定")'));
    assert.equal(window.getTitle(), '即我已锁定');
    assert.equal(await overlay.webContents.executeJavaScript('typeof window.deviceLock.unlock'), 'function');
    return { window, overlay };
  };
  const first = await create('私聊对象');
  const second = await create('附件文件名');
  const artifacts = path.join(root, '.runtime', 'device-lock-acceptance');
  await mkdir(artifacts, { recursive: true });
  first.window.show(); first.window.focus();
  await Promise.race([first.overlay.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'), pause(15000).then(() => { throw new Error('overlay never painted'); })]);
  assert.equal(first.window.isVisible(), false);
  assert.equal(second.window.isVisible(), false);
  await writeFile(path.join(artifacts, 'lock-surface.png'), (await first.overlay.webContents.capturePage()).toPNG());
  if (process.env.DEVICE_LOCK_ACCEPTANCE_HOLD === '1') await pause(45000);
  // A background title update must not disclose the private conversation name.
  second.window.setTitle('新的敏感标题'); assert.equal(second.window.getTitle(), '即我已锁定');
  // Unlock destroys the lock renderer; its evaluation reply may never arrive.
  void first.overlay.webContents.executeJavaScript('document.querySelector("#unlock").click(); undefined').catch(() => {});
  await until(() => first.window.contentView.children.every(view => view.webContents === first.window.webContents));
  assert.equal(first.window.isVisible(), true); assert.equal(second.window.isVisible(), true);
  assert.equal(alreadyProtected.isContentProtected(), true);
  assert.equal(first.window.isContentProtected(), false);
  assert.equal(first.window.getTitle(), '私聊对象'); assert.equal(second.window.getTitle(), '新的敏感标题');
  first.window.minimize(); await until(() => first.window.isMinimized());
  for (let i = 0; i < 1000; i++) surfaces.update(owner.snapshot());
  assert.equal(first.window.isMinimized(), true, 'ordinary reports must not restore minimized windows');
  first.window.hide(); second.window.hide();
  for (let i = 0; i < 20; i++) surfaces.update(owner.snapshot());
  assert.equal(first.window.isVisible(), false, 'ordinary reports must not reopen hidden windows');
  locked = true; surfaces.update(owner.snapshot());
  first.window.show();
  const guard = BrowserWindow.getAllWindows().find(item => ![first.window, second.window, alreadyProtected].includes(item));
  assert.ok(guard); guard.close(); await until(() => guard.isDestroyed());
  for (let i = 0; i < 20; i++) surfaces.update(owner.snapshot());
  assert.equal(BrowserWindow.getAllWindows().length, 3, 'background reports must not reopen a closed guard');
  assert.equal(first.window.isVisible(), false);
  locked = false; surfaces.update(owner.snapshot());
  assert.equal(first.window.isVisible(), false, 'remote unlock must respect a closed guard');
  surfaces.revealOnActivate(first.window); assert.equal(first.window.isVisible(), true);
  console.log(JSON.stringify({ status: 'passed', checks: ['private native windows hidden including accessibility', 'new window protection', 'private title redaction', 'trusted preload IPC', 'restore after authorized unlock', '1000 idle snapshots preserve minimized window', 'hidden and closed windows stay hidden', 'explicit reopening after unlock'], artifacts }));
})().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
