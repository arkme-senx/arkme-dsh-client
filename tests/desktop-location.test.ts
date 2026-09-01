import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DESKTOP_LOCATION_OPEN_SETTINGS_CHANNEL,
  DESKTOP_LOCATION_PERMISSION_STATE_CHANNEL,
  DESKTOP_LOCATION_REQUEST_PERMISSION_CHANNEL,
  DesktopLocationPermissionService,
  mapCoreLocationAuthorizationStatus,
  registerDesktopLocationIpc,
  type DesktopLocationIpcEvent,
  type DesktopLocationIpcRegistrar
} from "../src/desktop-location.js";
import type { MacCoreLocationDriver } from "../src/macos-core-location.js";

afterEach(() => {
  vi.useRealTimers();
});

function driverFixture(options: {
  authorizationStatus?: number;
  locationServicesEnabled?: boolean;
  requestError?: Error;
} = {}): MacCoreLocationDriver & {
  authorizationStatus: ReturnType<typeof vi.fn<() => number>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
  locationServicesEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  requestWhenInUseAuthorization: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    authorizationStatus: vi.fn(() => options.authorizationStatus ?? 0),
    locationServicesEnabled: vi.fn(() => options.locationServicesEnabled ?? true),
    requestWhenInUseAuthorization: vi.fn(() => {
      if (options.requestError !== undefined) throw options.requestError;
    }),
    dispose: vi.fn()
  };
}

describe("DesktopLocationPermissionService", () => {
  test("maps every public CoreLocation authorization state without reading coordinates", () => {
    expect([0, 1, 2, 3, 4, 99].map(mapCoreLocationAuthorizationStatus)).toEqual([
      "prompt",
      "restricted",
      "denied",
      "granted",
      "granted",
      "unavailable"
    ]);
  });

  test("does not load CoreLocation outside macOS", () => {
    const createMacDriver = vi.fn(driverFixture);
    const service = new DesktopLocationPermissionService({
      platform: "win32",
      createMacDriver
    });

    expect(service.permissionState()).toEqual({ schemaVersion: 1, state: "unavailable" });
    expect(createMacDriver).not.toHaveBeenCalled();
  });

  test("distinguishes disabled services and native load failures", () => {
    const disabled = new DesktopLocationPermissionService({
      platform: "darwin",
      createMacDriver: () => driverFixture({ locationServicesEnabled: false })
    });
    expect(disabled.permissionState()).toEqual({ schemaVersion: 1, state: "services-disabled" });

    const diagnostic = vi.fn();
    const unavailable = new DesktopLocationPermissionService({
      platform: "darwin",
      createMacDriver: () => { throw new Error("native missing"); },
      diagnostic
    });
    expect(unavailable.permissionState()).toEqual({ schemaVersion: 1, state: "unavailable" });
    expect(diagnostic).toHaveBeenCalledWith("native-unavailable", expect.any(Error));
  });

  test("uses one native request and resolves all callers after authorization changes", async () => {
    vi.useFakeTimers();
    let authorizationStatus = 0;
    const driver = driverFixture();
    driver.authorizationStatus.mockImplementation(() => authorizationStatus);
    const service = new DesktopLocationPermissionService({
      platform: "darwin",
      createMacDriver: () => driver
    });

    const first = service.requestPermission();
    const second = service.requestPermission();
    expect(second).toBe(first);
    expect(driver.requestWhenInUseAuthorization).toHaveBeenCalledOnce();

    authorizationStatus = 3;
    await vi.advanceTimersByTimeAsync(250);
    await expect(first).resolves.toEqual({ schemaVersion: 1, state: "granted" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("bounds a silent native request and clears its polling timer", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    const service = new DesktopLocationPermissionService({
      platform: "darwin",
      createMacDriver: () => driverFixture(),
      requestTimeoutMillis: 1_000,
      pollIntervalMillis: 100,
      diagnostic
    });

    const request = service.requestPermission();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(request).resolves.toEqual({ schemaVersion: 1, state: "prompt" });
    expect(diagnostic).toHaveBeenCalledWith("request-timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("returns unavailable on native failure and resolves pending work during disposal", async () => {
    const diagnostic = vi.fn();
    const failed = new DesktopLocationPermissionService({
      platform: "darwin",
      createMacDriver: () => driverFixture({ requestError: new Error("request failed") }),
      diagnostic
    });
    await expect(failed.requestPermission()).resolves.toEqual({ schemaVersion: 1, state: "unavailable" });
    expect(diagnostic).toHaveBeenCalledWith("native-failed", expect.any(Error));

    vi.useFakeTimers();
    const driver = driverFixture();
    const service = new DesktopLocationPermissionService({
      platform: "darwin",
      createMacDriver: () => driver
    });
    const pending = service.requestPermission();
    service.dispose();
    service.dispose();
    await expect(pending).resolves.toEqual({ schemaVersion: 1, state: "unavailable" });
    expect(driver.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

type IpcHandler = (
  event: DesktopLocationIpcEvent,
  value: unknown
) => unknown | Promise<unknown>;

function ipcFixture(options: {
  focused?: boolean;
  frameUrl?: string;
  harnessOrigin?: string | null;
  openSettings?: () => Promise<boolean>;
  senderId?: number;
  windowUrl?: string;
} = {}) {
  const handlers = new Map<string, IpcHandler>();
  const service = {
    permissionState: vi.fn(() => ({ schemaVersion: 1 as const, state: "prompt" as const })),
    requestPermission: vi.fn(async () => ({ schemaVersion: 1 as const, state: "granted" as const }))
  } as unknown as DesktopLocationPermissionService;
  const diagnostic = vi.fn();
  const origin = options.harnessOrigin === undefined
    ? "http://127.0.0.1:41234"
    : options.harnessOrigin;
  registerDesktopLocationIpc({
    handle(channel, handler) { handlers.set(channel, handler); }
  } satisfies DesktopLocationIpcRegistrar, {
    getActiveHarnessOrigin: () => origin,
    getMainWindow: () => ({
      destroyed: false,
      focused: options.focused ?? true,
      url: options.windowUrl ?? "http://127.0.0.1:41234/chat",
      webContentsId: 7
    }),
    getService: () => service,
    openSettings: options.openSettings ?? vi.fn(async () => true),
    diagnostic
  });
  const event: DesktopLocationIpcEvent = {
    sender: { id: options.senderId ?? 7 },
    senderFrame: { url: options.frameUrl ?? "http://127.0.0.1:41234/embedded" }
  };
  const invoke = async (channel: string, value?: unknown) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`Missing handler ${channel}`);
    return await handler(event, value);
  };
  return { diagnostic, invoke, service };
}

describe("desktop location IPC policy", () => {
  test("lets same-origin frames read status without focus or activation", async () => {
    const { invoke, service } = ipcFixture({ focused: false });
    await expect(invoke(DESKTOP_LOCATION_PERMISSION_STATE_CHANNEL)).resolves.toEqual({
      schemaVersion: 1,
      state: "prompt"
    });
    expect(service.permissionState).toHaveBeenCalledOnce();
  });

  test("requires focused current window and the exact trusted activation payload for mutation", async () => {
    const unfocused = ipcFixture({ focused: false });
    await expect(unfocused.invoke(
      DESKTOP_LOCATION_REQUEST_PERMISSION_CHANNEL,
      { userActivation: true }
    )).resolves.toEqual({ schemaVersion: 1, state: "unavailable" });

    const focused = ipcFixture();
    for (const value of [undefined, false, { userActivation: false }, { userActivation: true, extra: true }]) {
      await expect(focused.invoke(DESKTOP_LOCATION_REQUEST_PERMISSION_CHANNEL, value)).resolves.toEqual({
        schemaVersion: 1,
        state: "unavailable"
      });
    }
    await expect(focused.invoke(
      DESKTOP_LOCATION_REQUEST_PERMISSION_CHANNEL,
      { userActivation: true }
    )).resolves.toEqual({ schemaVersion: 1, state: "granted" });
    expect(focused.service.requestPermission).toHaveBeenCalledOnce();
  });

  test("rejects cross-origin frames, stale window URLs and other webContents", async () => {
    for (const options of [
      { frameUrl: "https://example.com" },
      { windowUrl: "file:///Applications/arkme.app/status.html" },
      { senderId: 8 },
      { harnessOrigin: "http://localhost:41234" },
      { harnessOrigin: null }
    ]) {
      const fixture = ipcFixture(options);
      await expect(fixture.invoke(DESKTOP_LOCATION_PERMISSION_STATE_CHANNEL)).resolves.toEqual({
        schemaVersion: 1,
        state: "unavailable"
      });
      expect(fixture.service.permissionState).not.toHaveBeenCalled();
    }
  });

  test("opens settings only from an activated focused Harness frame and fails closed", async () => {
    const openSettings = vi.fn(async () => true);
    const allowed = ipcFixture({ openSettings });
    await expect(allowed.invoke(
      DESKTOP_LOCATION_OPEN_SETTINGS_CHANNEL,
      { userActivation: true }
    )).resolves.toBe(true);
    expect(openSettings).toHaveBeenCalledOnce();

    const failed = ipcFixture({
      openSettings: async () => { throw new Error("settings unavailable"); }
    });
    await expect(failed.invoke(
      DESKTOP_LOCATION_OPEN_SETTINGS_CHANNEL,
      { userActivation: true }
    )).resolves.toBe(false);
    expect(failed.diagnostic).toHaveBeenCalledWith("open-settings-failed", expect.any(Error));
  });
});
