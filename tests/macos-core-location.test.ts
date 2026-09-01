import { describe, expect, test } from "vitest";
import { createMacCoreLocationDriver } from "../src/macos-core-location.js";

describe.skipIf(process.platform !== "darwin")("macOS CoreLocation FFI", () => {
  test("loads CoreLocation in-process and keeps a CLLocationManager without reading coordinates", () => {
    const driver = createMacCoreLocationDriver();
    try {
      expect(typeof driver.locationServicesEnabled()).toBe("boolean");
      expect([0, 1, 2, 3, 4]).toContain(driver.authorizationStatus());
    } finally {
      driver.dispose();
      driver.dispose();
    }
    expect(() => driver.authorizationStatus()).toThrow("CLLocationManager is disposed");
  });
});

describe("CoreLocation platform loading", () => {
  test("fails before resolving the native addon on non-macOS platforms", () => {
    expect(() => createMacCoreLocationDriver("win32")).toThrow(
      "CoreLocation is only available on macOS"
    );
    expect(() => createMacCoreLocationDriver("linux")).toThrow(
      "CoreLocation is only available on macOS"
    );
  });
});
