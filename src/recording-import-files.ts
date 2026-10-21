import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

interface Grant { token: string; path: string; name: string; size: number; lastModified: number; dev: number; ino: number; bookmark?: string }
interface QueueRow { id: string; accountKey: string; source: { kind: 'desktop'; token: string }; [key: string]: unknown }
interface Journal { version: 1; grants: Record<string, Grant>; rows: Record<string, QueueRow> }
export interface RecordingFilesContext { directory: string; origin: string; cookie: string; valid(): boolean }

/** Only native picker/preload-created grants reach this service; renderer paths are never accepted. */
export class DesktopRecordingFiles {
  private tail: Promise<unknown> = Promise.resolve();
  private uploads = new Map<string, { context: RecordingFilesContext; controller: AbortController }>();
  constructor(private readonly accessBookmark: (bookmark: string) => () => void = () => () => {}) {}

  private async transaction<T>(context: RecordingFilesContext, write: boolean, work: (state: Journal) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (!context.valid()) throw new Error('录音导入账号已切换');
      const file = path.join(context.directory, 'recording-import-queue.json');
      let state: Journal;
      try { state = JSON.parse(await readFile(file, 'utf8')) as Journal; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        state = { version: 1, grants: {}, rows: {} };
      }
      if (state.version !== 1 || !state.grants || !state.rows) throw new Error('导入队列文件无效，已保留原文件');
      const result = await work(state);
      if (!context.valid()) throw new Error('录音导入账号已切换');
      if (write) {
        await mkdir(context.directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
      }
      return result;
    });
    this.tail = run.catch(() => undefined);
    return await run;
  }

  async capture(context: RecordingFilesContext, paths: string[], bookmarks: string[] = []) {
    if (paths.length > 10000) throw new Error('单次选择文件过多');
    const grants: Grant[] = [];
    for (const [index, file] of paths.entries()) {
      if (!path.isAbsolute(file) || !/\.(wav|mp3|m4a)$/i.test(file)) throw new Error('请选择录音文件');
      const bookmark = bookmarks[index];
      const stop = bookmark ? this.accessBookmark(bookmark) : () => {};
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 ** 3) throw new Error('录音文件大小无效');
        grants.push({ token: randomUUID(), path: file, name: path.basename(file), size: stat.size,
          lastModified: Math.trunc(stat.mtimeMs), dev: stat.dev, ino: stat.ino, ...(bookmark ? { bookmark } : {}) });
      } finally { stop(); }
    }
    await this.transaction(context, true, state => { for (const grant of grants) state.grants[grant.token] = grant; });
    return grants.map(({ token, name, size, lastModified }) => ({ token, name, size, lastModified }));
  }

  async list(context: RecordingFilesContext, accountKey: string) {
    return await this.transaction(context, false, state => Object.values(state.rows).filter(row => row.accountKey === accountKey));
  }

  async change(context: RecordingFilesContext, accountKey: string, upserts: QueueRow[], removals: string[]) {
    if (!/^(prod|test):\d+$/.test(accountKey) || !Array.isArray(upserts) || !Array.isArray(removals)
      || JSON.stringify(upserts).length > 10_000_000) throw new Error('导入队列参数无效');
    await this.transaction(context, true, state => {
      for (const row of upserts) {
        if (typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(row.id) || row.accountKey !== accountKey
          || row.source?.kind !== 'desktop' || !state.grants[row.source.token]) throw new Error('录音文件授权无效');
        state.rows[row.id] = row;
      }
      for (const id of removals) if (state.rows[id]?.accountKey === accountKey) {
        const token = state.rows[id]!.source.token;
        delete state.rows[id];
        if (!Object.values(state.rows).some(row => row.source.token === token)) delete state.grants[token];
      }
    });
  }

  private async file<T>(context: RecordingFilesContext, token: string, work: (grant: Grant, handle: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
    const grant = await this.transaction(context, false, state => state.grants[token]);
    if (!grant) throw new Error('文件授权不存在，请恢复文件访问');
    const stop = grant.bookmark ? this.accessBookmark(grant.bookmark) : () => {};
    try {
      const handle = await open(grant.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const check = async () => {
          const stat = await handle.stat();
          if (!context.valid()) throw new Error('录音导入账号已切换');
          if (!stat.isFile() || stat.dev !== grant.dev || stat.ino !== grant.ino || stat.size !== grant.size
            || Math.trunc(stat.mtimeMs) !== grant.lastModified) throw new Error('原文件已改变，请移除此项后重新选择');
        };
        await check();
        const result = await work(grant, handle);
        await check();
        return result;
      } finally { await handle.close(); }
    } finally { stop(); }
  }

  async stat(context: RecordingFilesContext, token: string) {
    return await this.file(context, token, async ({ name, size, lastModified }) => ({ name, size, lastModified }));
  }

  async read(context: RecordingFilesContext, token: string, start: number, end: number) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 1024 * 1024) throw new Error('录音读取范围无效');
    return await this.file(context, token, async (grant, handle) => {
      if (end > grant.size) throw new Error('录音读取越界');
      const bytes = new Uint8Array(end - start);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) throw new Error('录音读取不完整');
        offset += bytesRead;
      }
      return bytes;
    });
  }

  async upload(context: RecordingFilesContext, token: string, request: { id: string; path: string; headers: Record<string, string> }) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(request.id) || this.uploads.has(request.id)
      || !/^\/[a-zA-Z0-9_/-]+\/api\/recording\/import$/.test(request.path)) throw new Error('录音导入请求无效');
    const headers: Record<string, string> = { Origin: context.origin, Cookie: context.cookie };
    const allowed = new Set(['content-type', 'x-arkme-file-name', 'x-arkme-start-at', 'x-arkme-belong-user', 'x-arkme-recording-kind', 'x-arkme-import-batch', 'x-arkme-import-task']);
    for (const [key, value] of Object.entries(request.headers)) {
      if (!allowed.has(key.toLowerCase()) || typeof value !== 'string' || value.length > 2048) throw new Error('录音请求参数无效');
      headers[key] = value;
    }
    const controller = new AbortController();
    this.uploads.set(request.id, { context, controller });
    try {
      return await this.file(context, token, async (grant, handle) => {
        headers['Content-Length'] = String(grant.size);
        const body = Readable.from((async function* () {
          let position = 0;
          while (position < grant.size) {
            controller.signal.throwIfAborted();
            if (!context.valid()) throw new Error('录音导入账号已切换');
            const bytes = Buffer.alloc(Math.min(1024 * 1024, grant.size - position));
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
            if (!bytesRead) throw new Error('录音读取不完整');
            position += bytesRead;
            yield bytes.subarray(0, bytesRead);
          }
        })());
        const response = await fetch(new URL(request.path, context.origin), {
          method: 'POST', headers, body: Readable.toWeb(body) as ReadableStream<Uint8Array>, duplex: 'half',
          signal: controller.signal, redirect: 'error'
        } as RequestInit);
        const result = await response.json() as { ok: boolean; value?: unknown; error?: { message?: string } };
        if (!response.ok || !result.ok) throw new Error(result.error?.message ?? '录音导入失败');
        return result.value;
      });
    } finally { this.uploads.delete(request.id); }
  }

  cancel(context: RecordingFilesContext, id: string) {
    const running = this.uploads.get(id);
    if (running?.context.directory === context.directory) running.controller.abort();
  }
}
