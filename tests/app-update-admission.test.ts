import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { ArkmeAppUpdateController, type AppUpdaterPort } from '../src/app-update.js';

function fixture() {
  const checkInstallEligibility = vi.fn(async () => true);
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: false,
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: {
      version: '3.0.26', files: [{ url: 'arkme-3.0.26-vc304-x64.exe', sha512: Buffer.alloc(64, 1).toString('base64'), size: 100 }],
    } }),
    downloadUpdate: vi.fn(async () => ['C:\\fixture\\update.exe']),
    quitAndInstall: vi.fn(),
  });
  const installUpdate = vi.fn(async (_target: { version: string; versionCode: number }, launch: () => void) => launch());
  const createUpdater = vi.fn(() => updater as unknown as AppUpdaterPort);
  const controller = new ArkmeAppUpdateController({
    currentVersion: '3.0.23', currentVersionCode: 301, platform: 'win32', arch: 'x64',
    serviceBaseUrl: 'https://api.jotmo.cc', checkInstallEligibility, createUpdater, installUpdate,
    fetchImpl: async () => new Response(JSON.stringify({ version: '3.0.26', versionCode: 304, updateFeedUrl: 'https://updates.example.test/' })),
  });
  return { controller, checkInstallEligibility, updater, createUpdater, installUpdate };
}

test('unregistered/legacy installation offers full installer without download or quit', async () => {
  const f = fixture(); f.checkInstallEligibility.mockResolvedValue(false);
  await expect(f.controller.prepareNow()).resolves.toMatchObject({ status: 'available', canAutoInstall: false, error: expect.stringContaining('完整安装包') });
  expect(f.createUpdater).not.toHaveBeenCalled();
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  expect(f.installUpdate).not.toHaveBeenCalled();
});

test('rechecks after download before any receipt, shutdown or installer callback', async () => {
  const f = fixture(); await f.controller.prepareNow();
  f.checkInstallEligibility.mockResolvedValue(false);
  await expect(f.controller.install()).resolves.toMatchObject({ status: 'available', canAutoInstall: false, error: expect.stringContaining('完整安装包') });
  expect(f.checkInstallEligibility).toHaveBeenCalledTimes(2);
  expect(f.installUpdate).not.toHaveBeenCalled();
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  expect(f.controller.snapshotNow().downloadedFilePath).toBeUndefined();
});

test('inspection exception cannot proceed to shutdown', async () => {
  const f = fixture(); await f.controller.prepareNow();
  f.checkInstallEligibility.mockRejectedValue(new Error('probe timed out'));
  await expect(f.controller.install()).resolves.toMatchObject({ status: 'available', canAutoInstall: false });
  expect(f.installUpdate).not.toHaveBeenCalled();
});

test('eligible installation keeps the normal update path', async () => {
  const f = fixture(); await f.controller.prepareNow(); await f.controller.install();
  expect(f.checkInstallEligibility).toHaveBeenNthCalledWith(1, { version: '3.0.26', versionCode: 304 });
  expect(f.checkInstallEligibility).toHaveBeenNthCalledWith(2, { version: '3.0.26', versionCode: 304 });
  expect(f.installUpdate).toHaveBeenCalledOnce();
  expect(f.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
});
