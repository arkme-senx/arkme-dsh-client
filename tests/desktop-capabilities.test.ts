import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  arkmeDesktopCapabilities,
  resolveArkmePreloadPath
} from "../src/desktop-capabilities.js";

describe("Arkme desktop preload capabilities", () => {
  test("exposes an immutable startup authentication gate flag", () => {
    expect(arkmeDesktopCapabilities).toEqual({
      startupAuthGate: true,
      appUpdate: true,
      runtimeManaged: true
    });
    expect(Object.isFrozen(arkmeDesktopCapabilities)).toBe(true);
    expect(() => {
      (arkmeDesktopCapabilities as { startupAuthGate: boolean }).startupAuthGate = false;
    }).toThrow(TypeError);
    expect(arkmeDesktopCapabilities.startupAuthGate).toBe(true);
    expect(arkmeDesktopCapabilities.appUpdate).toBe(true);
    expect(arkmeDesktopCapabilities.runtimeManaged).toBe(true);
  });

  test("resolves the CommonJS preload next to the main process bundle", () => {
    expect(resolveArkmePreloadPath("/Applications/arkme/resources/app.asar/dist")).toBe(
      path.join("/Applications/arkme/resources/app.asar/dist", "preload.cjs")
    );
  });

  test("resolves the packaged preload from the unpacked resources directory", () => {
    expect(resolveArkmePreloadPath("/tmp/dist", true, "/Applications/arkme/resources")).toBe(
      path.join(
        "/Applications/arkme/resources",
        "app.asar.unpacked",
        "dist",
        "preload.cjs"
      )
    );
  });
});
