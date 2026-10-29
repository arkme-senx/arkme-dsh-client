// Local-only smoke: real Electron/preload/editor, deterministic fake Provider.
// Build the plugin fixture first with scripts/build-long-article-window-smoke.mjs.
import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { installLongArticleWindowIpc } from '../../dist/long-article-window-ipc.js';
const [pluginArg, bundleArg, outputArg] = process.argv.slice(2);
const pluginRoot = pluginArg && path.resolve(pluginArg), bundleRoot = bundleArg && path.resolve(bundleArg), outputRoot = outputArg && path.resolve(outputArg);
if (!pluginRoot || !bundleRoot || !outputRoot) throw new Error('Pass plugin root, bundle directory, output directory');
app.setPath('userData', path.join(outputRoot, 'electron-profile'));
setTimeout(() => { console.error('Smoke deadline exceeded'); app.exit(1) }, 90000).unref();
let main;
let origin;
let failSave = false;
let failSend = false;
let draft;
let editable = true;
const updates = [];
const original = { sourceRef: "source-A", itemUid: "existing-1", title: "已发送的长文", textContent: "原文正文", textFormat: "markdown", editable: true, version: 3, sendAtMillis: 1, updateAtMillis: 1, recordDurationMillis: 0, editDurationMillis: 0, thinkingDurationMillis: 0 };
let userId = 7;
const sends = [];
const errors = [];
const result = { checks: [], screenshots: [] };
const preload = path.resolve('dist/preload.cjs');
for (const name of ['arkme-device-lock:available', 'arkme-app-update:app-version-code', 'arkme-desktop:branding-snapshot', 'arkme-session-selection:bootstrap', 'arkme-runtime:harness-version', 'arkme-desktop:attention-capabilities', 'arkme-runtime:page-ready-nonce', 'arkme-app-update:app-version', 'arkme:desktop-notification:permission-state']) {
  ipcMain.on(name, event => { event.returnValue = null; });
}
for (const name of ['arkme-app-update:notice', 'arkme:runtime-update-notice:snapshot']) ipcMain.handle(name, () => null);
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  contents.on('dom-ready', () => { void contents.executeJavaScript('window.confirm = () => true; void 0'); });
});
const manager = installLongArticleWindowIpc({ main: () => main, origin: () => origin, scope: () => origin, preload: () => preload });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, origin || 'http://localhost').pathname;
    if (pathname === '/arkme-self/api') {
      let raw = ''; for await (const part of request) raw += part;
      const { operation, params = {} } = JSON.parse(raw);
      let value;
      if (operation === 'auth.status') value = { status: 'authenticated', userId, environment: 'prod' };
      else if (operation === 'auth.config') value = {};
      else if (operation === 'search.locations') value = { markers: [], truncated: false, items: [], hasMore: false, nextOffset: 0 };
      else if (operation === 'calendar.activity') value = { items: [], has_more: false };
      else if (operation === 'sources.self-target') value = { sourceRef: 'source-A', sourceKey: 'chat:A', kind: 'send_to_self', displayName: '发给自己' };
      else if (operation === 'search.scene') value = { items: [{ recordUid: 'existing-1', recordOwnerUserId: 7, title: original.title, textContent: original.textContent, snippet: '', sendAtMillis: 1, templateKind: 8, displayKind: 1, media: [], files: [], targetSource: { sourceRef: 'source-A', sourceKey: 'chat:A', displayName: '产品讨论群' } }], hasMore: false };

      else if (operation === 'provider.capabilities') value = { features: { markdownLongArticles: true } };
      else if (operation === 'source.long-article.draft.get') value = draft;
      else if (operation === 'source.long-article.draft.put') { if (failSave) throw new Error('模拟草稿保存失败'); draft = params; }
      else if (operation === 'source.long-article.draft.delete') draft = undefined;
      else if (operation === 'source.long-article.publish' || operation === 'source.send-rich') {
        sends.push(params); if (failSend) throw new Error('模拟发送失败');
        value = { itemUid: 'record-1', status: 1, sequence: 9 };
      } else if (operation === 'source.long-article.update') { updates.push(params); value = { ...original, ...params, version: 4 }; }
      else if (operation === 'source.long-article.detail' && params.itemUid === 'existing-1') value = { ...original, editable };
      else if (operation === 'source.long-article.detail') value = { itemUid: 'record-1', textContent: sends.at(-1)?.textContent, textFormat: 'markdown' };
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, value })); return;
    }
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/theme/base.css"><link rel="stylesheet" href="/theme/design-platform.css"><style>body{margin:0;font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-base)}button,input,textarea{font-family:inherit}#root{height:100vh}</style></head><body><div id="root"></div><script type="module" src="/editor.js"></script></body></html>'); return;
    }
    if (pathname.startsWith('/theme/')) {
      const variable = pathname.endsWith('base.css') ? 'base_css_default' : 'design_platform_css_default';
      const source = await readFile(path.resolve('node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'), 'utf8');
      const line = source.split('\n').find(value => value.trimStart().startsWith('var ' + variable + ' = '));
      if (!line) throw new Error('Missing bundled theme CSS: ' + variable);
      const css = JSON.parse(line.slice(line.indexOf(' = ') + 3).trim().replace(/;$/, ''));
      response.setHeader('Content-Type', 'text/css'); response.end(css); return;
    }
    const name = path.basename(pathname);
    const file = pathname.startsWith('/theme/') ? path.join(pluginRoot, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/styles', name) : path.join(bundleRoot, name);
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(await readFile(file));
  } catch (error) {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: false, error: { code: 'smoke-failure', message: error.message, retryable: true } }));
  }
});
const waitFor = async (check, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timeout: ' + label);
};
const js = (window, source) => window.webContents.executeJavaScript(source, true);
const click = (window, label) => js(window, `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`);
const editor = () => BrowserWindow.getAllWindows().find(window => window !== main);
const ready = window => waitFor(() => js(window, '!!document.querySelector(".tiptap[contenteditable=true]")'), 'editor ready');
const fill = async (window, title = '独立窗口长文测试') => {
  await js(window, `(() => { const title=document.querySelector('input[aria-label="长文标题"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(title,${JSON.stringify(title)}); title.dispatchEvent(new Event('input',{bubbles:true})); const body=document.querySelector('.tiptap'); body.focus(); document.execCommand('insertText',false,'这篇长文在独立窗口中编辑。主窗口切换会话后，发送目标仍然保持不变。'); })()`);
};
const shot = async (window, name) => {
  const file = path.join(outputRoot, name + '.png'); await writeFile(file, (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file);
};
async function run() {
try {
  await mkdir(outputRoot, { recursive: true });
  await app.whenReady(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  main = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await main.loadURL(origin);
  await waitFor(() => js(main, 'typeof window.smokeBrowse === "function"'), 'main ready');
  await js(main, 'window.smokeBrowse("library")');
  const library = editor();
  await waitFor(() => js(library, '!!document.querySelector("[data-arkme-long-article-result]")'), 'library ready');
  assert.equal(await js(library, 'document.querySelector(".arkme-article-library").getBoundingClientRect().width === innerWidth'), true);
  await shot(library, 'library-light');
  await js(library, 'document.body.setAttribute("data-ds-dark-theme", "")'); await waitFor(() => js(library, 'getComputedStyle(document.querySelector(".arkme-article-library")).backgroundColor !== "rgb(255, 255, 255)"'), 'dark theme applied'); await shot(library, 'library-dark');
  await js(main, 'window.smokeBrowse("library")'); assert.equal(manager.size, 1);
  result.checks.push('library native window, full-size surface, repeat opens focus the same window');
  await js(library, 'document.querySelector("[data-arkme-long-article-result]").click()');
  await waitFor(() => manager.size === 2, 'article opened from library');
  let article = BrowserWindow.getAllWindows().find(window => window !== main && window !== library);
  await ready(article); await shot(article, 'library-article');
  assert.equal(await js(article, '!!document.querySelector(".arkme-article-workspace-directory")'), true);
  result.checks.push('library opens a dedicated article editor with directory and outline');
  await js(article, 'document.querySelector(".tiptap").focus(); document.execCommand("insertText",false,"独立窗口自动发布验证");');
  await waitFor(() => updates.length > 0, 'automatic publication');
  result.checks.push('existing article automatically publishes changes');
  failSave = true;
  await js(article, 'document.querySelector(".tiptap").focus(); document.execCommand("insertText",false,"关闭保存失败验证");');
  article.close();
  await waitFor(() => js(article, 'document.body.textContent.includes("模拟草稿保存失败")'), 'save failure remains visible');
  assert.equal(manager.size, 2);
  failSave = false; article.close(); await waitFor(() => manager.size === 1, 'article close flush');
  result.checks.push('failed close save retains article window and a later retry closes safely');
  await click(library, '新建长文'); await waitFor(() => manager.size === 2, 'create from library');
  article = BrowserWindow.getAllWindows().find(window => window !== main && window !== library); await ready(article);
  await fill(article, '从长文库创建');
  await waitFor(() => sends.length > 0, 'new article auto publication');
  assert.equal(manager.context(article.webContents.id).autoPublish, true);
  result.checks.push('library creation retains automatic publication mode');
  article.close(); await waitFor(() => manager.size === 1, 'created article close');
  await js(main, 'window.smokeBrowse("location")');
  const location = BrowserWindow.getAllWindows().find(window => window !== main && window !== library);
  await waitFor(() => js(location, '!!document.querySelector("[aria-label=位置地图]")'), 'location ready');
  await shot(location, 'location-light');
  await js(location, 'document.body.setAttribute("data-ds-dark-theme", "")'); await shot(location, 'location-dark');
  assert.equal(await js(location, 'document.querySelector(".arkme-day-map-dialog").getBoundingClientRect().height === innerHeight'), true);
  await js(main, 'window.smokeBrowse("location", {initialDate:{bucketDate:"2026-10-26",timezone:"Asia/Shanghai"}})');
  await waitFor(() => js(location, 'document.body.textContent.includes("2026")'), 'date context applied');
  assert.equal(manager.size, 2);
  assert.equal(manager.context(location.webContents.id).location.initialDate.bucketDate, '2026-10-26');
  result.checks.push('location window is independent and a calendar request reuses it with the new day');
  await js(main, 'window.arkmeLongArticle.onNavigate(value => { window.smokeNavigated = value.recordUid }); void 0');
  assert.equal(await js(location, 'window.arkmeLongArticle.navigate({source:{sourceRef:"source-A",sourceKey:"chat:A",displayName:"产品讨论群"},recordUid:"record-target",sendAtMillis:1})'), true);
  await waitFor(() => js(main, 'window.smokeNavigated === "record-target"'), 'main receives navigation');
  result.checks.push('location record navigation reaches and focuses the main window');
  userId = 8; manager.setAccount('prod:8');
  await waitFor(() => manager.size === 0, 'account invalidates both browse windows');
  result.checks.push('account invalidation closes both browser surfaces');
  assert.deepEqual(errors, []); result.errors = errors;
  await writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2)); main.destroy(); server.close(); app.exit(0);
} catch (error) {
  console.error(error, errors); await writeFile(path.join(outputRoot, 'failure.json'), JSON.stringify({message:String(error), errors},null,2));
  for (const window of BrowserWindow.getAllWindows()) window.destroy(); server.close(); app.exit(1);
}
}
void run();
