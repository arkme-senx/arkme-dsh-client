import type { ArkmeAppUpdateController, ArkmeAppUpdateSnapshot } from './app-update.js';

export const APP_UPDATE_CHANGED_CHANNEL = 'arkme-app-update:changed';
export interface AppUpdateNoticeSnapshot {
  schemaVersion: 1;
  revision: number;
  expanded: boolean;
  state: ArkmeAppUpdateSnapshot | null;
  websiteOpening: boolean;
  actionError?: string;
  actionMessage?: string;
}
export interface AppUpdateNoticeSender {
  webContentsId: number;
  isMainFrame: boolean;
  url: string;
}
interface NoticeWindow {
  webContentsId: number;
  getCurrentUrl(): string;
  send(channel: string, snapshot: AppUpdateNoticeSnapshot): void;
}
type UpdateController = Pick<ArkmeAppUpdateController, 'snapshotNow' | 'subscribe' | 'prepareNow' | 'download' | 'install'>;
interface NoticeOptions {
  statusPageUrl: string;
  getHarnessOrigin(): string | null;
  getWindow(): NoticeWindow | null;
  openExternal(url: string): Promise<unknown>;
}

export function isTrustedAppUpdatePage(url: string, statusPageUrl: string, harnessOrigin: string | null): boolean {
  try {
    const candidate = new URL(url);
    const local = new URL(statusPageUrl);
    if (candidate.protocol === 'file:' && candidate.host === local.host && candidate.pathname === local.pathname) return true;
    return harnessOrigin !== null && candidate.origin === harnessOrigin;
  } catch { return false; }
}

function hasUpdateNotice(state: ArkmeAppUpdateSnapshot | null): boolean {
  return state !== null && !!state.latestVersion?.trim()
    && typeof state.latestVersionCode === 'number' && state.latestVersionCode > state.currentVersionCode
    && ['available', 'downloading', 'downloaded', 'installing', 'failed'].includes(state.status);
}

export class AppUpdateNoticeCoordinator {
  private current: AppUpdateNoticeSnapshot = { schemaVersion: 1, revision: 0, expanded: false, state: null, websiteOpening: false };
  private controller: UpdateController | undefined;
  private unsubscribe: (() => void) | undefined;
  private websiteTask: Promise<boolean> | undefined;
  private announcedReleaseIdentity: string | undefined;
  constructor(private readonly options: NoticeOptions) {}

  attach(controller: UpdateController): void {
    this.unsubscribe?.();
    this.controller = controller;
    this.unsubscribe = controller.subscribe(state => this.accept(state));
    this.accept(controller.snapshotNow());
  }
  private accept(state: ArkmeAppUpdateSnapshot): void {
    const phaseKey = (value: ArkmeAppUpdateSnapshot | null) => value === null ? ''
      : `${value.status}:${value.latestVersionCode ?? ''}:${value.failureStage ?? ''}:${value.error ?? ''}`;
    const newPhase = phaseKey(state) !== phaseKey(this.current.state);
    const releaseIdentity = state.status === 'available'
      ? `${state.latestVersionCode ?? ''}:${state.latestVersion ?? ''}`
      : undefined;
    const newlyAnnouncedRelease = releaseIdentity !== undefined && releaseIdentity !== this.announcedReleaseIdentity;
    if (releaseIdentity !== undefined) this.announcedReleaseIdentity = releaseIdentity;
    const shouldExpand = state.status === 'available'
      ? newlyAnnouncedRelease
      : newPhase && ['downloaded', 'failed', 'installing'].includes(state.status);
    const { actionError: _error, actionMessage: _message, ...previous } = this.current;
    // Checking (including an offline result) temporarily hides the renderer,
    // but must preserve whether the user left the discovered update open.
    const checkingWithoutRelease = state.status === 'checking'
      || (state.status === 'failed' && state.failureStage === 'check' && !hasUpdateNotice(state));
    const expanded = checkingWithoutRelease ? previous.expanded
      : hasUpdateNotice(state) && (shouldExpand || previous.expanded);
    this.publish({ ...previous, state: { ...state }, expanded });
  }
  private publish(next: AppUpdateNoticeSnapshot): void {
    this.current = { ...next, revision: this.current.revision + 1 };
    const window = this.options.getWindow();
    if (window === null || !this.trustedPage(window.getCurrentUrl())) return;
    window.send(APP_UPDATE_CHANGED_CHANNEL, this.copy());
  }
  private copy(): AppUpdateNoticeSnapshot {
    return { ...this.current, state: this.current.state === null ? null : { ...this.current.state } };
  }
  private trustedPage(url: string): boolean {
    return isTrustedAppUpdatePage(url, this.options.statusPageUrl, this.options.getHarnessOrigin());
  }
  private authorized(sender: AppUpdateNoticeSender): boolean {
    const window = this.options.getWindow();
    return window !== null && window.webContentsId === sender.webContentsId && sender.isMainFrame
      && this.trustedPage(sender.url) && this.trustedPage(window.getCurrentUrl());
  }
  isInstalling(): boolean { return this.current.state?.status === 'installing'; }
  snapshot(sender: AppUpdateNoticeSender): AppUpdateNoticeSnapshot | null { return this.authorized(sender) ? this.copy() : null; }
  status(sender: AppUpdateNoticeSender): ArkmeAppUpdateSnapshot | null { return this.snapshot(sender)?.state ?? null; }
  async open(sender: AppUpdateNoticeSender): Promise<boolean> {
    if (!this.authorized(sender)) return false;
    if (!hasUpdateNotice(this.current.state)) {
      await this.check(sender);
      return this.controller !== undefined;
    }
    this.publish({ ...this.current, expanded: true });
    return true;
  }
  collapse(sender: AppUpdateNoticeSender): boolean {
    if (!this.authorized(sender) || this.isInstalling()) return false;
    this.publish({ ...this.current, expanded: false });
    return true;
  }
  async check(sender: AppUpdateNoticeSender): Promise<ArkmeAppUpdateSnapshot | null> { return this.run(sender, 'prepareNow'); }
  async download(sender: AppUpdateNoticeSender): Promise<ArkmeAppUpdateSnapshot | null> { return this.run(sender, 'download'); }
  async install(sender: AppUpdateNoticeSender): Promise<ArkmeAppUpdateSnapshot | null> { return this.run(sender, 'install'); }
  async retry(sender: AppUpdateNoticeSender): Promise<ArkmeAppUpdateSnapshot | null> {
    return this.run(sender, this.current.state?.failureStage === 'download' && this.current.state.canAutoInstall ? 'download' : 'prepareNow');
  }
  private async run(sender: AppUpdateNoticeSender, operation: 'prepareNow' | 'download' | 'install'): Promise<ArkmeAppUpdateSnapshot | null> {
    if (!this.authorized(sender)) return null;
    if (this.isInstalling()) return this.status(sender);
    this.publish({ ...this.current, expanded: hasUpdateNotice(this.current.state) });
    if (this.controller === undefined) {
      this.publish({ ...this.current, actionError: '更新暂不可用，请前往官网下载最新版本' });
      return null;
    }
    try {
      const result = await this.controller[operation]();
      if (operation === 'prepareNow' && hasUpdateNotice(this.current.state)) {
        this.publish({ ...this.current, expanded: true });
      }
      return result;
    }
    catch (error) {
      this.publish({ ...this.current, actionError: error instanceof Error ? error.message : String(error) });
      return this.status(sender);
    }
  }
  openWebsite(sender: AppUpdateNoticeSender): Promise<boolean> {
    if (!this.authorized(sender) || this.isInstalling()) return Promise.resolve(false);
    if (this.websiteTask !== undefined) return this.websiteTask;
    const { actionError: _error, actionMessage: _message, ...previous } = this.current;
    this.publish({ ...previous, websiteOpening: true });
    const task = (async () => {
      try {
        await this.options.openExternal('https://jiwo.cc');
        this.publish({ ...this.current, websiteOpening: false, actionMessage: '已在浏览器打开官网，下载后请安装' });
        return true;
      } catch (error) {
        this.publish({ ...this.current, websiteOpening: false, actionError: error instanceof Error ? error.message : String(error) });
        return false;
      }
    })();
    this.websiteTask = task;
    void task.finally(() => { if (this.websiteTask === task) this.websiteTask = undefined; });
    return task;
  }
}

export function registerAppUpdateNoticeIpc(ipc: {
  handle(channel: string, handler: (sender: AppUpdateNoticeSender) => unknown): void;
}, coordinator: AppUpdateNoticeCoordinator): void {
  ipc.handle('arkme-app-update:notice', sender => coordinator.snapshot(sender));
  ipc.handle('arkme-app-update:status', sender => coordinator.status(sender));
  ipc.handle('arkme-app-update:check', sender => coordinator.check(sender));
  ipc.handle('arkme-app-update:download', sender => coordinator.download(sender));
  ipc.handle('arkme-app-update:install', sender => coordinator.install(sender));
  ipc.handle('arkme-app-update:open', sender => coordinator.open(sender));
  ipc.handle('arkme-app-update:collapse', sender => coordinator.collapse(sender));
  ipc.handle('arkme-app-update:retry', sender => coordinator.retry(sender));
  ipc.handle('arkme-app-update:open-website', sender => coordinator.openWebsite(sender));
}

export const APP_UPDATE_NOTICE_CSS = `
#arkme-desktop-update-notices {
  position: fixed; z-index: 2147483646; top: 4px; left: 50%; transform: translateX(-50%);
  /* Keep the cards at 36px, with space for shadows inside the scroll container. */
  box-sizing: border-box; width: min(584px, 100%); padding: 32px;
  max-height: calc(100vh - 8px); overflow-y: auto;
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#arkme-desktop-update-notices #arkme-runtime-update-notice {
  position: static; transform: none; order: 1; max-width: 100%;
}
#arkme-runtime-update-notice[data-app-installing="true"] button { pointer-events: none; opacity: .5; }
#arkme-app-update-notice { order: 0; width: fit-content; max-width: 100%; color: #20283b; font-size: 13px; pointer-events: auto; }
/* Floating cards overlap native header drag regions. Exclude the card, not the stack's transparent padding. */
#arkme-app-update-notice .arkme-app-update-card,
#arkme-app-update-notice .arkme-app-update-card * { -webkit-app-region: no-drag; }
#arkme-app-update-notice .arkme-app-update-card {
  display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: start; gap: 10px;
  box-sizing: border-box; padding: 13px 16px; border: 1px solid rgba(109,126,163,.18);
  border-radius: 12px; background: #fff; box-shadow: 0 8px 24px rgba(33,41,63,.14);
}
#arkme-app-update-notice .arkme-app-update-icon { color: #496ee8; font-size: 20px; line-height: 30px; text-align: center; }
#arkme-app-update-notice strong { display: block; font-size: 13px; font-weight: 600; line-height: 30px; overflow-wrap: anywhere; }
#arkme-app-update-notice p { margin: 3px 0 0; color: #68738b; line-height: 1.5; overflow-wrap: anywhere; }
#arkme-app-update-notice p:empty { display: none; }
#arkme-app-update-notice .arkme-app-update-notes { white-space: pre-wrap; max-height: 72px; overflow-y: auto; font-size: 12px; }
#arkme-app-update-notice [role="alert"] { color: #a34420; }
#arkme-app-update-notice progress { display: block; width: 100%; height: 5px; margin: 8px 0 2px; accent-color: #496ee8; }
#arkme-app-update-notice .arkme-app-update-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
#arkme-app-update-notice button { appearance: none; border: 0; border-radius: 7px; padding: 6px 9px; background: transparent; color: #65718b; font: inherit; line-height: 18px; cursor: pointer; white-space: nowrap; }
#arkme-app-update-notice button:hover { background: #eef2ff; color: #2f50c7; }
#arkme-app-update-notice button[data-primary="true"] { background: #496ee8; color: white; }
#arkme-app-update-notice button:disabled { cursor: default; opacity: .6; }
#arkme-app-update-notice button:focus-visible { outline: 2px solid #496ee8; outline-offset: 2px; }
@media (max-width: 620px) {
  #arkme-app-update-notice .arkme-app-update-card { grid-template-columns: 22px minmax(0, 1fr); }
  #arkme-app-update-notice .arkme-app-update-actions { grid-column: 2; }
}
`;

export async function installAppUpdateNoticeStyles(target: {
  getCurrentUrl(): string;
  insertCSS(css: string): Promise<unknown>;
}, statusPageUrl: string, harnessOrigin: string | null): Promise<boolean> {
  if (!isTrustedAppUpdatePage(target.getCurrentUrl(), statusPageUrl, harnessOrigin)) return false;
  await target.insertCSS(APP_UPDATE_NOTICE_CSS);
  return true;
}
