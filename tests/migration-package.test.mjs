import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { assertMigrationRelease, migrationDistribution, stageMigrationPayload, publishVerifiedPackage } from '../scripts/build-macos-migration.mjs';

const manifest = { version: '3.0.0', versionCode: 275, build: { appId: 'cc.jiwo.arkme', productName: '即我', mac: { minimumSystemVersion: '12.0' } } };
const info = { CFBundleIdentifier: 'cc.jiwo.arkme', CFBundleName: '即我', CFBundleExecutable: 'arkme', CFBundleShortVersionString: '3.0.0', CFBundleVersion: '275', LSMinimumSystemVersion: '12.0' };
const signature = 'Authority=Developer ID Application: Publisher (T6NSNA8LDZ)\nTeamIdentifier=T6NSNA8LDZ\n';

test('only the matching signed production application may enter a migration package', () => {
  expect(assertMigrationRelease(manifest, info, signature)).toBe('T6NSNA8LDZ');
  for (const invalid of [
    { ...info, CFBundleIdentifier: 'cc.jiwo.arkme.test' },
    { ...info, CFBundleName: 'arkme' },
    { ...info, CFBundleVersion: '0.3.0' },
    { ...info, CFBundleShortVersionString: '3.1.0' },
    { ...info, CFBundleExecutable: 'other' },
    { ...info, LSMinimumSystemVersion: '13.0' },
  ]) expect(() => assertMigrationRelease(manifest, invalid, signature)).toThrow();
  expect(() => assertMigrationRelease(manifest, info, 'Signature=adhoc\nTeamIdentifier=not set')).toThrow();
  expect(() => assertMigrationRelease(manifest, info, 'Authority=Apple Development: Developer\nTeamIdentifier=T6NSNA8LDZ\n')).toThrow();
});

test('verified PKG publication can replace the same release on retry and preserves it on copy failure', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'jiwo-pkg-retry-'));
  try {
    const source = path.join(work, 'source.pkg');
    const destination = path.join(work, 'release.pkg');
    await writeFile(source, 'verified first build');
    await publishVerifiedPackage(source, destination);
    await writeFile(source, 'verified retry build');
    await publishVerifiedPackage(source, destination);
    expect(await readFile(destination, 'utf8')).toBe('verified retry build');
    await expect(publishVerifiedPackage(path.join(work, 'missing.pkg'), destination)).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('verified retry build');
  } finally { await rm(work, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'darwin')('real PKG payload never owns Library parent directories or user data', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'jiwo-pkg-bom-'));
  try {
    const app = path.join(work, 'fixture.app');
    await mkdir(app);
    await writeFile(path.join(app, 'program'), 'signed-app-fixture');
    const root = await stageMigrationPayload(app, work);
    const component = path.join(work, 'component.pkg');
    execFileSync('/usr/bin/pkgbuild', ['--root', root, '--install-location', '/Library/Application Support/cc.jiwo.installer', '--identifier', 'cc.jiwo.test', '--version', '1', '--ownership', 'recommended', component], { stdio: 'pipe' });
    const expanded = path.join(work, 'expanded');
    execFileSync('/usr/sbin/pkgutil', ['--expand', component, expanded]);
    const entries = execFileSync('/usr/bin/lsbom', ['-s', path.join(expanded, 'Bom')], { encoding: 'utf8' }).trim().split('\n');
    // pkgbuild may emit AppleDouble metadata for the payload directory.
    expect(entries.every(entry => entry === '.' || entry === './._payload' || entry === './payload' || entry.startsWith('./payload/'))).toBe(true);
    expect(entries).toContain('./payload/即我.app/program');
    expect(await readFile(path.join(root, 'payload/即我.app/program'), 'utf8')).toBe('signed-app-fixture');
  } finally { await rm(work, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'darwin')('distribution is valid XML and rejects injected component references', async () => {
  expect(() => migrationDistribution('../wrong.pkg', manifest)).toThrow();
  expect(() => migrationDistribution('x.pkg</pkg-ref>', manifest)).toThrow();
  const root = await mkdtemp(path.join(os.tmpdir(), 'jiwo-pkg-xml-'));
  try {
    const file = path.join(root, 'distribution.xml');
    await writeFile(file, migrationDistribution('migration-component.pkg', manifest));
    execFileSync('/usr/bin/xmllint', ['--noout', file]);
    const minimum = execFileSync('/usr/bin/xmllint', ['--xpath', 'string(/installer-gui-script/installation-check/@script)', file], { encoding: 'utf8' });
    expect(minimum.trim()).toBe('checkSystem()');
    const domains = execFileSync('/usr/bin/xmllint', ['--xpath', 'string(/installer-gui-script/domains/@enable_currentUserHome)', file], { encoding: 'utf8' });
    expect(domains.trim()).toBe('false');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer metadata follows the current release and validates the system version', () => {
  const release = { ...manifest, version: '3.8.1', build: { ...manifest.build, mac: { minimumSystemVersion: '13.0' } } };
  const xml = migrationDistribution('component.pkg', release);
  expect(xml).toContain('<title>即我</title>');
  expect(xml).toContain('cc.jiwo.arkme.installer');
  expect(xml).toContain('13.0');
  expect(xml).not.toContain('即我 3.0');
  expect(() => migrationDistribution('component.pkg', { ...release, build: { mac: { minimumSystemVersion: "13');evil()" } } })).toThrow();
});
