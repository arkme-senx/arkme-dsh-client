import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, test } from 'vitest';

const script = path.resolve('scripts/build-macos-artifacts.mjs');
test.skipIf(process.platform !== 'darwin')('an initial compile failure invalidates old release evidence and releases the build lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jiwo-build-failure-'));
  try {
    await mkdir(path.join(root, 'release'));
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin/pnpm'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    await writeFile(path.join(root, 'package.json'), '{}');
    const report = path.join(root, 'release/jiwo-release-verification.json');
    await writeFile(report, '{"status":"verified"}');
    const result = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, PATH: `${path.join(root, 'bin')}:/usr/bin:/bin` }, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    await expect(readFile(report)).rejects.toThrow(/ENOENT/);
    // The failed owner must release its lock so a normal retry can start.
    await mkdir(path.join(root, 'release/.jiwo-release-build.lock'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'darwin').each(['scripts/build-macos-artifacts.mjs', 'scripts/build-macos-migration.mjs'])('a second release invocation %s cannot invalidate or overwrite an active build', async entrypoint => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jiwo-build-lock-'));
  try {
    await mkdir(path.join(root, 'release/.jiwo-release-build.lock'), { recursive: true });
    const report = path.join(root, 'release/jiwo-release-verification.json');
    await writeFile(report, 'active owner evidence');
    const result = spawnSync(process.execPath, [path.resolve(entrypoint)], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Another macOS release build');
    expect(await readFile(report, 'utf8')).toBe('active owner evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});
