import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { assertRuntimePluginReady, stageLocalRuntimePlugin } from '../scripts/local-runtime-plugin.mjs';
import { validatePackagedPluginMetadata, writePluginProvenance } from '../scripts/production-plugin-source.mjs';

test('production readiness gate rejects published plugin without the ready capability', () => {
  expect(() => assertRuntimePluginReady({ name: '@senguoyun/dsh-arkme', version: '0.1.52' })).toThrow('desktopHarnessReady');
  expect(() => assertRuntimePluginReady({ arkme: { desktopHarnessReady: { version: 1 } } })).not.toThrow();
});

test('local candidate preserves real version and bytes, records content provenance, and cannot impersonate Git production', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkme-local-plugin-'));
  try {
    const localPluginDir = path.join(root, 'source');
    const pluginDir = path.join(root, 'staged');
    await mkdir(path.join(localPluginDir, 'lib'), { recursive: true });
    const manifest = { name: '@senguoyun/dsh-arkme', version: '0.1.52', files: ['lib'], arkme: { desktopHarnessReady: { version: 1 } } };
    await writeFile(path.join(localPluginDir, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(localPluginDir, 'lib/client.js'), 'window.arkmeDesktop?.notifyHarnessReady?.();');
    const source = await stageLocalRuntimePlugin({ localPluginDir, pluginDir });
    expect(source.packageVersion).toBe('0.1.52');
    expect(source.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path.join(pluginDir, 'lib/client.js'), 'utf8')).toBe('window.arkmeDesktop?.notifyHarnessReady?.();');
    await writePluginProvenance({ pluginDir, source, packageVersion: '0.1.52' });
    const provenance = JSON.parse(await readFile(path.join(pluginDir, 'PLUGIN_PROVENANCE.json'), 'utf8'));
    expect(provenance).toMatchObject({ source: 'local', releaseEligible: false, contentSha256: source.contentSha256 });
    expect(provenance.commit).toBeUndefined();
    expect(() => validatePackagedPluginMetadata({ manifest, provenance, expectedSource: source })).not.toThrow();
    expect(() => validatePackagedPluginMetadata({ manifest, provenance, expectedSource: { packageName: manifest.name, packageVersion: manifest.version, repository: 'repo', commit: 'abc', dependencySpec: 'git' } })).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
