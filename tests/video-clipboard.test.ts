import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopVideoClipboard, videoClipboardIdentityAllowed, type VideoClipboardContext } from '../src/video-clipboard.js';

const roots: string[] = [];
afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });
const ref = 'arkme-file-v1.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherRef = 'arkme-file-v1.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const nextId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arkme-video-copy-test-')); roots.push(directory);
  let revision = 1, valid = true; const files: string[] = [];
  const native = { supported: true, revision: () => revision, files: () => files,
    write: vi.fn((file: string, expected: number) => {
      if (revision !== expected) throw new Error('剪贴板已更新');
      files.splice(0, files.length, file); revision++;
    }) };
  const context: VideoClipboardContext = { directory, origin: 'http://127.0.0.1:3102', cookie: 'fixture-only',
    accountKey: 'prod:42', scope: 'runtime-one:prod:42', sender: {}, valid: () => valid,
    watchInvalidation: () => () => {} };
  const requests: Array<{ url: string; method: string; range: string | null }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', range: new Headers(init?.headers).get('Range') });
    if (init?.method === 'POST') return Response.json({ ok: true, value: { state: 'ready', file: { fileRef: ref } } });
    if (String(url).includes('/team/media')) return new Response(null, { status: 206 });
    return new Response(init?.method === 'HEAD' ? null : 'synthetic video', { headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '15', 'Content-Disposition': "inline; filename*=UTF-8''sample.mp4",
      'X-Arkme-File-Origin': 'local',
    } });
  });
  const owner = new DesktopVideoClipboard(native, { fetch: fetcher as typeof fetch });
  const begin = () => owner.begin(context, { requestId: id, accountKey: context.accountKey });
  const copy = (mediaRef?: string) => owner.copy(context, { requestId: id, accountKey: context.accountKey, fileRef: ref, ...(mediaRef ? { mediaRef } : {}) });
  return { directory, context, owner, native, fetcher, requests, begin, copy,
    invalidate: () => { valid = false; }, changeClipboard: () => { revision++; } };
}

describe('native video copy reservation and bounded staging', () => {
  it('streams the authorized local file and reuses warm bytes after a fresh local HEAD', async () => {
    const f = await fixture(); f.begin(); await f.copy();
    expect(await readFile(f.native.files()[0]!, 'utf8')).toBe('synthetic video');
    f.begin(); await f.copy();
    expect(f.requests.map(r => r.method)).toEqual(['HEAD', 'GET', 'HEAD']);
    expect(f.native.write).toHaveBeenCalledTimes(2);
    expect(f.requests.every(r => r.url === `http://127.0.0.1:3102/arkme-self/api/files/local?ref=${ref}`)).toBe(true);
    const headers = new Headers(f.fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Cookie')).toBe('fixture-only'); expect(headers.get('Origin')).toBe(f.context.origin);
    expect(f.fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  it('requires a click-time reservation and rejects arbitrary URLs/paths, account and sender changes', async () => {
    const f = await fixture(); await expect(f.copy()).rejects.toThrow();
    expect(() => f.owner.begin(f.context, { requestId: id, accountKey: 'prod:43' })).toThrow();
    f.begin();
    await expect(f.owner.copy({ ...f.context, sender: {} }, { requestId: id, accountKey: 'prod:42', fileRef: ref })).rejects.toThrow();
    await expect(f.owner.copy(f.context, { requestId: id, accountKey: 'prod:42', fileRef: '/etc/passwd' })).rejects.toThrow();
    expect(f.requests).toHaveLength(0); expect(f.native.write).not.toHaveBeenCalled();
  });
  it('does not overwrite clipboard changed while the UI received the cold original', async () => {
    const f = await fixture(); f.begin(); f.changeClipboard();
    await expect(f.copy()).rejects.toThrow('剪贴板'); expect(f.native.write).not.toHaveBeenCalled();
  });
  it('cancels preparation and leaves the previous clipboard file pasteable', async () => {
    const f = await fixture(); f.begin(); await f.copy(); const previous = f.native.files()[0]!;
    f.begin(); f.owner.cancel(f.context, id); await expect(f.copy()).rejects.toThrow();
    expect(await readFile(previous, 'utf8')).toBe('synthetic video');
  });
  it('fences clipboard/account changes after streaming, before commit', async () => {
    const f = await fixture();
    f.fetcher.mockImplementationOnce(async () => new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '15', 'X-Arkme-File-Origin': 'local' } }));
    f.fetcher.mockImplementationOnce(async () => { f.invalidate(); return new Response('synthetic video'); });
    f.begin(); await expect(f.copy()).rejects.toThrow(); expect(f.native.write).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
  });
  it('rechecks media-ref binding and Team live permission even with warm staged bytes', async () => {
    const f = await fixture(); const media = 'team-app-media.signed-fixture';
    f.begin(); await f.copy(media); f.begin(); await f.copy(media);
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(2);
    expect(f.requests.filter(r => r.url.includes('/team/media'))).toEqual([
      { url: `http://127.0.0.1:3102/arkme-self/api/team/media?ref=${media}`, method: 'HEAD', range: 'bytes=0-0' },
      { url: `http://127.0.0.1:3102/arkme-self/api/team/media?ref=${media}`, method: 'HEAD', range: 'bytes=0-0' },
    ]);
    expect(f.requests.filter(r => r.method === 'GET')).toHaveLength(1);
    const originalFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes('/team/media') ? new Response(null, { status: 403 }) : originalFetch(url, init));
    f.begin(); await expect(f.copy(media)).rejects.toThrow(); expect(f.native.write).toHaveBeenCalledTimes(2);
  });
  it('rejects a Team grant for a different cached file and never commits', async () => {
    const f = await fixture(); const originalFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => init?.method === 'POST'
      ? Response.json({ ok: true, value: { state: 'ready', file: { fileRef: otherRef } } }) : originalFetch(url, init));
    f.begin(); await expect(f.copy('team-app-media.signed-fixture')).rejects.toThrow(); expect(f.native.write).not.toHaveBeenCalled();
  });
  it.each(['received', 'unknown', undefined])('requires a media binding for trusted origin=%s even if the renderer omits it', async origin => {
    const f = await fixture();
    const headers = new Headers({ 'Content-Type': 'video/mp4', 'Content-Length': '15' });
    if (origin) headers.set('X-Arkme-File-Origin', origin);
    f.fetcher.mockResolvedValueOnce(new Response(null, { headers }));
    f.begin(); await expect(f.copy()).rejects.toThrow('来源');
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.native.write).not.toHaveBeenCalled();
  });
  it.each(['received', 'unknown'])('allows origin=%s only with its exact authorized original binding', async origin => {
    const f = await fixture(); const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).includes('/files/local')) response.headers.set('X-Arkme-File-Origin', origin);
      return response;
    });
    f.begin(); await expect(f.copy('arkme-media-v1.signed-fixture')).resolves.toEqual({ copied: true });
    f.begin(); await expect(f.copy()).rejects.toThrow('来源'); expect(f.native.write).toHaveBeenCalledOnce();
  });
  it('copies a real local imported video without requiring a reception mapping for its later ordinary upload', async () => {
    const f = await fixture(); f.begin(); await f.copy('arkme-media-v1.later-upload');
    expect(f.requests.map(request => request.method)).toEqual(['HEAD', 'GET']);
    expect(f.native.write).toHaveBeenCalledOnce();
  });
  it.each(['text/plain', 'image/png'])('rejects non-video local files (%s)', async contentType => {
    const f = await fixture(); f.fetcher.mockResolvedValue(new Response(null, { headers: { 'Content-Type': contentType, 'Content-Length': '15', 'X-Arkme-File-Origin': 'local' } }));
    f.begin(); await expect(f.copy()).rejects.toThrow('仅支持复制视频'); expect(f.native.write).not.toHaveBeenCalled();
  });
  it('rejects truncated and oversized streams without disturbing existing clipboard content', async () => {
    const f = await fixture(); f.begin(); await f.copy(); const previous = f.native.files()[0]!;
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': '30', 'X-Arkme-File-Origin': 'local' };
    f.fetcher.mockResolvedValueOnce(new Response(null, { headers }));
    f.fetcher.mockResolvedValueOnce(new Response('short'));
    f.begin(); await expect(f.owner.copy(f.context, { requestId: id, accountKey: 'prod:42', fileRef: otherRef })).rejects.toThrow();
    expect(await readFile(previous, 'utf8')).toBe('synthetic video');
    f.fetcher.mockResolvedValueOnce(new Response(null, { headers: { ...headers, 'Content-Length': String(1024 ** 3 + 1) } }));
    f.begin(); await expect(f.copy()).rejects.toThrow(); expect(f.native.write).toHaveBeenCalledTimes(1);
  });
  it('latest click wins and a foreign sender cannot cancel another reservation', async () => {
    const f = await fixture(); f.begin();
    f.owner.cancel({ ...f.context, sender: {} }, id); await f.copy();
    f.begin(); f.owner.begin(f.context, { requestId: nextId, accountKey: 'prod:42' });
    await expect(f.copy()).rejects.toThrow();
    await f.owner.copy(f.context, { requestId: nextId, accountKey: 'prod:42', fileRef: ref });
    expect(f.native.write).toHaveBeenCalledTimes(2);
  });
  it('releases navigation/auth observers on scope invalidation and enforces the bounded click deadline', async () => {
    const f = await fixture(); let invalidate!: () => void; const release = vi.fn();
    f.context.watchInvalidation = listener => { invalidate = listener; return release; };
    f.begin(); invalidate(); await expect(f.copy()).rejects.toThrow(); expect(release).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    try {
      f.begin(); await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(f.copy()).rejects.toThrow(); expect(release).toHaveBeenCalledTimes(2);
      expect(f.native.write).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('preserves a prior process clipboard reference during cleanup and removes only obsolete staged files', async () => {
    const f = await fixture(); f.begin(); await f.copy(); const previous = f.native.files()[0]!;
    const restored = new DesktopVideoClipboard(f.native, { fetch: f.fetcher as typeof fetch });
    restored.begin(f.context, { requestId: nextId, accountKey: 'prod:42' });
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(restored.copy(f.context, { requestId: nextId, accountKey: 'prod:42', fileRef: otherRef })).rejects.toThrow();
    expect(await readFile(previous, 'utf8')).toBe('synthetic video');
    restored.begin(f.context, { requestId: nextId, accountKey: 'prod:42' });
    await restored.copy(f.context, { requestId: nextId, accountKey: 'prod:42', fileRef: otherRef });
    await expect(readFile(previous)).rejects.toThrow();
    expect(await readdir(f.directory)).toHaveLength(1);
  });
  it('never reuses bytes across account/runtime scope and cleans replaced files in the single native directory', async () => {
    const f = await fixture(); f.begin(); await f.copy(); const previous = f.native.files()[0]!;
    const next = { ...f.context, accountKey: 'prod:43', scope: 'runtime-two:prod:43' };
    f.owner.begin(next, { requestId: nextId, accountKey: next.accountKey });
    await f.owner.copy(next, { requestId: nextId, accountKey: next.accountKey, fileRef: ref });
    expect(f.requests.filter(r => r.method === 'GET')).toHaveLength(2);
    expect(await readdir(f.directory)).toHaveLength(1);
    await expect(readFile(previous)).rejects.toThrow();
  });
  it('cancels a stalled local stream without a native write or leaked temporary file', async () => {
    const f = await fixture(); let started!: () => void; const streaming = new Promise<void>(resolve => { started = resolve; });
    f.fetcher.mockImplementationOnce(async () => new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '15', 'X-Arkme-File-Origin': 'local' } }));
    let cancelled = false;
    f.fetcher.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('short')); started(); }, cancel() { cancelled = true; } })));
    f.begin(); const copy = f.copy(); await streaming; f.owner.cancel(f.context, id);
    await expect(copy).rejects.toThrow(); expect(cancelled).toBe(true); expect(f.native.write).not.toHaveBeenCalled(); expect(await readdir(f.directory)).toEqual([]);
  });
  it('performs final Team authorization after slow staging and denies a mid-download revocation', async () => {
    const f = await fixture(); let revoked = false;
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes('/team/media')) { expect(revoked).toBe(true); return new Response(null, { status: 403 }); }
      const response = await original(url, init); if (!init?.method) revoked = true; return response;
    });
    f.begin(); await expect(f.copy('team-app-media.signed-fixture')).rejects.toThrow(); expect(f.native.write).not.toHaveBeenCalled();
  });
});

describe('desktop video clipboard identity', () => {
  const accepted = { accountKey: 'prod:42', accountRef: createHash('sha256').update('arkme-dsh-account-scope-v1\n42').digest('hex'),
    environment: 'prod', origin: 'http://127.0.0.1:3102', frameUrl: 'http://127.0.0.1:3102/',
    mainFrame: true, mainOwner: true, conversationOwner: false, ready: true, locked: false };
  it('accepts only the active account and a trusted main/conversation main frame', () => {
    expect(videoClipboardIdentityAllowed(accepted)).toBe(true);
    expect(videoClipboardIdentityAllowed({ ...accepted, mainOwner: false, conversationOwner: true })).toBe(true);
  });
  it.each([{ accountKey: 'prod:43' }, { accountKey: 'test:42' }, { locked: true }, { ready: false },
    { mainFrame: false }, { mainOwner: false }, { frameUrl: 'about:blank' }, { frameUrl: 'https://example.com/' },
    { origin: 'http://127.0.0.1:3103' }, { origin: 'https://example.com', frameUrl: 'https://example.com/' }])('rejects stale/untrusted context %j', change => {
    expect(videoClipboardIdentityAllowed({ ...accepted, ...change })).toBe(false);
  });
});
