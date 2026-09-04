import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  ArkmeAppUpdateController,
  appUpdateFeedURL,
  resolveSupportedAppUpdateTarget,
  type AppUpdaterPort,
  type AppUpdaterProgress,
  type AppUpdaterUpdateInfo,
} from "../src/app-update.js";
import { parseAppVersionCode } from "../src/app-version-code.js";
import { AUTOMATIC_UPDATE_CHECK_INTERVAL_MS } from "../src/update-check-policy.js";

function fakeUpdater(info: AppUpdaterUpdateInfo): AppUpdaterPort & { quit: ReturnType<typeof vi.fn> } {
  let progressListener: ((progress: AppUpdaterProgress) => void) | undefined;
  const quit = vi.fn();
  const updater: AppUpdaterPort & { quit: ReturnType<typeof vi.fn> } = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: info })),
    downloadUpdate: vi.fn(async () => {
      progressListener?.({ transferred: 50, total: 100 });
      return ["/cache/verified-update"];
    }),
    quitAndInstall: quit,
    on: (_event, listener) => {
      progressListener = listener;
      return updater;
    },
    removeListener: (_event, listener) => {
      if (progressListener === listener) progressListener = undefined;
      return updater;
    },
    quit,
  };
  return updater;
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
      downloadsDirectory: os.tmpdir(),
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
      downloadsDirectory: os.tmpdir(),
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
      downloadsDirectory: os.tmpdir(),
      fetchImpl,
    });

    await expect(controller.checkNow()).resolves.toMatchObject({ status: "available" });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "failed" });
    await expect(controller.download()).resolves.toMatchObject({ status: "failed", error: "请先检查更新" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("reads the direct JSON feed and downloads the selected package without installing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-app-update-"));
    const packageURL = "https://cdn.example.test/Arkme.exe";
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/latest")) return new Response(JSON.stringify({ version: "1.3.0", versionCode: 2, releaseNotes: "修复", downloadUrl: packageURL }), { status: 200 });
      if (url === packageURL) return new Response("installer bytes", { status: 200 });
      return new Response(null, { status: 404 });
    };
    const controller = new ArkmeAppUpdateController({ currentVersion: "1.2.0", currentVersionCode: 1, serviceBaseUrl: "https://api.jotmo.cc", platform: "win32", arch: "x64", downloadsDirectory: path.join(root, "downloads"), fetchImpl });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "available", latestVersion: "1.3.0" });
    await expect(controller.download()).resolves.toMatchObject({ status: "downloaded", downloadedFilePath: path.join(root, "downloads", "arkme-1.3.0-win32-x64.exe") });
    await expect(readFile(path.join(root, "downloads", "arkme-1.3.0-win32-x64.exe"), "utf8")).resolves.toBe("installer bytes");
    await rm(root, { recursive: true, force: true });
  });

  test("uses per-platform latest JSON endpoints and treats a missing release as current", async () => {
    expect(appUpdateFeedURL("https://api.jotmo.cc", "linux", "x64")).toBe("https://api.jotmo.cc/api/public/v1/arkme/app-update/linux/x64/latest");
    expect(resolveSupportedAppUpdateTarget("darwin", "x64")).toBeNull();
    const controller = new ArkmeAppUpdateController({ currentVersion: "1.2.0", currentVersionCode: 1, serviceBaseUrl: "https://api.jotmo.cc", platform: "darwin", arch: "arm64", downloadsDirectory: os.tmpdir(), fetchImpl: async () => new Response(null, { status: 404 }) });
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
      downloadsDirectory: os.tmpdir(),
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
      downloadsDirectory: os.tmpdir(),
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
      downloadsDirectory: os.tmpdir(),
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
      downloadsDirectory: os.tmpdir(),
      fetchImpl,
      now: () => now
    });

    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    now = 4_000;
    await controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not replace a downloaded update with a later automatic check", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-downloaded-update-"));
    let now = 10_000;
    const packageURL = "https://d.jiwo.cc/arkme-1.3.0.zip";
    const fetchImpl = vi.fn(async input => String(input).endsWith("/latest")
      ? new Response(JSON.stringify({ version: "1.3.0", versionCode: 2, downloadUrl: packageURL }), { status: 200 })
      : new Response("package", { status: 200 }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: root,
      fetchImpl,
      now: () => now
    });

    await controller.checkNow();
    await controller.download();
    now += AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;
    await expect(controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).resolves.toMatchObject({ status: "downloaded" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await rm(root, { recursive: true, force: true });
  });

  test("does not let an in-flight automatic check replace download progress", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-check-download-race-"));
    let now = 10_000;
    let feedRequests = 0;
    let finishAutomaticCheck: ((response: Response) => void) | undefined;
    let finishDownload: ((response: Response) => void) | undefined;
    const initialPackageURL = "https://d.jiwo.cc/arkme-1.3.0.zip";
    const nextPackageURL = "https://d.jiwo.cc/arkme-1.4.0.zip";
    const fetchImpl: typeof fetch = async input => {
      if (String(input).endsWith("/latest")) {
        feedRequests += 1;
        if (feedRequests === 1) {
          return new Response(JSON.stringify({ version: "1.3.0", versionCode: 2, downloadUrl: initialPackageURL }), { status: 200 });
        }
        return await new Promise<Response>(resolve => { finishAutomaticCheck = resolve; });
      }
      return await new Promise<Response>(resolve => { finishDownload = resolve; });
    };
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: root,
      fetchImpl,
      now: () => now
    });

    await controller.checkNow();
    now += AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;
    const automaticCheck = controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    await vi.waitFor(() => expect(feedRequests).toBe(2));
    const download = controller.download();
    expect(controller.snapshotNow()).toMatchObject({ status: "downloading", latestVersion: "1.3.0" });

    finishAutomaticCheck?.(new Response(JSON.stringify({ version: "1.4.0", versionCode: 3, downloadUrl: nextPackageURL }), { status: 200 }));
    const automaticSnapshot = await automaticCheck;
    finishDownload?.(new Response("package", { status: 200 }));
    const downloadedSnapshot = await download;

    expect(automaticSnapshot).toMatchObject({ status: "downloading", latestVersion: "1.3.0" });
    expect(downloadedSnapshot).toMatchObject({
      status: "downloaded",
      latestVersion: "1.3.0",
      downloadedFilePath: path.join(root, "arkme-1.3.0-darwin-arm64.zip")
    });
    await rm(root, { recursive: true, force: true });
  });

  test("does not let an in-flight automatic check replace a completed download", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-check-downloaded-race-"));
    let now = 10_000;
    let feedRequests = 0;
    let finishAutomaticCheck: ((response: Response) => void) | undefined;
    const packageURL = "https://d.jiwo.cc/arkme-1.3.0.zip";
    const fetchImpl: typeof fetch = async input => {
      if (String(input).endsWith("/latest")) {
        feedRequests += 1;
        if (feedRequests === 1) {
          return new Response(JSON.stringify({ version: "1.3.0", versionCode: 2, downloadUrl: packageURL }), { status: 200 });
        }
        return await new Promise<Response>(resolve => { finishAutomaticCheck = resolve; });
      }
      return new Response("package", { status: 200 });
    };
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: root,
      fetchImpl,
      now: () => now
    });

    await controller.checkNow();
    now += AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;
    const automaticCheck = controller.checkIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    await vi.waitFor(() => expect(feedRequests).toBe(2));
    await controller.download();
    finishAutomaticCheck?.(new Response(JSON.stringify({ version: "1.4.0", versionCode: 3, downloadUrl: "https://d.jiwo.cc/arkme-1.4.0.zip" }), { status: 200 }));

    await expect(automaticCheck).resolves.toMatchObject({
      status: "downloaded",
      latestVersion: "1.3.0",
      downloadedFilePath: path.join(root, "arkme-1.3.0-darwin-arm64.zip")
    });
    await rm(root, { recursive: true, force: true });
  });

  test("reports byte progress while a direct update package is downloading", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const packageURL = "https://cdn.example.test/Arkme.zip";
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: os.tmpdir(),
      fetchImpl: async input => {
        if (String(input).endsWith("/latest")) {
          return new Response(JSON.stringify({ version: "1.3.0", versionCode: 2, releaseNotes: "修复", downloadUrl: packageURL }), { status: 200 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(value) { streamController = value; },
        }), { status: 200, headers: { "content-length": "8" } });
      },
    });

    await controller.checkNow();
    const downloading = controller.download();
    await new Promise(resolve => setTimeout(resolve, 0));
    streamController?.enqueue(new TextEncoder().encode("half"));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(controller.snapshotNow()).toMatchObject({
      status: "downloading",
      downloadedBytes: 4,
      totalBytes: 8,
    });

    streamController?.enqueue(new TextEncoder().encode("done"));
    streamController?.close();
    await expect(downloading).resolves.toMatchObject({ status: "downloaded" });
  });

  test("names a downloaded test update for the side-by-side test application", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-test-app-update-"));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      applicationName: "arkme Test",
      serviceBaseUrl: "https://jotmo.senguo.me",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: root,
      fetchImpl: async input => String(input).endsWith("/latest")
        ? new Response(JSON.stringify({
          version: "1.3.0",
          versionCode: 2,
          downloadUrl: "https://d.jiwo.cc/arkme-test-1.3.0.zip"
        }), { status: 200 })
        : new Response("test update bytes", { status: 200 })
    });

    await controller.checkNow();
    await expect(controller.download()).resolves.toMatchObject({
      status: "downloaded",
      downloadedFilePath: path.join(root, "arkme Test-1.3.0-darwin-arm64.zip")
    });
    await rm(root, { recursive: true, force: true });
  });

  test("opens electron-updater only after the Version Code gate and allows lower SemVer", async () => {
    const downloadUrl = "https://cdn.example.test/stable/arkme-1.1.0-vc2-arm64.zip";
    const updater = fakeUpdater({
      version: "1.1.0",
      files: [{ url: downloadUrl, sha512: "digest", size: 123 }],
    });
    const createUpdater = vi.fn(() => updater);
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: os.tmpdir(),
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
      installMode: "in-app",
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
      downloadsDirectory: os.tmpdir(),
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
      info: { version: "1.4.0", files: [{ url: "arkme-1.3.0-vc2-x64.exe", sha512: "digest", size: 10 }] },
      error: "版本",
    },
    {
      name: "URL",
      info: { version: "1.3.0", files: [{ url: "other-1.3.0-vc2-x64.exe", sha512: "digest", size: 10 }] },
      error: "地址",
    },
    {
      name: "Version Code filename",
      info: { version: "1.3.0", files: [{ url: "arkme-1.3.0-x64.exe", sha512: "digest", size: 10 }] },
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
      info: { version: "1.3.0", files: [{ url: "arkme-1.3.0-vc2-x64.exe", sha512: "digest", size: 0 }] },
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
      downloadsDirectory: os.tmpdir(),
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
      files: [{ url: "arkme-1.3.0-vc2-x64.exe", sha512: "digest", size: 100 }],
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
      downloadsDirectory: os.tmpdir(),
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
      files: [{ url: downloadUrl, sha512: "declared-digest", size: 100 }],
    });
    updater.downloadUpdate = vi.fn(async () => { throw new Error("invalid platform signature"); });
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "win32",
      arch: "x64",
      downloadsDirectory: os.tmpdir(),
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
      files: [{ url: downloadUrl, sha512: "digest", size: 100 }],
    });
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: os.tmpdir(),
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

  test("surfaces a previous incomplete install at startup before automatic checks overwrite it", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
      currentVersionCode: 1,
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: os.tmpdir(),
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
