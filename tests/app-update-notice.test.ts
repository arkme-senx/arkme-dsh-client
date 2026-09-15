import { describe, expect, it, vi } from 'vitest';
import { AppUpdateNoticeCoordinator, registerAppUpdateNoticeIpc, isTrustedAppUpdatePage } from '../src/app-update-notice.js';
import type { ArkmeAppUpdateSnapshot } from '../src/app-update.js';

const statusPageUrl = 'file:///Applications/arkme.app/Contents/Resources/app.asar/dist/ui/status.html';
const harnessOrigin = 'http://127.0.0.1:23456';
function fixture() {
  let url = `${statusPageUrl}?kind=failed`;
  let origin: string | null = null;
  let state: ArkmeAppUpdateSnapshot = { status: 'idle', currentVersion: '1.2.0', currentVersionCode: 1, canAutoInstall: false };
  let onState: ((state: ArkmeAppUpdateSnapshot) => void) | undefined;
  const send = vi.fn();
  const openExternal = vi.fn(async (_url: string) => {});
  const controller = {
    snapshotNow: () => ({ ...state }),
    subscribe: (listener: typeof onState) => { onState = listener; return () => { onState = undefined; }; },
    prepareNow: vi.fn(async () => state), download: vi.fn(async () => state), install: vi.fn(async () => state),
  };
  const coordinator = new AppUpdateNoticeCoordinator({
    statusPageUrl, getHarnessOrigin: () => origin,
    getWindow: () => ({ webContentsId: 7, getCurrentUrl: () => url, send }), openExternal,
  });
  coordinator.attach(controller);
  const event = { webContentsId: 7, isMainFrame: true, url };
  return { coordinator, controller, send, openExternal, event,
    navigate(next: string, nextOrigin: string | null) { url = next; origin = nextOrigin; event.url = next; },
    emit(patch: Partial<ArkmeAppUpdateSnapshot>) { state = { ...state, ...patch }; onState?.(state); },
    replace(next: ArkmeAppUpdateSnapshot) { state = next; onState?.(state); },
  };
}

describe('client-owned APP update notice', () => {
  it('works on a failed local page with no Harness origin or plugin', async () => {
    const { coordinator, controller, event } = fixture();
    expect(coordinator.snapshot(event)).toMatchObject({ expanded: false, state: { status: 'idle' } });
    await expect(coordinator.open(event)).resolves.toBe(true);
    expect(controller.prepareNow).toHaveBeenCalledOnce();
    expect(coordinator.snapshot(event)).toMatchObject({ expanded: false });
  });
  it('keeps background check failures invisible but lets settings retry them', async () => {
    const f = fixture();
    f.emit({ status: 'failed', failureStage: 'check', error: 'offline' });
    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(false);
    await f.coordinator.open(f.event);
    expect(f.controller.prepareNow).toHaveBeenCalledOnce();
  });
  it('preserves collapse across progress/navigation and expands completion', () => {
    const f = fixture();
    f.emit({ status: 'available', latestVersion: '1.3.0', latestVersionCode: 2 });
    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(true);
    f.coordinator.collapse(f.event);
    f.emit({ status: 'downloading', downloadedBytes: 10 });
    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(false);
    f.navigate(`${harnessOrigin}/workspace`, harnessOrigin);
    f.emit({ downloadedBytes: 50 });
    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(false);
    f.emit({ status: 'downloaded' });
    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(true);
    f.coordinator.collapse(f.event);
    f.emit({ status: 'downloaded' });
    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(false);
  });
  it.each([false, true])('keeps a collapsed release closed after rechecking the same Version Code (offline: %s)', offline => {
    const f = fixture();
    f.emit({ status: 'available', latestVersion: '1.3.0', latestVersionCode: 2 });
    f.coordinator.collapse(f.event);

    f.emit({ status: 'checking' });
    if (offline) {
      f.replace({ status: 'failed', failureStage: 'check', error: 'offline', currentVersion: '1.2.0', currentVersionCode: 1, canAutoInstall: false });
      f.emit({ status: 'checking' });
    }
    f.emit({ status: 'available', latestVersion: '1.3.0', latestVersionCode: 2 });

    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(false);
  });
  it.each([false, true])('preserves an undismissed website-only notice across background rechecks (offline: %s)', offline => {
    const f = fixture();
    f.emit({ status: 'available', canAutoInstall: false, latestVersion: '1.3.0', latestVersionCode: 2 });
    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(true);

    f.emit({ status: 'checking' });
    if (offline) {
      f.replace({ status: 'failed', failureStage: 'check', error: 'offline', currentVersion: '1.2.0', currentVersionCode: 1, canAutoInstall: false });
      f.emit({ status: 'checking' });
    }
    f.emit({ status: 'available', latestVersion: '1.3.0', latestVersionCode: 2 });

    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(true);
  });
  it('reopens a collapsed notice when a recheck discovers a new Version Code', () => {
    const f = fixture();
    f.emit({ status: 'available', latestVersion: '1.3.0', latestVersionCode: 2 });
    f.coordinator.collapse(f.event);

    f.emit({ status: 'checking' });
    f.emit({ status: 'available', latestVersion: '1.4.0', latestVersionCode: 3 });

    expect(f.coordinator.snapshot(f.event)?.expanded).toBe(true);
  });
  it('opens only the fixed website without checking a feed or changing update state', async () => {
    const f = fixture();
    f.emit({ status: 'failed', failureStage: 'check', error: 'offline' });
    const before = f.coordinator.snapshot(f.event)?.state;
    await expect(f.coordinator.openWebsite(f.event)).resolves.toBe(true);
    expect(f.openExternal).toHaveBeenCalledWith('https://jiwo.cc');
    expect(f.controller.prepareNow).not.toHaveBeenCalled();
    expect(f.coordinator.snapshot(f.event)?.state).toEqual(before);
  });
  it('deduplicates website clicks and recovers from browser failure', async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.openExternal.mockImplementationOnce(async () => await new Promise((_resolve, fail) => { reject = fail; }));
    const first = f.coordinator.openWebsite(f.event);
    const duplicate = f.coordinator.openWebsite(f.event);
    expect(f.coordinator.snapshot(f.event)?.websiteOpening).toBe(true);
    expect(f.openExternal).toHaveBeenCalledOnce();
    reject(new Error('browser unavailable'));
    await expect(first).resolves.toBe(false); await duplicate;
    expect(f.coordinator.snapshot(f.event)).toMatchObject({ websiteOpening: false, actionError: 'browser unavailable' });
    await expect(f.coordinator.openWebsite(f.event)).resolves.toBe(true);
  });
  it('routes retries by failure stage and forbids repeated actions while installing', async () => {
    const f = fixture();
    f.emit({ status: 'failed', failureStage: 'download', canAutoInstall: true });
    await f.coordinator.retry(f.event);
    expect(f.controller.download).toHaveBeenCalledOnce();
    f.emit({ failureStage: 'install' });
    await f.coordinator.retry(f.event);
    expect(f.controller.prepareNow).toHaveBeenCalledOnce();
    f.emit({ status: 'installing' });
    await expect(f.coordinator.openWebsite(f.event)).resolves.toBe(false);
    expect(f.coordinator.collapse(f.event)).toBe(false);
    expect(f.coordinator.isInstalling()).toBe(true);
  });
  it('rejects wrong windows, subframes, external and unrelated local pages', async () => {
    const f = fixture();
    for (const event of [
      { ...f.event, webContentsId: 8 }, { ...f.event, isMainFrame: false },
      { ...f.event, url: 'https://jiwo.cc' }, { ...f.event, url: 'file:///tmp/status.html' },
      { ...f.event, url: statusPageUrl.replace('file:///', 'file://evil/') },
    ]) {
      expect(f.coordinator.snapshot(event)).toBeNull();
      await expect(f.coordinator.openWebsite(event)).resolves.toBe(false);
    }
    expect(f.openExternal).not.toHaveBeenCalled();
    f.navigate('https://example.test', null);
    f.send.mockClear(); f.emit({ status: 'failed' });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('registers guarded IPC without a filesystem download operation', async () => {
    const f = fixture();
    const handlers = new Map<string, (event: typeof f.event) => unknown>();
    registerAppUpdateNoticeIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, f.coordinator);
    expect(handlers.has('arkme-app-update:show-in-folder')).toBe(false);
    await handlers.get('arkme-app-update:open-website')?.(f.event);
    expect(f.openExternal).toHaveBeenCalledWith('https://jiwo.cc');
  });
});

it('compares exact local page identity and active Harness origin', () => {
  expect(isTrustedAppUpdatePage(`${statusPageUrl}?kind=failed`, statusPageUrl, null)).toBe(true);
  expect(isTrustedAppUpdatePage(`${harnessOrigin}/workspace`, statusPageUrl, harnessOrigin)).toBe(true);
  expect(isTrustedAppUpdatePage('http://127.0.0.1:9999', statusPageUrl, harnessOrigin)).toBe(false);
});
