import {installScreenshotShortcut} from './screenshot-shortcut-ipc.js';
import { installScreenshotIpc } from './desktop-screenshot-ipc.js';
import { installConversationWindowIpc } from './conversation-window-ipc.js';
import { installAttachmentPreviewNative } from "./attachment-preview-native.js";
import { installLongArticleWindowIpc } from "./long-article-window-ipc.js";
import { DesktopSessionSelection } from "./session-selection.js";
import { harnessCookieHeader, type HarnessAuthSession } from "./harness-auth-session.js";
import { HarnessCookieInstaller } from "./harness-cookie-install.js";
import { HarnessPageReadiness, localHarnessMountFailure, settleHarnessPageRendering } from "./harness-page-ready.js";
import { assertPreviousHarnessExited } from "./harness-process-lifetime.js";
import { RuntimeDataTransactionStore, type RuntimeDataTransaction } from "./runtime-data-transaction.js";
import { commitRuntimeUpgrade, recoverRuntimeUpgrade, restoreFailedRuntimeTrial } from "./runtime-upgrade.js";
import { RUNTIME_CACHE_EPOCH, readPreviousRuntimeBaseline, resolveRuntimeCacheRoot } from "./runtime/cache-epoch.js";
import { createDesktopDeviceReader } from "./desktop-device.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  Menu,
  nativeImage,
  Notification,
  net,
  shell,
  type MenuItemConstructorOptions,
  type NativeImage
} from "electron";
import {
  ArkmeAppUpdateController,
  resolveSupportedAppUpdateTarget
} from "./app-update.js";
import {
  clearPendingAppUpdateInstall,
  reconcilePendingAppUpdateInstall,
  writePendingAppUpdateInstall
} from "./app-update-install-receipt.js";
import { readAppVersionCode } from "./app-version-code.js";
import { resolveArkmeAppIdentity } from "./app-identity.js";
import { createAppQuitGuard, type AppQuitGuard } from "./app-quit-guard.js";
import { installApplicationMenuForPlatform } from "./application-menu.js";
import {
  type ArkmeDeepLinkIntent,
  ArkmeDeepLinkQueue,
  createExtensionShareHarnessUrl,
  createProtocolClientRegistration,
  findArkmeDeepLink,
  parseArkmeDeepLink
} from "./deep-link.js";
import { DesktopController } from "./desktop-controller.js";
import { resolveArkmePreloadPath } from "./desktop-capabilities.js";
import { AppUpdateNoticeCoordinator, registerAppUpdateNoticeIpc, installAppUpdateNoticeStyles } from "./app-update-notice.js";
import { createElectronAppUpdater } from "./electron-app-updater.js";
import {
  startDesktopCapabilityBridge,
  type DesktopAccountScopeIdentity,
  type DesktopAccountScopePort,
  type DesktopCapabilityBridge
} from "./desktop-capability-bridge.js";
import {
  arkmePluginSupportsDesktopAccountScope,
  DshAccountScopeStore,
  type DshAccountScopeChoice,
  type DshAccountScopeLaunch
} from "./dsh-account-scope.js";
import {
  DesktopLocationPermissionService,
  registerDesktopLocationIpc
} from "./desktop-location.js";
import {
  desktopNativeNotificationAvailable,
  desktopNotificationSettingsUrl,
  DESKTOP_NOTIFICATION_PERMISSION_CHANGED_CHANNEL,
  DESKTOP_NOTIFICATION_OPEN_SETTINGS_CHANNEL,
  DESKTOP_NOTIFICATION_PERMISSION_STATE_CHANNEL,
  DESKTOP_NOTIFICATION_REFRESH_PERMISSION_CHANNEL,
  DESKTOP_NOTIFICATION_READY_CHANNEL,
  DESKTOP_NOTIFICATION_READY_V2_CHANNEL,
  DESKTOP_NOTIFICATION_RESULT_V2_CHANNEL,
  DESKTOP_NOTIFICATION_SHOW_CHANNEL,
  DESKTOP_NOTIFICATION_UNREADY_V2_CHANNEL,
  desktopNotificationDocumentNavigationInvalidatesConsumer,
  DesktopNotificationCoordinator,
  isMacNotificationsNotAllowedError,
  parseDesktopNotificationPermissionState,
  rendererReportedDesktopNotificationPermission,
  type DesktopNotificationPermissionState,
  type HarnessNotificationWindow,
  type NativeNotification
} from "./desktop-notification.js";
import { startDirectoryPickerBridge, type DirectoryPickerBridge } from "./directory-picker-bridge.js";
import {
  HarnessProcessSupervisor,
  withBundledPackageManagerEnvironment,
  type HarnessState
} from "./harness-supervisor.js";
import { installHarnessPermissionPolicy } from "./harness-permission-policy.js";
import { registerMacWindowDragRegionReinstall } from "./mac-window-drag.js";
import { MacPointerWindowDrag } from "./mac-pointer-window-drag.js";
import { MacNotificationPermissionReader } from "./macos-notification-permission.js";
import { createMacCoreLocationDriver } from "./macos-core-location.js";
import { createDesktopNativeBadgeAdapter } from "./native-badge-adapter.js";
import { NativeBadgeCoordinator } from "./native-badge.js";
import {
  RuntimeUpdateNoticeCoordinator,
  installRuntimeUpdateNoticeStyles,
  registerRuntimeUpdateNoticeIpc,
  stageRuntimeUpdateInBackground,
  type RuntimeUpdateNoticeWindow
} from "./runtime-update-notice.js";
import {
  decideNavigation,
  type AppAction
} from "./navigation-policy.js";
import {
  commitRuntimeManagedProfileTransaction,
  provisionArkmeWebProfile,
  recoverRuntimeManagedProfileTransaction,
  rollbackRuntimeManagedProfileTransaction,
  type RuntimeManagedProfileTransaction
} from "./plugin-profile.js";
import {
  readPackagedTestPluginPath,
  resolveArkmePluginPathForLaunch,
  resolveDshBinPath,
  resolveManagedExtensionRestartPaths,
  resolvePnpmBinDirectory
} from "./runtime-path.js";
import {
  ensureDefaultWorkspace,
  loadLastWorkspace,
  resolveArkmeAppDataPath,
  resolveAppUpdateInstallReceiptPath,
  resolveUserDataPath,
  saveLastWorkspace
} from "./settings.js";
import { createStatusPageUrl } from "./status-url.js";
import { lockWindowTitle } from "./window-title-policy.js";
import { createWindowsBadgeDotImage } from "./windows-badge-icon.js";
import {
  ElectronRuntimeManifestError,
  fetchElectronRuntimeManifest,
  verifyElectronRuntimePluginHealth
} from "./runtime/client.js";
import { installElectronRuntimeRelease } from "./runtime/installer.js";
import { RuntimeNetworkWaitingError } from "./runtime/download.js";
import {
  BadRuntimeReleaseBlockedError,
  ElectronRuntimeManager,
  type ResolvedElectronRuntime,
  type RuntimeInstallProgress
} from "./runtime/manager.js";
import {
  createCoalescedAsyncRenderer,
  createRuntimeProgressPageRenderer,
  RUNTIME_STATUS_PROGRESS_CHANNEL
} from "./runtime/progress-renderer.js";
import { readPackagedRuntimeServiceConfig } from "./runtime/service-config.js";
import {
  isDeterministicRuntimeArtifactError,
  runtimeArtifactFailureCode,
  RuntimePluginReadinessError
} from "./runtime/errors.js";
import {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  isAutomaticUpdateCheckEnabled,
  UPDATE_CHECK_ENABLED_ENV,
  withStartupUpdateCheckEnvironment
} from "./update-check-policy.js";


const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeServiceConfig = readPackagedRuntimeServiceConfig(moduleDirectory);
const runtimeEnvironment = runtimeServiceConfig.environment;
const packagedLocalTest = app.isPackaged
  && existsSync(path.join(process.resourcesPath, "ARKME_TEST_PLUGIN.json"));
const startupEnvironment = withStartupUpdateCheckEnvironment(
  process.env,
  app.isPackaged,
  packagedLocalTest
);
process.env[UPDATE_CHECK_ENABLED_ENV] = startupEnvironment[UPDATE_CHECK_ENABLED_ENV] ?? "1";
const automaticUpdateChecksEnabled = isAutomaticUpdateCheckEnabled(process.env);
const appIdentity = resolveArkmeAppIdentity(runtimeEnvironment, packagedLocalTest);
const statusHtmlPath = path.join(moduleDirectory, "ui", "status.html");
const statusPageUrl = pathToFileURL(statusHtmlPath).href;
const appName = appIdentity.appName;
const deepLinks = new ArkmeDeepLinkQueue();
app.setName(appName);
app.setAppUserModelId(appIdentity.appId);
const appDataPath = resolveArkmeAppDataPath(app.getPath("appData"), process.env.ARKME_APP_DATA_PATH);
app.setPath("appData", appDataPath);
app.setPath("userData", resolveUserDataPath(appDataPath, runtimeEnvironment));
const diagnosticLogPath = path.join(
  app.getPath("userData"),
  "logs",
  "desktop-startup.log"
);

function logDiagnostic(message: string, details?: unknown): void {
  const suffix = details === undefined
    ? ""
    : ` ${details instanceof Error ? details.stack ?? details.message : JSON.stringify(details)}`;
  const line = `${new Date().toISOString()} ${message}${suffix}\n`;
  void mkdir(path.dirname(diagnosticLogPath), { recursive: true })
    .then(() => appendFile(diagnosticLogPath, line, { encoding: "utf8", mode: 0o600 }))
    .catch(() => undefined);
}

registerProtocolClient();
const initialDeepLink = findArkmeDeepLink(process.argv, appIdentity.protocol);
if (initialDeepLink !== undefined) {
  deepLinks.push(initialDeepLink);
  logDiagnostic("deep-link-accepted", { source: "initial-argv" });
}

logDiagnostic("process-start", {
  argv: process.argv,
  execPath: process.execPath,
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
  automaticUpdateChecksEnabled,
  resourcesPath: process.resourcesPath
});

let mainWindow: BrowserWindow | null = null;
let macPointerWindowDrag: MacPointerWindowDrag | undefined;
let harnessAuthSession: HarnessAuthSession | null = null;
let harnessCookieInstaller: HarnessCookieInstaller | null = null;
const harnessPageReadiness = new HarnessPageReadiness();
let holdCandidateNavigation = false;
let deferredAccountScopeRelaunch = false;
let runtimeDataStore: RuntimeDataTransactionStore | null = null;
let runtimeRecoveryRequired = false;
let bufferedHarnessReadyState: Extract<HarnessState, {kind: "ready"}> | null = null;
let controller: DesktopController | null = null;
let activeHarnessOrigin: string | null = null;
let activeHarnessVersion: string | undefined;
let logPath = "";
let actionQueue: Promise<void> = Promise.resolve();
let directoryPickerBridge: DirectoryPickerBridge | null = null;
let desktopCapabilityBridge: DesktopCapabilityBridge | null = null;
const desktopSessionSelection = new DesktopSessionSelection();
let accountScopeStore: DshAccountScopeStore | null = null;
let activeAccountScope: DshAccountScopeLaunch | null = null;
let accountScopeChoices: DshAccountScopeChoice[] = [];
let accountScopeReady = false;
let accountScopeTransition: { ref: string; identity: DesktopAccountScopeIdentity } | null = null;
let accountScopeRelaunchScheduled = false;
let lastHarnessReadyState: Extract<HarnessState, { kind: "ready" }> | null = null;
let activeLaunchRuntime: LaunchRuntime | null = null;
let appUpdateController: ArkmeAppUpdateController | null = null;
let appQuitGuard: AppQuitGuard | null = null;
let desktopResumeGeneration = 0;
let desktopSuspended = false;
let lifecycleHooksInstalled = false;

let runtimeManager: ElectronRuntimeManager | null = null;
let renderRuntimeProgressPage: ReturnType<typeof createRuntimeProgressPageRenderer> | null = null;
let windowsBadgeDotImage: NativeImage | null = null;
let nativeBadgeInitialized = false;
let desktopNotificationPermission: DesktopNotificationPermissionState = Notification.isSupported()
  ? "default"
  : "unavailable";
const macNotificationPermissionReader = new MacNotificationPermissionReader(
  process.platform === "darwin" && app.isPackaged,
  undefined,
  result => { logDiagnostic("macos-notification-permission-query", result); }
);
let desktopLocationPermission: DesktopLocationPermissionService | null = null;
const runtimeProgressRenderer = createCoalescedAsyncRenderer<RuntimeInstallProgress>(async state => {
  await renderState(state).catch(error => logDiagnostic("runtime-progress-render-failed", error));
}, 100);

type AutomaticUpdateCheckSource = "startup" | "window-focus";

interface LaunchRuntime {
  dshBinPath: string;
  arkmePluginPath: string;
  packageManagerBinPath: string;
  packageManagerCliPath: string;
  runtimeManaged: boolean;
  release?: ResolvedElectronRuntime;
}

interface HarnessLaunchPaths {
  userDataPath: string;
  settingsPath: string;
  dshHome: string;
  harnessLogPath: string;
  runtimeScopeRef: string;
  accountScopeRequired: boolean;
}

const desktopAccountScopes: DesktopAccountScopePort = {
  attest: async identity => await attestDesktopAccountScope(identity),
  prepare: async identity => await prepareDesktopAccountScope(identity),
  commit: async transitionRef => await commitDesktopAccountScope(transitionRef),
  abort: async transitionRef => await abortDesktopAccountScope(transitionRef)
};

const desktopNotifications = new DesktopNotificationCoordinator({
  getHarnessOrigin: () => activeHarnessOrigin,
  getWindow: notificationWindow,
  diagnostic: (event, details) => {
    logDiagnostic(`desktop-notification-${event}`, details);
    if (event === "notification_failed" && isMacNotificationsNotAllowedError(details.error)) {
      void refreshDesktopNotificationPermission("native-not-allowed");
    }
  },
  createNotification: options => (
    desktopNotificationCapability() ? createDesktopNativeNotification(options) : undefined
  )
});

function createDesktopNativeNotification(
  { title, body }: { title: string; body: string }
): NativeNotification {
  const notification = new Notification({ title, body });
  return {
    show: () => { notification.show(); },
    close: () => { notification.close(); },
    onClick: listener => { notification.once("click", listener); },
    onShow: listener => { notification.once("show", listener); },
    onFailed: listener => {
      notification.once("failed", (_event, error) => { listener(error); });
    },
    onClose: listener => { notification.once("close", listener); }
  };
}

const nativeBadges = new NativeBadgeCoordinator(createDesktopNativeBadgeAdapter<NativeImage>({
  platform: process.platform,
  setAppBadgeCount: count => app.setBadgeCount(count),
  setMacDockBadge: text => {
    if (app.dock === undefined) throw new Error("macOS Dock is unavailable");
    app.dock.setBadge(text);
  },
  linuxBadgeSupported: () => {
    const unityCheck = (app as typeof app & { isUnityRunning?: () => boolean }).isUnityRunning;
    return unityCheck?.call(app) === true;
  },
  getWindowsWindow: () => mainWindow,
  getWindowsDotImage: windowsBadgeDot,
  windowsDescription: "Arkme 有未读消息"
}));

const appUpdateNotices = new AppUpdateNoticeCoordinator({
  statusPageUrl,
  getHarnessOrigin: () => activeHarnessOrigin,
  getWindow: () => {
    const window = mainWindow;
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return null;
    return {
      webContentsId: window.webContents.id,
      getCurrentUrl: () => window.webContents.getURL(),
      send: (channel, snapshot) => { if (!window.webContents.isDestroyed()) window.webContents.send(channel, snapshot); }
    };
  },
  openExternal: async url => { await shell.openExternal(url); }
});
registerAppUpdateNoticeIpc({
  handle(channel, handler) { ipcMain.handle(channel, event => handler(appUpdateSender(event))); }
}, appUpdateNotices);
ipcMain.on("arkme-app-update:app-version", event => {
  event.returnValue = appUpdateNotices.snapshot(appUpdateSender(event)) === null ? "" : app.getVersion();
});

const runtimeUpdateNotices = new RuntimeUpdateNoticeCoordinator({
  getHarnessOrigin: () => activeHarnessOrigin,
  getWindow: runtimeUpdateNoticeWindow,
  applicationName: appName,
  diagnostic: (event, details) => { logDiagnostic(`runtime-update-notice-${event}`, details); },
  createNotification: ({ title, body }) => {
    if (!Notification.isSupported()) return undefined;
    const notification = new Notification({ title, body });
    return {
      show: () => { notification.show(); },
      onClick: listener => { notification.once("click", listener); },
      onFailed: listener => {
        notification.once("failed", (_event, error) => { listener(error); });
      }
    };
  },
  relaunch: () => { app.relaunch(); },
  quit: () => { app.quit(); }
});

registerRuntimeUpdateNoticeIpc({
  handle(channel, handler) {
    ipcMain.handle(channel, (event, value: unknown) => {
      if (channel === "arkme:runtime-update-notice:restart" && appUpdateNotices.isInstalling()) return false;
      return handler({ senderFrame: event.senderFrame }, value);
    });
  }
}, runtimeUpdateNotices);

registerDesktopLocationIpc({
  handle(channel, handler) {
    ipcMain.handle(channel, (event, value: unknown) => handler({
      sender: { id: event.sender.id },
      senderFrame: event.senderFrame === null ? null : { url: event.senderFrame.url }
    }, value));
  }
}, {
  getActiveHarnessOrigin: () => activeHarnessOrigin,
  getMainWindow: () => {
    const window = mainWindow;
    if (window === null || window.isDestroyed()) return null;
    return {
      destroyed: false,
      focused: window.isFocused(),
      url: window.webContents.getURL(),
      webContentsId: window.webContents.id
    };
  },
  getService: () => desktopLocationPermission,
  openSettings: async () => {
    if (process.platform !== "darwin") return false;
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
    );
    return true;
  },
  diagnostic: (event, details) => { logDiagnostic(`desktop-location-${event}`, details); }
});

ipcMain.handle(DESKTOP_NOTIFICATION_SHOW_CHANNEL, (event, request: unknown) => (
  desktopNotifications.show(event.senderFrame?.url ?? "", request)
));
ipcMain.on(DESKTOP_NOTIFICATION_READY_CHANNEL, event => {
  desktopNotifications.markHarnessReady(event.senderFrame?.url ?? "");
});
ipcMain.on(DESKTOP_NOTIFICATION_READY_V2_CHANNEL, (event, value: unknown) => {
  const senderUrl = currentHarnessMainFrameUrl(event);
  if (senderUrl === undefined) return;
  desktopNotifications.markReadyV2(
    senderUrl,
    value
  );
});
ipcMain.on(DESKTOP_NOTIFICATION_UNREADY_V2_CHANNEL, (event, value: unknown) => {
  const senderUrl = currentHarnessMainFrameUrl(event);
  if (senderUrl === undefined) return;
  desktopNotifications.markUnreadyV2(
    senderUrl,
    value
  );
});
ipcMain.on(DESKTOP_NOTIFICATION_RESULT_V2_CHANNEL, (event, value: unknown) => {
  const senderUrl = currentHarnessMainFrameUrl(event);
  if (senderUrl === undefined) return;
  desktopNotifications.completeV2(
    senderUrl,
    value
  );
});
ipcMain.on(DESKTOP_NOTIFICATION_PERMISSION_STATE_CHANNEL, (event, value: unknown) => {
  const permission = parseDesktopNotificationPermissionState(value);
  if (!isCurrentHarnessSender(event.sender.id, event.senderFrame?.url ?? event.sender.getURL())
    || permission === undefined) {
    event.returnValue = false;
    return;
  }
  setDesktopNotificationPermission(rendererReportedPermission(permission), "renderer-report");
  event.returnValue = true;
});
ipcMain.handle(DESKTOP_NOTIFICATION_OPEN_SETTINGS_CHANNEL, async event => {
  if (!isCurrentHarnessSender(event.sender.id, event.senderFrame?.url ?? event.sender.getURL())) return false;
  const settingsUrl = desktopNotificationSettingsUrl(process.platform, appIdentity.appId);
  if (settingsUrl === undefined) return false;
  try {
    await shell.openExternal(settingsUrl);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle(DESKTOP_NOTIFICATION_REFRESH_PERMISSION_CHANNEL, async event => {
  if (!isCurrentHarnessSender(event.sender.id, event.senderFrame?.url ?? event.sender.getURL())) {
    return "unavailable" satisfies DesktopNotificationPermissionState;
  }
  return await refreshDesktopNotificationPermission("renderer-refresh");
});
ipcMain.on("arkme-desktop:attention-capabilities", event => {
  event.returnValue = {
    schemaVersion: 1,
    notificationShow: desktopNotificationCapability(),
    notificationPermission: desktopNotificationReportedPermission(),
    badgeMode: nativeBadges.mode
  };
});
ipcMain.on("arkme-runtime:page-ready-nonce", event => {
  event.returnValue = harnessPageReadiness.nonce(appUpdateSender(event));
});
ipcMain.on("arkme-runtime:page-ready", (event, nonce: unknown) => {
  harnessPageReadiness.accept(appUpdateSender(event), nonce);
});
ipcMain.on("arkme-runtime:harness-version", event => {
  event.returnValue = activeHarnessVersion ?? null;
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  registerApplicationLifecycle();
  void app.whenReady().then(() => bootstrap()).catch(showFatalBootstrapError);
}

function registerApplicationLifecycle(): void {
  appQuitGuard = createAppQuitGuard({
    stopHarness: stopHarnessForExit,
    closeDirectoryPicker: closeDirectoryPickerForExit,
    closeDesktopCapabilities: closeDesktopCapabilitiesForExit,
    clearNativeBadge: clearNativeBadgeForExit,
    quit: () => app.quit(),
    onStopError: (error: unknown) => {
      console.error("Failed to stop Harness cleanly", error);
    },
    onCloseError: (error: unknown) => {
      console.error("Failed to close directory picker bridge", error);
    },
    onDesktopCapabilitiesCloseError: (error: unknown) => {
      console.error("Failed to close desktop capability bridge", error);
    },
    onBadgeClearError: (error: unknown) => {
      console.error("Failed to clear the native badge", error);
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const accepted = acceptDeepLink(url);
    logDiagnostic("deep-link-received", { source: "open-url", accepted });
  });

  app.on("second-instance", (_event, commandLine) => {
    const intent = findArkmeDeepLink(commandLine, appIdentity.protocol);
    if (intent !== undefined) {
      acceptDeepLinkIntent(intent);
      logDiagnostic("deep-link-accepted", { source: "second-instance" });
    }
    focusMainWindow();
  });

  app.on("activate", () => {
    void refreshDesktopNotificationPermission("app-activate");
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (longArticleWindows.requestQuit(() => app.quit())) { event.preventDefault(); return; }
    appQuitGuard?.handleBeforeQuit(event);
  });
  app.on("will-quit", () => {
    desktopLocationPermission?.dispose();
    desktopLocationPermission = null;
  });
}

async function stopHarnessForExit(): Promise<void> {
  if (longArticleWindows.size > 0) throw new Error("请先保存并关闭长文窗口，再重试更新或退出");
  desktopSessionSelection.invalidate();
  await desktopSessionSelection.flush();
  await controller?.stop("quit");
  await harnessCookieInstaller?.idle();
}

async function closeDirectoryPickerForExit(): Promise<void> {
  await directoryPickerBridge?.close();
}

async function closeDesktopCapabilitiesForExit(): Promise<void> {
  await desktopCapabilityBridge?.close();
}

function clearNativeBadgeForExit(): void {
  nativeBadges.clearNative();
}

function registerProtocolClient(): void {
  const defaultApp = Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp);
  const registration = createProtocolClientRegistration(
    defaultApp,
    process.execPath,
    process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]),
    appIdentity.protocol
  );
  const registered = "executable" in registration
    ? app.setAsDefaultProtocolClient(registration.scheme, registration.executable, registration.args)
    : app.setAsDefaultProtocolClient(registration.scheme);
  if (!registered) logDiagnostic("protocol-registration-failed", { scheme: registration.scheme });
}

function acceptDeepLink(raw: string): boolean {
  const intent = parseArkmeDeepLink(raw, appIdentity.protocol);
  if (intent === undefined) return false;
  acceptDeepLinkIntent(intent);
  return true;
}

function acceptDeepLinkIntent(intent: ArkmeDeepLinkIntent): void {
  deepLinks.push(intent);
  if (app.isReady()) enqueueAction(deliverPendingDeepLink);
}

function focusMainWindow(): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function deliverPendingDeepLink(): Promise<void> {
  const intent = deepLinks.peek();
  const window = mainWindow;
  if (intent === undefined || activeHarnessOrigin === null || window === null || window.isDestroyed()) return;
  await window.loadURL(createExtensionShareHarnessUrl(activeHarnessOrigin, intent));
  deepLinks.markDelivered(intent);
  focusMainWindow();
}

async function bootstrap(manualRetry = false): Promise<void> {
  logDiagnostic("bootstrap-start");
  if (!lifecycleHooksInstalled) {
    lifecycleHooksInstalled = true;
    powerMonitor.on("suspend", () => {
      desktopSuspended = true;
      logDiagnostic("system-suspend", { resumeGeneration: desktopResumeGeneration });
    });
    powerMonitor.on("resume", () => {
      desktopSuspended = false;
      desktopResumeGeneration += 1;
      logDiagnostic("system-resume", { resumeGeneration: desktopResumeGeneration });
    });
  }
  await refreshDesktopNotificationPermission("bootstrap");
  desktopLocationPermission ??= new DesktopLocationPermissionService({
    platform: process.platform,
    createMacDriver: createMacCoreLocationDriver,
    diagnostic: (event, error) => { logDiagnostic(`desktop-location-${event}`, error); }
  });
  if (mainWindow === null) createMainWindow();
  const currentVersionCode = await readAppVersionCode(path.join(app.getAppPath(), "package.json"));
  if (appUpdateController === null) await installAppUpdateController(currentVersionCode);
  checkAppUpdateIfStale("startup");
  if (!nativeBadgeInitialized) {
    nativeBadgeInitialized = true;
    nativeBadges.clearNative();
  }
  const userDataPath = app.getPath("userData");
  await assertPreviousHarnessExited(path.join(userDataPath, "runtime-process.json"));
  let runtime = await resolveLaunchRuntime(userDataPath, currentVersionCode, manualRetry);
  await configureAccountScopeForRuntime(userDataPath, runtime);
  lastHarnessReadyState = null;
  if (desktopCapabilityBridge === null) {
    desktopCapabilityBridge = await startDesktopCapabilityBridge({
      notifications: desktopNotifications,
      notificationSupported: desktopNotificationCapability,
      badges: nativeBadges,
      lifecycle: () => ({ resumeGeneration: desktopResumeGeneration, suspended: desktopSuspended }),
      accountScopes: desktopAccountScopes
    });
    logDiagnostic("desktop-capability-bridge-started", { badgeMode: nativeBadges.mode });
  }
  const accountScope = activeAccountScope;
  if (accountScope === null) throw new Error("DSH account scope is unavailable");
  logPath = diagnosticLogPath;
  await recoverRuntimeManagedProfileTransaction(accountScope.dshHome, runtimeEnvironment);
  logDiagnostic("runtime-paths", { userDataPath, ...runtime, statusHtmlPath });
  if (directoryPickerBridge === null) {
    directoryPickerBridge = await startDirectoryPickerBridge(showDirectoryDialog);
  }
  runtime = await launchHarnessRuntime(runtime, accountScopeLaunchPaths(userDataPath, accountScope));
  activeLaunchRuntime = runtime;
  finishRuntimeBootstrap(accountScope.logPath);
}

async function configureAccountScopeForRuntime(
  userDataPath: string,
  runtime: LaunchRuntime
): Promise<void> {
  desktopSessionSelection.invalidate();
  const store = new DshAccountScopeStore(userDataPath, undefined, async (source, target) => {
    await runtimeDataStore?.transferCommittedIdentity(source, target);
  });
  if (await arkmePluginSupportsDesktopAccountScope(runtime.arkmePluginPath)) {
    accountScopeStore = store;
    activeAccountScope = await store.launch({deferLegacyMigration: runtime.runtimeManaged});
    accountScopeReady = false;
    return;
  }
  if (await store.configured()) {
    throw new Error("当前 Arkme 运行环境不支持已启用的 DSH 账号会话隔离");
  }
  accountScopeStore = null;
  accountScopeChoices = [];
  activeAccountScope = await store.legacyLaunch();
  accountScopeReady = true;
}

async function attestDesktopAccountScope(
  identity: DesktopAccountScopeIdentity
): Promise<{ status: "ready" | "relaunch" }> {
  if (accountScopeTransition !== null) throw new Error("DSH account scope transition is already active");
  const store = accountScopeStore;
  if (store === null) throw new Error("DSH account scope store is unavailable");
  // Reconciliation only plans legacy moves. The stopped-process relaunch owns
  // the actual rename, including recovery after commit but before migration.
  const result = await store.reconcile(identity, {deferLegacyMigration: true});
  activeAccountScope = result.launch;
  accountScopeReady = result.status === "ready";
  if (accountScopeReady) {
    await refreshAccountScopeMenu();
    await revealAttestedHarness();
  }
  else {
    await renderAccountScopeWaiting();
    scheduleAccountScopeRelaunch();
  }
  return { status: result.status };
}

async function prepareDesktopAccountScope(
  identity: DesktopAccountScopeIdentity
): Promise<{ transitionRef: string }> {
  if (accountScopeTransition !== null) throw new Error("DSH account scope transition is already active");
  const transitionRef = `scope-transition-${randomUUID()}`;
  accountScopeTransition = { ref: transitionRef, identity };
  accountScopeReady = false;
  await renderAccountScopeWaiting();
  return { transitionRef };
}

async function commitDesktopAccountScope(
  transitionRef: string
): Promise<{ status: "ready" | "relaunch" }> {
  const transition = accountScopeTransition;
  const store = accountScopeStore;
  if (transition === null || transition.ref !== transitionRef || store === null) {
    throw new Error("DSH account scope transition is stale");
  }
  const result = await store.reconcile(transition.identity, {deferLegacyMigration: true});
  accountScopeTransition = null;
  activeAccountScope = result.launch;
  accountScopeReady = result.status === "ready";
  if (accountScopeReady) {
    await refreshAccountScopeMenu();
    await revealAttestedHarness();
  }
  else scheduleAccountScopeRelaunch();
  return { status: result.status };
}

async function abortDesktopAccountScope(transitionRef: string): Promise<{ status: "ready" }> {
  if (accountScopeTransition?.ref !== transitionRef) throw new Error("DSH account scope transition is stale");
  accountScopeTransition = null;
  accountScopeReady = true;
  await revealAttestedHarness();
  return { status: "ready" };
}

async function revealAttestedHarness(): Promise<void> {
  if (lastHarnessReadyState !== null) await renderState(lastHarnessReadyState);
}

async function renderAccountScopeWaiting(): Promise<void> {
  desktopSessionSelection.invalidate();
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return;
  activeHarnessOrigin = null;
  desktopNotifications.markHarnessLoading();
  const workspacePath = lastHarnessReadyState?.workspacePath ?? controller?.getCurrentWorkspace() ?? "";
  await window.loadURL(createStatusPageUrl(
    statusHtmlPath,
    { kind: "starting", workspacePath },
    runtimeEnvironment
  ));
  if (!window.isVisible()) window.show();
}

function scheduleAccountScopeRelaunch(): void {
  // Attestation may register an account during the trial, but moving its data
  // directory must wait until the verified runtime and snapshot commit together.
  if (holdCandidateNavigation) {
    deferredAccountScopeRelaunch = true;
    return;
  }
  if (accountScopeRelaunchScheduled) return;
  accountScopeRelaunchScheduled = true;
  setTimeout(() => {
    enqueueAction(async () => {
      try { await switchAccountScopeRuntime(); }
      finally { accountScopeRelaunchScheduled = false; }
    });
  }, 50);
}

async function switchAccountScopeRuntime(): Promise<void> {
  desktopSessionSelection.invalidate();
  const store = accountScopeStore;
  const runtime = activeLaunchRuntime;
  if (store === null || runtime === null) throw new Error("DSH account scope runtime is unavailable");
  await controller?.stop("restart");
  controller = null;
  activeHarnessOrigin = null;
  accountScopeReady = false;
  lastHarnessReadyState = null;
  const scope = await store.launch();
  activeAccountScope = scope;
  logPath = scope.logPath;
  await recoverRuntimeManagedProfileTransaction(scope.dshHome, runtimeEnvironment);
  activeLaunchRuntime = await launchHarnessRuntime(
    runtime,
    accountScopeLaunchPaths(app.getPath("userData"), scope)
  );
}

function accountScopeLaunchPaths(
  userDataPath: string,
  scope: DshAccountScopeLaunch
): HarnessLaunchPaths {
  return {
    userDataPath,
    settingsPath: scope.settingsPath,
    dshHome: scope.dshHome,
    harnessLogPath: scope.logPath,
    runtimeScopeRef: scope.runtimeScopeRef,
    accountScopeRequired: accountScopeStore !== null
  };
}

function desktopNotificationCapability(): boolean {
  return desktopNativeNotificationAvailable(
    process.platform,
    Notification.isSupported(),
    desktopNotificationPermission,
    app.isPackaged
  );
}

function desktopNotificationReportedPermission(): DesktopNotificationPermissionState {
  return process.platform === "darwin" && !app.isPackaged
    ? "unavailable"
    : desktopNotificationPermission;
}

function rendererReportedPermission(
  permission: DesktopNotificationPermissionState
): DesktopNotificationPermissionState {
  return rendererReportedDesktopNotificationPermission(
    process.platform,
    desktopNotificationPermission,
    permission
  );
}

function setDesktopNotificationPermission(
  permission: DesktopNotificationPermissionState,
  source: string
): void {
  if (!Notification.isSupported()) permission = "unavailable";
  if (permission === desktopNotificationPermission) return;
  desktopNotificationPermission = permission;
  logDiagnostic("desktop-notification-permission", { permission, source });
  const window = mainWindow;
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(DESKTOP_NOTIFICATION_PERMISSION_CHANGED_CHANNEL, permission);
  }
}

async function refreshDesktopNotificationPermission(
  source: string
): Promise<DesktopNotificationPermissionState> {
  if (process.platform !== "darwin") return desktopNotificationPermission;
  const permission = await macNotificationPermissionReader.refresh();
  setDesktopNotificationPermission(permission, source);
  return permission;
}

function isCurrentHarnessSender(webContentsId: number, senderUrl: string): boolean {
  if (activeHarnessOrigin === null || mainWindow === null || mainWindow.isDestroyed()
    || mainWindow.webContents.id !== webContentsId) return false;
  try { return new URL(senderUrl).origin === activeHarnessOrigin; }
  catch { return false; }
}

function currentHarnessMainFrameUrl(event: Electron.IpcMainEvent): string | undefined {
  const senderFrame = event.senderFrame;
  if (senderFrame === null || senderFrame !== event.sender.mainFrame) return undefined;
  return isCurrentHarnessSender(event.sender.id, senderFrame.url) ? senderFrame.url : undefined;
}

ipcMain.on("arkme-desktop:window-drag", (event, message: unknown) => {
  if (currentHarnessMainFrameUrl(event) !== undefined) macPointerWindowDrag?.accept(message);
});

async function launchHarnessRuntime(
  initialRuntime: LaunchRuntime,
  paths: HarnessLaunchPaths,
  reloadingBadRelease = false
): Promise<LaunchRuntime> {
  let runtime = initialRuntime;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const initialAccountScope = activeAccountScope;
    let profileTransaction: RuntimeManagedProfileTransaction | undefined;
    let dataTransaction: RuntimeDataTransaction | undefined;
    let candidateCompleted = false;
    holdCandidateNavigation = runtime.release?.probation === true
      || (runtime.runtimeManaged && paths.accountScopeRequired && paths.runtimeScopeRef === "web:legacy");
    bufferedHarnessReadyState = null;
    deferredAccountScopeRelaunch = false;
    try {
      if (runtime.release !== undefined) {
        if (runtimeDataStore === null) throw new Error("Runtime data transaction store unavailable");
        dataTransaction = await runtimeDataStore.begin({
          dshHome: paths.dshHome,
          releaseId: runtime.release.releaseId,
          harnessIdentity: runtime.release.manifest.artifacts.harness.sha256,
          registry: [path.join(paths.userDataPath, "dsh-account-scopes.json"), paths.settingsPath],
          allowHarnessTransition: runtime.release.probation
        });
        holdCandidateNavigation ||= dataTransaction !== undefined;
      }
      await initializeHarnessRuntime(
        runtime,
        paths,
        transaction => { profileTransaction = transaction; }
      );
      if (holdCandidateNavigation && runtime.release !== undefined) {
        const authenticated = harnessAuthSession;
        if (authenticated === null || authenticated.signal.aborted) throw new Error("Harness authentication unavailable");
        await verifyElectronRuntimePluginHealth(
          authenticated.url,
          runtime.release.manifest.artifacts.requiredPlugin.version,
          fetch,
          {headers: {cookie: harnessCookieHeader(authenticated)}, signal: authenticated.signal}
        );
        await validateCandidateHarnessPage(runtime, authenticated);
      }
      const commitProfile = async () => {
        if (profileTransaction === undefined) return;
        await commitRuntimeManagedProfileTransaction(profileTransaction);
        profileTransaction = undefined;
      };
      const commitRelease = async () => {
        if (runtime.release?.probation !== true) return;
        if (runtimeManager === null) throw new Error("Runtime manager unavailable");
        await runtimeManager.completeCandidate();
        candidateCompleted = true;
        logDiagnostic("runtime-candidate-complete", { releaseId: runtime.release.releaseId });
      };
      if (dataTransaction !== undefined) {
        await commitRuntimeUpgrade(dataTransaction, {commitProfile, commitRelease});
      } else {
        await commitProfile();
        await commitRelease();
      }
      if (runtime.release?.probation === true) {
        runtime = launchRuntimeFromRelease({...runtime.release, probation: false});
      }
      await releaseCandidateHarnessNavigation();
      runtimeRecoveryRequired = false;
      return runtime;
    } catch (error) {
      holdCandidateNavigation = false;
      bufferedHarnessReadyState = null;
      deferredAccountScopeRelaunch = false;
      runtimeRecoveryRequired = true;
      activeHarnessOrigin = null;
      const restored = await restoreFailedRuntimeTrial(dataTransaction, {
        stopHarness: async () => {
          await controller?.stop("failure");
          controller = null;
        },
        rollbackProfile: async () => {
          if (profileTransaction === undefined) return;
          await rollbackRuntimeManagedProfileTransaction(profileTransaction);
          profileTransaction = undefined;
        }
      });
      if (!restored) throw error;
      activeAccountScope = initialAccountScope;
      accountScopeTransition = null;
      accountScopeReady = accountScopeStore === null;
      if (runtime.release?.probation !== true || runtimeManager === null) throw error;
      if (candidateCompleted) throw error;
      const failedReleaseId = runtime.release.releaseId;
      const reason = error instanceof Error ? error.message : String(error);
      const artifactFailure = isDeterministicRuntimeArtifactError(error);
      const fallback = artifactFailure
        ? await runtimeManager.quarantineCandidate({
          code: runtimeArtifactFailureCode(error),
          reason
        })
        : await runtimeManager.rollbackCandidate({
          phase: error instanceof RuntimePluginReadinessError ? "plugin-health" : "unknown",
          scope: error instanceof RuntimePluginReadinessError ? "artifact" : "unknown",
          code: error instanceof RuntimePluginReadinessError ? error.code : "RUNTIME_START_FAILED",
          reason
        });
      if (fallback === undefined) {
        if (artifactFailure || reloadingBadRelease) {
          throw new BadRuntimeReleaseBlockedError(
            failedReleaseId,
            runtimeEnvironment,
            reason
          );
        }
        throw error;
      }
      runtime = launchRuntimeFromRelease(fallback);
      logDiagnostic("runtime-candidate-rollback", { failed: failedReleaseId, fallback: fallback.releaseId });
    }
  }
  throw new Error("Electron runtime fallback could not be started");
}

function finishRuntimeBootstrap(harnessLogPath: string): void {
  logPath = harnessLogPath;
  installApplicationMenu();
  void refreshAccountScopeMenu().catch(error => logDiagnostic("account-scope-menu-failed", error));
  checkRuntimeUpdateIfStale("startup");
}

async function resolveLaunchRuntime(userDataPath: string, shellVersionCode: number, manualRetry = false): Promise<LaunchRuntime> {
  if (!app.isPackaged) {
    const dshBinPath = resolveDshBinPath(false, process.resourcesPath, import.meta.url);
    const packageManagerBinPath = resolvePnpmBinDirectory(false, process.resourcesPath, import.meta.url);
    return {
      dshBinPath,
      arkmePluginPath: await resolveArkmePluginPathForLaunch(false, process.resourcesPath, import.meta.url),
      packageManagerBinPath,
      packageManagerCliPath: path.join(packageManagerBinPath, "..", "pnpm", "bin", "pnpm.cjs"),
      runtimeManaged: false
    };
  }
  const packagedTestPluginPath = await readPackagedTestPluginPath(process.resourcesPath);
  if (packagedTestPluginPath !== undefined) {
    const dshBinPath = resolveDshBinPath(true, process.resourcesPath, import.meta.url);
    const packageManagerBinPath = resolvePnpmBinDirectory(true, process.resourcesPath, import.meta.url);
    return {
      dshBinPath,
      arkmePluginPath: packagedTestPluginPath,
      packageManagerBinPath,
      packageManagerCliPath: path.join(packageManagerBinPath, "..", "pnpm", "bin", "pnpm.cjs"),
      runtimeManaged: false
    };
  }
  const electronMajor = Number.parseInt(process.versions.electron?.split(".")[0] ?? "", 10);
  const modulesAbi = Number.parseInt(process.versions.modules, 10);
  if (electronMajor !== 43 || modulesAbi !== 148) {
    throw new Error(`Electron runtime requires Electron 43 / ABI 148, received ${process.versions.electron} / ${process.versions.modules}`);
  }
  const root = resolveRuntimeCacheRoot(userDataPath);
  const runtimeServiceBaseUrl = runtimeServiceConfig.serviceBaseUrl;
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => (
    net.fetch(typeof input === "string" ? input : input instanceof URL ? input.href : input, init)
  )) as unknown as typeof fetch;
  runtimeManager = new ElectronRuntimeManager({
    root,
    cacheEpoch: RUNTIME_CACHE_EPOCH,
    environment: runtimeEnvironment,
    manifestContext: {
      os: process.platform === "win32" ? "windows" : process.platform,
      arch: process.arch,
      shellVersion: app.getVersion(),
      electronMajor,
      modulesAbi
    },
    readInitialBaseline: () => readPreviousRuntimeBaseline(userDataPath, runtimeEnvironment, {
      os: process.platform === "win32" ? "windows" : process.platform,
      arch: process.arch,
      shellVersion: app.getVersion(),
      electronMajor,
      modulesAbi
    }),
    fetchManifest: baseline => fetchElectronRuntimeManifest({
      serviceBaseUrl: runtimeServiceBaseUrl,
      platform: process.platform,
      arch: process.arch,
      shellVersion: app.getVersion(),
      electronMajor,
      modulesAbi,
      shellVersionCode,
      ...(baseline === undefined ? {} : { baseline }),
      fetcher
    }),
    installRelease: async (manifest, stagingPath, progress) => {
      await installElectronRuntimeRelease(manifest, stagingPath, {
        downloadsPath: path.join(root, "downloads"),
        fetcher,
        ...(progress === undefined ? {} : { onProgress: progress })
      });
    }
  });
  runtimeDataStore = new RuntimeDataTransactionStore({userDataPath, environment: runtimeEnvironment});
  await recoverRuntimeUpgrade(runtimeDataStore, {
    commitProfile: async (dshHome, releaseId) => {
      await recoverRuntimeManagedProfileTransaction(dshHome, runtimeEnvironment, {commitReleaseId: releaseId});
    },
    commitRelease: async releaseId => {
      if (runtimeManager === null) throw new Error("Runtime manager unavailable");
      await runtimeManager.recoverCommittedCandidate(releaseId);
    }
  });
  let release: ResolvedElectronRuntime;
  try {
    release = await runtimeManager.prepareForLaunch(state => runtimeProgressRenderer.schedule(state), {manualRetry});
  } finally {
    await runtimeProgressRenderer.flush();
  }
  return launchRuntimeFromRelease(release);
}

function launchRuntimeFromRelease(release: ResolvedElectronRuntime): LaunchRuntime {
  return {
    dshBinPath: release.dshBinPath,
    arkmePluginPath: release.pluginPath,
    packageManagerBinPath: release.packageManagerBinPath,
    packageManagerCliPath: release.packageManagerCliPath,
    runtimeManaged: true,
    release
  };
}

async function initializeHarnessRuntime(
  runtime: LaunchRuntime,
  paths: HarnessLaunchPaths,
  onProfileTransaction: (transaction: RuntimeManagedProfileTransaction | undefined) => void
): Promise<void> {
  const packageManagerCommand = path.join(
    runtime.packageManagerBinPath,
    process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  );
  await Promise.all([
    access(runtime.dshBinPath),
    access(path.join(runtime.arkmePluginPath, "lib", "index.js")),
    access(packageManagerCommand),
    access(runtime.packageManagerCliPath)
  ]);
  const dshVersion = await readDshPackageVersion(runtime.dshBinPath);
  const supportsAccountScope = await arkmePluginSupportsDesktopAccountScope(runtime.arkmePluginPath);
  if (supportsAccountScope !== paths.accountScopeRequired) {
    throw new Error("Harness fallback changed the DSH account-scope capability");
  }
  activeHarnessVersion = runtime.release?.manifest.artifacts.harness.version ?? dshVersion;
  const packageManagerEnvironment = withBundledPackageManagerEnvironment(
    startupEnvironment,
    runtime.packageManagerBinPath,
    process.execPath,
    runtime.packageManagerCliPath
  );
  const provisionedProfile = await provisionArkmeWebProfile({
    dshHome: paths.dshHome,
    environment: runtimeEnvironment,
    pluginDir: runtime.arkmePluginPath,
    appVersion: app.getVersion(),
    ...(dshVersion === undefined ? {} : { dshVersion }),
    runtimeManaged: runtime.runtimeManaged,
    ...(runtime.release === undefined ? {} : { runtimeReleaseId: runtime.release.releaseId }),
    ...(runtime.runtimeManaged ? {} : { packageManager: {
      executable: process.execPath,
      prefixArgs: [runtime.packageManagerCliPath],
      installArgs: ["--frozen-lockfile=false"],
      environment: packageManagerEnvironment
    } })
  });
  onProfileTransaction(provisionedProfile.runtimeTransaction);
  logDiagnostic("profile-ready", { dshHome: paths.dshHome, source: runtime.runtimeManaged ? "release-set" : "development" });
  const supervisor = new HarnessProcessSupervisor({
    processGuard: {
      modulePath: path.join(path.dirname(resolveArkmePreloadPath(
        moduleDirectory, app.isPackaged, process.resourcesPath
      )), "harness-process-lifetime.js"),
      receiptPath: path.join(paths.userDataPath, "runtime-process.json")
    },
    onAuthenticated: async authenticated => {
      if (harnessCookieInstaller === null) throw new Error("Harness browser session unavailable");
      await harnessCookieInstaller.install(authenticated);
      authenticated.signal.throwIfAborted();
      harnessAuthSession = authenticated;
      authenticated.signal.addEventListener("abort", () => {
        if (harnessAuthSession === authenticated) harnessAuthSession = null;
      }, {once:true});
    },
    execPath: process.execPath,
    dshBinPath: runtime.dshBinPath,
    dshHome: paths.dshHome,
    logPath: paths.harnessLogPath,
    packageManagerBinPath: runtime.packageManagerBinPath,
    packageManagerCliPath: runtime.packageManagerCliPath,
    inheritedEnv: {
      ...packageManagerEnvironment,
      ARKME_APP_VERSION: app.getVersion(),
      ...(paths.accountScopeRequired ? {
        ARKME_ACCOUNT_SCOPE_REQUIRED: "1",
        ARKME_DSH_RUNTIME_SCOPE_REF: paths.runtimeScopeRef
      } : {}),
      ...(runtime.runtimeManaged ? { ARKME_RUNTIME_MANAGED: "1" } : {}),
      ...(runtime.release === undefined ? {} : { ARKME_RUNTIME_RELEASE_ID: runtime.release.releaseId })
    },
    managedRestart: resolveManagedExtensionRestartPaths(
      runtime.arkmePluginPath,
      paths.dshHome,
      runtime.release?.releaseId
    ),
    optionalExtensionRecovery: {
      dshHome: paths.dshHome,
      environment: runtimeEnvironment,
      ...(runtime.release === undefined ? {} : { runtimeReleaseId: runtime.release.releaseId })
    },
    ...(directoryPickerBridge === null ? {} : { directoryPickerBridge }),
    ...(desktopCapabilityBridge === null ? {} : { desktopCapabilityBridge })
  });
  controller = new DesktopController(supervisor, {
    chooseWorkspace,
    ensureDefaultWorkspace: () => ensureDefaultWorkspace(paths.userDataPath),
    loadWorkspace: () => loadLastWorkspace(paths.settingsPath),
    renderState,
    saveWorkspace: workspacePath => saveLastWorkspace(paths.settingsPath, workspacePath)
  });
  const initialized = await controller.initialize();
  logDiagnostic("controller-initialized", { initialized });
  if (!initialized) throw new Error("Harness controller initialization was cancelled");
}

/** The visible status page stays in place until all candidate commits succeed. */
async function releaseCandidateHarnessNavigation(): Promise<void> {
  holdCandidateNavigation = false;
  const ready = bufferedHarnessReadyState;
  bufferedHarnessReadyState = null;
  if (ready !== null) await renderState(ready);
  if (deferredAccountScopeRelaunch) {
    deferredAccountScopeRelaunch = false;
    scheduleAccountScopeRelaunch();
  }
}

async function validateCandidateHarnessPage(runtime: LaunchRuntime, authenticated: HarnessAuthSession): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(runtime.arkmePluginPath, "package.json"), "utf8")) as {
    arkme?: {desktopHarnessReady?: {version?: unknown}}
  };
  if (pkg.arkme?.desktopHarnessReady?.version !== 1) {
    throw new RuntimePluginReadinessError();
  }
  const window = mainWindow;
  if (window === null || window.isDestroyed()) throw new Error("Harness browser unavailable");
  const trial = new BrowserWindow({show: false, webPreferences: {
    backgroundThrottling: false,
    session: window.webContents.session,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    preload: resolveArkmePreloadPath(moduleDirectory, app.isPackaged, process.resourcesPath)
  }});
  const probeAbort = new AbortController();
  const trialSignal = AbortSignal.any([authenticated.signal, probeAbort.signal]);
  const probe = harnessPageReadiness.arm(trial.webContents.id, authenticated.url,
    trialSignal);
  // Handle early abort/rejection while loadURL is still in flight.
  void probe.ready.catch(() => undefined);
  const origin = new URL(authenticated.url).origin;
  let documentGeneration = 0;
  let localMountError: Error | undefined;
  trial.webContents.on("console-message", (_event, level, message) => {
    const failure = localHarnessMountFailure(level, message);
    if (failure === undefined) return;
    localMountError = failure;
    probeAbort.abort();
  });
  trial.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      documentGeneration += 1;
      harnessPageReadiness.navigation(trial.webContents.id);
    }
  });
  const guard = (event: Electron.Event, url: string) => {
    try { if (new URL(url).origin === origin) return; } catch { /* Reject malformed navigation. */ }
    event.preventDefault();
    probeAbort.abort();
  };
  trial.webContents.on("will-navigate", guard);
  trial.webContents.on("will-redirect", guard);
  trial.webContents.on("will-attach-webview", event => event.preventDefault());
  trial.webContents.setWindowOpenHandler(() => ({action: "deny"}));
  trial.webContents.on("render-process-gone", () => probeAbort.abort());
  trial.webContents.on("preload-error", () => probeAbort.abort());
  trial.once("closed", () => probeAbort.abort());
  try {
    if (activeAccountScope === null || !await desktopSessionSelection.prepare(
      trial.webContents.id, authenticated.url, activeAccountScope, false
    )) throw new Error("DSH trial session selection was superseded");
    await Promise.all([trial.loadURL(authenticated.url), probe.ready]);
    const verifiedGeneration = documentGeneration;
    await settleHarnessPageRendering(script => trial.webContents.executeJavaScript(script), trialSignal);
    if (documentGeneration !== verifiedGeneration) throw new Error("Harness page changed during validation");
    trialSignal.throwIfAborted();
    authenticated.signal.throwIfAborted();
  } catch (error) {
    throw localMountError ?? error;
  } finally {
    desktopSessionSelection.invalidate(trial.webContents.id);
    probe.dispose();
    if (!trial.isDestroyed()) trial.destroy();
  }
}

async function readDshPackageVersion(dshBinPath: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(path.dirname(dshBinPath), "..", "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.trim() !== ""
      ? manifest.version.trim()
      : undefined;
  } catch (error) {
    logDiagnostic("dsh-version-read-failed", error);
    return undefined;
  }
}

async function installAppUpdateController(currentVersionCode: number): Promise<void> {
  if (packagedLocalTest) return;
  const target = resolveSupportedAppUpdateTarget(process.platform, process.arch);
  if (target === null) return;
  const receiptPath = resolveAppUpdateInstallReceiptPath(app.getPath("userData"));
  const reconciliation = await reconcilePendingAppUpdateInstall(receiptPath, currentVersionCode);
  if (reconciliation.outcome !== "none") {
    logDiagnostic(`app-update-install-${reconciliation.outcome}`, reconciliation.target);
  }
  const inAppInstallSupported = app.isPackaged
    && (target.platform === "darwin" || target.platform === "win32");
  appUpdateController = new ArkmeAppUpdateController({
    currentVersion: app.getVersion(),
    currentVersionCode,
    serviceBaseUrl: runtimeServiceConfig.serviceBaseUrl,
    platform: target.platform,
    arch: target.arch,
    ...(reconciliation.outcome === "incomplete"
      ? { previousInstallFailure: reconciliation.target }
      : {}),
    ...(inAppInstallSupported ? {
      createUpdater: (feedURL: string, targetVersion: string) => createElectronAppUpdater(
        target.platform as "darwin" | "win32",
        feedURL,
        targetVersion
      ),
      installUpdate: async (installTarget: { version: string; versionCode: number }, launchInstaller: () => void) => {
        await writePendingAppUpdateInstall(receiptPath, installTarget);
        try {
          await stopHarnessForExit();
          await closeDirectoryPickerForExit().catch(error => logDiagnostic("app-update-directory-picker-close-failed", error));
          await closeDesktopCapabilitiesForExit().catch(error => logDiagnostic("app-update-desktop-capabilities-close-failed", error));
          clearNativeBadgeForExit();
          appQuitGuard?.allowImmediateQuit();
          try {
            launchInstaller();
          } catch (error) {
            appQuitGuard?.restoreGuardedQuit();
            throw error;
          }
        } catch (error) {
          await clearPendingAppUpdateInstall(receiptPath).catch(clearError => {
            logDiagnostic("app-update-install-receipt-clear-failed", clearError);
          });
          throw error;
        }
      }
    } : {})
  });
  appUpdateNotices.attach(appUpdateController);
  appUpdateController.subscribe(snapshot => {
    if (snapshot.status === "failed" && snapshot.failureStage === "install") appQuitGuard?.restoreGuardedQuit();
    if (snapshot.status !== "downloading") logDiagnostic("app-update-state", {
      status: snapshot.status, versionCode: snapshot.latestVersionCode, failureStage: snapshot.failureStage, error: snapshot.error
    });
  });
}

function checkAutomaticUpdates(source: AutomaticUpdateCheckSource): void {
  checkAppUpdateIfStale(source);
  checkRuntimeUpdateIfStale(source);
}

function checkAppUpdateIfStale(source: AutomaticUpdateCheckSource): void {
  if (!automaticUpdateChecksEnabled) {
    logDiagnostic("app-update-background-check-disabled", { source });
    return;
  }
  const updateController = appUpdateController;
  if (updateController === null) {
    logDiagnostic("app-update-background-check-unavailable", { source });
    return;
  }
  const before = updateController.snapshotNow();
  const task = source === "startup"
    ? updateController.prepareNow()
    : updateController.prepareIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
  const after = updateController.snapshotNow();
  const outcome = after.status === "checking"
    ? before.status === "checking" ? "joined" : "started"
    : before.status === "downloading" || before.status === "downloaded"
      ? "download-state-skipped"
      : "cooldown-skipped";
  logDiagnostic("app-update-background-check-scheduled", { source, outcome, status: after.status });
  if (outcome.endsWith("-skipped")) return;
  void task.then(snapshot => {
    logDiagnostic("app-update-background-check-complete", { source, status: snapshot.status });
  }).catch((error: unknown) => {
    logDiagnostic("app-update-background-check-failed", {
      source,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    });
  });
}

function checkRuntimeUpdateIfStale(source: AutomaticUpdateCheckSource): void {
  if (!automaticUpdateChecksEnabled) {
    logDiagnostic("runtime-background-check-disabled", { source });
    return;
  }
  const manager = runtimeManager;
  if (manager === null) {
    logDiagnostic("runtime-background-check-unavailable", { source });
    return;
  }
  void stageRuntimeUpdateInBackground({
    attemptId: randomUUID(),
    coordinator: runtimeUpdateNotices,
    stageLatest: progress => manager.stageLatestIfStale(
      AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
      progress
    )
  }).then(result => {
    logDiagnostic(
      result === "throttled"
        ? "runtime-background-check-cooldown-skipped"
        : "runtime-background-check-complete",
      { source, result }
    );
  }).catch(error => {
    logDiagnostic("runtime-background-check-failed", {
      source,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    });
  });
}

function appUpdateSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  return {
    webContentsId: event.sender.id,
    isMainFrame: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
    url: event.senderFrame?.url ?? ""
  };
}

function isCurrentAppUpdateSender(event: Electron.IpcMainInvokeEvent): boolean {
  const senderFrame = event.senderFrame;
  return senderFrame !== null
    && senderFrame === event.sender.mainFrame
    && isCurrentHarnessSender(event.sender.id, senderFrame.url);
}

const conversationWindows = installConversationWindowIpc({
  main: () => mainWindow,
  origin: () => activeHarnessOrigin,
  scope: () => JSON.stringify([activeHarnessOrigin, activeAccountScope?.dshHome, accountScopeReady]),
  preload: () => resolveArkmePreloadPath(moduleDirectory, app.isPackaged, process.resourcesPath),
});

const longArticleWindows = installLongArticleWindowIpc({
  conversationSender: id => conversationWindows.isActive(id),
  changed: () => conversationWindows.publish(-1, {kind: 'changed'}),
  main: () => mainWindow,
  origin: () => activeHarnessOrigin,
  scope: () => JSON.stringify([activeHarnessOrigin, activeAccountScope?.dshHome, accountScopeReady]),
  preload: () => resolveArkmePreloadPath(moduleDirectory, app.isPackaged, process.resourcesPath),
});

ipcMain.on("arkme-session-selection:bootstrap", event => {
  event.returnValue = desktopSessionSelection.bootstrap(appUpdateSender(event));
});
ipcMain.handle("arkme-session-selection:save", (event, value: unknown) => {
  if (!accountScopeReady || !isCurrentAppUpdateSender(event)) return false;
  return desktopSessionSelection.save(appUpdateSender(event), value).catch(error => {
    logDiagnostic("session-selection-save-failed", error);
    throw error;
  });
});

const readDesktopDevice = createDesktopDeviceReader();
ipcMain.handle("arkme-desktop:directory-badge", (event, count: unknown) => (
  isCurrentAppUpdateSender(event) && nativeBadges.applyDirectoryCount(count).accepted
));
ipcMain.handle("arkme-desktop:device-snapshot", event => (
  (isCurrentAppUpdateSender(event) || (event.senderFrame === event.sender.mainFrame && conversationWindows.isActive(event.sender.id))) ? readDesktopDevice() : null
));

let screenshotIpcInstalled = false;
function createMainWindow(): void {
  if (!screenshotIpcInstalled) {
    screenshotIpcInstalled = true;
    installScreenshotShortcut({main:()=>mainWindow,origin:()=>activeHarnessOrigin,allowed:id=>accountScopeReady && (id===mainWindow?.webContents.id || conversationWindows.isActive(id))});
    installScreenshotIpc({
      main: () => mainWindow, origin: () => activeHarnessOrigin,
      scope: () => JSON.stringify([activeHarnessOrigin, activeAccountScope?.dshHome, accountScopeReady]),
      preload: () => resolveArkmePreloadPath(moduleDirectory, app.isPackaged, process.resourcesPath),
      allowed: id => accountScopeReady && (id === mainWindow?.webContents.id || conversationWindows.isActive(id)),
    });
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: appName,
    backgroundColor: "#f5f7fa",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolveArkmePreloadPath(moduleDirectory, app.isPackaged, process.resourcesPath),
      sandbox: true,
      webSecurity: true
    }
  });

  harnessCookieInstaller = new HarnessCookieInstaller(mainWindow.webContents.session.cookies);
  if (process.platform === "darwin") {
    const drag = new MacPointerWindowDrag(process.platform, mainWindow);
    macPointerWindowDrag = drag;
    mainWindow.on("blur", () => drag.cancel());
    mainWindow.on("hide", () => drag.cancel());
    mainWindow.on("minimize", () => drag.cancel());
    mainWindow.on("maximize", () => drag.cancel());
    mainWindow.on("enter-full-screen", () => drag.cancel());
    mainWindow.on("closed", () => drag.cancel());
    mainWindow.webContents.on("did-start-navigation", () => drag.cancel());
  }
  installHarnessPermissionPolicy(mainWindow.webContents.session, {
    getActiveHarnessOrigin: () => activeHarnessOrigin,
    getMainWebContentsId: () => {
      const window = mainWindow;
      return window === null || window.isDestroyed() ? null : window.webContents.id;
    },
    diagnostic: details => { logDiagnostic("permission-decision", details); }
  });

  const statusWindow = mainWindow;
  renderRuntimeProgressPage = createRuntimeProgressPageRenderer({
    getCurrentUrl: () => statusWindow.webContents.getURL(),
    loadUrl: async url => { await statusWindow.loadURL(url); },
    sendProgress: progress => {
      statusWindow.webContents.send(RUNTIME_STATUS_PROGRESS_CHANNEL, progress);
    }
  }, statusHtmlPath, runtimeEnvironment);

  lockWindowTitle(mainWindow, appName);
  mainWindow.on('closed', () => conversationWindows.closeAll());
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) conversationWindows.closeAll(); });
  mainWindow.webContents.on('render-process-gone', () => conversationWindows.closeAll());
  installNavigationPolicy(mainWindow);
  registerMacWindowDragRegionReinstall(process.platform, mainWindow, error => {
    logDiagnostic("mac-window-drag-region-failed", error);
  });
  mainWindow.webContents.on("did-start-loading", () => {
    logDiagnostic("did-start-loading");
  });
  mainWindow.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!desktopNotificationDocumentNavigationInvalidatesConsumer(isInPlace, isMainFrame)) return;
    harnessPageReadiness.navigation(mainWindow?.webContents.id ?? -1);
    logDiagnostic("did-start-main-frame-navigation", { url });
    nativeBadges.releaseDirectory();
    desktopNotifications.markHarnessLoading();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    logDiagnostic("did-finish-load", { url: mainWindow?.webContents.getURL() });
    void installRuntimeUpdateNoticeStyles({
      getCurrentUrl: () => statusWindow.webContents.getURL(),
      insertCSS: async css => await statusWindow.webContents.insertCSS(css, { cssOrigin: "user" })
    }, activeHarnessOrigin).then(async () => {
      await installAppUpdateNoticeStyles({
        getCurrentUrl: () => statusWindow.webContents.getURL(),
        insertCSS: async css => await statusWindow.webContents.insertCSS(css, { cssOrigin: "user" })
      }, statusPageUrl, activeHarnessOrigin);
    }).catch(error => {
      logDiagnostic("update-notice-style-failed", error);
    });
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logDiagnostic("did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame });
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    logDiagnostic("preload-error", { preloadPath, error: error.stack ?? error.message });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    nativeBadges.releaseDirectory();
    logDiagnostic("render-process-gone", details);
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logDiagnostic("renderer-console", { level, message, line, sourceId });
  });
  mainWindow.on("close", event => {
    if (longArticleWindows.requestQuit(() => mainWindow?.close())) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    nativeBadges.releaseDirectory();
    mainWindow = null;
    renderRuntimeProgressPage = null;
  });
  mainWindow.on("focus", () => {
    void refreshDesktopNotificationPermission("window-focus");
    checkAutomaticUpdates("window-focus");
  });
  mainWindow.once("ready-to-show", () => {
    const result = nativeBadges.replay();
    if (!result.accepted && result.outcome === "native-failed") {
      logDiagnostic("native-badge-replay-failed", { mode: nativeBadges.mode });
    }
  });
}

function installNavigationPolicy(window: BrowserWindow): void {
  const attachmentPreview = installAttachmentPreviewNative(window, () => activeHarnessOrigin);
  const handleNavigation = (event: Electron.Event, targetUrl: string) => {
    const decision = decideNavigation(targetUrl, {
      statusPageUrl,
      harnessOrigin: activeHarnessOrigin
    });
    if (decision.kind === "allow") return;

    event.preventDefault();
    if (decision.kind === "action") enqueueAction(() => handleAppAction(decision.action));
    if (decision.kind === "external") void shell.openExternal(decision.url);
  };

  window.webContents.on("will-navigate", handleNavigation);
  window.webContents.on("will-redirect", handleNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(details => {
    const preview = attachmentPreview.handle(details);
    if (preview) return preview;
    const { url } = details;
    const decision = decideNavigation(url, {
      statusPageUrl,
      harnessOrigin: activeHarnessOrigin
    });
    if (decision.kind === "action") enqueueAction(() => handleAppAction(decision.action));
    if (decision.kind === "external") void shell.openExternal(decision.url);
    return { action: "deny" };
  });
}

async function renderState(state: HarnessState | RuntimeInstallProgress): Promise<void> {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return;

  if (state.kind === "ready") {
    lastHarnessReadyState = state;
    if (holdCandidateNavigation) {
      bufferedHarnessReadyState = state;
      return;
    }
    if (!accountScopeReady) {
      await renderAccountScopeWaiting();
      return;
    }
    activeHarnessOrigin = new URL(state.url).origin;
    logDiagnostic("render-ready", { url: state.url });
    const authenticated = harnessAuthSession;
    if (authenticated !== null && !authenticated.signal.aborted) {
      const readiness = harnessPageReadiness.arm(window.webContents.id, state.url, authenticated.signal);
      void readiness.ready.catch(() => undefined);
    }
    if (activeAccountScope === null || !await desktopSessionSelection.prepare(
      window.webContents.id, state.url, activeAccountScope
    )) return;
    const intent = deepLinks.peek();
    await window.loadURL(intent === undefined ? state.url : createExtensionShareHarnessUrl(state.url, intent));
    if (intent !== undefined) deepLinks.markDelivered(intent);
  } else if (state.kind === "runtime-installing" && renderRuntimeProgressPage !== null) {
    desktopSessionSelection.invalidate();
    activeHarnessOrigin = null;
    desktopNotifications.markHarnessLoading();
    const renderMode = await renderRuntimeProgressPage(state);
    logDiagnostic("render-runtime-progress", {
      mode: renderMode,
      phase: state.phase,
      harnessPercent: state.harnessPercent,
      pluginPercent: state.pluginPercent
    });
  } else {
    desktopSessionSelection.invalidate();
    activeHarnessOrigin = null;
    desktopNotifications.markHarnessLoading();
    const url = createStatusPageUrl(statusHtmlPath, state, runtimeEnvironment);
    logDiagnostic("render-status", { kind: state.kind, url, message: "message" in state ? state.message : undefined });
    await window.loadURL(url);
  }

  if (!window.isVisible()) window.show();
}

function notificationWindow(): HarnessNotificationWindow | null {
  const window = mainWindow;
  if (window === null) return null;
  return {
    isDestroyed: () => window.isDestroyed(),
    isMinimized: () => window.isMinimized(),
    restore: () => { window.restore(); },
    show: () => { window.show(); },
    focus: () => { window.focus(); },
    send: (channel, sourceRef) => { window.webContents.send(channel, sourceRef); },
    sendActivation: (channel, activation) => { window.webContents.send(channel, activation); },
    sendActivationV2: (channel, activation) => { window.webContents.send(channel, activation); }
  };
}

function windowsBadgeDot(): NativeImage {
  if (windowsBadgeDotImage !== null) return windowsBadgeDotImage;
  windowsBadgeDotImage = createWindowsBadgeDotImage(nativeImage);
  return windowsBadgeDotImage;
}

function runtimeUpdateNoticeWindow(): RuntimeUpdateNoticeWindow | null {
  const window = mainWindow;
  if (window === null) return null;
  return {
    getCurrentUrl: () => window.webContents.getURL(),
    isDestroyed: () => window.isDestroyed(),
    isVisible: () => window.isVisible(),
    isFocused: () => window.isFocused(),
    isMinimized: () => window.isMinimized(),
    restore: () => { window.restore(); },
    show: () => { window.show(); },
    focus: () => { window.focus(); },
    send: (channel, snapshot) => { window.webContents.send(channel, snapshot); }
  };
}

async function chooseWorkspace(): Promise<string | null> {
  return showDirectoryDialog("选择 Harness 项目目录");
}

async function showDirectoryDialog(title: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    buttonLabel: "使用此项目",
    properties: ["openDirectory"]
  };
  const result = mainWindow === null || !mainWindow.isVisible()
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "文件",
      submenu: [
        {
          label: "选择项目…",
          accelerator: "CmdOrCtrl+O",
          click: () => enqueueAction(async () => {
            await controller?.chooseAndSwitchWorkspace();
          })
        },
        {
          label: "重新启动 Harness",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => enqueueAction(async () => {
            await controller?.retry();
          })
        },
        { type: "separator" },
        { role: "close" }
      ]
    },
    ...(accountScopeChoices.length > 1 ? [{
      label: "会话空间",
      submenu: accountScopeChoices.map((choice, index) => ({
        label: `本机会话空间 ${String(index + 1)}`,
        type: "radio" as const,
        checked: choice.active,
        click: () => enqueueAction(async () => { await activateDesktopAccountContainer(choice.containerRef); })
      }))
    } satisfies MenuItemConstructorOptions] : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" }
      ]
    }
  ];
  installApplicationMenuForPlatform(process.platform, Menu, template);
}

async function refreshAccountScopeMenu(): Promise<void> {
  if (holdCandidateNavigation || deferredAccountScopeRelaunch || accountScopeRelaunchScheduled) return;
  accountScopeChoices = accountScopeStore === null ? [] : await accountScopeStore.accountContainers();
  installApplicationMenu();
}

async function activateDesktopAccountContainer(containerRef: string): Promise<void> {
  const store = accountScopeStore;
  if (store === null) throw new Error("DSH account scope store is unavailable");
  accountScopeReady = false;
  await renderAccountScopeWaiting();
  activeAccountScope = await store.activate(containerRef);
  scheduleAccountScopeRelaunch();
}

function enqueueAction(action: () => Promise<void>): void {
  actionQueue = actionQueue.then(action, action).catch(showActionError);
}

async function handleAppAction(action: AppAction): Promise<void> {
  if (appUpdateNotices.isInstalling()) return;
  if (action === "reload-runtime") {
    await reloadCurrentRuntimeEnvironment();
    return;
  }
  if (action === "retry") {
    if (runtimeRecoveryRequired) {
      // A previous stop may have failed. Keep its handle until it really exits,
      // then run journal recovery instead of bypassing it through controller.retry.
      await controller?.stop("failure");
      controller = null;
      await bootstrap(true);
    }
    else if (controller === null) await bootstrap(true);
    else await controller.retry();
    return;
  }
  if (controller === null) {
    if (action === "open-logs") {
      const openError = await shell.openPath(logPath || diagnosticLogPath);
      if (openError.length > 0) shell.showItemInFolder(logPath || diagnosticLogPath);
    }
    return;
  }
  if (action === "choose-workspace") {
    await controller.chooseAndSwitchWorkspace();
    return;
  }

  const openError = await shell.openPath(logPath);
  if (openError.length > 0) shell.showItemInFolder(logPath);
}

async function reloadCurrentRuntimeEnvironment(): Promise<void> {
  if (!app.isPackaged || runtimeManager === null) {
    throw new Error("当前客户端没有可重新加载的运行环境");
  }
  const userDataPath = app.getPath("userData");
  let release: ResolvedElectronRuntime;
  try {
    release = await runtimeManager.reloadCurrentEnvironment(state => runtimeProgressRenderer.schedule(state));
  } finally {
    await runtimeProgressRenderer.flush();
  }
  const runtime = launchRuntimeFromRelease(release);
  await configureAccountScopeForRuntime(userDataPath, runtime);
  const accountScope = activeAccountScope;
  if (accountScope === null) throw new Error("DSH account scope is unavailable");
  lastHarnessReadyState = null;
  const paths = accountScopeLaunchPaths(userDataPath, accountScope);
  await recoverRuntimeManagedProfileTransaction(paths.dshHome, runtimeEnvironment);
  logDiagnostic("runtime-manual-reload", {
    environment: runtimeEnvironment,
    releaseId: release.releaseId,
    serviceBaseUrl: runtimeServiceConfig.serviceBaseUrl
  });
  activeLaunchRuntime = await launchHarnessRuntime(runtime, paths, true);
}

async function showActionError(error: unknown): Promise<void> {
  console.error("Desktop action failed", error);
  await renderFailure(error);
}

async function showFatalBootstrapError(error: unknown): Promise<void> {
  logDiagnostic("fatal-bootstrap-error", error);
  console.error("arkme failed to initialize", error);
  if (mainWindow === null && app.isReady()) createMainWindow();
  await renderFailure(error);
}

async function renderFailure(error: unknown): Promise<void> {
  logDiagnostic("render-failure", error);
  const message = error instanceof Error ? error.message : String(error);
  const workspacePath = controller?.getCurrentWorkspace();
  const display = error instanceof ElectronRuntimeManifestError || error instanceof BadRuntimeReleaseBlockedError
    || error instanceof RuntimeNetworkWaitingError
    ? {
      displayTitle: error.displayTitle,
      suggestion: error.suggestion,
      technicalDetails: error.technicalDetails,
      showWorkspaceAction: error.showWorkspaceAction,
      ...("showReloadRuntimeAction" in error
        ? { showReloadRuntimeAction: error.showReloadRuntimeAction }
        : {})
    }
    : {};
  const state: HarnessState = workspacePath === null || workspacePath === undefined
    ? { kind: "failed", message, logPath, ...display }
    : { kind: "failed", workspacePath, message, logPath, ...display };
  await renderState(state);
}
