import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(tool, args) {
  return execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

// Compare bytes, modes and symlink targets, never ownership/timestamps changed by packaging.
async function inventory(root) {
  const entries = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) entries.push([relative, 'link', await readlink(absolute)]);
    else if (info.isDirectory()) {
      entries.push([relative, 'directory', info.mode & 0o777]);
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (info.isFile()) entries.push([relative, 'file', info.mode & 0o777, createHash('sha512').update(await readFile(absolute)).digest('hex')]);
    else throw new Error(`Unsupported application entry: ${relative}`);
  }
  await visit('');
  return JSON.stringify(entries);
}

async function applicationIn(root) {
  const apps = [];
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name === '__MACOSX') continue;
      const entry = path.join(directory, item.name);
      if (item.name.endsWith('.app')) apps.push(entry);
      else await visit(entry);
    }
  }
  await visit(root);
  if (apps.length !== 1 || path.basename(apps[0]) !== '即我.app') throw new Error('Release must contain exactly one 即我.app');
  return apps[0];
}

/** Local build output check; code signing and notarization are separate mandatory pipeline gates. */
export async function verifyMacReleasePair({ appRoot, releaseDirectory, version, versionCode }) {
  if (process.platform !== 'darwin') throw new Error('Verify macOS release archives on macOS');
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appRoot, 'Contents/Info.plist')]));
  if (info.CFBundleIdentifier !== 'cc.jiwo.arkme' || info.CFBundleExecutable !== 'arkme'
    || info.CFBundleShortVersionString !== version || info.CFBundleVersion !== String(versionCode)) {
    throw new Error('Release application identity/version mismatch');
  }
  const expected = await inventory(appRoot);
  const work = await mkdtemp(path.join(os.tmpdir(), 'jiwo-verify-release-'));
  const artifacts = [];
  try {
    for (const kind of ['pkg', 'zip']) {
      const filename = `即我-${version}-vc${versionCode}-universal.${kind}`;
      const archive = path.join(releaseDirectory, filename);
      const stat = await lstat(archive);
      if (!stat.isFile()) throw new Error(`Release artifact must be a regular file: ${filename}`);
      const unpacked = path.join(work, kind);
      if (kind === 'pkg') run('/usr/sbin/pkgutil', ['--expand-full', archive, unpacked]);
      else run('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
      if (await inventory(await applicationIn(unpacked)) !== expected) {
        throw new Error(`${kind} application content or permissions differ from the signed source`);
      }
      artifacts.push({ kind, filename, size: stat.size, sha512: createHash('sha512').update(await readFile(archive)).digest('hex') });
    }
    return { appId: info.CFBundleIdentifier, version, versionCode,
      applicationSHA512: createHash('sha512').update(expected).digest('hex'), artifacts };
  } finally { await rm(work, { recursive: true, force: true }); }
}
export function verifyPairedMacUpdateMetadata(metadata, report) {
  const zip = report.artifacts.find(artifact => artifact.kind === 'zip');
  const expectedURL = value => typeof value === 'string' && decodeURIComponent(value) === zip.filename;
  if (!zip || metadata.version !== report.version || !Array.isArray(metadata.files) || metadata.files.length !== 1
    || !expectedURL(metadata.files[0]?.url) || (metadata.path !== undefined && !expectedURL(metadata.path))
    || metadata.files[0].size !== zip.size
    || metadata.files[0].sha512 !== Buffer.from(zip.sha512, 'hex').toString('base64')) {
    throw new Error('latest-mac.yml must reference only the verified paired ZIP with matching size and SHA-512');
  }
}
