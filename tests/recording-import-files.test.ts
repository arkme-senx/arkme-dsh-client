import { mkdtemp, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopRecordingFiles, type RecordingFilesContext } from '../src/recording-import-files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arkme-import-grants-')); roots.push(directory);
  const file = path.join(directory, 'recording.wav'); await writeFile(file, 'sample audio');
  const context: RecordingFilesContext = { directory, origin: 'http://127.0.0.1:3102', cookie: '', valid: () => true };
  return { directory, file, context, service: new DesktopRecordingFiles() };
}

describe('durable native recording file grants', () => {
  it('streams a granted file only to the authenticated local import route', async () => {
    const { file, context, service } = await fixture();
    const [grant] = await service.capture(context, [file]);
    let received = ''; let cookie = ''; let origin = '';
    const server = createServer(async (req, res) => {
      cookie = req.headers.cookie ?? ''; origin = req.headers.origin ?? '';
      for await (const bytes of req) received += bytes.toString();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, value: { importRef: 'receipt' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
      const local = { ...context, origin: `http://127.0.0.1:${address.port}`, cookie: 'local-only-fixture' };
      await expect(service.upload(local, grant!.token, { id: 'one', path: '/arkme-self/api/recording/import', headers: { 'Content-Type': 'audio/wav' } })).resolves.toEqual({ importRef: 'receipt' });
      expect(received).toBe('sample audio'); expect(cookie).toBe(local.cookie); expect(origin).toBe(local.origin);
      await expect(service.upload(local, grant!.token, { id: 'two', path: 'https://example.com/import', headers: {} })).rejects.toThrow('无效');
      await expect(service.upload(local, grant!.token, { id: 'three', path: '/arkme-self/api/recording/import', headers: { Cookie: 'override' } })).rejects.toThrow('无效');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('restores queued and unsubmitted files after a new process and origin', async () => {
    const { file, context, service } = await fixture();
    const [grant] = await service.capture(context, [file]);
    const row = { id: 'queue-1', accountKey: 'prod:42', source: { kind: 'desktop' as const, token: grant!.token }, submission: 'batch' };
    await service.change(context, 'prod:42', [row], []);
    const restored = new DesktopRecordingFiles();
    const nextContext = { ...context, origin: 'http://127.0.0.1:59999' };
    expect(await restored.list(nextContext, 'prod:42')).toEqual([row]);
    expect(await restored.list(nextContext, 'prod:43')).toEqual([]);
    expect(new TextDecoder().decode(await restored.read(nextContext, grant!.token, 0, 6))).toBe('sample');
    expect(JSON.stringify(grant)).not.toContain(file);
  });
  it('keeps another account and removes only the selected queue item', async () => {
    const { file, context, service } = await fixture();
    const [grant] = await service.capture(context, [file]);
    const source = { kind: 'desktop' as const, token: grant!.token };
    await service.change(context, 'prod:42', [{ id: 'one', accountKey: 'prod:42', source }], []);
    await service.change(context, 'prod:43', [{ id: 'two', accountKey: 'prod:43', source }], ['one']);
    expect(await service.list(context, 'prod:42')).toHaveLength(1);
    await service.change(context, 'prod:42', [], ['one']);
    expect(await service.list(context, 'prod:43')).toHaveLength(1);
    expect(await service.stat(context, grant!.token)).toMatchObject({ name: 'recording.wav' });
  });
  it('rejects replaced files, symlinks and missing sources without deleting the queue', async () => {
    const { file, context, service } = await fixture();
    const [grant] = await service.capture(context, [file]);
    await service.change(context, 'prod:42', [{ id: 'one', accountKey: 'prod:42', source: { kind: 'desktop', token: grant!.token } }], []);
    await rename(file, `${file}.old`); await writeFile(file, 'sample audio');
    await expect(service.stat(context, grant!.token)).rejects.toThrow('改变');
    await rm(file); await symlink(`${file}.old`, file);
    await expect(service.read(context, grant!.token, 0, 2)).rejects.toThrow();
    await rm(file);
    await expect(service.stat(context, grant!.token)).rejects.toThrow();
    expect(await service.list(context, 'prod:42')).toHaveLength(1);
  });
  it('rejects revoked account scope and forged grants', async () => {
    const { context, service } = await fixture();
    await expect(service.list({ ...context, valid: () => false }, 'prod:42')).rejects.toThrow('切换');
    await expect(service.change(context, 'prod:42', [{ id: 'one', accountKey: 'prod:42', source: { kind: 'desktop', token: 'forged' } }], [])).rejects.toThrow('授权');
  });
  it('retains and surfaces an unreadable/corrupt journal instead of resetting it', async () => {
    const { context, service, directory } = await fixture();
    const journal = path.join(directory, 'recording-import-queue.json');
    await writeFile(journal, 'broken');
    await expect(service.list(context, 'prod:42')).rejects.toThrow();
    expect(await readFile(journal, 'utf8')).toBe('broken');
  });
  it('restores security scoped access for every reopened file and releases it', async () => {
    const { file, context } = await fixture();
    let started = 0; let stopped = 0;
    const service = new DesktopRecordingFiles(bookmark => { expect(bookmark).toBe('bookmark'); started++; return () => { stopped++; }; });
    const [grant] = await service.capture(context, [file], ['bookmark']);
    await service.stat(context, grant!.token); await service.read(context, grant!.token, 0, 3);
    expect(started).toBe(3); expect(stopped).toBe(started);
  });
});
