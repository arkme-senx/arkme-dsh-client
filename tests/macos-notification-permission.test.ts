import { describe, expect, it, vi } from "vitest";
import {
  MacNotificationPermissionReader,
  desktopPermissionFromMacNotificationSettings,
  parseMacNotificationSettings
} from "../src/macos-notification-permission.js";

const authorizedSettings = {
  authorizationStatus: 2,
  alertSetting: 2,
  notificationCenterSetting: 2,
  soundSetting: 2,
  badgeSetting: 2
};

describe("macOS native notification permission", () => {
  it("accepts only a complete integer settings snapshot", () => {
    expect(parseMacNotificationSettings(authorizedSettings)).toEqual(authorizedSettings);
    expect(parseMacNotificationSettings({ ...authorizedSettings, badgeSetting: 1.5 })).toBeUndefined();
    expect(parseMacNotificationSettings({ authorizationStatus: 2 })).toBeUndefined();
    expect(parseMacNotificationSettings(null)).toBeUndefined();
  });

  it("treats only UNAuthorizationStatus.authorized as granted", () => {
    expect(desktopPermissionFromMacNotificationSettings(authorizedSettings)).toBe("granted");
    for (const authorizationStatus of [0, 1, 3, 4, 99]) {
      expect(desktopPermissionFromMacNotificationSettings({
        ...authorizedSettings,
        authorizationStatus
      })).toBe("denied");
    }
    expect(desktopPermissionFromMacNotificationSettings(undefined)).toBe("denied");
  });

  it("coalesces concurrent native reads and fails closed with a recovery path", async () => {
    let resolveQuery: ((value: unknown) => void) | undefined;
    const query = vi.fn(() => new Promise<unknown>(resolve => { resolveQuery = resolve; }));
    const diagnostic = vi.fn();
    const reader = new MacNotificationPermissionReader(true, () => ({
      queryNotificationAuthorizationStatus: query
    }), diagnostic);
    const first = reader.refresh();
    const second = reader.refresh();
    expect(query).toHaveBeenCalledOnce();
    resolveQuery?.(authorizedSettings);
    await expect(first).resolves.toBe("granted");
    await expect(second).resolves.toBe("granted");
    expect(diagnostic).toHaveBeenCalledWith({
      outcome: "native",
      permission: "granted",
      settings: authorizedSettings
    });

    const failed = new MacNotificationPermissionReader(true, () => ({
      queryNotificationAuthorizationStatus: async () => { throw new Error("native load failed"); }
    }));
    await expect(failed.refresh()).resolves.toBe("denied");
    await expect(new MacNotificationPermissionReader(false).refresh()).resolves.toBe("unavailable");
  });
});
