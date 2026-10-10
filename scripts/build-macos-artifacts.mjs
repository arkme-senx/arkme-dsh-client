import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { buildMigrationPackage } from './build-macos-migration.mjs';
import { verifyMacReleasePair, verifyPairedMacUpdateMetadata } from './macos-release-pair.mjs';
import { withMacReleaseLock } from './macos-release-lock.mjs';
import { electronBuilderCSCName } from './macos-signing-identity.mjs';

if (process.platform !== 'darwin') throw new Error('Build production macOS artifacts on macOS');
const releaseDirectory = path.resolve('release');
const appRoot = path.join(releaseDirectory, 'mac-universal/即我.app');
const reportPath = path.join(releaseDirectory, 'jiwo-release-verification.json');
await withMacReleaseLock(releaseDirectory, async () => {
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const electronBuilderIdentity = electronBuilderCSCName(process.env.CSC_NAME);

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...environment } });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message})`);
}

// electron-builder signs, notarizes and staples the app before archiving it.
run('pnpm', ['run', 'build']);
run('pnpm', ['exec', 'electron-builder', '--mac', 'zip', '--universal', '--publish', 'never'], { CSC_NAME: electronBuilderIdentity });
run(process.execPath, ['scripts/verify-macos-signature.mjs', appRoot]);
await buildMigrationPackage({ appRoot, outputDirectory: releaseDirectory });
const report = await verifyMacReleasePair({ appRoot, releaseDirectory, version: manifest.version, versionCode: manifest.versionCode });
verifyPairedMacUpdateMetadata(parse(await readFile(path.join(releaseDirectory, 'latest-mac.yml'), 'utf8')), report);
run(process.execPath, ['scripts/verify-app-update-metadata.mjs', '--platform', 'darwin', '--release-dir', releaseDirectory]);
run(process.execPath, ['scripts/packaged-smoke.mjs', '--platform', 'darwin'], { ARKME_PACKAGED_APP_ROOT: appRoot });
await writeFile(`${reportPath}.tmp`, `${JSON.stringify({ ...report, checkedAt: new Date().toISOString(), status: 'verified' }, null, 2)}\n`);
await rename(`${reportPath}.tmp`, reportPath);
console.log(`Verified complete PKG + ZIP release: ${reportPath}`);
});
