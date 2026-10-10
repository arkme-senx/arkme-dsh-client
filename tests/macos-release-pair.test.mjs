import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { verifyMacReleasePair, verifyPairedMacUpdateMetadata } from '../scripts/macos-release-pair.mjs';

test('update metadata references exactly the verified paired ZIP', () => {
  const zip = { kind: 'zip', filename: '即我-3.0.0-vc277-universal.zip', size: 123, sha512: 'ab'.repeat(64) };
  const report = { version: '3.0.0', artifacts: [zip] };
  const metadata = { version: report.version, path: zip.filename, files: [{ url: zip.filename, size: zip.size, sha512: Buffer.from(zip.sha512, 'hex').toString('base64') }] };
  expect(() => verifyPairedMacUpdateMetadata(metadata, report)).not.toThrow();
  for (const invalid of [
    { ...metadata, files: [{ ...metadata.files[0], url: 'unrelated-vc277.zip' }] },
    { ...metadata, files: [...metadata.files, { ...metadata.files[0], url: 'installer.pkg' }] },
    { ...metadata, path: 'old.zip' },
    { ...metadata, files: [{ ...metadata.files[0], sha512: Buffer.alloc(64).toString('base64') }] },
    { ...metadata, files: [{ ...metadata.files[0], size: 124 }] },
  ]) expect(() => verifyPairedMacUpdateMetadata(invalid, report)).toThrow();
});

const roots = [];
const version = '3.0.0', versionCode = 275;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jiwo-release-pair-')); roots.push(root);
  const appRoot = path.join(root, 'source', '即我.app');
  await mkdir(path.join(appRoot, 'Contents/MacOS'), { recursive: true });
  await writeFile(path.join(appRoot, 'Contents/MacOS/arkme'), 'program');
  await chmod(path.join(appRoot, 'Contents/MacOS/arkme'), 0o755);
  await symlink('MacOS/arkme', path.join(appRoot, 'Contents/program-link'));
  await writeFile(path.join(appRoot, 'Contents/Info.plist'), JSON.stringify({
    CFBundleIdentifier: 'cc.jiwo.arkme', CFBundleExecutable: 'arkme',
    CFBundleShortVersionString: version, CFBundleVersion: String(versionCode),
  }));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', path.join(appRoot, 'Contents/Info.plist')]);
  const releaseDirectory = path.join(root, 'release'); await mkdir(releaseDirectory);
  const basename = `即我-${version}-vc${versionCode}-universal`;
  const zip = path.join(releaseDirectory, `${basename}.zip`), pkg = path.join(releaseDirectory, `${basename}.pkg`);
  const payload = path.join(root, 'payload'); await mkdir(path.join(payload, 'payload'), { recursive: true });
  execFileSync('/usr/bin/ditto', [appRoot, path.join(payload, 'payload/即我.app')]);
  execFileSync('/usr/bin/pkgbuild', ['--root', payload, '--identifier', 'cc.jiwo.arkme.installer', '--version', version,
    '--install-location', '/Library/Application Support/cc.jiwo.installer', pkg], { stdio: 'pipe' });
  const zipApp = async () => { await rm(zip, { force: true }); execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appRoot, zip]); };
  await zipApp();
  return { appRoot, releaseDirectory, version, versionCode, zip, pkg, zipApp };
}

test.skipIf(process.platform !== 'darwin')('real ZIP and PKG contain the same application, including executable modes and links', async () => {
  const input = await fixture();
  const report = await verifyMacReleasePair(input);
  expect(report).toMatchObject({ appId: 'cc.jiwo.arkme', version, versionCode });
  expect(report.artifacts.map(x => x.kind).sort()).toEqual(['pkg', 'zip']);
  for (const artifact of report.artifacts) {
    expect(artifact.size).toBe((await readFile(path.join(input.releaseDirectory, artifact.filename))).length);
    expect(artifact.sha512).toMatch(/^[a-f0-9]{128}$/);
  }
});

test.skipIf(process.platform !== 'darwin')('a missing PKG cannot be delivered as a ZIP-only release', async () => {
  const input = await fixture(); await rm(input.pkg);
  await expect(verifyMacReleasePair(input)).rejects.toThrow();
});

test.skipIf(process.platform !== 'darwin')('a stale PKG with different program bytes is rejected', async () => {
  const input = await fixture(); await writeFile(path.join(input.appRoot, 'Contents/MacOS/arkme'), 'different'); await input.zipApp();
  await expect(verifyMacReleasePair(input)).rejects.toThrow(/differ|match/);
});

test.skipIf(process.platform !== 'darwin')('changed executable permissions are rejected even when file bytes are identical', async () => {
  const input = await fixture(); await chmod(path.join(input.appRoot, 'Contents/MacOS/arkme'), 0o644); await input.zipApp();
  await expect(verifyMacReleasePair(input)).rejects.toThrow(/differ|match/);
});

test.skipIf(process.platform !== 'darwin')('a release label cannot hide another app build version', async () => {
  const input = await fixture();
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', '999', path.join(input.appRoot, 'Contents/Info.plist')]);
  await expect(verifyMacReleasePair(input)).rejects.toThrow(/identity|version/);
});
