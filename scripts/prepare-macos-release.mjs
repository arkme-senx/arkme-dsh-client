import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { verifyPairedMacUpdateMetadata } from './macos-release-pair.mjs';
import { withMacReleaseLock } from './macos-release-lock.mjs';

export function createMacReleasePublication({ report, metadata, cdnBase, releaseNotes, buildCommit, privateKey }) {
  if (report.status !== 'verified' || report.appId !== 'cc.jiwo.arkme'
    || !/^\d+\.\d+\.\d+$/.test(report.version) || !Number.isSafeInteger(report.versionCode)
    || report.versionCode <= 0 || report.versionCode > 2147483647
    || report.artifacts?.length !== 2 || new Set(report.artifacts.map(a => a.kind)).size !== 2
    || !report.artifacts.every(a => ['pkg', 'zip'].includes(a.kind) && a.filename === `即我-${report.version}-vc${report.versionCode}-universal.${a.kind}`
      && Number.isSafeInteger(a.size) && a.size > 0 && /^[a-f0-9]{128}$/.test(a.sha512))
    || !releaseNotes?.trim() || !/^[a-f0-9]{40}$/.test(buildCommit)) throw new Error('Complete verified release evidence, notes and git commit are required');
  verifyPairedMacUpdateMetadata(metadata, report);
  const base = new URL(cdnBase);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('CDN base must be a fixed HTTPS URL');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('App manifest signing requires an Ed25519 private key');
  const prefix = `arkme-releases/app/${report.version}/darwin/arm64/cc.jiwo.arkme`;
  const mapping = report.artifacts.map(a => ({ ...a, objectKey: `${prefix}/${a.kind === 'pkg' ? 'installers' : 'updates'}/jiwo-${report.version}-vc${report.versionCode}-universal.${a.kind}` }));
  const artifacts = mapping.map(a => ({ object_key: a.objectKey, platform: 'darwin', architecture: 'arm64', kind: a.kind, size: a.size, sha512: a.sha512, signing_status: 'signed-notarized' }));
  const manifest = { schemaVersion: 1, component: 'app', version: report.version, embeddedPluginVersion: '', dshVersion: '', gitCommit: buildCommit,
    artifacts: artifacts.map(a => ({ objectKey: a.object_key, platform: a.platform, architecture: a.architecture, kind: a.kind, size: a.size, sha512: a.sha512, signingStatus: a.signing_status })) };
  const payload = JSON.stringify(manifest);
  const url = objectKey => `${base.href.replace(/\/$/, '')}/${objectKey}`;
  const zip = mapping.find(a => a.kind === 'zip');
  const publishedMetadata = { ...metadata, path: path.posix.basename(zip.objectKey), files: [{ ...metadata.files[0], url: path.posix.basename(zip.objectKey) }] };
  return {
    request: { component: 'app', channel: 'stable', platform: 'darwin', architecture: 'arm64', version: report.version, version_code: report.versionCode,
      release_notes: releaseNotes.trim(), download_url: url(mapping.find(a => a.kind === 'pkg').objectKey), update_feed_url: url(`${prefix}/updates/`), artifacts,
      app: { build_commit: buildCommit, embedded_plugin_version: '', dsh_version: '', manifest_payload: payload, manifest_signature: sign(null, Buffer.from(payload), key).toString('base64') } },
    metadata: publishedMetadata,
    uploads: [...mapping.map(a => ({ localFile: a.filename, objectKey: a.objectKey, size: a.size, sha512: a.sha512 })),
      { localFile: 'publication/latest-mac.yml', objectKey: `${prefix}/updates/latest-mac.yml` }],
    publicKeyBase64: Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  };
}

export async function prepareMacReleasePublication({ releaseDirectory, cdnBase, releaseNotesFile, buildCommit, privateKeyFile }) {
  return withMacReleaseLock(releaseDirectory, async () => {
  const report = JSON.parse(await readFile(path.join(releaseDirectory, 'jiwo-release-verification.json'), 'utf8'));
  const metadata = parse(await readFile(path.join(releaseDirectory, 'latest-mac.yml'), 'utf8'));
  const publication = createMacReleasePublication({ report, metadata, cdnBase, buildCommit,
    releaseNotes: await readFile(releaseNotesFile, 'utf8'), privateKey: await readFile(privateKeyFile) });
  // Refuse stale evidence even when files were modified outside the build tools.
  for (const artifact of report.artifacts) {
    const bytes = await readFile(path.join(releaseDirectory, artifact.filename));
    if (bytes.length !== artifact.size || createHash('sha512').update(bytes).digest('hex') !== artifact.sha512) throw new Error(`Artifact changed after verification: ${artifact.filename}`);
  }
  const output = path.join(releaseDirectory, 'publication');
  await mkdir(output, { recursive: true });
  const zip = publication.uploads.find(artifact => artifact.objectKey.endsWith('.zip'));
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  builderRequire('app-builder-lib');
  const { buildBlockMap } = builderRequire('app-builder-lib/out/targets/blockmap/blockmap.js');
  const blockmapName = `${path.posix.basename(zip.objectKey)}.blockmap`;
  const blockmapPath = path.join(output, blockmapName);
  const zipInfo = await buildBlockMap(path.join(releaseDirectory, zip.localFile), 'gzip', `${blockmapPath}.tmp`);
  if (zipInfo.size !== zip.size || zipInfo.sha512 !== Buffer.from(zip.sha512, 'hex').toString('base64')) throw new Error('ZIP changed while generating its blockmap');
  await rename(`${blockmapPath}.tmp`, blockmapPath);
  const blockmap = await readFile(blockmapPath);
  publication.uploads.push({ localFile: `publication/${blockmapName}`, objectKey: `${zip.objectKey}.blockmap`, size: blockmap.length, sha512: createHash('sha512').update(blockmap).digest('hex') });
  // The signed request is the final completion marker; never write it before
  // all companion publication metadata has reached its final filename.
  for (const [name, content] of [['latest-mac.yml', stringify(publication.metadata)],
    ['upload-map.json', JSON.stringify({ publicKeyBase64: publication.publicKeyBase64, uploads: publication.uploads }, null, 2)],
    ['release-request.json', JSON.stringify(publication.request, null, 2)]]) {
    await writeFile(path.join(output, `${name}.tmp`), `${content.trimEnd()}\n`);
    await rename(path.join(output, `${name}.tmp`), path.join(output, name));
  }
  return output;
  }, { invalidateReport: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const options = { releaseDirectory: path.resolve(argument('--release-dir') ?? 'release'), cdnBase: argument('--cdn-base'), releaseNotesFile: argument('--release-notes-file'), buildCommit: argument('--build-commit'), privateKeyFile: argument('--signing-key-file') };
  if (!options.cdnBase || !options.releaseNotesFile || !options.buildCommit || !options.privateKeyFile) throw new Error('Required: --cdn-base --release-notes-file --build-commit --signing-key-file (Ed25519 PEM; never printed)');
  console.log(`Prepared local publication files: ${await prepareMacReleasePublication(options)}. No upload or publication was performed.`);
}
