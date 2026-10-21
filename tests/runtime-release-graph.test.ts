import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { expect, test } from 'vitest';

test('runtime lock is a single published rc2 graph with no retired client runtime or host API proxy', async () => {
  const lock = parse(await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'));
  const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const runtime = JSON.parse(await readFile(new URL('../runtime/package.json', import.meta.url), 'utf8'));
  expect(runtime.dependencies['@deepseek-ai/dsh']).toBe('0.2.1-rc.2');
  expect(root.devDependencies['@deepseek-ai/dsh']).toBe('0.2.1-rc.2');
  const dshKeys = Object.keys(lock.packages).filter(name => /^@deepseek-ai\/dsh(?:-|@)/.test(name));
  expect(dshKeys.length).toBeGreaterThan(100);
  expect(dshKeys.every(name => name.endsWith('@0.2.1-rc.2'))).toBe(true);
  expect(dshKeys.some(name => name.startsWith('@deepseek-ai/dsh-client-runtime@') || name.startsWith('@deepseek-ai/dsh-host-apiproxy@'))).toBe(false);
  expect(Object.keys(root.dependencies).some(name => name.startsWith('@deepseek-ai/'))).toBe(false);
  expect(root.devDependencies.electron).toBe('43.2.0');
  expect(runtime.dependencies.pnpm).toBe('11.19.0');
  expect(lock.catalogs.production['@senguoyun/dsh-arkme']).toEqual({ specifier: 'git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#9497ad8f963ca18af9ce8a39664e8fe1faa20a0b', version: '3.0.18' });
});
