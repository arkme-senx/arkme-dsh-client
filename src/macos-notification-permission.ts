import { createRequire } from "node:module";
import type { DesktopNotificationPermissionState } from "./desktop-notification.js";

export interface MacNotificationSettings {
  authorizationStatus: number;
  alertSetting: number;
  notificationCenterSetting: number;
  soundSetting: number;
  badgeSetting: number;
}

interface MacNotificationPermissionBinding {
  queryNotificationAuthorizationStatus(): Promise<unknown>;
}

export type MacNotificationPermissionBindingLoader = () => MacNotificationPermissionBinding;
export type MacNotificationPermissionDiagnostic = (
  result: Readonly<{
    outcome: "native" | "invalid" | "failed";
    permission: DesktopNotificationPermissionState;
    settings?: MacNotificationSettings;
    error?: string;
  }>
) => void;

const requireFromModule = createRequire(import.meta.url);

export function parseMacNotificationSettings(value: unknown): MacNotificationSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const fields = [
    "authorizationStatus",
    "alertSetting",
    "notificationCenterSetting",
    "soundSetting",
    "badgeSetting"
  ] as const;
  if (!fields.every(field => Number.isSafeInteger(candidate[field]))) return undefined;
  return Object.fromEntries(fields.map(field => [field, candidate[field]])) as unknown as MacNotificationSettings;
}

export function desktopPermissionFromMacNotificationSettings(
  settings: MacNotificationSettings | undefined
): DesktopNotificationPermissionState {
  // Keep parity with Jotmo's native desktop implementation: only Apple's
  // explicit UNAuthorizationStatus.authorized (raw value 2) is positive.
  // notDetermined, denied, provisional, malformed and query failures all keep
  // a visible recovery path instead of hiding it optimistically.
  return settings?.authorizationStatus === 2 ? "granted" : "denied";
}

export class MacNotificationPermissionReader {
  private refreshInFlight: Promise<DesktopNotificationPermissionState> | undefined;

  constructor(
    private readonly enabled: boolean,
    private readonly loadBinding: MacNotificationPermissionBindingLoader = loadNativeBinding,
    private readonly diagnostic: MacNotificationPermissionDiagnostic = () => undefined
  ) {}

  async refresh(): Promise<DesktopNotificationPermissionState> {
    if (!this.enabled) return "unavailable";
    if (this.refreshInFlight !== undefined) return await this.refreshInFlight;
    const pending = this.refreshOnce();
    this.refreshInFlight = pending;
    try { return await pending; }
    finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    }
  }

  private async refreshOnce(): Promise<DesktopNotificationPermissionState> {
    try {
      const settings = parseMacNotificationSettings(await this.loadBinding()
        .queryNotificationAuthorizationStatus());
      const permission = desktopPermissionFromMacNotificationSettings(settings);
      this.diagnostic(settings === undefined
        ? { outcome: "invalid", permission }
        : { outcome: "native", permission, settings });
      return permission;
    } catch (error) {
      this.diagnostic({
        outcome: "failed",
        permission: "denied",
        error: error instanceof Error ? error.message : String(error)
      });
      return "denied";
    }
  }
}

function loadNativeBinding(): MacNotificationPermissionBinding {
  return requireFromModule("@arkme/macos-notification-permission") as MacNotificationPermissionBinding;
}
