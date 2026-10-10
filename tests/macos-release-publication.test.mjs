import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { createMacReleasePublication, prepareMacReleasePublication } from '../scripts/prepare-macos-release.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const report = { status: 'verified', appId: 'cc.jiwo.arkme', version: '3.0.0', versionCode: 277,
  artifacts: ['pkg', 'zip'].map(kind => ({ kind, filename: `即我-3.0.0-vc277-universal.${kind}`, size: 123, sha512: 'ab'.repeat(64) })) };
const metadata = { version: '3.0.0', path: report.artifacts[1].filename, files: [{ url: report.artifacts[1].filename, size: 123, sha512: Buffer.from('ab'.repeat(64), 'hex').toString('base64') }] };
const input = { report, metadata, cdnBase: 'https://cdn.example/releases/', releaseNotes: '升级说明', buildCommit: 'a'.repeat(40), privateKey };

test('publication preserves artifact bytes, signs the existing backend manifest and isolates the ZIP feed', () => {
  const result = createMacReleasePublication(input);
  expect(result.request).toMatchObject({ component: 'app', channel: 'stable', platform: 'darwin', architecture: 'arm64', version_code: 277 });
  expect(result.request.download_url).toBe('https://cdn.example/releases/arkme-releases/app/3.0.0/darwin/arm64/cc.jiwo.arkme/installers/jiwo-3.0.0-vc277-universal.pkg');
  expect(result.request.update_feed_url).toBe('https://cdn.example/releases/arkme-releases/app/3.0.0/darwin/arm64/cc.jiwo.arkme/updates/');
  const { manifest_payload, manifest_signature } = result.request.app;
  expect(verify(null, Buffer.from(manifest_payload), publicKey, Buffer.from(manifest_signature, 'base64'))).toBe(true);
  const manifest = JSON.parse(manifest_payload);
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.artifacts.map(artifact => artifact.kind)).toEqual(['pkg', 'zip']);
  expect(manifest.artifacts[0].sha512).toBe(report.artifacts[0].sha512);
  expect(result.metadata.path).toBe('jiwo-3.0.0-vc277-universal.zip');
  expect(result.metadata.files).toEqual([{ ...metadata.files[0], url: result.metadata.path }]);
});

test('publication refuses incomplete evidence and a metadata archive outside the verified pair', () => {
  for (const reportChange of [{ status: 'failed' }, { appId: 'com.senx.arkme.harness' }, { artifacts: [report.artifacts[1]] }, { versionCode: 0 }]) {
    expect(() => createMacReleasePublication({ ...input, report: { ...report, ...reportChange } })).toThrow();
  }
  expect(() => createMacReleasePublication({ ...input, metadata: { ...metadata, path: 'other.zip' } })).toThrow();
  expect(() => createMacReleasePublication({ ...input, cdnBase: 'http://cdn.example/' })).toThrow();
});

test('publication shares the build lock, includes renamed blockmaps and invalidates stale requests on failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jiwo-publication-'));
  try {
    const releaseDirectory = path.join(root, 'release'); await mkdir(releaseDirectory);
    const freshReport = structuredClone(report);
    for (const artifact of freshReport.artifacts) {
      const bytes = Buffer.from(`${artifact.kind} verified fixture`);
      artifact.size = bytes.length; artifact.sha512 = createHash('sha512').update(bytes).digest('hex');
      await writeFile(path.join(releaseDirectory, artifact.filename), bytes);
    }
    const zip = freshReport.artifacts.find(a => a.kind === 'zip');
    await writeFile(path.join(releaseDirectory, `${zip.filename}.blockmap`), 'blockmap fixture');
    await writeFile(path.join(releaseDirectory, 'jiwo-release-verification.json'), JSON.stringify(freshReport));
    await writeFile(path.join(releaseDirectory, 'latest-mac.yml'), stringify({ version: report.version, files: [{ url: zip.filename, size: zip.size, sha512: Buffer.from(zip.sha512, 'hex').toString('base64') }] }));
    const privateKeyFile = path.join(root, 'key.pem'), releaseNotesFile = path.join(root, 'notes.txt');
    await writeFile(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(releaseNotesFile, 'release notes');
    const options = { releaseDirectory, cdnBase: input.cdnBase, buildCommit: input.buildCommit, privateKeyFile, releaseNotesFile };
    const lock = path.join(releaseDirectory, '.jiwo-release-build.lock');
    await mkdir(lock);
    await expect(prepareMacReleasePublication(options)).rejects.toThrow(/Another macOS release build/);
    await rm(lock, { recursive: true });
    const output = await prepareMacReleasePublication(options);
    const uploads = JSON.parse(await readFile(path.join(output, 'upload-map.json'), 'utf8')).uploads;
    const map = uploads.find(a => a.objectKey.endsWith('.zip.blockmap'));
    expect(map.localFile).toBe('publication/jiwo-3.0.0-vc277-universal.zip.blockmap');
    const blockmapBytes = await readFile(path.join(releaseDirectory, map.localFile));
    expect(createHash('sha512').update(blockmapBytes).digest('hex')).toBe(map.sha512);
    const decoded = JSON.parse(gunzipSync(blockmapBytes));
    expect(decoded.files[0].sizes.reduce((sum, value) => sum + value, 0)).toBe(zip.size);
    await writeFile(path.join(releaseDirectory, zip.filename), 'modified after validation');
    await expect(prepareMacReleasePublication(options)).rejects.toThrow(/Artifact changed/);
    await expect(readFile(path.join(output, 'release-request.json'))).rejects.toThrow(/ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
