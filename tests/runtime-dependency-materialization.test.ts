import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

// Build scripts are plain ESM and exercised against an on-disk pnpm graph.
import { materializeRuntimeNodeModules } from '../scripts/materialize-runtime-node-modules.mjs';

test('preserves conflicting transitive versions and the direct root selection without pnpm links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkme-materialize-'));
  const modules = path.join(root, 'node_modules');
  const store = path.join(modules, '.pnpm');
  async function pkg(slot: string, name: string, version: string, dependencies: Record<string, string>, program: string) {
    const directory = path.join(store, slot, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, dependencies, main: 'index.cjs' }));
    await writeFile(path.join(directory, 'index.cjs'), program);
    return directory;
  }
  try {
    const oldParser = await pkg('parser@1', 'parser', '1.0.0', {}, 'module.exports = "parser-v1"');
    const newParser = await pkg('parser@2', 'parser', '2.0.0', {}, 'module.exports = "parser-v2"');
    const oldConsumer = await pkg('legacy@1', 'legacy', '1.0.0', { parser: '1.0.0' }, 'module.exports = require("parser")');
    const newConsumer = await pkg('modern@1', 'modern', '1.0.0', { parser: '2.0.0' }, 'module.exports = require("parser")');
    await symlink(oldParser, path.join(path.dirname(oldConsumer), 'parser'), 'dir');
    await symlink(newParser, path.join(path.dirname(newConsumer), 'parser'), 'dir');
    await symlink(oldParser, path.join(modules, 'parser'), 'dir');
    await symlink(oldConsumer, path.join(modules, 'legacy'), 'dir');
    await symlink(newConsumer, path.join(modules, 'modern'), 'dir');
    await materializeRuntimeNodeModules(root);
    const require = createRequire(path.join(root, 'probe.cjs'));
    expect(require('legacy')).toBe('parser-v1');
    expect(require('modern')).toBe('parser-v2');
    expect(require('parser')).toBe('parser-v1');
    expect(JSON.parse(await readFile(path.join(modules, 'modern/node_modules/parser/package.json'), 'utf8')).version).toBe('2.0.0');
    await expect(readFile(path.join(store, 'lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
