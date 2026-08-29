import { describe, expect, test, vi } from "vitest";
import {
  fetchElectronRuntimeManifest,
  resolveElectronRuntimeTarget,
  verifyElectronRuntimePluginHealth
} from "../src/runtime/client.js";
import { RuntimeArtifactValidationError } from "../src/runtime/errors.js";
import { deriveElectronRuntimeReleaseId, type ElectronRuntimeManifest } from "../src/runtime/manifest.js";

describe("Electron runtime manifest client", () => {
  test("maps Electron platforms to the four supported backend targets", () => {
    expect(resolveElectronRuntimeTarget("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(resolveElectronRuntimeTarget("darwin", "x64")).toEqual({ os: "darwin", arch: "x64" });
    expect(resolveElectronRuntimeTarget("win32", "x64")).toEqual({ os: "windows", arch: "x64" });
    expect(resolveElectronRuntimeTarget("linux", "x64")).toEqual({ os: "linux", arch: "x64" });
    expect(resolveElectronRuntimeTarget("linux", "arm64")).toBeNull();
  });

  test("requests the public Electron manifest with manual redirect handling", async () => {
    const document = {
      schemaVersion: 1,
      releaseId: "electron-runtime-v1-0123456789abcdef0123456789abcdef",
      channel: "stable",
      publishedAt: "2026-08-27T00:00:00Z",
      target: { os: "windows", arch: "x64" },
      minShellVersion: "0.2.0",
      runtimeApiVersion: 1,
      dataSchemaVersion: 1,
      electron: { major: 43, modulesAbi: 148 },
      pnpmVersion: "11.19.0",
      artifacts: {
        harness: { version: "0.1.0-rc.8", versionCode: 1, modulesAbi: 148, url: "https://d.jiwo.cc/harness.tar.zst", sha256: "a".repeat(64), size: 1, unpackedSize: 1, entry: "harness/node_modules/@deepseek-ai/dsh/lib/bin.js", metadata: "harness/runtime-metadata.json" },
        requiredPlugin: { version: "0.1.18", versionCode: 1, url: "https://d.jiwo.cc/plugin.tar.zst", sha256: "b".repeat(64), size: 1, unpackedSize: 1, name: "@senguoyun/dsh-arkme", target: "harness/node_modules/@senguoyun/dsh-arkme" }
      }
    };
    document.releaseId = deriveElectronRuntimeReleaseId(document as ElectronRuntimeManifest);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(document), { status: 200 }));

    const result = await fetchElectronRuntimeManifest({
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "win32",
      arch: "x64",
      shellVersion: "0.2.0",
      electronMajor: 43,
      modulesAbi: 148,
      fetcher
    });

    expect(result.releaseId).toBe(document.releaseId);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.jotmo.cc/api/public/v1/arkme/electron-runtime-update/windows/x64/latest",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  test("allows the build-pinned test service origin", async () => {
    const document = {
      schemaVersion: 1,
      releaseId: "electron-runtime-v1-0123456789abcdef0123456789abcdef",
      channel: "stable",
      publishedAt: "2026-08-27T00:00:00Z",
      target: { os: "darwin", arch: "arm64" },
      minShellVersion: "0.2.0",
      runtimeApiVersion: 1,
      dataSchemaVersion: 1,
      electron: { major: 43, modulesAbi: 148 },
      pnpmVersion: "11.19.0",
      artifacts: {
        harness: { version: "0.1.0-rc.8", versionCode: 1, modulesAbi: 148, url: "https://d.jiwo.cc/harness.tar.zst", sha256: "a".repeat(64), size: 1, unpackedSize: 1, entry: "harness/node_modules/@deepseek-ai/dsh/lib/bin.js", metadata: "harness/runtime-metadata.json" },
        requiredPlugin: { version: "0.1.18", versionCode: 1, url: "https://d.jiwo.cc/plugin.tar.zst", sha256: "b".repeat(64), size: 1, unpackedSize: 1, name: "@senguoyun/dsh-arkme", target: "harness/node_modules/@senguoyun/dsh-arkme" }
      }
    };
    document.releaseId = deriveElectronRuntimeReleaseId(document as ElectronRuntimeManifest);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(document), { status: 200 }));

    await fetchElectronRuntimeManifest({
      serviceBaseUrl: "https://jotmo.senguo.me",
      platform: "darwin",
      arch: "arm64",
      shellVersion: "0.2.0",
      electronMajor: 43,
      modulesAbi: 148,
      fetcher
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://jotmo.senguo.me/api/public/v1/arkme/electron-runtime-update/darwin/arm64/latest",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  test("turns a structured runtime availability response into user-readable guidance", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: "arkme_plugin_version_too_low",
      message: "当前服务器提供的 Arkme 插件版本过低，与此版本的客户端不兼容。",
      suggestion: "请稍后重试；如果问题持续出现，请联系管理员。",
      current_version: "0.1.17",
      required_version: "0.1.18"
    }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-123"
      }
    }));

    await expect(fetchElectronRuntimeManifest({
      serviceBaseUrl: "https://jotmo.senguo.me",
      platform: "darwin",
      arch: "arm64",
      shellVersion: "0.2.0",
      electronMajor: 43,
      modulesAbi: 148,
      fetcher
    })).rejects.toMatchObject({
      name: "ElectronRuntimeManifestError",
      message: "当前服务器提供的 Arkme 插件版本过低，与此版本的客户端不兼容。",
      displayTitle: "运行环境暂时不可用",
      suggestion: "请稍后重试；如果问题持续出现，请联系管理员。",
      technicalDetails: "插件版本 0.1.17，最低要求 0.1.18",
      showWorkspaceAction: false
    });
  });

  test("turns a network failure into user-readable recovery guidance", async () => {
    await expect(fetchElectronRuntimeManifest({
      serviceBaseUrl: "https://jotmo.senguo.me",
      platform: "darwin",
      arch: "arm64",
      shellVersion: "0.2.0",
      electronMajor: 43,
      modulesAbi: 148,
      fetcher: async () => { throw new TypeError("fetch failed"); }
    })).rejects.toMatchObject({
      name: "ElectronRuntimeManifestError",
      displayTitle: "无法连接运行环境服务",
      message: "未能连接到运行环境服务，请检查网络连接后重试。",
      suggestion: "如果网络正常但问题持续出现，请联系管理员。",
      technicalDetails: "网络请求失败",
      showWorkspaceAction: false
    });
  });

  test("accepts probation only when the running plugin reports the release-set version", async () => {
    await expect(verifyElectronRuntimePluginHealth(
      "http://127.0.0.1:49152",
      "0.1.18",
      async () => new Response(JSON.stringify({ ok: true, value: { installedVersion: "0.1.18" } }), { status: 200 })
    )).resolves.toBeUndefined();

    const mismatch = verifyElectronRuntimePluginHealth(
      "http://127.0.0.1:49152",
      "0.1.18",
      async () => new Response(JSON.stringify({ ok: true, value: { installedVersion: "0.1.17" } }), { status: 200 })
    );
    await expect(mismatch).rejects.toBeInstanceOf(RuntimeArtifactValidationError);
    await expect(mismatch).rejects.toMatchObject({ code: "PLUGIN_IDENTITY_MISMATCH" });

    await expect(verifyElectronRuntimePluginHealth(
      "http://127.0.0.1:49152",
      "0.1.18",
      async () => new Response(null, { status: 503 })
    )).rejects.not.toBeInstanceOf(RuntimeArtifactValidationError);
  });

  test("stops reading a chunked manifest as soon as it exceeds one MiB", async () => {
    const cancel = vi.fn(async () => undefined);
    let reads = 0;
    const response = {
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads <= 2
              ? { done: false as const, value: new Uint8Array(600 * 1024) }
              : { done: true as const, value: undefined };
          },
          cancel
        })
      },
      arrayBuffer: vi.fn(async () => { throw new Error("must not buffer the whole response"); })
    } as unknown as Response;

    await expect(fetchElectronRuntimeManifest({
      serviceBaseUrl: "https://api.jotmo.cc",
      platform: "darwin",
      arch: "arm64",
      shellVersion: "0.2.0",
      electronMajor: 43,
      modulesAbi: 148,
      fetcher: async () => response
    })).rejects.toThrow(/too large/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });
});
