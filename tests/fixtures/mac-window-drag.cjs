const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const html = `<nav id="navigation"></nav>
    <header data-arkme-window-drag-region="conversation">
      <div data-arkme-window-drag-region="conversation" id="space"><h2>Selectable title</h2></div>
      <button><span id="icon">Action</span></button>
      <label><input></label><a href="#">Link</a><div contenteditable="true">Edit</div>
      <div role="menu"><div id="menu-content">Menu content</div></div>
    </header><main><p>Message text</p><textarea></textarea></main>
    <aside style="display:flex;flex-direction:column;width:250px">
      <div id="toolbar" data-arkme-window-drag-region="conversation" data-arkme-window-drag-directory
        style="flex:none;margin:24px 16px 16px;display:flex;align-items:center;gap:8px">
        <label id="search" style="flex:1;min-width:0;height:40px"><input style="width:100%;box-sizing:border-box"></label>
        <button style="width:32px;height:32px">+</button>
      </div><div id="list">Conversation list</div>
    </aside>
    <header id="arko" data-arkme-window-drag-region="conversation" style="display:flex;width:600px;gap:10px">
      <span id="arko-copy" data-arkme-window-drag-region="conversation" data-arkme-window-drag-copy
        style="flex:1;min-width:0;display:flex;flex-direction:column">
        <h2 id="arko-title" style="margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Arko</h2>
        <span>Agent disclaimer</span>
      </span>
      <div role="toolbar"><button id="arko-action">Model</button></div>
    </header>
    <section id="market">
      <header id="market-header" data-arkme-window-drag-region="marketplace">
        <h2>市集</h2><nav role="tablist" data-arkme-window-drag-region="marketplace">
          <button role="tab"><span id="market-tab-label">发现</span></button>
        </nav>
      </header>
      <div id="market-search"><input placeholder="Search"><button>Filter</button></div>
    </section>`;
  const script = process.env.ARKME_TEST_DRAG_SCRIPT;
  const snapshot = () => window.webContents.executeJavaScript(`(() => {
    const region = document.getElementById('arkme-mac-window-drag-region');
    const style = getComputedStyle(region);
    const drag = selector => getComputedStyle(document.querySelector(selector)).webkitAppRegion;
    return { display: style.display, drag: style.webkitAppRegion,
      header: drag('header'), space: drag('#space'),
      controls: ['h2', 'button', '#icon', 'input', 'label', 'a', '[contenteditable]', '#menu-content'].map(drag),
      body: drag('main'), input: drag('textarea'),
      marketHeader: drag('#market-header'), marketTabs: drag('#market [role="tablist"]'),
      marketTab: drag('#market [role="tab"]'), marketLabel: drag('#market-tab-label'),
      marketSearch: drag('#market-search'), marketInput: drag('#market-search input'),
      arkoHeader: drag('#arko'), arkoCopy: drag('#arko-copy'),
      arkoText: drag('#arko-title'), arkoAction: drag('#arko-action'),
      count: document.querySelectorAll('#arkme-mac-window-drag-region').length,
      styles: document.querySelectorAll('#arkme-mac-window-drag-style').length };
  })()`);
  const setMode = mode => window.webContents.executeJavaScript(
    `document.getElementById('navigation').setAttribute('data-arkme-window-drag-mode', ${JSON.stringify(mode)})`
  );
  const layout = () => window.webContents.executeJavaScript(`(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect().toJSON();
    return { search: rect('search'), list: rect('list'), toolbar: rect('toolbar') };
  })()`);
  const fallback = state => {
    assert.notEqual(state.display, 'none');
    assert.equal(state.drag, 'drag');
    assert.notEqual(state.header, 'drag');
  };
  for (let load = 0; load < 2; load++) {
    await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    await window.webContents.executeJavaScript(script);
    fallback(await snapshot());
    const before = await layout();
    for (let change = 0; change < 3; change++) {
      await setMode('conversation');
      const state = await snapshot();
      assert.equal(state.display, 'none');
      assert.equal(state.drag, 'no-drag');
      assert.equal(state.header, 'drag');
      assert.equal(state.space, 'drag');
      assert.ok(state.controls.every(value => value === 'no-drag'));
      assert.notEqual(state.body, 'drag');
      assert.notEqual(state.input, 'drag');
      assert.notEqual(state.marketHeader, 'drag');
      assert.equal(state.arkoHeader, 'drag');
      assert.equal(state.arkoCopy, 'drag');
      assert.equal(state.arkoText, 'no-drag');
      assert.equal(state.arkoAction, 'no-drag');
      const arkoSpace = await window.webContents.executeJavaScript(`(() => {
        const text = document.getElementById('arko-title').getBoundingClientRect();
        const copy = document.getElementById('arko-copy').getBoundingClientRect();
        return copy.width - text.width;
      })()`);
      assert.ok(arkoSpace > 100, 'Arko title must leave draggable whitespace beside its selectable text');
      const after = await layout();
      assert.deepEqual(after.search, before.search);
      assert.deepEqual(after.list, before.list);
      assert.equal(after.search.y - after.toolbar.y, 24);
      await setMode('marketplace');
      const market = await snapshot();
      assert.equal(market.display, 'none');
      assert.equal(market.drag, 'no-drag');
      assert.equal(market.marketHeader, 'drag');
      assert.equal(market.marketTabs, 'drag');
      assert.equal(market.marketTab, 'no-drag');
      assert.equal(market.marketLabel, 'no-drag');
      assert.notEqual(market.header, 'drag');
      assert.notEqual(market.arkoHeader, 'drag');
      assert.notEqual(market.marketSearch, 'drag');
      assert.notEqual(market.marketInput, 'drag');
      assert.deepEqual((await layout()).search, before.search);
      await setMode('fallback');
      fallback(await snapshot());
    }
    await setMode('conversation');
    await window.webContents.executeJavaScript(script);
    const repeated = await snapshot();
    assert.equal(repeated.display, 'none');
    assert.equal(repeated.count, 1);
    assert.equal(repeated.styles, 1);
    await window.webContents.executeJavaScript("document.getElementById('navigation').remove()");
    fallback(await snapshot());
  }
  window.destroy();
  console.log('mac-window-drag passed');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
