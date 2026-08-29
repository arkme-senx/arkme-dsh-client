import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

describe("packaged application layout", () => {
  test("resolves macOS, Windows, and Linux electron-builder output paths", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts", "packaged-layout.mjs")).href;
    const program = `
      import { packagedAppLayout } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify({
        mac: packagedAppLayout("/project", "darwin"),
        windows: packagedAppLayout("C:/project", "win32"),
        linux: packagedAppLayout("/project", "linux")
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mac: {
        appRoot: path.join("/project", "release", "mac-arm64", "arkme.app"),
        appAsar: path.join("/project", "release", "mac-arm64", "arkme.app", "Contents", "Resources", "app.asar"),
        electron: path.join("/project", "release", "mac-arm64", "arkme.app", "Contents", "MacOS", "arkme"),
        resources: path.join("/project", "release", "mac-arm64", "arkme.app", "Contents", "Resources", "app.asar.unpacked")
      },
      windows: {
        appRoot: path.win32.join("C:/project", "release", "win-unpacked"),
        appAsar: path.win32.join("C:/project", "release", "win-unpacked", "resources", "app.asar"),
        electron: path.win32.join("C:/project", "release", "win-unpacked", "arkme.exe"),
        resources: path.win32.join("C:/project", "release", "win-unpacked", "resources", "app.asar.unpacked")
      },
      linux: {
        appRoot: path.join("/project", "release", "linux-unpacked"),
        appAsar: path.join("/project", "release", "linux-unpacked", "resources", "app.asar"),
        electron: path.join("/project", "release", "linux-unpacked", "arkme"),
        resources: path.join("/project", "release", "linux-unpacked", "resources", "app.asar.unpacked")
      }
    });
  });

  test("normalizes a supplied relative macOS app root before exposing runtime paths", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts", "packaged-layout.mjs")).href;
    const program = `
      import { packagedAppLayoutFromRoot } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify(packagedAppLayoutFromRoot(
        "release/mac-universal/arkme.app",
        "darwin"
      )));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot: path.resolve("release", "mac-universal", "arkme.app"),
      appAsar: path.resolve("release", "mac-universal", "arkme.app", "Contents", "Resources", "app.asar"),
      electron: path.resolve("release", "mac-universal", "arkme.app", "Contents", "MacOS", "arkme"),
      resources: path.resolve("release", "mac-universal", "arkme.app", "Contents", "Resources", "app.asar.unpacked")
    });
  });

  test("resolves the executable name for a side-by-side test application", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts", "packaged-layout.mjs")).href;
    const program = `
      import { packagedAppLayoutFromRoot } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify({
        mac: packagedAppLayoutFromRoot(
          "release-test-dynamic/mac-universal/arkme Test.app",
          "darwin",
          "arkme Test"
        ).electron,
        windows: packagedAppLayoutFromRoot(
          "C:/project/release-test-dynamic/win-unpacked",
          "win32",
          "arkme Test"
        ).electron,
        linux: packagedAppLayoutFromRoot(
          "/project/release-test-dynamic/linux-unpacked",
          "linux",
          "arkme Test"
        ).electron
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mac: path.resolve("release-test-dynamic", "mac-universal", "arkme Test.app", "Contents", "MacOS", "arkme Test"),
      windows: path.win32.resolve("C:/project/release-test-dynamic/win-unpacked", "arkme Test.exe"),
      linux: path.resolve("/project/release-test-dynamic/linux-unpacked", "arkme Test")
    });
  });

  test("requires the requested smoke target to match the host platform", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts", "packaged-layout.mjs")).href;
    const program = `
      import { resolvePackagedSmokePlatform } from ${JSON.stringify(moduleUrl)};
      const result = {
        defaultTarget: resolvePackagedSmokePlatform([], "darwin"),
        windowsTarget: resolvePackagedSmokePlatform(["--platform", "win32"], "win32"),
        linuxTarget: resolvePackagedSmokePlatform(["--platform", "linux"], "linux")
      };
      let mismatch;
      try {
        resolvePackagedSmokePlatform(["--platform", "win32"], "darwin");
      } catch (error) {
        mismatch = error.message;
      }
      process.stdout.write(JSON.stringify({ ...result, mismatch }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      defaultTarget: "darwin",
      windowsTarget: "win32",
      linuxTarget: "linux",
      mismatch: "Cannot verify a win32 package on a darwin host"
    });
  });

  test("accepts an explicit packaged app root without relying on shell-specific environment syntax", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts", "packaged-layout.mjs")).href;
    const program = `
      import { resolvePackagedSmokeAppRoot } from ${JSON.stringify(moduleUrl)};
      let missingValue;
      try {
        resolvePackagedSmokeAppRoot(["--app-root"]);
      } catch (error) {
        missingValue = error.message;
      }
      process.stdout.write(JSON.stringify({
        explicit: resolvePackagedSmokeAppRoot(
          ["--platform", "win32", "--app-root", "release-test-dynamic/win-unpacked"],
          "legacy-root"
        ),
        legacyEnvironment: resolvePackagedSmokeAppRoot([], "legacy-root"),
        absent: resolvePackagedSmokeAppRoot([], undefined),
        missingValue
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      explicit: "release-test-dynamic/win-unpacked",
      legacyEnvironment: "legacy-root",
      missingValue: "Packaged smoke --app-root requires a path"
    });
  });
});
