import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ArkmeAppUpdateController, appUpdateFeedURL, resolveSupportedAppUpdateTarget } from "../src/app-update.js";
import { AUTOMATIC_UPDATE_CHECK_INTERVAL_MS } from "../src/update-check-policy.js";

describe("ArkmeAppUpdateController", () => {
  test("reads the direct JSON feed and downloads the selected package without installing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-app-update-"));
    const packageURL = "https://cdn.example.test/Arkme.exe";
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/latest")) return new Response(JSON.stringify({ version: "1.3.0", releaseNotes: "修复", downloadUrl: packageURL }), { status: 200 });
      if (url === packageURL) return new Response("installer bytes", { status: 200 });
      return new Response(null, { status: 404 });
    };
    const controller = new ArkmeAppUpdateController({ currentVersion: "1.2.0", serviceBaseUrl: "https://api.jotmo.cc", platform: "win32", arch: "x64", downloadsDirectory: path.join(root, "downloads"), fetchImpl });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "available", latestVersion: "1.3.0" });
    await expect(controller.download()).resolves.toMatchObject({ status: "downloaded", downloadedFilePath: path.join(root, "downloads", "arkme-1.3.0-win32-x64.exe") });
    await expect(readFile(path.join(root, "downloads", "arkme-1.3.0-win32-x64.exe"), "utf8")).resolves.toBe("installer bytes");
    await rm(root, { recursive: true, force: true });
  });

  test("uses per-platform latest JSON endpoints and treats a missing release as current", async () => {
    expect(appUpdateFeedURL("https://api.jotmo.cc", "linux", "x64")).toBe("https://api.jotmo.cc/api/public/v1/arkme/app-update/linux/x64/latest");
    expect(resolveSupportedAppUpdateTarget("darwin", "x64")).toBeNull();
    const controller = new ArkmeAppUpdateController({ currentVersion: "1.2.0", serviceBaseUrl: "https://api.jotmo.cc", platform: "darwin", arch: "arm64", downloadsDirectory: os.tmpdir(), fetchImpl: async () => new Response(null, { status: 404 }) });
    await expect(controller.checkNow()).resolves.toMatchObject({ status: "current", noUpdateAvailable: true });
  });

  test("rechecks automatically at thirty minutes and lets manual checks bypass the cooldown", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
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
      ? new Response(JSON.stringify({ version: "1.3.0", downloadUrl: packageURL }), { status: 200 })
      : new Response("package", { status: 200 }));
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
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
          return new Response(JSON.stringify({ version: "1.3.0", downloadUrl: initialPackageURL }), { status: 200 });
        }
        return await new Promise<Response>(resolve => { finishAutomaticCheck = resolve; });
      }
      return await new Promise<Response>(resolve => { finishDownload = resolve; });
    };
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
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

    finishAutomaticCheck?.(new Response(JSON.stringify({ version: "1.4.0", downloadUrl: nextPackageURL }), { status: 200 }));
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
          return new Response(JSON.stringify({ version: "1.3.0", downloadUrl: packageURL }), { status: 200 });
        }
        return await new Promise<Response>(resolve => { finishAutomaticCheck = resolve; });
      }
      return new Response("package", { status: 200 });
    };
    const controller = new ArkmeAppUpdateController({
      currentVersion: "1.2.0",
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
    finishAutomaticCheck?.(new Response(JSON.stringify({ version: "1.4.0", downloadUrl: "https://d.jiwo.cc/arkme-1.4.0.zip" }), { status: 200 }));

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
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: os.tmpdir(),
      fetchImpl: async input => {
        if (String(input).endsWith("/latest")) {
          return new Response(JSON.stringify({ version: "1.3.0", releaseNotes: "修复", downloadUrl: packageURL }), { status: 200 });
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
      applicationName: "arkme Test",
      serviceBaseUrl: "https://jotmo.senguo.me",
      platform: "darwin",
      arch: "arm64",
      downloadsDirectory: root,
      fetchImpl: async input => String(input).endsWith("/latest")
        ? new Response(JSON.stringify({
          version: "1.3.0",
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
});
