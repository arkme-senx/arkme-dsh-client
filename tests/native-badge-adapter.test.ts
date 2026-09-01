import { describe, expect, test, vi } from "vitest";
import {
  createDesktopNativeBadgeAdapter,
  resolveNativeBadgeMode
} from "../src/native-badge-adapter.js";

describe("desktop native badge adapter", () => {
  test("uses absolute application badge counts on macOS and supported Linux launchers", () => {
    const setAppBadgeCount = vi.fn(() => true);
    const setMacDockBadge = vi.fn();
    const mac = createDesktopNativeBadgeAdapter({
      platform: "darwin",
      setAppBadgeCount,
      setMacDockBadge,
      linuxBadgeSupported: () => false,
      getWindowsWindow: () => null,
      getWindowsDotImage: () => "dot"
    });
    expect(mac.mode).toBe("count");
    expect(mac.apply(9)).toBe(true);
    expect(mac.apply(0)).toBe(true);

    const linux = createDesktopNativeBadgeAdapter({
      platform: "linux",
      setAppBadgeCount,
      setMacDockBadge,
      linuxBadgeSupported: () => true,
      getWindowsWindow: () => null,
      getWindowsDotImage: () => "dot"
    });
    expect(linux.mode).toBe("count");
    expect(linux.apply(4)).toBe(true);
    expect(setMacDockBadge.mock.calls).toEqual([["9"], [""]]);
    expect(setAppBadgeCount.mock.calls).toEqual([[4]]);
  });

  test("uses a fixed dot overlay on Windows and clears it with null", () => {
    const window = { isDestroyed: () => false, setOverlayIcon: vi.fn() };
    const adapter = createDesktopNativeBadgeAdapter({
      platform: "win32",
      setAppBadgeCount: vi.fn(() => false),
      setMacDockBadge: vi.fn(),
      linuxBadgeSupported: () => false,
      getWindowsWindow: () => window,
      getWindowsDotImage: () => "safe-dot",
      windowsDescription: "unread"
    });

    expect(adapter.mode).toBe("dot");
    expect(adapter.apply(99)).toBe(true);
    expect(adapter.apply(0)).toBe(true);
    expect(window.setOverlayIcon.mock.calls).toEqual([
      ["safe-dot", "unread"],
      [null, ""]
    ]);
  });

  test("reports unsupported desktops and unavailable Windows windows", () => {
    expect(resolveNativeBadgeMode("linux", () => false)).toBe("unsupported");
    expect(resolveNativeBadgeMode("freebsd", () => true)).toBe("unsupported");
    const adapter = createDesktopNativeBadgeAdapter({
      platform: "win32",
      setAppBadgeCount: vi.fn(() => true),
      setMacDockBadge: vi.fn(),
      linuxBadgeSupported: () => false,
      getWindowsWindow: () => null,
      getWindowsDotImage: () => "dot"
    });
    expect(adapter.apply(1)).toBe(false);
  });
});
