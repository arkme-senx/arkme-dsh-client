// Run after building the desktop host. Pass the local plugin checkout as argv[2].
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { installCallWindow } from '../../dist/call-window.js';

app.setPath('userData', await mkdtemp(path.join(tmpdir(), 'arkme-call-window-')));
const assets = path.resolve(process.argv[2], 'assets/desktop_call');
let bundleRequests = 0;
let finishColdLoad;
const coldLoad = new Promise(resolve => { finishColdLoad = resolve; });
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.split('/').pop();
  if (name !== 'index.html' && name !== 'bundle.js') { res.end('<main>Arkme</main>'); return; }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
  if (name === 'bundle.js') {
    bundleRequests++;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    await coldLoad;
  }
  const file = await readFile(path.join(assets, name), 'utf8');
  // Use the production controls with local fixture state, without contacting a peer.
  const fixture = `
    window.previewConnected = media => {
      state.phase = CALL_PHASE.connected;
      state.activeMediaType = media;
      state.peer.name = '测试联系人';
      state.peer.avatar = 'data:image/png;base64,' + 'A'.repeat(70000);
      state.audioEnabled = true;
      state.engine = { hangup: async () => {} };
      render();
    };
  `;
  res.end(name === 'bundle.js' ? file + fixture : file);
});
async function wait(check, description) {
  for (let count = 0; count < 150; count++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(description);
}
async function run() {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const channel of ['arkme-session-selection:bootstrap','arkme-runtime:harness-version','arkme-desktop:attention-capabilities',
    'arkme-runtime:page-ready-nonce','arkme-app-update:app-version','arkme-app-update:app-version-code','arkme:desktop-notification:permission-state',
    'arkme-desktop:branding-snapshot','arkme-device-lock:available']) {
    ipcMain.on(channel, event => { event.returnValue = null; });
  }
  for (const channel of ['arkme:runtime-update-notice:snapshot', 'arkme-app-update:notice']) ipcMain.handle(channel, () => null);
  const main = new BrowserWindow({show: false, webPreferences: {preload: path.resolve('dist/preload.cjs')}});
  installCallWindow({main: () => main, origin: () => origin, preload: path.resolve('dist/call-preload.cjs')});
  await main.loadURL(origin);
  const js = source => main.webContents.executeJavaScript(source);
  await js(`window.events = [];
    let compact = false, fullscreen = false;
    arkmeCallWindow.listen((id, kind, value) => {
      events.push([id, kind, value]);
      if (kind !== 'message') return;
      const {type} = JSON.parse(value);
      if (type === 'toggle_compact_mode_request') { compact = !compact; fullscreen = false; }
      else if (type === 'toggle_fullscreen_request') { fullscreen = !fullscreen; compact = false; }
      else return;
      arkmeCallWindow.sync(id, '/arkme-self/api/call', true, compact, fullscreen, '');
    }); void 0`);
  await js("arkmeCallWindow.sync('cold','/arkme-self/api/call',true,false,false,'')");
  await wait(() => js("events.some(([id,k])=>id==='cold' && k==='loaded')"), 'cold call document');
  const coldView = webContents.getAllWebContents().find(c => c.getURL().includes('callRequestId=cold'));
  const coldWindow = BrowserWindow.getAllWindows().find(w => w !== main);
  assert.equal(coldWindow.isVisible(), false);
  finishColdLoad();
  await wait(() => coldWindow.isVisible(), 'first call UI before SDK login');
  assert.ok(await coldView.executeJavaScript("!!document.querySelector('[data-desktop-call-shell]')"));
  await js("arkmeCallWindow.release('cold')");
  await wait(() => coldView.isDestroyed(), 'cold window cleanup');
  for (const media of ['audio','video']) {
    const sync = (visible, compact = false, fullscreen = false) => js(
      `arkmeCallWindow.sync('${media}','/arkme-self/api/call',${visible},${compact},${fullscreen},'')`);
    await sync(false);
    await wait(() => js(`events.some(([id,kind])=>id==='${media}' && kind==='loaded')`), 'receiver transport not ready');
    const engine = webContents.getAllWebContents().find(c => c.getURL().includes('callRequestId=' + media));
    assert.ok(engine);
    await wait(() => engine.executeJavaScript("!!document.querySelector('[data-desktop-call-shell]')"), 'call UI did not mount');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await sync(true);
    await wait(() => BrowserWindow.getAllWindows().length === 2, 'missing call window');
    const win = BrowserWindow.getAllWindows().find(w => w !== main);
    assert.equal(win.contentView.children[0].webContents.id, engine.id);
    assert.equal(win.isModal(), false);
    assert.equal(win.getParentWindow(), null);
    assert.deepEqual(win.getContentSize(), [960, 640]);
    assert.deepEqual(await engine.executeJavaScript(`(() => {
      const strip = [...document.querySelectorAll('[aria-hidden=true]')].find(el => getComputedStyle(el).webkitAppRegion === 'drag');
      const bounds = strip.getBoundingClientRect();
      return [bounds.height, innerWidth - bounds.right];
    })()`), [24, 56]);
    await engine.executeJavaScript(`previewConnected('${media}')`);
    async function click(action) {
      let point;
      await wait(async () => {
        point = await engine.executeJavaScript(`(() => {
        const button = document.querySelector('[data-action="${action}"]');
        const rect = button.getBoundingClientRect();
        const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
        if (!button.contains(document.elementFromPoint(x, y))) return null;
        return {x,y};
      })()`);
        return point != null;
      }, 'button not hittable: '+action);
      if (!engine.debugger.isAttached()) engine.debugger.attach();
      await engine.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', ...point});
      await engine.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', clickCount:1, ...point});
      await engine.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', clickCount:1, ...point});
    }
    app.focus({steal:true});
    win.focus();
    engine.focus();
    await new Promise(r => setTimeout(r, 500));
    await click('toggle-compact-mode');
    await wait(() => win.getContentSize()[0] === 160, 'compact size');
    await click('restore-regular-window');
    await wait(() => win.getContentSize()[0] === 960, 'regular size');
    let entered = false;
    win.once('enter-full-screen', () => { entered = true; });
    await click('toggle-fullscreen');
    await wait(() => win.isFullScreen(), 'fullscreen');
    await wait(() => entered, 'fullscreen transition');
    await wait(async () => await engine.executeJavaScript('innerWidth') === win.getContentSize()[0], 'fullscreen content layout');
    await click('toggle-fullscreen');
    await wait(() => !win.isFullScreen(), 'exit fullscreen');
    await engine.executeJavaScript("document.querySelector('[data-action=hangup]').click()");
    await wait(() => js(`events.some(([id,kind,data])=>id==='${media}' && kind==='message' && JSON.parse(data).type==='end')`), 'end message');
    await js(`arkmeCallWindow.release('${media}')`);
    await wait(() => win.isDestroyed() && engine.isDestroyed(), 'window or engine retained after release');
  }
  assert.equal(bundleRequests, 1, 'same-version engine reused across calls');
  console.log('PASS cold first frame, cached engine, audio/video window lifecycle, receiver promotion, compact, fullscreen, teardown');
  app.exit(0);
}
run().catch(error => { console.error(error); app.exit(1); });
