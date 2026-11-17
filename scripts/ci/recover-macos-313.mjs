// One-time recovery of the verified Mac build from release run 44147416141.
// Upload only: this script never reserves a version or activates a release.
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import YAML from 'yaml';
import {api, prefix, required} from './api.mjs';
import {putImmutableObject} from './oss-upload.mjs';
import {resolveAppUpdateMetadata} from '../../src/app-update-metadata.ts';

export const recovery = Object.freeze({
  repository: 'arkme-senx/arkme-dsh-client',
  source: '81950aaeb5924fa8a3ec7ff6ac907a5633baed0e',
  run: 44147416141, job: 134266394030, artifact: 14360210722,
  archiveSHA256: '508e4d4903514b7c17e87aeb1e589498e6742e30651017c9358051c180768352',
  metadataSHA256: '7e0623f7870395dcdbca78a32af44bb012355d47bacad6caa8a764ac907abfdd',
  version: '3.0.35', code: 313,
});
const hash = (bytes, algorithm = 'sha512') => createHash(algorithm).update(bytes).digest('hex');
const directory = 'artifacts/macos';
const feedURL = 'https://d.jiwo.cc/' + prefix('prod', 'macos', recovery.version, recovery.code);
const expectedNames = new Map([
  ['latest-mac.yml', 'yaml'],
  ['即我-3.0.35-vc313-universal.pkg', 'pkg'],
  ['即我-3.0.35-vc313-universal.zip', 'zip'],
  ['即我-3.0.35-vc313-universal.zip.blockmap', 'blockmap'],
]);

export function validateRecoverySource(run, job, artifact) {
  if (run.id !== recovery.run || run.head_sha !== recovery.source || run.head_branch !== 'master' ||
      run.event !== 'push' || run.status !== 'completed' ||
      run.path !== '.github/workflows/build-pre-release.yml' || run.repository?.full_name !== recovery.repository ||
      job.id !== recovery.job || job.run_id !== recovery.run || job.conclusion !== 'success' ||
      artifact.id !== recovery.artifact || artifact.expired ||
      artifact.name !== `arkme-${recovery.source}-macos` ||
      artifact.digest !== `sha256:${recovery.archiveSHA256}` ||
      artifact.workflow_run?.id !== recovery.run || artifact.workflow_run?.head_sha !== recovery.source) {
    throw new Error('Recovery source identity or successful Mac evidence differs');
  }
}

export async function validateRecoveryFiles(metadataBytes, read = name => readFile(path.join(directory, name))) {
  if (hash(metadataBytes, 'sha256') !== recovery.metadataSHA256) throw new Error('Recovery metadata changed');
  const meta = JSON.parse(metadataBytes);
  if (meta.batch_id !== recovery.source || meta.platform !== 'macos' || meta.run_attempt !== 1 ||
      meta.electron_major !== 43 || meta.modules_abi !== 148 || meta.files.length !== expectedNames.size ||
      !meta.signing_evidence?.verified || !meta.signing_evidence?.notarized || meta.signing_evidence.team_id !== 'T6NSNA8LDZ') {
    throw new Error('Recovery build or signing identity differs');
  }
  const seen = new Set();
  const files = [];
  for (const f of meta.files) {
    if (expectedNames.get(f.name) !== f.kind || f.platform !== 'macos' || seen.has(f.name) ||
        (['pkg', 'zip'].includes(f.kind) && f.signing_status !== 'signed-notarized')) {
      throw new Error('Unexpected recovery artifact');
    }
    seen.add(f.name);
    const bytes = await read(f.name);
    if (bytes.length !== f.size || hash(bytes) !== f.sha512) throw new Error('Recovery artifact bytes changed');
    files.push({...f, bytes});
  }
  const feed = YAML.parse(files.find(f => f.kind === 'yaml').bytes.toString('utf8'));
  for (const arch of ['arm64', 'x64']) {
    const selected = resolveAppUpdateMetadata(feed, {version: recovery.version, versionCode: recovery.code, platform: 'darwin', arch, feedURL});
    const zip = files.find(f => f.name === selected.filename);
    if (zip?.kind !== 'zip' || selected.file.size !== zip.size || selected.file.sha512 !== Buffer.from(zip.sha512, 'hex').toString('base64')) {
      throw new Error('Recovery updater does not select the verified ZIP');
    }
  }
  return files;
}

export function validateRecoveryGrant(g, name) {
  if (!expectedNames.has(name) || g.object_key !== prefix('prod', 'macos', recovery.version, recovery.code) + name ||
      (g.url !== new URL(encodeURIComponent(name), feedURL).href && g.url !== feedURL + name)) {
    throw new Error('Recovery upload grant differs from the exact production object');
  }
}

async function github(route) {
  const response = await fetch(`https://api.github.com/repos/${recovery.repository}/${route}`, {
    headers: {Authorization: `Bearer ${required('GH_TOKEN')}`, Accept: 'application/vnd.github+json'},
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`Recovery GitHub request failed: HTTP ${response.status}`);
  return response;
}

async function main(command) {
  if (required('GITHUB_REPOSITORY') !== recovery.repository) throw new Error('Wrong recovery repository');
  if (command === 'prepare') {
    const [run, job, artifact] = await Promise.all([
      github(`actions/runs/${recovery.run}`).then(r => r.json()),
      github(`actions/jobs/${recovery.job}`).then(r => r.json()),
      github(`actions/artifacts/${recovery.artifact}`).then(r => r.json()),
    ]);
    validateRecoverySource(run, job, artifact);
    const bytes = Buffer.from(await (await github(`actions/artifacts/${recovery.artifact}/zip`)).arrayBuffer());
    if (hash(bytes, 'sha256') !== recovery.archiveSHA256) throw new Error('Recovery archive digest differs');
    await mkdir(directory, {recursive: true});
    await writeFile('verified-macos-313.zip', bytes);
    execFileSync('unzip', ['-q', '-o', 'verified-macos-313.zip', '-d', directory]);
    await validateRecoveryFiles(await readFile(path.join(directory, 'platform.json')));
    console.log('Verified original Mac run, signed build evidence, archive and all artifact digests');
  } else if (command === 'upload') {
    // Validate all bytes before requesting any scoped credential or uploading.
    const files = await validateRecoveryFiles(await readFile(path.join(directory, 'platform.json')));
    const {default: OSS} = await import('ali-oss');
    const rank = f => f.kind === 'yaml' ? 1 : 0;
    const uploaded = [];
    for (const f of files.sort((a, b) => rank(a) - rank(b))) {
      const grant = await putImmutableObject({bytes: f.bytes, filename: f.name,
        credentials: async () => {
          const g = await api('upload-credentials', {batch_id: recovery.source, run_id: String(recovery.run), platform: 'macos', file: f.name});
          validateRecoveryGrant(g, f.name);
          return g;
        },
        createClient: (g, options) => new OSS({...options, endpoint: g.endpoint, bucket: g.bucket,
          accessKeyId: g.credentials.access_key_id, accessKeySecret: g.credentials.access_key_secret,
          stsToken: g.credentials.security_token, secure: true}),
      });
      const response = await fetch(grant.url, {signal: AbortSignal.timeout(300000)});
      if (!response.ok) throw new Error('Recovery CDN object unavailable');
      const actual = Buffer.from(await response.arrayBuffer());
      if (actual.length !== f.size || hash(actual) !== f.sha512) throw new Error('Recovery CDN bytes differ');
      uploaded.push({name: f.name, url: grant.url, size: f.size, sha512: f.sha512});
    }
    await writeFile('macos-upload-receipt.json', JSON.stringify({source: recovery, feedURL, uploaded, activated: false}, null, 2));
    console.log('All four immutable Mac objects uploaded and verified; release activation remains a manager action');
  } else throw new Error('Expected prepare or upload');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
