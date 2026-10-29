import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertElectronHarnessRuntime } from './runtime/electron-harness-lib.mjs';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export function assertElectronInstallation(expected, installed, runtime) {
  if (expected !== installed || installed !== runtime.electronVersion) {
    throw new Error(`Electron version mismatch: package.json=${expected}, installed=${installed}, binary=${runtime.electronVersion}. Run pnpm install --frozen-lockfile; do not independently upgrade/downgrade Electron or override its binary.`);
  }
  // Updating the dependency pin alone must not bypass the verified runtime contract.
  assertElectronHarnessRuntime(runtime);
}

export async function verifyElectronRuntime({ harness = false } = {}) {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const installed = require('electron/package.json').version;
  const executable = require('electron');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  delete env.ARKME_PROCESS_GUARD_GENERATION;
  const options = { cwd: projectRoot, env, timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true };
  const { stdout } = await execute(executable, ['--print', 'JSON.stringify({electronVersion:process.versions.electron,modulesAbi:process.versions.modules})'], options);
  const runtime = JSON.parse(stdout.trim());
  assertElectronInstallation(manifest.devDependencies.electron, installed, runtime);
  if (harness) {
    const entry = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
    const preload = pathToFileURL(path.join(projectRoot, 'dist/harness-process-lifetime.js')).href;
    const probe = `const {createRequire}=require('node:module');
      const loader=createRequire(process.env.DSH_INSTALLED_MODULE_BASE_PATH)('node-addon-require-builtin').requireBuiltin('internal/modules/esm/loader');
      if(typeof loader.getOrInitializeCascadedLoader!=='function')throw Error('Unsupported module loader');`;
    const workerProbe = probe.replace("const {createRequire}=require('node:module');", "import {createRequire} from 'node:module';");
    const code = `${probe}
      const {Worker}=require('node:worker_threads');
      const worker=new Worker(new URL(${JSON.stringify('data:text/javascript,' + encodeURIComponent(workerProbe))}), {execArgv:[]});
      worker.on('error', error=>{console.error(error);process.exitCode=1});
      worker.on('exit', code=>{if(code!==0)process.exitCode=1;else console.log('Harness main/Worker builtin access verified')});`;
    try {
      await execute(executable, ['--expose-internals', '--import', preload, '--eval', code], {
        ...options,
        env: { ...env, DSH_INSTALLED_MODULE_BASE_PATH: entry, ARKME_DEVELOPMENT_HOST: '1', ARKME_HOST_POLICY: JSON.stringify({ schemaVersion: 1, distribution: 'website' }) },
      });
    } catch (cause) {
      throw new Error('Electron/Harness compatibility check failed. Rebuild the client and verify the pinned runtime together; changing Electron alone is not a fix.', { cause });
    }
  }
  return runtime;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = await verifyElectronRuntime({ harness: process.argv.includes('--harness') });
  console.log(`Verified Electron ${runtime.electronVersion} / ABI ${runtime.modulesAbi}${process.argv.includes('--harness') ? ' with Harness main/Worker compatibility' : ''}`);
}
