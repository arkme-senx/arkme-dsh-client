import { describe, expect, test } from "vitest";
import {
  assertElectronHarnessVersion,
  assertElectronHarnessRuntime,
  electronHarnessArtifactName,
  electronHarnessMetadata,
  resolveElectronHarnessTarget
} from "../scripts/runtime/electron-harness-lib.mjs";

describe("Electron Harness runtime artifacts", () => {
  test.each([
    ["darwin", "arm64", { os: "darwin", arch: "arm64" }],
    ["darwin", "x64", { os: "darwin", arch: "x64" }],
    ["win32", "x64", { os: "windows", arch: "x64" }],
    ["linux", "x64", { os: "linux", arch: "x64", libc: "glibc" }]
  ])("maps %s/%s to an Electron release target", (platform, arch, expected) => {
    expect(resolveElectronHarnessTarget(platform, arch)).toEqual(expected);
  });

  test("rejects unsupported targets instead of publishing a mislabeled native artifact", () => {
    expect(() => resolveElectronHarnessTarget("linux", "arm64")).toThrow(/unsupported/i);
  });

  test("accepts the exact Harness version selected by the runtime manifest without a fixed release gate", () => {
    expect(() => assertElectronHarnessVersion("0.1.1-rc.2")).not.toThrow();
    expect(() => assertElectronHarnessVersion("latest")).toThrow(/exact semver/i);
    expect(() => assertElectronHarnessVersion("^0.1.1-rc.2")).toThrow(/exact semver/i);
  });

  test("names and identifies an Electron 43 ABI-148 artifact", () => {
    const target = resolveElectronHarnessTarget("linux", "x64");
    expect(electronHarnessArtifactName(target, "0.1.0-rc.8")).toBe(
      "harness-electron43-linux-x64-glibc-0.1.0-rc.8.tar.zst"
    );
    expect(electronHarnessMetadata({
      target,
      version: "0.1.0-rc.8",
      buildId: "jenkins-20260827-1"
    })).toEqual({
      schemaVersion: 1,
      component: "electron-harness",
      version: "0.1.0-rc.8",
      buildId: "jenkins-20260827-1",
      target,
      runtime: {
        kind: "electron",
        electronVersion: "43.2.0",
        electronMajor: 43,
        modulesAbi: 148
      },
      pnpmVersion: "11.19.0"
    });
  });

  test("rejects Electron runtimes that only match the ABI or only match the version", () => {
    expect(() => assertElectronHarnessRuntime({
      electronVersion: "42.3.0",
      modulesAbi: "148"
    })).toThrow(/42\.3\.0.*43\.2\.0/);
    expect(() => assertElectronHarnessRuntime({
      electronVersion: "43.2.0",
      modulesAbi: "147"
    })).toThrow(/147.*148/);
  });
});
