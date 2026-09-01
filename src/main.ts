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
  resolveSupportedAppUpdateTarget,
  shouldForceDevAppUpdate
} from "./app-update.js";
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
import {
  startDesktopCapabilityBridge,
  type DesktopCapabilityBridge
} from "./desktop-capability-bridge.js";
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
  resolveAppUpdateDownloadsPath,
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
  runtimeArtifactFailureCode
} from "./runtime/errors.js";


const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeServiceConfig = readPackagedRuntimeServiceConfig(moduleDirectory);
const runtimeEnvironment = runtimeServiceConfig.environment;
const packagedLocalTest = app.isPackaged
  && existsSync(path.join(process.resourcesPath, "ARKME_TEST_PLUGIN.json"));
const appIdentity = resolveArkmeAppIdentity(runtimeEnvironment, packagedLocalTest);
const statusHtmlPath = path.join(moduleDirectory, "ui", "status.html");
const statusPageUrl = pathToFileURL(statusHtmlPath).href;
const appName = appIdentity.appName;
const deepLinks = new ArkmeDeepLinkQueue();
app.setName(appName);
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
  resourcesPath: process.resourcesPath
});

let mainWindow: BrowserWindow | null = null;
let controller: DesktopController | null = null;
let activeHarnessOrigin: string | null = null;
let activeHarnessVersion: string | undefined;
let logPath = "";
let actionQueue: Promise<void> = Promise.resolve();
let directoryPickerBridge: DirectoryPickerBridge | null = null;
let desktopCapabilityBridge: DesktopCapabilityBridge | null = null;
let appUpdateController: ArkmeAppUpdateController | null = null;
let appQuitGuard: AppQuitGuard | null = null;
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

interface LaunchRuntime {
  dshBinPath: string;
  arkmePluginPath: string;
  packageManagerBinPath: string;
  packageManagerCliPath: string;
  runtimeManaged: boolean;
  release?: ResolvedElectronRuntime;
}

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
    ipcMain.handle(channel, (event, value: unknown) => handler({ senderFrame: event.senderFrame }, value));
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
  const settingsUrl = desktopNotificationSettingsUrl(process.platform);
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
ipcMain.on("arkme-runtime:harness-version", event => {
  event.returnValue = activeHarnessVersion ?? null;
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  registerApplicationLifecycle();
  void app.whenReady().then(bootstrap).catch(showFatalBootstrapError);
}

function registerApplicationLifecycle(): void {
  appQuitGuard = createAppQuitGuard({
    stopHarness: async () => {
      await controller?.stop("quit");
    },
    closeDirectoryPicker: async () => {
      await directoryPickerBridge?.close();
    },
    closeDesktopCapabilities: async () => {
      await desktopCapabilityBridge?.close();
    },
    clearNativeBadge: () => {
      nativeBadges.clearNative();
    },
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
    appQuitGuard?.handleBeforeQuit(event);
  });
  app.on("will-quit", () => {
    desktopLocationPermission?.dispose();
    desktopLocationPermission = null;
  });
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

async function bootstrap(): Promise<void> {
  logDiagnostic("bootstrap-start");
  await refreshDesktopNotificationPermission("bootstrap");
  app.setAppUserModelId(appIdentity.appId);
  desktopLocationPermission ??= new DesktopLocationPermissionService({
    platform: process.platform,
    createMacDriver: createMacCoreLocationDriver,
    diagnostic: (event, error) => { logDiagnostic(`desktop-location-${event}`, error); }
  });
  if (mainWindow === null) createMainWindow();
  if (!nativeBadgeInitialized) {
    nativeBadgeInitialized = true;
    nativeBadges.clearNative();
  }
  if (desktopCapabilityBridge === null) {
    desktopCapabilityBridge = await startDesktopCapabilityBridge({
      notifications: desktopNotifications,
      notificationSupported: desktopNotificationCapability,
      badges: nativeBadges
    });
    logDiagnostic("desktop-capability-bridge-started", { badgeMode: nativeBadges.mode });
  }
  const userDataPath = app.getPath("userData");
  const settingsPath = path.join(userDataPath, "settings.json");
  logPath = diagnosticLogPath;
  const dshHome = path.join(userDataPath, "dsh");
  await recoverRuntimeManagedProfileTransaction(dshHome, runtimeEnvironment);
  let runtime = await resolveLaunchRuntime(userDataPath);
  logDiagnostic("runtime-paths", { userDataPath, ...runtime, statusHtmlPath });
  if (directoryPickerBridge === null) {
    directoryPickerBridge = await startDirectoryPickerBridge(showDirectoryDialog);
  }
  runtime = await launchHarnessRuntime(runtime, { userDataPath, settingsPath, dshHome });
  finishRuntimeBootstrap(userDataPath);
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

async function launchHarnessRuntime(
  initialRuntime: LaunchRuntime,
  paths: { userDataPath: string; settingsPath: string; dshHome: string },
  reloadingBadRelease = false
): Promise<LaunchRuntime> {
  let runtime = initialRuntime;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let profileTransaction: RuntimeManagedProfileTransaction | undefined;
    let candidateCompleted = false;
    try {
      await initializeHarnessRuntime(
        runtime,
        paths,
        transaction => { profileTransaction = transaction; }
      );
      if (runtime.release?.probation === true) {
        const origin = await waitForHarnessOrigin();
        await verifyElectronRuntimePluginHealth(
          origin,
          runtime.release.manifest.artifacts.requiredPlugin.version
        );
      }
      if (runtime.release?.probation === true) {
        await runtimeManager?.completeCandidate();
        candidateCompleted = true;
        logDiagnostic("runtime-candidate-complete", { releaseId: runtime.release.releaseId });
      }
      if (profileTransaction !== undefined) {
        await commitRuntimeManagedProfileTransaction(profileTransaction);
        profileTransaction = undefined;
      }
      return runtime;
    } catch (error) {
      await controller?.stop("failure").catch(() => undefined);
      controller = null;
      activeHarnessOrigin = null;
      if (profileTransaction !== undefined) {
        await rollbackRuntimeManagedProfileTransaction(profileTransaction);
        profileTransaction = undefined;
      }
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
          phase: "unknown",
          scope: "unknown",
          code: "RUNTIME_START_FAILED",
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

function finishRuntimeBootstrap(userDataPath: string): void {
  logPath = path.join(userDataPath, "logs", "harness.log");
  installAppUpdateController();
  installApplicationMenu();
  if (runtimeManager !== null) {
    const manager = runtimeManager;
    void stageRuntimeUpdateInBackground({
      attemptId: randomUUID(),
      coordinator: runtimeUpdateNotices,
      stageLatest: progress => manager.stageLatest(progress)
    }).then(result => {
      logDiagnostic("runtime-background-check-complete", { result });
    }).catch(error => {
      logDiagnostic("runtime-background-check-failed", error);
    });
  }
}

async function resolveLaunchRuntime(userDataPath: string): Promise<LaunchRuntime> {
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
  const root = path.join(userDataPath, "runtime-manager", "electron-v1");
  const runtimeServiceBaseUrl = runtimeServiceConfig.serviceBaseUrl;
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => (
    net.fetch(typeof input === "string" ? input : input instanceof URL ? input.href : input, init)
  )) as unknown as typeof fetch;
  runtimeManager = new ElectronRuntimeManager({
    root,
    environment: runtimeEnvironment,
    manifestContext: {
      os: process.platform === "win32" ? "windows" : process.platform,
      arch: process.arch,
      shellVersion: app.getVersion(),
      electronMajor,
      modulesAbi
    },
    fetchManifest: () => fetchElectronRuntimeManifest({
      serviceBaseUrl: runtimeServiceBaseUrl,
      platform: process.platform,
      arch: process.arch,
      shellVersion: app.getVersion(),
      electronMajor,
      modulesAbi,
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
  let release: ResolvedElectronRuntime;
  try {
    release = await runtimeManager.prepareForLaunch(state => runtimeProgressRenderer.schedule(state));
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
  paths: { userDataPath: string; settingsPath: string; dshHome: string },
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
  activeHarnessVersion = runtime.release?.manifest.artifacts.harness.version ?? dshVersion;
  const packageManagerEnvironment = withBundledPackageManagerEnvironment(
    process.env,
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
    execPath: process.execPath,
    dshBinPath: runtime.dshBinPath,
    dshHome: paths.dshHome,
    logPath: path.join(paths.userDataPath, "logs", "harness.log"),
    packageManagerBinPath: runtime.packageManagerBinPath,
    packageManagerCliPath: runtime.packageManagerCliPath,
    inheritedEnv: {
      ...packageManagerEnvironment,
      ARKME_APP_VERSION: app.getVersion(),
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

async function waitForHarnessOrigin(): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (activeHarnessOrigin === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (activeHarnessOrigin === null) throw new Error("Electron runtime health check could not resolve the Harness origin");
  return activeHarnessOrigin;
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

function installAppUpdateController(): void {
  if (packagedLocalTest) return;
  const target = resolveSupportedAppUpdateTarget(process.platform, process.arch);
  if (target === null) return;
  appUpdateController = new ArkmeAppUpdateController({
    currentVersion: app.getVersion(),
    applicationName: appIdentity.appName,
    serviceBaseUrl: runtimeServiceConfig.serviceBaseUrl,
    platform: target.platform,
    arch: target.arch,
    downloadsDirectory: resolveAppUpdateDownloadsPath(
      runtimeEnvironment,
      app.getPath("userData"),
      app.getPath("downloads")
    )
  });
  if (app.isPackaged || shouldForceDevAppUpdate(app.isPackaged)) {
    void appUpdateController.checkNow().catch((error: unknown) => {
      logDiagnostic("app-update-background-check-failed", error);
    });
  }
}

ipcMain.handle("arkme-app-update:status", () => appUpdateController?.snapshotNow() ?? null);
ipcMain.handle("arkme-app-update:check", async () => await appUpdateController?.checkNow() ?? null);
ipcMain.handle("arkme-app-update:download", async () => await appUpdateController?.download() ?? null);
ipcMain.handle("arkme-app-update:show-in-folder", async () => {
  const downloadedFilePath = appUpdateController?.snapshotNow().downloadedFilePath;
  if (downloadedFilePath === undefined) return false;
  try {
    await access(downloadedFilePath);
  } catch {
    return false;
  }
  shell.showItemInFolder(downloadedFilePath);
  return true;
});

function createMainWindow(): void {
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
  installNavigationPolicy(mainWindow);
  registerMacWindowDragRegionReinstall(process.platform, mainWindow, error => {
    logDiagnostic("mac-window-drag-region-failed", error);
  });
  mainWindow.webContents.on("did-start-loading", () => {
    logDiagnostic("did-start-loading");
  });
  mainWindow.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!desktopNotificationDocumentNavigationInvalidatesConsumer(isInPlace, isMainFrame)) return;
    logDiagnostic("did-start-main-frame-navigation", { url });
    desktopNotifications.markHarnessLoading();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    logDiagnostic("did-finish-load", { url: mainWindow?.webContents.getURL() });
    void installRuntimeUpdateNoticeStyles({
      getCurrentUrl: () => statusWindow.webContents.getURL(),
      insertCSS: async css => await statusWindow.webContents.insertCSS(css, { cssOrigin: "user" })
    }, activeHarnessOrigin).catch(error => {
      logDiagnostic("runtime-update-notice-style-failed", error);
    });
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logDiagnostic("did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame });
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    logDiagnostic("preload-error", { preloadPath, error: error.stack ?? error.message });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logDiagnostic("render-process-gone", details);
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logDiagnostic("renderer-console", { level, message, line, sourceId });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    renderRuntimeProgressPage = null;
  });
  mainWindow.on("focus", () => {
    void refreshDesktopNotificationPermission("window-focus");
  });
  mainWindow.once("ready-to-show", () => {
    const result = nativeBadges.replay();
    if (!result.accepted && result.outcome === "native-failed") {
      logDiagnostic("native-badge-replay-failed", { mode: nativeBadges.mode });
    }
  });
}

function installNavigationPolicy(window: BrowserWindow): void {
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
  window.webContents.setWindowOpenHandler(({ url }) => {
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
    activeHarnessOrigin = new URL(state.url).origin;
    logDiagnostic("render-ready", { url: state.url });
    const intent = deepLinks.peek();
    await window.loadURL(intent === undefined ? state.url : createExtensionShareHarnessUrl(state.url, intent));
    if (intent !== undefined) deepLinks.markDelivered(intent);
  } else if (state.kind === "runtime-installing" && renderRuntimeProgressPage !== null) {
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

function enqueueAction(action: () => Promise<void>): void {
  actionQueue = actionQueue.then(action, action).catch(showActionError);
}

async function handleAppAction(action: AppAction): Promise<void> {
  if (action === "reload-runtime") {
    await reloadCurrentRuntimeEnvironment();
    return;
  }
  if (action === "retry") {
    if (controller === null) await bootstrap();
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
  const paths = {
    userDataPath,
    settingsPath: path.join(userDataPath, "settings.json"),
    dshHome: path.join(userDataPath, "dsh")
  };
  await recoverRuntimeManagedProfileTransaction(paths.dshHome, runtimeEnvironment);
  let release: ResolvedElectronRuntime;
  try {
    release = await runtimeManager.reloadCurrentEnvironment(state => runtimeProgressRenderer.schedule(state));
  } finally {
    await runtimeProgressRenderer.flush();
  }
  logDiagnostic("runtime-manual-reload", {
    environment: runtimeEnvironment,
    releaseId: release.releaseId,
    serviceBaseUrl: runtimeServiceConfig.serviceBaseUrl
  });
  await launchHarnessRuntime(launchRuntimeFromRelease(release), paths, true);
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
