import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import {
  ArkmeAppUpdateController,
  appUpdateFeedURL,
  resolveSupportedAppUpdateTarget,
  type AppUpdaterPort,
  type AppUpdaterUpdateInfo,
} from "../src/app-update.js";
import { parseAppVersionCode } from "../src/app-version-code.js";
import { AUTOMATIC_UPDATE_CHECK_INTERVAL_MS } from "../src/update-check-policy.js";

const TEST_SHA512 = Buffer.alloc(64, 1).toString("base64");

function fakeUpdater(info: AppUpdaterUpdateInfo): AppUpdaterPort & { quit: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  const quit = vi.fn();
  return Object.assign(emitter, {
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: false,
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: info })),
    downloadUpdate: vi.fn(async () => {
      emitter.emit("download-progress", { transferred: 50, total: 100 });
      return ["/cache/verified-update"];
    }),
    quitAndInstall: quit, quit,
  });
}

describe("ArkmeAppUpdateController", () => {
  test.each([
    { serverVersion: "1.1.0", serverVersionCode: 2, expectedStatus: "available" },
    { serverVersion: "9.0.0", serverVersionCode: 1, expectedStatus: "current" },
    { serverVersion: "9.0.0", serverVersionCode: 0, expectedStatus: "current" },
    { serverVersion: "1.2.0", serverVersionCode: 2, expectedStatus: "available" },
  ])("uses Version Code instead of the displayed version name: $serverVersion/$serverVersionCode", async ({
    serverVersion,
    serverVersionCode,
    expectedStatus,
  }) => {
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: async () => new Response(JSON.stringify({
        version: serverVersion,
        versionCode: serverVersionCode,
        downloadUrl: "https://d.jiwo.cc/arkme.zip",
      }), { status: 200 }),
    });

    await expect(controller.checkNow()).resolves.toMatchObject({ status: expectedStatus });
  });

  test.each([undefined, "2", -1, 1.5, 2_147_483_648])("fails closed for an invalid feed Version Code: %s", async versionCode => {
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: async () => new Response(JSON.stringify({
        version: "9.0.0",
        ...(versionCode === undefined ? {} : { versionCode }),
        downloadUrl: "https://d.jiwo.cc/arkme.zip",
      }), { status: 200 }),
    });

    await expect(controller.checkNow()).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("Version Code"),
    });
    await expect(controller.download()).resolves.toMatchObject({ status: "failed" });
  });

  test("parses only positive integer application Version Codes", () => {
    expect(parseAppVersionCode({ versionCode: 1 })).toBe(1);
    for (const manifest of [{}, { versionCode: 0 }, { versionCode: -1 }, { versionCode: 1.5 }, { versionCode: "1" }, { versionCode: 2_147_483_648 }]) {
      expect(() => parseAppVersionCode(manifest)).toThrow(/Version Code/);
    }
  });

  test("clears a previously available download when a later feed has no Version Code", async () => {
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      return new Response(JSON.stringify(requestCount === 1
        ? { version: "1.3.0", versionCode: 2, downloadUrl: "https://d.jiwo.cc/arkme.zip" }
        : { version: "1.4.0", downloadUrl: "https://d.jiwo.cc/arkme-next.zip" }), { status: 200 });
    });
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      fetchImpl,
    });

    await expect(controller.checkNow()).resolves.toMatchObject({ status: "available" });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "failed" });
    await expect(controller.download()).resolves.toMatchObject({ status: "failed", failureStage: "check", error: expect.stringContaining("Version Code") });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });


  test("uses per-platform latest JSON endpoints and treats a missing release as current", async () => {
    expect(appUpdateFeedURL("https://api.jotmo.cc", "linux", "x64")).toBe("https://api.jotmo.cc/api/public/v1/arkme/app-update/linux/x64/latest");
    expect(resolveSupportedAppUpdateTarget("darwin", "x64")).toBeNull();
    const controller = new ArkmeAppUpdateController({ currentVersion: "1.2.0", currentVersionCode: 1, serviceBaseUrl: "https://api.jotmo.cc", platform: "darwin", arch: "arm64", fetchImpl: async () => new Response(null, { status: 404 }) });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "current", noUpdateAvailable: true });
  });

  test("rechecks automatically at thirty minutes and lets manual checks bypass the cooldown", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      fetchImpl,
      now: () => now
    });

    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    now += 30 * 60_000 - 1;
    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 1;
    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await controller.checkNow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("coalesces concurrent automatic and manual checks into one feed request", async () => {
    let finishRequest: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(async () => await new Promise<Response>(resolve => { finishRequest = resolve; }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      fetchImpl
    });

    const automatic = controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    const manual = controller.checkNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    finishRequest?.(new Response(null, { status: 404 }));
    await expect(Promise.all([automatic, manual])).resolves.toEqual([
      expect.objectContaining({ status: "current" }),
      expect.objectContaining({ status: "current" })
    ]);
  });

  test("counts failed requests toward the automatic cooldown", async () => {
    let now = 5_000;
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      fetchImpl,
      now: () => now
    });

    await expect(controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).resolves.toMatchObject({ status: "failed" });
    now += 10_000;
    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rechecks after the wall clock moves backward", async () => {
    let now = 5_000;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      fetchImpl,
      now: () => now
    });

    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    now = 4_000;
    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });






  test("opens electron-updater only after the Version Code gate and allows lower SemVer", async () => {
    const downloadUrl = "https://cdn.example.test/stable/arkme-1.1.0-vc2-arm64.zip";
    const updater = fakeUpdater({
      version: "1.1.0",
      files: [{ url: downloadUrl, sha512: TEST_SHA512, size: 123 }],
    });
    const createUpdater = vi.fn(() => updater);
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      createUpdater,
      fetchImpl: async () => new Response(JSON.stringify({
        version: "1.1.0",
        versionCode: 2,
        downloadUrl,
        updateFeedUrl: "https://cdn.example.test/stable/",
      })),
    });

    await expect(controller.checkNow()).resolves.toMatchObject({
      status: "available",
      canAutoInstall: true,
      currentVersionCode: 1,
      latestVersionCode: 2,
    });
    expect(createUpdater).toHaveBeenCalledTimes(1);
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: true });
  });

  test("never creates an updater when the server Version Code cannot upgrade the app", async () => {
    const createUpdater = vi.fn();
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 2,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "win32",
      arch: "x64",
      createUpdater,
      fetchImpl: async () => new Response(JSON.stringify({
        version: "9.0.0",
        versionCode: 2,
        downloadUrl: "https://cdn.example.test/arkme-9.0.0-vc2-x64.exe",
        updateFeedUrl: "https://cdn.example.test/",
      })),
    });

    await expect(controller.checkNow()).resolves.toMatchObject({ status: "current" });
    expect(createUpdater).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "version",
      info: { version: "1.4.0", files: [{ url: "arkme-1.3.0-vc2-x64.exe", sha512: TEST_SHA512, size: 10 }] },
      error: "版本",
    },
    {
      name: "URL",
      info: { version: "1.3.0", files: [{ url: "https://other.example.test/arkme-1.3.0-vc2-x64.exe", sha512: TEST_SHA512, size: 10 }] },
      error: "地址",
    },
    {
      name: "Version Code filename",
      info: { version: "1.3.0", files: [{ url: "arkme-1.3.0-x64.exe", sha512: TEST_SHA512, size: 10 }] },
      downloadUrl: "https://cdn.example.test/stable/arkme-1.3.0-x64.exe",
      error: "Version Code",
    },
    {
      name: "SHA-512",
      info: { version: "1.3.0", files: [{ url: "arkme-1.3.0-vc2-x64.exe", size: 10 }] },
      error: "SHA-512",
    },
    {
      name: "size",
      info: { version: "1.3.0", files: [{ url: "arkme-1.3.0-vc2-x64.exe", sha512: TEST_SHA512, size: 0 }] },
      error: "大小",
    },
  ])("fails closed when updater metadata has a mismatched $name", async ({ info, downloadUrl, error }) => {
    const packageURL = downloadUrl ?? "https://cdn.example.test/stable/arkme-1.3.0-vc2-x64.exe";
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "win32",
      arch: "x64",
      createUpdater: () => fakeUpdater(info),
      fetchImpl: async () => new Response(JSON.stringify({
        version: "1.3.0",
        versionCode: 2,
        downloadUrl: packageURL,
        updateFeedUrl: "https://cdn.example.test/stable/",
      })),
    });

    await expect(controller.checkNow()).resolves.toMatchObject({
      status: "failed",
      failureStage: "check",
      error: expect.stringContaining(error),
    });
    await expect(controller.download()).resolves.toMatchObject({ status: "failed" });
  });

  test("uses updater verification/download progress and coalesces restart-and-install requests", async () => {
    const downloadUrl = "https://cdn.example.test/stable/arkme-1.3.0-vc2-x64.exe";
    const updater = fakeUpdater({
      version: "1.3.0",
      files: [{ url: "arkme-1.3.0-vc2-x64.exe", sha512: TEST_SHA512, size: 100 }],
    });
    let finishInstall: (() => void) | undefined;
    const installUpdate = vi.fn(async (_target, launch: () => void) => {
      await new Promise<void>(resolve => { finishInstall = resolve; });
      launch();
    });
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "win32",
      arch: "x64",
      createUpdater: () => updater,
      installUpdate,
      fetchImpl: async () => new Response(JSON.stringify({
        version: "1.3.0",
        versionCode: 2,
        downloadUrl,
        updateFeedUrl: "https://cdn.example.test/stable/",
      })),
    });

    await controller.checkNow();
    await expect(controller.download()).resolves.toMatchObject({
      status: "downloaded",
      downloadedFilePath: "/cache/verified-update",
      downloadedBytes: 50,
      totalBytes: 100,
    });
    const first = controller.install();
    const duplicate = controller.install();
    expect(duplicate).toBe(first);
    expect(controller.snapshotNow()).toMatchObject({ status: "installing" });
    finishInstall?.();
    await expect(first).resolves.toMatchObject({ status: "installing" });
    await expect(controller.install()).resolves.toMatchObject({ status: "installing" });
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(updater.quit).toHaveBeenCalledWith(true, true);
  });

  test("stops at the download stage when updater SHA-512 or platform signature verification fails", async () => {
    const downloadUrl = "https://cdn.example.test/stable/arkme-1.3.0-vc2-x64.exe";
    const updater = fakeUpdater({
      version: "1.3.0",
      files: [{ url: downloadUrl, sha512: TEST_SHA512, size: 100 }],
    });
    updater.downloadUpdate = vi.fn(async () => { throw new Error("invalid platform signature"); });
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "win32",
      arch: "x64",
      createUpdater: () => updater,
      fetchImpl: async () => new Response(JSON.stringify({
        version: "1.3.0",
        versionCode: 2,
        downloadUrl,
        updateFeedUrl: "https://cdn.example.test/stable/",
      })),
    });

    await controller.checkNow();
    await expect(controller.download()).resolves.toMatchObject({
      status: "failed",
      failureStage: "download",
      error: expect.stringContaining("signature"),
    });
    expect(updater.quit).not.toHaveBeenCalled();
  });

  test("does not launch the installer when Harness shutdown preparation fails", async () => {
    const downloadUrl = "https://cdn.example.test/stable/arkme-1.3.0-vc2-arm64.zip";
    const updater = fakeUpdater({
      version: "1.3.0",
      files: [{ url: downloadUrl, sha512: TEST_SHA512, size: 100 }],
    });
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      createUpdater: () => updater,
      installUpdate: async () => { throw new Error("Harness stop failed"); },
      fetchImpl: async () => new Response(JSON.stringify({
        version: "1.3.0",
        versionCode: 2,
        downloadUrl,
        updateFeedUrl: "https://cdn.example.test/stable/",
      })),
    });

    await controller.checkNow();
    await controller.download();
    await expect(controller.install()).resolves.toMatchObject({
      status: "failed",
      failureStage: "install",
      error: expect.stringContaining("Harness stop failed"),
    });
    expect(updater.quit).not.toHaveBeenCalled();
  });

  test.each([
    { platform: "darwin", arch: "arm64", packageName: "arkme-0.2.6-vc3-universal.zip", website: "https://downloads.example.test/arkme.dmg.zip" },
    { platform: "darwin", arch: "arm64", packageName: "arkme-0.2.6-vc3-universal.zip", website: "https://downloads.example.test/arkme.dmg" },
    { platform: "win32", arch: "x64", packageName: "arkme-0.2.6-vc3-x64.exe", website: "https://downloads.example.test/arkme-portable.zip" },
    { platform: "darwin", arch: "arm64", packageName: "arkme-0.2.6-vc3-universal.zip", website: undefined },
    { platform: "darwin", arch: "arm64", packageName: "arkme-0.2.6-vc3-universal.zip", website: "not-an-update-url" },
  ] as const)("updates $platform from YAML independently of website URL $website", async ({ platform, arch, packageName, website }) => {
    const updater = fakeUpdater({ version: "0.2.6", files: [{ url: packageName, sha512: TEST_SHA512, size: 100 }] });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      version: "0.2.6", versionCode: 3, downloadUrl: website, updateFeedUrl: "https://updates.example.test/0.2.6-vc3/",
    })));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "0.2.4", currentVersionCode: 2, serviceBaseUrl: "https://api.jotmo.cc",
      platform, arch, fetchImpl, createUpdater: () => updater,
      installUpdate: async (_target, launch) => launch(),
    });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "available", canAutoInstall: true, latestVersionCode: 3 });
    await expect(controller.download()).resolves.toMatchObject({ status: "downloaded" });
    await expect(controller.install()).resolves.toMatchObject({ status: "installing" });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.quit).toHaveBeenCalledWith(true, true);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Never fetch the website package.
  });

  test.each(["http://updates.example.test/", "https://updates.example.test/latest-mac.yml", { url: "https://updates.example.test/" }])("never falls back to manual download for an invalid feed: %s", async updateFeedUrl => {
    const createUpdater = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      version: "0.2.6", versionCode: 3, downloadUrl: "https://downloads.example.test/arkme.dmg.zip", updateFeedUrl,
    })));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "0.2.4", currentVersionCode: 2, serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin", arch: "arm64", fetchImpl, createUpdater,
    });
    const failure = await controller.checkNow();
    expect(failure).toMatchObject({ status: "failed", failureStage: "check", canAutoInstall: false, latestVersion: "0.2.6", latestVersionCode: 3 });
    await expect(controller.download()).resolves.toEqual(failure);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(createUpdater).not.toHaveBeenCalled();
  });

  test("retains the metadata failure on stale download, then recovers through a fresh check", async () => {
    const info = { version: "0.2.5", files: [{ url: "arkme-0.2.6-vc3-universal.zip", sha512: TEST_SHA512, size: 100 }] };
    const updater = fakeUpdater(info);
    const controller = new ArkmeAppUpdateController({
      currentVersion: "0.2.4", currentVersionCode: 2, serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin", arch: "arm64", createUpdater: () => updater,
      fetchImpl: async () => new Response(JSON.stringify({
        version: "0.2.6", versionCode: 3, downloadUrl: "https://downloads.example.test/arkme.dmg.zip", updateFeedUrl: "https://updates.example.test/",
      })),
    });
    const failure = await controller.checkNow();
    expect(failure).toMatchObject({ failureStage: "check", error: "自动更新元数据版本与发布记录不一致" });
    await expect(controller.download()).resolves.toEqual(failure);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    info.version = "0.2.6";
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "available", canAutoInstall: true });
    await expect(controller.download()).resolves.toMatchObject({ status: "downloaded" });
  });

  test("surfaces a previous incomplete install at startup before automatic checks overwrite it", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      previousInstallFailure: { version: "1.3.0", versionCode: 2 },
      fetchImpl,
      now: () => 10_000,
    });
    expect(controller.snapshotNow()).toMatchObject({
      status: "failed",
      failureStage: "install",
      latestVersionCode: 2,
      error: expect.stringContaining("上次安装未完成"),
    });
    await expect(controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).resolves.toMatchObject({
      status: "failed",
      failureStage: "install",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


test.each([false, true])("protects an active/completed auto download from a late check: completed=%s", async completed => {
  let finishCheck!: (response: Response) => void;
  let finishDownload!: (files: string[]) => void;
  let calls = 0;
  const updater = fakeUpdater({ version: "1.3.0", files: [{ url: "arkme-1.3.0-vc2-arm64.zip", sha512: TEST_SHA512, size: 100 }] });
  updater.downloadUpdate = async () => await new Promise(resolve => { finishDownload = resolve; });
  const controller = new ArkmeAppUpdateController({
    currentVersion: "1.2.0", currentVersionCode: 1, serviceBaseUrl: "https://api.jotmo.cc", platform: "darwin", arch: "arm64",
    createUpdater: () => updater,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ version: "1.3.0", versionCode: 2, updateFeedUrl: "https://updates.example.test/" }));
      return await new Promise(resolve => { finishCheck = resolve; });
    },
  });
  await controller.checkNow();
  const checking = controller.checkNow();
  const downloading = controller.download();
  if (completed) { finishDownload(["/cache/verified-update"]); await downloading; }
  finishCheck(new Response(JSON.stringify({ version: "1.4.0", versionCode: 3, updateFeedUrl: "https://updates.example.test/" })));
  await expect(checking).resolves.toMatchObject({ status: completed ? "downloaded" : "downloading", latestVersion: "1.3.0" });
  if (!completed) { finishDownload(["/cache/verified-update"]); await downloading; }
  await expect(controller.checkNow()).resolves.toMatchObject({ status: "downloaded" });
  expect(calls).toBe(2);
});
