import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ArkmeAppUpdateController, type AppUpdaterPort } from '../src/app-update.js';

function fixture(platform: 'darwin' | 'linux' = 'darwin', feed: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const updater = Object.assign(emitter, {
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: false,
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: {
      version: '1.3.0', files: [{ url: 'arkme-1.3.0-vc2-arm64.zip', sha512: Buffer.alloc(64, 1).toString('base64'), size: 100 }],
    } }),
    downloadUpdate: vi.fn(async () => { emitter.emit('download-progress', { transferred: 50, total: 100 }); return ['/cache/update.zip']; }),
    quitAndInstall: vi.fn(),
  });
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '1.3.0', versionCode: 2, updateFeedUrl: 'https://updates.example.test/', ...feed })));
  const createUpdater = vi.fn(() => updater as unknown as AppUpdaterPort);
  const controller = new ArkmeAppUpdateController({
    currentVersion: '1.2.0', currentVersionCode: 1, platform, arch: platform === 'linux' ? 'x64' : 'arm64',
    serviceBaseUrl: 'https://api.jotmo.cc', createUpdater, fetchImpl,
    installUpdate: async (_target, launch) => launch(),
  });
  return { controller, updater, fetchImpl, createUpdater };
}

describe('APP update observable state', () => {
  it('publishes transitions and download bytes without a plugin poller', async () => {
    const { controller } = fixture();
    const seen: Array<{ status: string; downloadedBytes?: number }> = [];
    const unsubscribe = controller.subscribe(state => seen.push(state));
    await controller.checkNow();
    await controller.download();
    await controller.install();
    expect(seen.map(state => state.status)).toEqual(['checking', 'available', 'downloading', 'downloading', 'downloaded', 'installing']);
    expect(seen[3]).toMatchObject({ downloadedBytes: 50 });
    unsubscribe();
  });
  it('keeps Linux release checks without creating an installer or fetching downloadUrl', async () => {
    const { controller, createUpdater, fetchImpl } = fixture('linux', { downloadUrl: 'https://files.example.test/arkme.AppImage' });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'available', latestVersion: '1.3.0', canAutoInstall: false });
    await expect(controller.download()).resolves.toMatchObject({ status: 'failed', canAutoInstall: false });
    expect(createUpdater).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('does not use a direct package when the automatic feed is missing', async () => {
    const { controller, fetchImpl } = fixture('darwin', { updateFeedUrl: undefined, downloadUrl: 'https://files.example.test/a.zip' });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'available', canAutoInstall: false });
    await controller.download();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('surfaces asynchronous native install errors after launch returned', async () => {
    const { controller, updater } = fixture();
    await controller.checkNow(); await controller.download(); await controller.install();
    updater.emit('error', new Error('native signature rejected'));
    expect(controller.snapshotNow()).toMatchObject({ status: 'failed', failureStage: 'install', error: 'native signature rejected' });
  });
  it('never replaces an emitted download failure with a late download completion', async () => {
    const { controller, updater } = fixture();
    updater.downloadUpdate.mockImplementation(async () => { updater.emit('error', new Error('checksum mismatch')); return ['/cache/update.zip']; });
    await controller.checkNow();
    await expect(controller.download()).resolves.toMatchObject({ status: 'failed', failureStage: 'download', error: 'checksum mismatch' });
  });
});

it('keeps the verified updater when a newer metadata check overlaps download', async () => {
  const first = fixture().updater;
  const second = fixture().updater;
  let finishMetadata!: () => void;
  second.checkForUpdates = async () => await new Promise(resolve => { finishMetadata = () => resolve({ isUpdateAvailable: true, updateInfo: {
    version: '1.4.0', files: [{ url: 'arkme-1.4.0-vc3-arm64.zip', sha512: Buffer.alloc(64, 1).toString('base64'), size: 100 }],
  } }); });
  let checks = 0;
  const createUpdater = vi.fn(() => (checks === 1 ? first : second) as unknown as AppUpdaterPort);
  const controller = new ArkmeAppUpdateController({
    currentVersion: '1.2.0', currentVersionCode: 1, platform: 'darwin', arch: 'arm64', serviceBaseUrl: 'https://api.jotmo.cc',
    createUpdater, fetchImpl: async () => { checks++; return new Response(JSON.stringify({ version: checks === 1 ? '1.3.0' : '1.4.0', versionCode: checks + 1, updateFeedUrl: 'https://updates.example.test/' })); },
  });
  await controller.checkNow();
  const checking = controller.checkNow();
  await vi.waitFor(() => expect(createUpdater).toHaveBeenCalledTimes(2));
  await controller.download();
  finishMetadata(); await checking;
  expect(first.downloadUpdate).toHaveBeenCalledOnce();
  expect(second.downloadUpdate).not.toHaveBeenCalled();
  expect(controller.snapshotNow()).toMatchObject({ status: 'downloaded', latestVersion: '1.3.0', latestVersionCode: 2 });
});
