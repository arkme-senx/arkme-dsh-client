import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { assertElectronInstallation, verifyElectronRuntime } from '../scripts/verify-electron-runtime.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

test('rejects a stale binary, dependency drift and an unverified ABI before building', () => {
  expect(() => assertElectronInstallation('43.2.0', '43.2.0', { electronVersion: '43.0.0', modulesAbi: 148 })).toThrow('version mismatch');
  expect(() => assertElectronInstallation('43.2.0', '43.0.0', { electronVersion: '43.0.0', modulesAbi: 148 })).toThrow('version mismatch');
  expect(() => assertElectronInstallation('43.2.0', '43.2.0', { electronVersion: '43.2.0', modulesAbi: 149 })).toThrow('ABI');
  expect(() => assertElectronInstallation('44.0.0', '44.0.0', { electronVersion: '44.0.0', modulesAbi: 148 })).toThrow('expected 43.2.0');
});

test('the installed executable matches the pinned Electron runtime', async () => {
  await expect(verifyElectronRuntime()).resolves.toEqual({ electronVersion: '43.2.0', modulesAbi: '148' });
});

test('the development adapter reaches real Electron main and ESM Workers that clear inherited arguments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkme builtin with spaces '));
  try {
    const preload = path.join(root, 'guard.mjs');
    const source = await readFile(new URL('../src/harness-process-lifetime.ts', import.meta.url), 'utf8');
    await writeFile(preload, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
    const entry = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
    const worker = `import {createRequire} from 'node:module';import {parentPort} from 'node:worker_threads';
      const addon=createRequire(process.env.DSH_INSTALLED_MODULE_BASE_PATH)('node-addon-require-builtin');
      parentPort.postMessage(typeof addon.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader);`;
    const program = `const {createRequire}=require('node:module');const {Worker}=require('node:worker_threads');
      const addon=createRequire(process.env.DSH_INSTALLED_MODULE_BASE_PATH)('node-addon-require-builtin');
      console.log('main:'+typeof addon.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader);
      const worker=new Worker(new URL(${JSON.stringify('data:text/javascript,' + encodeURIComponent(worker))}),{execArgv:[]});
      worker.on('message', result=>console.log('worker:'+result));worker.on('error',error=>{console.error(error);process.exitCode=1});`;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_INSTALLED_MODULE_BASE_PATH: entry,
      ARKME_DEVELOPMENT_HOST: '1', ARKME_HOST_POLICY: JSON.stringify({ schemaVersion: 1, distribution: 'website' }) };
    delete env.NODE_OPTIONS;
    delete env.ARKME_PROCESS_GUARD_GENERATION;
    const { stdout } = await execute(require('electron'), ['--expose-internals', '--import', pathToFileURL(preload).href, '--eval', program], { env, timeout: 4000 });
    expect(stdout).toContain('main:function');
    expect(stdout).toContain('worker:function');
    // Packaged website launches keep their existing prepared-runtime adapter.
    const inert = await execute(require('electron'), ['--expose-internals', '--import', pathToFileURL(preload).href, '--eval', "console.log(require('node:worker_threads').Worker.name)"], { env: { ...env, ARKME_DEVELOPMENT_HOST: '' }, timeout: 4000 });
    expect(inert.stdout.trim()).toBe('Worker');
  } finally { await rm(root, { recursive: true, force: true }); }
});
