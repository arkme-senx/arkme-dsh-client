import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

describe("packaged shell runner", () => {
  test("resolves explicit production and test packages on every supported host", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts", "packaged-shell-lib.mjs")).href;
    const program = `
      import { resolvePackagedShell } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify({
        prodMac: resolvePackagedShell("/project", "prod", "darwin"),
        testMac: resolvePackagedShell("/project", "test", "darwin"),
        prodWindows: resolvePackagedShell("C:/project", "prod", "win32"),
        testWindows: resolvePackagedShell("C:/project", "test", "win32"),
        prodLinux: resolvePackagedShell("/project", "prod", "linux"),
        testLinux: resolvePackagedShell("/project", "test", "linux")
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      prodMac: {
        environment: "prod",
        applicationName: "arkme",
        appRoot: "/project/release/mac-universal/arkme.app",
        appAsar: "/project/release/mac-universal/arkme.app/Contents/Resources/app.asar",
        executable: "/project/release/mac-universal/arkme.app/Contents/MacOS/arkme",
        buildCommand: "pnpm pack"
      },
      testMac: {
        environment: "test",
        applicationName: "arkme Test",
        appRoot: "/project/release-test-dynamic/mac-universal/arkme Test.app",
        appAsar: "/project/release-test-dynamic/mac-universal/arkme Test.app/Contents/Resources/app.asar",
        executable: "/project/release-test-dynamic/mac-universal/arkme Test.app/Contents/MacOS/arkme Test",
        buildCommand: "pnpm dist:test:mac"
      },
      prodWindows: {
        environment: "prod",
        applicationName: "arkme",
        appRoot: "C:\\project\\release\\win-unpacked",
        appAsar: "C:\\project\\release\\win-unpacked\\resources\\app.asar",
        executable: "C:\\project\\release\\win-unpacked\\arkme.exe",
        buildCommand: "pnpm dist:win"
      },
      testWindows: {
        environment: "test",
        applicationName: "arkme Test",
        appRoot: "C:\\project\\release-test-dynamic\\win-unpacked",
        appAsar: "C:\\project\\release-test-dynamic\\win-unpacked\\resources\\app.asar",
        executable: "C:\\project\\release-test-dynamic\\win-unpacked\\arkme Test.exe",
        buildCommand: "pnpm dist:test:win"
      },
      prodLinux: {
        environment: "prod",
        applicationName: "arkme",
        appRoot: "/project/release/linux-unpacked",
        appAsar: "/project/release/linux-unpacked/resources/app.asar",
        executable: "/project/release/linux-unpacked/arkme",
        buildCommand: "pnpm dist:linux"
      },
      testLinux: {
        environment: "test",
        applicationName: "arkme Test",
        appRoot: "/project/release-test-dynamic/linux-unpacked",
        appAsar: "/project/release-test-dynamic/linux-unpacked/resources/app.asar",
        executable: "/project/release-test-dynamic/linux-unpacked/arkme Test",
        buildCommand: "pnpm dist:test:linux"
      }
    });
  });

  test("rejects an unknown environment and a package baked for the opposite environment", () => {
    const moduleUrl = pathToFileURL(path.resolve("scripts", "packaged-shell-lib.mjs")).href;
    const program = `
      import { assertPackagedShellEnvironment, resolvePackagedShell } from ${JSON.stringify(moduleUrl)};
      const errors = {};
      try { resolvePackagedShell("/project", "staging", "darwin"); }
      catch (error) { errors.unknown = error.message; }
      try {
        assertPackagedShellEnvironment(
          JSON.stringify({ serviceBaseUrl: "https://jotmo.senguo.me" }),
          "prod"
        );
      } catch (error) { errors.mismatch = error.message; }
      process.stdout.write(JSON.stringify(errors));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      unknown: "Packaged shell environment must be prod or test: staging",
      mismatch: "Refusing to start test package through run:prod"
    });
  });
});
