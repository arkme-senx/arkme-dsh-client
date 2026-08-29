import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ArkmeAppUpdateController, appUpdateFeedURL, resolveSupportedAppUpdateTarget, shouldForceDevAppUpdate } from "../src/app-update.js";

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

  test("only enables the development startup check when explicitly requested", () => {
    expect(shouldForceDevAppUpdate(false, {})).toBe(false);
    expect(shouldForceDevAppUpdate(false, { ARKME_FORCE_DEV_APP_UPDATE: "1" })).toBe(true);
    expect(shouldForceDevAppUpdate(true, { ARKME_FORCE_DEV_APP_UPDATE: "1" })).toBe(false);
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
