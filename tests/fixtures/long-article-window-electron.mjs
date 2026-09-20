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
for (const name of ['arkme-session-selection:bootstrap', 'arkme-runtime:harness-version', 'arkme-desktop:attention-capabilities', 'arkme-runtime:page-ready-nonce', 'arkme-app-update:app-version', 'arkme:desktop-notification:permission-state']) {
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
  await waitFor(() => js(main, 'typeof window.smokeOpen === "function"'), 'main ready');
  await js(main, 'window.arkmeLongArticle.onCreated(value => { (window.receipts ??= []).push(value) }); window.smokeOpen()');
  let child = editor(); assert(child); await ready(child);
  await js(main, 'window.smokeOpen()'); assert.equal(manager.size, 1); result.checks.push('same-source window deduplication');
  assert.equal(await js(child, 'window.arkmeLongArticle.account("prod:9")'), false);
  assert.equal(await js(main, 'window.arkmeLongArticle.context()'), null);
  result.checks.push('main/child IPC role isolation');
  await fill(child);
  await waitFor(() => !!draft?.document && draft.title !== '', 'autosaved rich draft');
  assert.equal(draft.sourceRef, 'source-A'); result.checks.push('rich editor and draft persistence');
  await shot(child, 'article-light');
  await js(child, 'document.body.setAttribute("data-ds-dark-theme", "")'); await shot(child, 'article-dark');
  child.close(); await waitFor(() => js(child, '!!document.querySelector("[role=alertdialog]")'), 'native close prompt');
  await shot(child, 'article-close'); await click(child, '继续编辑'); assert.equal(manager.size, 1); result.checks.push('native close cancellation');
  failSave = true; child.close(); await click(child, '保存并关闭');
  await waitFor(() => js(child, 'document.body.textContent.includes("模拟草稿保存失败")'), 'save failure');
  assert.equal(manager.size, 1); result.checks.push('save failure retains window');
  failSave = false; await click(child, '保存并关闭'); await waitFor(() => manager.size === 0, 'save and close');
  await js(main, 'window.smokeOpen()'); child = editor(); await ready(child);
  await waitFor(() => js(child, 'document.querySelector("input").value === "独立窗口长文测试"'), 'draft recovery'); result.checks.push('draft recovery');
  // A changed main-window target does not alter the native immutable context.
  await js(main, 'document.getElementById("root").textContent = "会话 B"');
  failSend = true; await click(child, '发送');
  await waitFor(() => js(child, 'document.body.textContent.includes("模拟发送失败")'), 'send failure');
  failSend = false; await click(child, '发送'); await waitFor(() => manager.size === 0, 'successful send');
  assert.equal(sends.length, 2); assert.equal(sends[0].recordUid, sends[1].recordUid); assert.equal(sends[0].relationUid, sends[1].relationUid);
  assert.equal(sends[1].sourceRef, 'source-A'); assert.equal(sends[1].expectedUserId, 7);
  const receipt = await js(main, 'window.receipts'); assert.equal(receipt.length, 1); assert.equal(receipt[0].sourceKey, 'chat:A');
  result.checks.push('send retry identity', 'bound conversation after main switch', 'cross-window receipt');
  draft = undefined;
  const openExisting = () => js(main, 'window.smokeOpen(' + JSON.stringify({ mode: 'existing', item: { ...original, isMe: true, senderName: '我', status: 1 } }) + ')');
  await openExisting(); child = editor(); await ready(child);
  assert.equal(await js(child, 'document.querySelector("input").value'), original.title);
  await fill(child, '修改原长文'); await shot(child, 'existing-edit');
  await click(child, '保存修改'); await waitFor(() => manager.size === 0, 'original updated');
  assert.equal(updates.length, 1); assert.equal(updates[0].itemUid, 'existing-1'); assert.equal(updates[0].version, 3);
  assert.equal(sends.length, 2); result.checks.push('existing article edits original without sending');
  editable = false; await openExisting(); child = editor();
  await waitFor(() => js(child, 'document.body.textContent.includes("只读")'), 'read only original');
  assert.equal(await js(child, '!!document.querySelector("input[aria-label=长文标题]")'), false);
  await shot(child, 'existing-readonly'); child.close(); await waitFor(() => manager.size === 0, 'readonly close');
  result.checks.push('permission denied stays read only');
  await js(main, 'window.smokeOpen(' + JSON.stringify({ mode: 'snapshot', item: { ...original, isMe: false, senderName: '转发', status: 1 } }) + ')'); child = editor();
  await waitFor(() => js(child, '!!document.querySelector("[data-arkme-long-article-dialog=snapshot]")'), 'snapshot ready');
  assert.equal(await js(child, '!!document.querySelector("input,textarea,[contenteditable=true]")'), false);
  child.close(); await waitFor(() => manager.size === 0, 'snapshot close'); result.checks.push('forwarded snapshot opens read only');
  await js(main, 'window.smokeOpen()'); child = editor(); await ready(child); await fill(child, '账号切换保护');
  userId = 8; await js(main, 'window.arkmeLongArticle.account("prod:8")');
  await waitFor(() => js(child, 'document.body.textContent.includes("账号已切换")'), 'account invalidation');
  child.close(); await waitFor(() => js(child, '!!document.querySelector("[role=alertdialog]")'), 'invalidated close prompt');
  assert.equal(manager.size, 1); await click(child, '放弃修改'); await waitFor(() => manager.size === 0, 'explicit discard');
  result.checks.push('invalidated account still protects unsaved content');
  assert.deepEqual(errors, []);
  result.errors = errors;
  await writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  main.destroy(); server.close(); app.exit(0);
} catch (error) {
  console.error(error, errors); await writeFile(path.join(outputRoot, 'failure.json'), JSON.stringify({ message: String(error), errors }, null, 2));
  for (const window of BrowserWindow.getAllWindows()) window.destroy(); server.close(); app.exit(1);
}

}
void run();
