// Explicitly local, nonpublishable fixture. Exercises real packaged main twice.
// Run only after building an unsigned runtime-free app with the current source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveElectronRuntimeReleaseId, parseElectronRuntimeManifest } from '../../dist/runtime/manifest.js';
import { RUNTIME_CACHE_EPOCH, resolveRuntimeCacheRoot } from '../../dist/runtime/cache-epoch.js';
import { hasCompletedPackagedRuntimeStartup } from '../packaged-smoke-lib.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = path.resolve(process.argv[2] || '/tmp/arkme-rc2-runtime-free-desktop/mac-arm64/arkme.app');
const harnessDirectory = path.resolve(process.argv[3] || '/tmp/arkme-harness-015rc2-local');
const pluginDirectory = path.resolve(process.argv[4] || path.join(project, '../arkme-dsh-plugin/dist/runtime-artifacts'));
const appManifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'arkme-packaged-offline-')));
const appData = path.join(root, 'app-data');
const userData = path.join(appData, 'Arkme Harness');
const home = path.join(root, 'home');
const cache = resolveRuntimeCacheRoot(userData);
const downloads = path.join(cache, 'downloads');
await Promise.all([mkdir(downloads, { recursive: true }), mkdir(home), mkdir(path.join(userData, 'dsh'), { recursive: true })]);
const harnessMetadata = JSON.parse(await readFile(path.join(harnessDirectory, 'artifact-metadata.json'), 'utf8'));
const harness = harnessMetadata.artifacts.find(item => item.target.os === 'darwin' && item.target.arch === 'arm64');
const plugin = JSON.parse(await readFile(path.join(pluginDirectory, 'artifact-metadata.json'), 'utf8'));
assert.equal(harness.version, '0.1.5-rc.2');
assert.equal(plugin.version, '0.1.52');
const descriptor = artifact => ({
  version: artifact.version, versionCode: 1,
  url: `https://d.jiwo.cc/__local_smoke_not_published__/${artifact.sha256}.tar.zst`,
  sha256: artifact.sha256, size: artifact.size, unpackedSize: artifact.unpackedSize,
});
const manifest = {
  schemaVersion: 1, releaseId: '', channel: 'stable', publishedAt: '2026-09-14T00:00:00.000Z',
  target: { os: 'darwin', arch: 'arm64' }, minShellVersion: appManifest.version,
  runtimeApiVersion: 1, dataSchemaVersion: 1, electron: { major: 43, modulesAbi: 148 }, pnpmVersion: '11.19.0',
  artifacts: {
    harness: { ...descriptor(harness), modulesAbi: 148, entry: 'harness/node_modules/@deepseek-ai/dsh/lib/bin.js', metadata: 'harness/runtime-metadata.json' },
    requiredPlugin: { ...descriptor(plugin), name: '@senguoyun/dsh-arkme', target: 'harness/node_modules/@senguoyun/dsh-arkme' },
  },
  compatibility: { shellVersionCode: appManifest.versionCode, clientHarnessRange: { min: 1, max: 1 }, pluginHarnessRange: { min: 1, max: 1 }, clientMaxHarnessVersionCode: 1, pluginMaxHarnessVersionCode: 1, clientRuleRevision: 1, pluginRuleRevision: 1 },
  localFixture: { releaseEligible: false, syntheticVersionCodes: true, remoteUrlsDoNotExist: true },
};
manifest.releaseId = deriveElectronRuntimeReleaseId(manifest);
parseElectronRuntimeManifest(manifest, { os: 'darwin', arch: 'arm64', shellVersion: appManifest.version, electronMajor: 43, modulesAbi: 148 }, { requiredShellVersionCode: appManifest.versionCode });
for (const [metadata, directory] of [[harness, harnessDirectory], [plugin, pluginDirectory]]) {
  const source = path.join(directory, metadata.file);
  const bytes = await readFile(source);
  assert.equal(bytes.length, metadata.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  await cp(source, path.join(downloads, `${metadata.sha256}.tar.zst`));
}
await writeFile(path.join(cache, 'acquisition.json'), JSON.stringify({ schemaVersion: 1, environment: 'prod', cacheEpoch: RUNTIME_CACHE_EPOCH, manifest }, null, 2));
const legacyStatePath = path.join(userData, 'runtime-manager/electron-v1/state.json');
const legacyState = JSON.stringify({ schemaVersion: 2, environment: 'prod', activeReleaseId: 'electron-runtime-v1-' + 'f'.repeat(32), badReleases: [], localFixture: true });
await writeFile(legacyStatePath, legacyState);
const legacyCacheSentinel = path.join(userData, 'runtime-manager/electron-v1/old-cache.keep');
await writeFile(legacyCacheSentinel, 'OLD-CACHE-MUST-NOT-LAUNCH-OR-CHANGE');
await writeFile(path.join(userData, 'dsh/keep.txt'), 'LEGACY-DATA-MUST-SURVIVE');
await writeFile(path.join(root, 'LOCAL_FIXTURE.json'), JSON.stringify({ releaseEligible: false, manifest, root }, null, 2));
// Block external Chromium/Node HTTP traffic, while all loopback Harness and IPC
// requests bypass the proxy. The fixture URLs are never real published URLs.
let deniedNetworkRequests = 0;
const proxy = createServer((_request, response) => { deniedNetworkRequests++; response.writeHead(502); response.end('offline integration fixture'); });
proxy.on('connect', (_request, socket) => { deniedNetworkRequests++; socket.end('HTTP/1.1 502 Offline Fixture\r\nConnection: close\r\n\r\n'); });
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyAddress = `http://127.0.0.1:${proxy.address().port}`;
const executable = path.join(appRoot, 'Contents/MacOS/arkme');
const logPath = path.join(userData, 'logs/desktop-startup.log');
let child;
let output = '';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function stop(crash = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const receipt = await readJson(path.join(userData, 'runtime-process.json')).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  child.kill(crash ? 'SIGKILL' : 'SIGTERM');
  const deadline = Date.now() + 12_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); throw new Error('Packaged main did not exit after SIGTERM'); }
  // Do not kill or delete the receipt ourselves: the shipped stdin lifetime
  // guard must terminate the child when main exits, before restart may recover.
  if (receipt !== undefined) {
    const orphanDeadline = Date.now() + 8000;
    let exited = false;
    while (Date.now() < orphanDeadline) {
      const exists = pid => {
        try { process.kill(pid, 0); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
      };
      if (!exists(receipt.pid) && !exists(-receipt.pid)) { exited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(exited, 'Shipped lifetime guard did not terminate orphaned Harness');
  }
}
async function run(restart) {
  const previousLogSize = await stat(logPath).then(info => info.size, () => 0);
  child = spawn(executable, [`--proxy-server=${proxyAddress}`, '--proxy-bypass-list=127.0.0.1;localhost'], {
    env: { ...process.env, HOME: home, ARKME_APP_DATA_PATH: appData, ARKME_UPDATE_CHECK_ENABLED: '0', HTTP_PROXY: proxyAddress, HTTPS_PROXY: proxyAddress, NO_PROXY: 'localhost,127.0.0.1', NODE_USE_ENV_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-32_768); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-32_768); });
  const deadline = Date.now() + 90_000;
  let loadedAt;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged main exited: ${child.exitCode ?? child.signalCode}; see isolated diagnostics at ${root}`);
    try {
      const state = await readJson(path.join(cache, 'state.json'));
      const release = await readJson(path.join(cache, 'releases', state.activeReleaseId, 'release.json'));
      const log = (await readFile(logPath)).subarray(previousLogSize).toString('utf8');
      const ready = restart ? /render-ready \{"url":"http:\/\/127\.0\.0\.1:\d+\/"\}/.test(log)
        : hasCompletedPackagedRuntimeStartup({ state, release, log });
      if (!ready || state.activeReleaseId !== manifest.releaseId || state.probationReleaseId !== undefined) throw new Error('startup incomplete');
      const pageLoaded = /did-finish-load \{"url":"http:\/\/127\.0\.0\.1:\d+\/"\}/.test(log);
      if (!pageLoaded) throw new Error('final page still loading');
      loadedAt ??= Date.now();
      if (Date.now() - loadedAt < 2000) throw new Error('final page settling');
      assert(!/renderer-console \{"level":3/.test(log), 'Final page emitted renderer errors');
      const scopes = await readJson(path.join(userData, 'dsh-account-scopes.json'));
      assert.equal(scopes.pendingLegacy, undefined);
      assert.equal(scopes.containers[scopes.activeContainerRef].owner.kind, 'guest');
      const targetHome = path.join(userData, 'dsh-containers', scopes.activeContainerRef, 'dsh');
      assert.equal(await readFile(path.join(targetHome, 'keep.txt'), 'utf8'), 'LEGACY-DATA-MUST-SURVIVE');
      const identities = await readJson(path.join(userData, 'runtime-data-transactions/prod/committed-containers.json'));
      assert.deepEqual(identities.containers[await realpath(targetHome)], { releaseId: manifest.releaseId, harnessIdentity: harness.sha256 });
      assert.equal(await readFile(legacyStatePath, 'utf8'), legacyState);
      assert.equal(await readFile(legacyCacheSentinel, 'utf8'), 'OLD-CACHE-MUST-NOT-LAUNCH-OR-CHANGE');
      const transactions = path.join(userData, 'runtime-data-transactions/prod');
      const journals = [];
      for (const entry of await readdir(transactions, { withFileTypes: true })) {
        if (entry.isDirectory()) journals.push(await readJson(path.join(transactions, entry.name, 'transaction.json')));
      }
      assert(journals.length > 0 && journals.every(item => item.phase === 'completed'));
      assert(!/[?&]token=(?!\[redacted\])[^\s&#]+/.test(log));
      return { restart, releaseId: state.activeReleaseId, accountContainer: scopes.activeContainerRef, completedTransactions: journals.length, targetHome };
    } catch (error) {
      if (error.message === 'Final page emitted renderer errors' || Date.now() > deadline - 1000) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Packaged offline startup timed out');
}
try {
  console.log(JSON.stringify({ phase: 'starting-local-fixture', root, releaseEligible: false }));
  const first = await run(false);
  // Kill only this isolated main process to exercise the actual orphan guard.
  await stop(true);
  const second = await run(true);
  assert.equal(second.accountContainer, first.accountContainer);
  assert.equal(second.completedTransactions, first.completedTransactions);
  await stop();
  const report = { passed: true, releaseEligible: false, root, first, second, deniedNetworkRequests, epoch: RUNTIME_CACHE_EPOCH, acquisitionCacheUsed: true, legacyCachePreserved: true, legacyDataPreserved: true, identityTransferred: true, orphanLifetimeGuardVerified: true };
  await writeFile('/tmp/arkme-packaged-offline-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(path.join(root, 'process-output.log'), output);
  await writeFile('/tmp/arkme-packaged-offline-report.json', JSON.stringify({ passed: false, releaseEligible: false, root, error: error.message }, null, 2));
  console.error(`Local packaged offline fixture failed; diagnostics: ${root}`);
  throw error;
} finally {
  await stop();
  await new Promise(resolve => proxy.close(resolve));
}
