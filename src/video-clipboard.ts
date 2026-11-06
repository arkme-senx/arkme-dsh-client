import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

export interface NativeVideoClipboard {
  readonly supported: boolean;
  revision(): number;
  files(): string[];
  write(file: string, revision: number, windowHandle?: Buffer): void;
}
export interface VideoClipboardContext {
  directory: string;
  origin: string;
  cookie: string;
  accountKey: string;
  scope: string;
  sender: object;
  windowHandle?: Buffer;
  valid(): boolean;
  watchInvalidation(invalidate: () => void): () => void;
}
interface Reservation {
  id: string; context: VideoClipboardContext; revision: number; controller: AbortController;
  release(): void; copying: boolean;
}
interface Stage { key: string; file: string; directory: string; size: number }
const ID = /^[a-zA-Z0-9-]{1,100}$/;
const FILE_REF = /^arkme-file-v1\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Matches the maximum configurable Host maxUploadBytes (src/index.ts schema).
// Trusted local HEAD has already checked the file against that Host's actual policy.
const MAX_BYTES = 1024 ** 3;
export function videoClipboardIdentityAllowed(input: {
  accountKey: unknown; accountRef: string; environment: string; origin: string | null; frameUrl: string;
  mainFrame: boolean; mainOwner: boolean; conversationOwner: boolean; ready: boolean; locked: boolean;
}): boolean {
  if (!input.ready || input.locked || !input.mainFrame || (!input.mainOwner && !input.conversationOwner) || !input.origin) return false;
  const match = typeof input.accountKey === 'string' ? /^(prod|test):([1-9]\d*)$/.exec(input.accountKey) : null;
  if (!match || match[1] !== input.environment || !Number.isSafeInteger(Number(match[2]))) return false;
  try {
    localOrigin(input.origin);
    if (new URL(input.frameUrl).origin !== input.origin) return false;
  } catch { return false; }
  return createHash('sha256').update(`arkme-dsh-account-scope-v1\n${Number(match[2])}`).digest('hex') === input.accountRef;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('视频复制参数无效');
  return value as Record<string, unknown>;
}
function identity(value: unknown, context: VideoClipboardContext): string {
  const request = object(value);
  if (typeof request.requestId !== 'string' || !ID.test(request.requestId)
    || request.accountKey !== context.accountKey || !/^(prod|test):[1-9]\d*$/.test(context.accountKey)) throw new Error('视频复制账号或请求无效');
  return request.requestId;
}
function localOrigin(value: string): void {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('视频复制宿主无效');
}

/** Only this explicit click's authorized complete video becomes a native file reference. */
export class DesktopVideoClipboard {
  private pending: Reservation | undefined;
  private stage: Stage | undefined;
  private preparing: Promise<unknown> = Promise.resolve();
  private readonly fetch: typeof fetch;
  constructor(private readonly native: NativeVideoClipboard, options: { fetch?: typeof fetch } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  begin(context: VideoClipboardContext, input: unknown): void {
    const id = identity(input, context); localOrigin(context.origin);
    if (!this.native.supported) throw new Error('当前平台暂不支持复制视频');
    if (!context.valid()) throw new Error('视频复制窗口或账号已改变');
    this.finish();
    const revision = this.native.revision();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60_000); timer.unref();
    const unwatch = context.watchInvalidation(() => controller.abort());
    const reservation: Reservation = { id, context, revision, controller, copying: false,
      release: () => { clearTimeout(timer); unwatch(); controller.abort(); } };
    this.pending = reservation;
    controller.signal.addEventListener('abort', () => this.finish(reservation), { once: true });
  }
  cancel(context: Pick<VideoClipboardContext, 'sender' | 'scope'>, id: unknown): void {
    const pending = this.pending;
    if (pending && pending.id === id && pending.context.sender === context.sender && pending.context.scope === context.scope) this.finish(pending);
  }
  invalidate(): void { this.finish(); }
  private finish(expected = this.pending): void {
    if (expected && this.pending === expected) { this.pending = undefined; expected.release(); }
  }
  private assert(pending: Reservation): void {
    pending.controller.signal.throwIfAborted();
    if (this.pending !== pending || !pending.context.valid()) throw new Error('视频复制窗口或账号已改变');
    if (this.native.revision() !== pending.revision) throw new Error('剪贴板已更新，请重新点击复制视频');
  }
  async copy(context: VideoClipboardContext, input: unknown): Promise<{ copied: true }> {
    const id = identity(input, context); const request = object(input);
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.context.sender !== context.sender || pending.context.scope !== context.scope || pending.copying) throw new Error('视频复制请求已失效');
    if (typeof request.fileRef !== 'string' || !FILE_REF.test(request.fileRef)) throw new Error('视频文件引用无效');
    if (request.mediaRef !== undefined && (typeof request.mediaRef !== 'string'
      || !((request.mediaRef.startsWith('arkme-media-v1.') && request.mediaRef.length <= 100)
        || (request.mediaRef.startsWith('team-app-media.') && request.mediaRef.length <= 16_384)))) throw new Error('视频媒体引用无效');
    pending.copying = true;
    // A new click cancels its predecessor. Serialize disk preparation so an aborted
    // stream releases its one temporary file before the next request creates one.
    const previous = this.preparing;
    const task = previous.catch(() => {}).then(() => this.prepare(pending, request.fileRef as string, request.mediaRef as string | undefined));
    this.preparing = task;
    try { await task; return { copied: true }; }
    finally { this.finish(pending); }
  }
  private async request(pending: Reservation, suffix: string, options: RequestInit = {}): Promise<Response> {
    this.assert(pending);
    const context = pending.context;
    const response = await this.fetch(`${context.origin}/arkme-self/api${suffix}`, {
      ...options, headers: { Origin: context.origin, Cookie: context.cookie, ...options.headers },
      redirect: 'error', signal: pending.controller.signal,
    });
    try { this.assert(pending); } catch (error) { await response.body?.cancel(); throw error; }
    if (!response.ok) { await response.body?.cancel(); throw new Error('视频暂不可访问，请重试'); }
    return response;
  }
  private async authorize(pending: Reservation, fileRef: string, mediaRef: string | undefined): Promise<void> {
    if (!mediaRef) return;
    const response = await this.request(pending, '', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'files.receive', params: { mediaRef, start: false } }) });
    const result = await response.json() as { ok?: boolean; value?: { state?: string; file?: { fileRef?: string } } };
    this.assert(pending);
    if (!result.ok || result.value?.state !== 'ready' || result.value.file?.fileRef !== fileRef) throw new Error('视频原件与当前消息不匹配');
    // Ordinary opaque references can also carry a revocable source admission.
    // The existing media owner, not the renderer or a cached file, authorizes it.
    const route = mediaRef.startsWith('team-app-media.') ? '/team/media' : '/media';
    await this.request(pending, `${route}?ref=${encodeURIComponent(mediaRef)}`, { method: 'HEAD', headers: { Range: 'bytes=0-0' } });
  }
  private async cleanup(root: string, keep: string[] = []): Promise<void> {
    const protectedFiles = new Set([...this.native.files(), ...keep]);
    for (const name of await readdir(root)) {
      if (!/^video-[a-zA-Z0-9]+$/.test(name)) continue;
      const directory = path.join(root, name);
      if ([...protectedFiles].some(file => path.dirname(file) === directory)) continue;
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async prepare(pending: Reservation, fileRef: string, mediaRef: string | undefined): Promise<void> {
    let created: string | undefined;
    const context = pending.context;
    try {
      this.assert(pending);
      const response = await this.request(pending, `/files/local?ref=${encodeURIComponent(fileRef)}`, { method: 'HEAD' });
      // Only the Host can establish that a file was picked locally. An omitted
      // renderer hint must never turn received/legacy Team bytes into local data.
      const local = response.headers.get('x-arkme-file-origin') === 'local';
      if (!local && !mediaRef) throw new Error('视频来源需要重新确认，请从消息中重新打开');
      const size = Number(response.headers.get('content-length'));
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.toLowerCase();
      const disposition = response.headers.get('content-disposition') ?? '';
      const rawName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      let name = 'video.mp4';
      if (rawName) { try { name = decodeURIComponent(rawName); } catch { throw new Error('视频文件名无效'); } }
      // A generic MIME may accompany older uploaded videos. Never infer video from
      // a non-video MIME merely because the renderer requested this action.
      if (!(mime.startsWith('video/') || (mime === 'application/octet-stream' && /\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|ogv)$/i.test(name)))) throw new Error('仅支持复制视频');
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) throw new Error('视频大小无效或超过复制限制');
      name = path.basename(name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')).slice(-180);
      if (!name || name === '.' || name === '..') name = 'video.mp4';
      await mkdir(context.directory, { recursive: true, mode: 0o700 });
      await this.cleanup(context.directory);
      this.assert(pending);
      const key = `${context.scope}:${fileRef}`;
      const cached = this.stage?.key === key && this.stage.size === size ? this.stage : undefined;
      const info = cached ? await lstat(cached.file).catch(() => undefined) : undefined;
      let stage: Stage;
      if (cached && info?.isFile() && info.size === size) stage = cached;
      else {
        created = await mkdtemp(path.join(context.directory, 'video-'));
        const file = path.join(created, name);
        const bytes = await this.request(pending, `/files/local?ref=${encodeURIComponent(fileRef)}`);
        if (!bytes.body) throw new Error('视频读取不完整');
        let received = 0;
        const limit = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
          try { this.assert(pending); received += chunk.length;
            if (received > size || received > MAX_BYTES) throw new Error('视频读取超出限制');
            callback(null, chunk);
          } catch (error) { callback(error as Error); }
        } });
        await pipeline(Readable.fromWeb(bytes.body as never), limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: pending.controller.signal });
        if (received !== size) throw new Error('视频读取不完整');
        stage = { key, file, directory: created, size };
      }
      // Received bytes are not a live grant: bind and authorize immediately before
      // native commit, including the warm path, using the existing Host owners.
      await this.authorize(pending, fileRef, local && !mediaRef?.startsWith('team-app-media.') ? undefined : mediaRef);
      this.assert(pending);
      this.native.write(stage.file, pending.revision, context.windowHandle);
      this.stage = stage; created = undefined;
      // Cleanup is after the atomic clipboard replacement. A failed copy always
      // leaves the previous referenced file intact, including across restarts.
      await this.cleanup(context.directory, [stage.file]).catch(() => {});
    } finally { if (created) await rm(created, { recursive: true, force: true }); }
  }
}
