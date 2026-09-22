const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, titleBarStyle: 'hiddenInset', webPreferences: { sandbox: true } });
  const cards = {
    runtime: `<aside id="arkme-runtime-update-notice" data-kind="installed"><div class="arkme-runtime-update-notice__card">
      <span class="arkme-runtime-update-notice__message">新版本已安装，重启后激活。</span>
      <span class="arkme-runtime-update-notice__actions"><button id="restart"><span>立即重启</span></button><button>稍后</button></span>
      <button class="arkme-runtime-update-notice__close">×</button></div></aside>`,
    app: `<aside id="arkme-app-update-notice"><div class="arkme-app-update-card"><span>↑</span>
      <strong>客户端更新已准备好</strong><div class="arkme-app-update-actions"><button id="restart"><span>重启更新</span></button><button>稍后</button></div></div></aside>`
  };
  for (const [kind, card] of Object.entries(cards)) {
    await window.loadURL('data:text/html,' + encodeURIComponent(`<style>body{margin:0}header{height:68px;position:absolute;inset:0 0 auto}</style>
      <nav data-arkme-window-drag-mode="conversation"></nav><header data-arkme-window-drag-region="conversation"></header>
      <div id="arkme-desktop-update-notices">${card}</div>`));
    await window.webContents.executeJavaScript(process.env.ARKME_TEST_DRAG_SCRIPT);
    await window.webContents.insertCSS(process.env.ARKME_TEST_UPDATE_CSS, { cssOrigin: 'user' });
    // Avoid sampling the entry animation's transient transform.
    await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().map(animation => animation.finished))`);
    const state = await window.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('restart');
      const rect = button.getBoundingClientRect();
      const header = document.querySelector('header');
      const card = button.closest('[class$="card"]');
      const stack = document.getElementById('arkme-desktop-update-notices');
      const drag = element => getComputedStyle(element).webkitAppRegion;
      const hit = y => document.elementFromPoint(rect.x + rect.width / 2, y)?.closest('button')?.id;
      return { top: rect.top, bottom: rect.bottom, headerBottom: header.getBoundingClientRect().bottom,
        headerDrag: drag(header), stackDrag: drag(stack), cardDrag: drag(card),
        controls: [...card.querySelectorAll('button, button *')].map(drag),
        upperHit: hit(rect.top + 2), lowerHit: hit(rect.bottom - 2),
        outsideIsHeader: document.elementFromPoint(20, 40) === header };
    })()`);
    assert.ok(state.top < state.headerBottom && state.bottom > state.headerBottom, `${kind}: fixture must straddle the native drag region`);
    assert.equal(state.cardDrag, 'no-drag', `${kind}: floating card must exclude native header dragging`);
    assert.ok(state.controls.every(value => value === 'no-drag'), `${kind}: all button hit areas must be non-draggable`);
    assert.equal(state.headerDrag, 'drag');
    assert.notEqual(state.stackDrag, 'no-drag', 'transparent stack padding must not disable window dragging');
    assert.equal(state.outsideIsHeader, true);
    assert.equal(state.upperHit, 'restart');
    assert.equal(state.lowerHit, 'restart');
    console.log(kind, JSON.stringify(state));
  }
  window.destroy();
  console.log('update notice drag passed');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
