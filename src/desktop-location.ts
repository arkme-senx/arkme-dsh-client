import type { MacCoreLocationDriver } from "./macos-core-location.js";

export const DESKTOP_LOCATION_PERMISSION_STATE_CHANNEL = "arkme:desktop-location:permission-state";
export const DESKTOP_LOCATION_REQUEST_PERMISSION_CHANNEL = "arkme:desktop-location:request-permission";
export const DESKTOP_LOCATION_OPEN_SETTINGS_CHANNEL = "arkme:desktop-location:open-settings";

export type DesktopLocationPermissionState =
  | "granted"
  | "prompt"
  | "denied"
  | "restricted"
  | "services-disabled"
  | "unavailable";

export interface DesktopLocationPermissionSnapshot {
  readonly schemaVersion: 1;
  readonly state: DesktopLocationPermissionState;
}

export interface DesktopLocationPermissionServiceOptions {
  platform: NodeJS.Platform;
  createMacDriver(): MacCoreLocationDriver;
  diagnostic?(event: "native-unavailable" | "native-failed" | "request-timeout", error?: unknown): void;
  now?: () => number;
  pollIntervalMillis?: number;
  requestTimeoutMillis?: number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class DesktopLocationPermissionService {
  private driver: MacCoreLocationDriver | null = null;
  private disposed = false;
  private inFlight: Promise<DesktopLocationPermissionSnapshot> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: ((snapshot: DesktopLocationPermissionSnapshot) => void) | null = null;
  private readonly now: () => number;
  private readonly pollIntervalMillis: number;
  private readonly requestTimeoutMillis: number;
  private readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: DesktopLocationPermissionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMillis = positiveDuration(options.pollIntervalMillis, 250);
    this.requestTimeoutMillis = positiveDuration(options.requestTimeoutMillis, 60_000);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    if (options.platform !== "darwin") return;
    try {
      this.driver = options.createMacDriver();
    } catch (error) {
      options.diagnostic?.("native-unavailable", error);
    }
  }

  permissionState(): DesktopLocationPermissionSnapshot {
    if (this.disposed || this.driver === null) return snapshot("unavailable");
    try {
      if (!this.driver.locationServicesEnabled()) return snapshot("services-disabled");
      return snapshot(mapCoreLocationAuthorizationStatus(this.driver.authorizationStatus()));
    } catch (error) {
      this.options.diagnostic?.("native-failed", error);
      return snapshot("unavailable");
    }
  }

  requestPermission(): Promise<DesktopLocationPermissionSnapshot> {
    const current = this.permissionState();
    if (current.state !== "prompt") return Promise.resolve(current);
    if (this.inFlight !== null) return this.inFlight;

    let resolveRequest!: (value: DesktopLocationPermissionSnapshot) => void;
    const result = new Promise<DesktopLocationPermissionSnapshot>(resolve => {
      resolveRequest = resolve;
    });
    this.pendingResolve = resolveRequest;
    let tracked!: Promise<DesktopLocationPermissionSnapshot>;
    tracked = result.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;

    try {
      this.driver?.requestWhenInUseAuthorization();
    } catch (error) {
      this.options.diagnostic?.("native-failed", error);
      this.finishRequest(snapshot("unavailable"));
      return this.inFlight;
    }

    const startedAt = this.now();
    const poll = () => {
      if (this.disposed) {
        this.finishRequest(snapshot("unavailable"));
        return;
      }
      const state = this.permissionState();
      if (state.state !== "prompt") {
        this.finishRequest(state);
        return;
      }
      const elapsed = Math.max(0, this.now() - startedAt);
      const remaining = this.requestTimeoutMillis - elapsed;
      if (remaining <= 0) {
        this.options.diagnostic?.("request-timeout");
        this.finishRequest(state);
        return;
      }
      this.pendingTimer = this.setTimer(poll, Math.min(this.pollIntervalMillis, remaining));
    };
    poll();
    return this.inFlight;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishRequest(snapshot("unavailable"));
    try {
      this.driver?.dispose();
    } catch (error) {
      this.options.diagnostic?.("native-failed", error);
    }
    this.driver = null;
  }

  private finishRequest(value: DesktopLocationPermissionSnapshot): void {
    if (this.pendingTimer !== null) {
      this.clearTimer(this.pendingTimer);
      this.pendingTimer = null;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.(value);
  }
}

export interface DesktopLocationIpcEvent {
  sender: { id: number };
  senderFrame: { url: string } | null;
}

export interface DesktopLocationIpcRegistrar {
  handle(
    channel: string,
    handler: (event: DesktopLocationIpcEvent, value: unknown) => unknown | Promise<unknown>
  ): void;
}

export interface DesktopLocationIpcContext {
  getActiveHarnessOrigin(): string | null;
  getMainWindow(): {
    destroyed: boolean;
    focused: boolean;
    url: string;
    webContentsId: number;
  } | null;
  getService(): DesktopLocationPermissionService | null;
  openSettings(): Promise<boolean>;
  diagnostic?(event: "ipc-denied" | "open-settings-failed", details?: unknown): void;
}

export function registerDesktopLocationIpc(
  ipc: DesktopLocationIpcRegistrar,
  context: DesktopLocationIpcContext
): void {
  ipc.handle(DESKTOP_LOCATION_PERMISSION_STATE_CHANNEL, event => {
    if (!isCurrentHarnessSender(event, context, false)) return snapshot("unavailable");
    return context.getService()?.permissionState() ?? snapshot("unavailable");
  });
  ipc.handle(DESKTOP_LOCATION_REQUEST_PERMISSION_CHANNEL, (event, value) => {
    if (!hasTrustedUserActivation(value) || !isCurrentHarnessSender(event, context, true)) {
      return snapshot("unavailable");
    }
    return context.getService()?.requestPermission() ?? snapshot("unavailable");
  });
  ipc.handle(DESKTOP_LOCATION_OPEN_SETTINGS_CHANNEL, async (event, value) => {
    if (!hasTrustedUserActivation(value) || !isCurrentHarnessSender(event, context, true)) return false;
    try {
      return await context.openSettings();
    } catch (error) {
      context.diagnostic?.("open-settings-failed", error);
      return false;
    }
  });
}

function hasTrustedUserActivation(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.userActivation === true && Object.keys(candidate).length === 1;
}

export function mapCoreLocationAuthorizationStatus(status: number): DesktopLocationPermissionState {
  if (status === 0) return "prompt";
  if (status === 1) return "restricted";
  if (status === 2) return "denied";
  if (status === 3 || status === 4) return "granted";
  return "unavailable";
}

function isCurrentHarnessSender(
  event: DesktopLocationIpcEvent,
  context: DesktopLocationIpcContext,
  requireFocus: boolean
): boolean {
  const harnessOrigin = localHarnessOrigin(context.getActiveHarnessOrigin());
  const window = context.getMainWindow();
  const allowed = harnessOrigin !== null
    && window !== null
    && !window.destroyed
    && (!requireFocus || window.focused)
    && event.sender.id === window.webContentsId
    && sameOrigin(event.senderFrame?.url, harnessOrigin)
    && sameOrigin(window.url, harnessOrigin);
  if (!allowed) context.diagnostic?.("ipc-denied", { requireFocus });
  return allowed;
}

function localHarnessOrigin(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port.length > 0
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && url.username.length === 0
      && url.password.length === 0
      && value === url.origin
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function sameOrigin(value: string | undefined, expectedOrigin: string): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.username.length === 0
      && url.password.length === 0
      && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function snapshot(state: DesktopLocationPermissionState): DesktopLocationPermissionSnapshot {
  return { schemaVersion: 1, state };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}
