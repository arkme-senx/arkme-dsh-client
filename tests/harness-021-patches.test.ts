import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { patchDshBundledPnpm } from '../scripts/patch-dsh-bundled-pnpm.mjs';
import { patchDshProfileBundleResolution } from '../scripts/patch-dsh-profile-bundle-resolution.mjs';

describe('official Harness 0.2.1-rc.2 build integration', () => {
  test('keeps compatibility preflight and native module resolution while patching profile priority', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arkme-021-profile-'));
    try {
      await cp(new URL('./fixtures/dsh-app-boot-0.2.1-rc.2', import.meta.url), root, { recursive: true });
      await patchDshProfileBundleResolution(root);
      const source = await readFile(path.join(root, 'lib/index.js'), 'utf8');
      expect(source).toContain('bareModuleBaseUrl, binName = "dsh")');
      expect(source).toContain('prepareProfilePatches(ctx, [...patches]');
      expect(source).toContain('function removeLinkProjections(dir)');
      expect(source).toContain('async function createRuntimeResolution(options)');
      expect(source).toContain('const installedModuleDir = installedModuleBasePath');
      const loader = { resolveSync() {}, getModuleJobForImport() {}, resolve() {} };
      const modules: Record<string, unknown> = {
        'internal/modules/esm/loader': { getOrInitializeCascadedLoader: () => loader },
        'internal/modules/cjs/loader': { Module: { _resolveFilename() {} } },
        'internal/modules/helpers': { getCjsConditions: () => [] },
        'internal/modules/esm/utils': { getDefaultConditions: () => [] },
        'internal/modules/esm/resolve': { defaultResolve() {} },
      };
      let addonCalls = 0;
      const context = vm.createContext({
        process: { versions: { electron: '43.2.0' }, execArgv: ['--expose-internals'] },
        createRequire: () => (name: string) => name === 'node-addon-require-builtin'
          ? { requireBuiltin: (key: string) => { addonCalls++; return modules[key]; } }
          : modules[name],
      });
      const start = source.indexOf('function internalModules() {');
      const end = source.indexOf('\n}', start) + 2;
      vm.runInContext(source.slice(start, end).replaceAll('import.meta.url', '"file:///fixture/index.js"'), context);
      expect(vm.runInContext('internalModules().esm', context)).toBe(loader);
      expect(addonCalls).toBe(0);
      vm.runInContext('process.execArgv = []', context);
      vm.runInContext('internalModules()', context);
      expect(addonCalls).toBe(5);
      await patchDshProfileBundleResolution(root);
      expect(await readFile(path.join(root, 'lib/index.js'), 'utf8')).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('passes bundled Electron/Node invocation through the official package-manager API', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arkme-021-pnpm-'));
    try {
      await cp(new URL('./fixtures/dsh-cli-0.2.1-rc.2', import.meta.url), root, { recursive: true });
      const file = await patchDshBundledPnpm(root);
      const source = await readFile(file, 'utf8');
      const received: Array<{ args: string[]; options: Record<string, unknown> }> = [];
      const context = vm.createContext({
        process: { execPath: '/Applications/即我.app/Electron', env: { ARKME_PNPM_CLI_PATH: '/runtime with spaces/pnpm.cjs' } },
        resolveProfileDir: () => '/temporary-profile',
        existsSync: () => false,
        join: path.join,
        INSTALL_ANCHOR: '/installed/package.json',
        runPluginCommand: async (_context: unknown, args: string[], options: Record<string, unknown>) => {
          received.push({ args, options });
          return { exitCode: 0 };
        },
      });
      const program = source.slice(source.indexOf('//#region'), source.indexOf('//#endregion'));
      vm.runInContext(program, context);
      const args = ['add', 'link:/folder with spaces/plugin', 'literal;&value'];
      context.input = args;
      // The CLI passes cwd in its public operation context.
      vm.runInContext('process.cwd = () => "/caller"', context);
      expect(await vm.runInContext('runPlugin("web", input)', context)).toBe(0);
      expect(received[0]?.args).toEqual(args);
      expect(received[0]?.options).toMatchObject({
        command: '/Applications/即我.app/Electron',
        args: ['/runtime with spaces/pnpm.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
      await vm.runInContext('runPlugin("web", input, { command: "explicit", args: ["kept"] })', context);
      expect(received[1]?.options).toMatchObject({ command: 'explicit', args: ['kept'] });
      await patchDshBundledPnpm(root);
      expect(await readFile(file, 'utf8')).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
