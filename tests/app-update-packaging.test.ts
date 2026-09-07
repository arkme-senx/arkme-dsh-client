import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const hook = require("../scripts/ensure-app-update-config.cjs");
const { AppUpdater } = require("electron-updater/out/AppUpdater.js");
const builderRequire = createRequire(require.resolve("electron-builder"));
const { Platform } = builderRequire("app-builder-lib/out/index.js");
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(platform = "darwin", publish: unknown = [{ provider: "generic", url: "https://updates.invalid/arkme/" }]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arkme-update-packaging-"));
  temporaryDirectories.push(directory);
  const config = { publish };
  const appInfo = { updaterCacheDirName: "arkme-updater", channel: null };
  return {
    electronPlatformName: platform, appOutDir: directory, arch: 1,
    targets: [{ name: "dir" }],
    packager: {
      platform: platform === "win32" ? Platform.WINDOWS : Platform.MAC,
      appInfo, config, info: { config, appInfo }, platformSpecificBuildOptions: {},
      expandMacro: (value: string) => value,
      getResourcesDir: () => directory,
      isForceCodeSigningVerification: true,
      signingManager: { value: Promise.resolve({ computedPublisherName: { value: Promise.resolve(["Test Publisher"]) } }) },
    },
  };
}

describe("packaged app update configuration", () => {
  test("wires the pre-sign hook into the builder config", () => {
    expect(require("../electron-builder.cjs").afterPack).toBe(hook);
  });

  test.each(["darwin", "win32"])("generates builder-owned configuration even for a %s dir target", async platform => {
    const context = await fixture(platform);
    await hook(context);
    const config = parse(await readFile(path.join(context.appOutDir, "app-update.yml"), "utf8"));
    expect(config).toMatchObject({ provider: "generic", url: "https://updates.invalid/arkme/", updaterCacheDirName: "arkme-updater" });
    if (platform === "win32") expect(config.publisherName).toEqual(["Test Publisher"]);
  });

  test("fails closed instead of silently packaging without publish configuration", async () => {
    await expect(hook(await fixture("darwin", null))).rejects.toThrow(/app-update.yml/);
  });

  test("does not require updater configuration for Linux manual updates", async () => {
    const context = await fixture("linux", null);
    await hook(context);
    await expect(readFile(path.join(context.appOutDir, "app-update.yml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([undefined, "", "../cache", "/cache", "a/b", "a\\b"])("rejects unsafe cache directory %s", cache => {
    expect(() => hook.assertAppUpdateConfig({ provider: "generic", url: "https://updates.invalid/arkme/", updaterCacheDirName: cache })).toThrow(/updaterCacheDirName/);
  });

  test("real updater reproduces missing config and initializes successfully after the build hook", async () => {
    const context = await fixture();
    const configPath = path.join(context.appOutDir, "app-update.yml");
    const createUpdater = () => new AppUpdater({ provider: "generic", url: "https://updates.invalid/another-feed/" }, {
      version: "0.2.8", name: "arkme", isPackaged: true,
      appUpdateConfigPath: configPath, userDataPath: context.appOutDir, baseCachePath: context.appOutDir,
      whenReady: async () => {},
    });
    await expect(createUpdater().getOrCreateDownloadHelper()).rejects.toMatchObject({ code: "ENOENT" });
    await hook(context);
    const updater = createUpdater();
    updater.logger = { info() {}, warn() {}, error() {} };
    await expect(updater.getOrCreateDownloadHelper()).resolves.toMatchObject({ cacheDir: path.join(context.appOutDir, "arkme-updater") });
  });

  test("a rerun replaces stale configuration before signing", async () => {
    const context = await fixture();
    await writeFile(path.join(context.appOutDir, "app-update.yml"), "invalid");
    await hook(context);
    expect(hook.assertAppUpdateConfig(parse(await readFile(path.join(context.appOutDir, "app-update.yml"), "utf8"))).updaterCacheDirName).toBe("arkme-updater");
  });
});
