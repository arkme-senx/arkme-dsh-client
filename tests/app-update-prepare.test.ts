import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArkmeAppUpdateController, type AppUpdaterPort } from '../src/app-update.js';

const require = createRequire(import.meta.url);
const { AppUpdater } = require('electron-updater/out/AppUpdater.js');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function fixture(platform: 'darwin' | 'win32' | 'linux' = 'darwin') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arkme-prepare-cache-'));
  directories.push(directory);
  const configPath = path.join(directory, 'app-update.yml');
  await writeFile(configPath, 'updaterCacheDirName: arkme-test-updater\n');
  let versionCode = 2;
  let bytes = Buffer.from('verified update version code 2');
  let metadataValid = true;
  let serviceAvailable = true;
  const transferred = vi.fn(async (file: string, payload: Buffer) => { await writeFile(file, payload); });
  const fetchImpl = vi.fn(async () => serviceAvailable
    ? new Response(JSON.stringify({ version: '1.3.0', versionCode, updateFeedUrl: 'https://updates.example.test/' }))
    : new Response('', { status: 503 }));
  const quitAndInstall = vi.fn();
  const createUpdater = vi.fn(() => {
    // Exercise electron-updater's real persisted cache and hash verification. Only
    // the network transport and native installer are replaced by deterministic IO.
    const updater = new AppUpdater({ provider: 'generic', url: 'https://updates.example.test/' }, {
      version: '1.2.0', name: 'arkme-test', isPackaged: true, appUpdateConfigPath: configPath,
      userDataPath: directory, baseCachePath: directory, whenReady: async () => {},
    });
    updater.logger = { info() {}, warn() {}, error() {} };
    const payload = bytes;
    const extension = platform === 'win32' ? 'exe' : 'zip';
    const file = { url: `arkme-1.3.0-vc${metadataValid ? versionCode : 99}-${platform === 'darwin' ? 'arm64' : 'x64'}.${extension}`,
      sha512: createHash('sha512').update(payload).digest('base64'), size: payload.length };
    const info = { version: '1.3.0', files: [file] };
    updater.checkForUpdates = async () => {
      updater.updateInfoAndProvider = { info, provider: {} };
      return { isUpdateAvailable: true, updateInfo: info };
    };
    updater.doDownloadUpdate = async (downloadUpdateOptions: unknown) => updater.executeDownload({
      fileExtension: extension, fileInfo: { info: file, url: new URL(file.url, 'https://updates.example.test/') },
      downloadUpdateOptions,
      task: async (filePath: string) => { await transferred(filePath, payload); },
      done: async () => {},
    });
    updater.quitAndInstall = quitAndInstall;
    return updater as AppUpdaterPort;
  });
  const start = (incomplete = false) => new ArkmeAppUpdateController({
    currentVersion: '1.2.0', currentVersionCode: 1, platform, arch: platform === 'darwin' ? 'arm64' : 'x64',
    serviceBaseUrl: 'https://api.jotmo.cc', fetchImpl, createUpdater,
    installUpdate: async (_target, launch) => launch(),
    ...(incomplete ? { previousInstallFailure: { version: '1.3.0', versionCode: 2 } } : {}),
  });
  return { start, transferred, quitAndInstall, fetchImpl, createUpdater,
    invalidateMetadata() { metadataValid = false; },
    offline() { serviceAvailable = false; },
    publish(code: number) { versionCode = code; bytes = Buffer.from(`verified update version code ${code}`); },
  };
}

describe('automatic APP update preparation', () => {
  it.each(['darwin', 'win32'] as const)('downloads once and reuses a verified cache after a %s restart', async platform => {
    const f = await fixture(platform);
    const first = await f.start().prepareNow();
    expect(first).toMatchObject({ status: 'downloaded', latestVersionCode: 2 });
    expect(f.transferred).toHaveBeenCalledOnce();
    const second = await f.start().prepareNow();
    expect(second.downloadedFilePath).toBe(first.downloadedFilePath);
    expect(f.transferred).toHaveBeenCalledOnce();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.quitAndInstall).not.toHaveBeenCalled();
  });
  it.each(['corrupt', 'missing'] as const)('redownloads when the cached package is %s', async kind => {
    const f = await fixture();
    const first = await f.start().prepareNow();
    const file = first.downloadedFilePath!;
    if (kind === 'corrupt') await writeFile(file, 'partial or corrupt package');
    else await rm(file);
    const second = await f.start().prepareNow();
    expect(second.status).toBe('downloaded');
    expect(await readFile(second.downloadedFilePath!, 'utf8')).toBe('verified update version code 2');
    expect(f.transferred).toHaveBeenCalledTimes(2);
  });
  it('checks the latest Version Code before selecting an older cached package', async () => {
    const f = await fixture();
    await f.start().prepareNow();
    f.publish(3);
    const next = await f.start().prepareNow();
    expect(next).toMatchObject({ status: 'downloaded', latestVersionCode: 3 });
    expect(await readFile(next.downloadedFilePath!, 'utf8')).toBe('verified update version code 3');
    expect(f.transferred).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent automatic and manual preparations without installing', async () => {
    const f = await fixture();
    const controller = f.start();
    await Promise.all([controller.prepareNow(), controller.prepareIfStale(30_000), controller.prepareNow()]);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.transferred).toHaveBeenCalledOnce();
    expect(f.quitAndInstall).not.toHaveBeenCalled();
  });
  it('rejects unverified metadata before any download and does not silently retry during cooldown', async () => {
    const f = await fixture(); f.invalidateMetadata();
    const controller = f.start();
    await expect(controller.prepareNow()).resolves.toMatchObject({
      status: 'failed', failureStage: 'check', canAutoInstall: false,
      latestVersion: '1.3.0', latestVersionCode: 2,
    });
    await controller.prepareIfStale(30_000);
    expect(f.transferred).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it('does not call an installer on Linux or download the already installed Version Code', async () => {
    const linux = await fixture('linux');
    await expect(linux.start().prepareNow()).resolves.toMatchObject({ status: 'available', canAutoInstall: false });
    expect(linux.createUpdater).not.toHaveBeenCalled();
    const mac = await fixture(); mac.publish(1);
    await expect(mac.start().prepareNow()).resolves.toMatchObject({ status: 'current' });
    expect(mac.transferred).not.toHaveBeenCalled();
  });
  it('does not treat an old cached package as latest when the version service is unavailable', async () => {
    const f = await fixture(); await f.start().prepareNow(); f.offline();
    await expect(f.start().prepareNow()).resolves.toMatchObject({ status: 'failed', failureStage: 'check' });
    expect(f.transferred).toHaveBeenCalledOnce();
  });
  it('checks again after an incomplete installation, reuses cache, and retains the installation warning', async () => {
    const f = await fixture(); await f.start().prepareNow();
    const next = await f.start(true).prepareNow();
    expect(next).toMatchObject({ status: 'downloaded', latestVersionCode: 2, installWarning: '上次安装未完成，请重新尝试或前往官网下载最新版本' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.transferred).toHaveBeenCalledOnce();
  });
});
