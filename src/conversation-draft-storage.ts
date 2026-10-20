import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationEvent } from './conversation-windows.js';

export type ConversationSnapshot = Extract<ConversationEvent, {kind: 'draft' | 'article'}>;
export interface ConversationDraftPersistence {
  load(): Promise<ConversationSnapshot[]>;
  save(event: ConversationSnapshot): Promise<void>;
  flush(): Promise<void>;
}
const MAX_ENTRIES = 1000, MAX_BYTES = 32 * 1024 * 1024, MAX_EVENT_BYTES = 2 * 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Opaque window state, scoped by the native-selected Profile and account. No message semantics live here. */
export class ConversationDraftStorage implements ConversationDraftPersistence {
  private readonly directory: string;
  private sizes = new Map<string, number>();
  private total = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(root: string, account: string) { this.directory = path.join(root, digest(account)); }

  async load(): Promise<ConversationSnapshot[]> {
    await this.flush();
    const events: ConversationSnapshot[] = [];
    let directory;
    try { directory = await opendir(this.directory); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    this.sizes.clear(); this.total = 0;
    for await (const entry of directory) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      if (this.sizes.size >= MAX_ENTRIES) throw new Error('本地草稿数量超过保存上限');
      // Limit reads as well as writes. Corrupt state must never become an empty snapshot that overwrites it.
      const file = await open(path.join(this.directory, entry.name), 'r');
      let raw: string;
      try {
        const { size } = await file.stat();
        if (size > MAX_EVENT_BYTES || this.total + size > MAX_BYTES) throw new Error('本地草稿大小超过保存上限');
        raw = await file.readFile('utf8');
      } finally { await file.close(); }
      const envelope = JSON.parse(raw);
      const event = envelope?.event as ConversationSnapshot;
      if (envelope?.version !== 1 || !validSnapshot(event) || `${digest(event.key)}.json` !== entry.name) throw new Error('本地草稿数据无效，原文件已保留');
      const bytes = Buffer.byteLength(raw);
      this.sizes.set(entry.name, bytes); this.total += bytes; events.push(event);
    }
    return events;
  }

  save(event: ConversationSnapshot): Promise<void> {
    if (!validSnapshot(event)) return Promise.reject(new Error('草稿数据无效'));
    if (this.pending >= 64) return Promise.reject(new Error('草稿保存繁忙，请稍后重试'));
    const raw = JSON.stringify({version: 1, event});
    const bytes = Buffer.byteLength(raw), name = `${digest(event.key)}.json`;
    if (bytes > MAX_EVENT_BYTES) return Promise.reject(new Error('草稿大小超过保存上限'));
    this.pending++;
    const mutation = this.tail.then(async () => {
      const previous = this.sizes.get(name) ?? 0;
      if ((!this.sizes.has(name) && this.sizes.size >= MAX_ENTRIES) || this.total - previous + bytes > MAX_BYTES) throw new Error('本地草稿空间不足，现有草稿已保留');
      await mkdir(this.directory, {recursive: true, mode: 0o700});
      const temporary = path.join(this.directory, `${name}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, raw, {encoding: 'utf8', mode: 0o600});
        await rename(temporary, path.join(this.directory, name));
        this.sizes.set(name, bytes); this.total += bytes - previous;
      } finally { await rm(temporary, {force: true}); }
    });
    this.tail = mutation.catch(() => undefined).finally(() => { this.pending--; });
    return mutation;
  }
  async flush(): Promise<void> { await this.tail; }
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function validSnapshot(event: ConversationSnapshot): boolean {
  return !!event && (event.kind === 'draft' || event.kind === 'article') && typeof event.key === 'string'
    && event.key.length > 0 && event.key.length < 16384 && event.value !== undefined;
}
