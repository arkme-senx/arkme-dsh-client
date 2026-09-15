import * as fs from 'node:fs';
import vm from 'node:vm';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { patchDshProfileBundleResolution } from '../scripts/patch-dsh-profile-bundle-resolution.mjs';

describe('published dsh-app-boot 0.1.5-rc.2', () => {
  test('patches the real published source, preserves canonical link comparison, and is idempotent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkme-app-boot-rc2-'));
    try {
      await cp(new URL('./fixtures/dsh-app-boot-0.1.5-rc.2', import.meta.url), root, { recursive: true });
      await patchDshProfileBundleResolution(root);
      const patched = await readFile(path.join(root, 'lib/index.js'), 'utf8');
      expect(patched).toContain('if (symlinkPointsTo(link, target) && existsSync(join(link, "package.json"))) return;');
      expect(patched).toContain('canonicalLinkPath(resolve(dirname(link), readlinkSync(link)))');
      expect(patched).toContain('const installedModuleDir = installedModuleBasePath');
      expect(patched).toContain('const anchors = profileFirstBundles.has(packageName)');
      const functionSource = patched.slice(patched.indexOf('function ensureSymlink('), patched.indexOf('/** Add one profile-owned fallback link'));
      let unlinkCalls = 0;
      const context = vm.createContext({ ...fs, ...path, unlinkSync: (link: string) => { unlinkCalls++; fs.unlinkSync(link); } });
      vm.runInContext(functionSource, context);
      const target = path.join(root, 'package');
      const link = path.join(root, 'fallback');
      fs.mkdirSync(target);
      fs.symlinkSync('package', link);
      // rc2 canonical equality accepts relative links. A package-less target
      // must still be repaired; a live relative link must remain untouched.
      vm.runInContext(`ensureSymlink(${JSON.stringify(link)}, ${JSON.stringify(target)})`, context);
      expect(unlinkCalls).toBe(1);
      fs.writeFileSync(path.join(target, 'package.json'), '{}');
      fs.unlinkSync(link);
      fs.symlinkSync('package', link);
      vm.runInContext(`ensureSymlink(${JSON.stringify(link)}, ${JSON.stringify(target)})`, context);
      expect(unlinkCalls).toBe(1);

      await patchDshProfileBundleResolution(root);
      expect(await readFile(path.join(root, 'lib/index.js'), 'utf8')).toBe(patched);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
