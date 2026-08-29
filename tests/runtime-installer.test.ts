import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { pack } from "tar-stream";
import { installElectronRuntimeRelease, validateInstalledElectronRuntime } from "../src/runtime/installer.js";
import { RuntimeArtifactValidationError } from "../src/runtime/errors.js";
import type { ElectronRuntimeManifest } from "../src/runtime/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function archive(entries: Array<{ name: string; body: string }>): Promise<Buffer> {
  const tar = pack();
  for (const entry of entries) tar.entry({ name: entry.name, mode: 0o755 }, entry.body);
  tar.finalize();
  const chunks: Buffer[] = [];
  await pipeline(tar, createZstdCompress(), new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }
  }));
  return Buffer.concat(chunks);
}

function artifact(bytes: Buffer, url: string) {
  return {
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    unpackedSize: 1024
  };
}

describe("Electron runtime release installer", () => {
  test("combines an ABI-148 Harness artifact with the separately managed Arkme plugin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-installer-"));
    temporaryDirectories.push(root);
    const metadata = JSON.stringify({
      schemaVersion: 1,
      component: "electron-harness",
      version: "0.1.0-rc.8",
      buildId: "electron-build-1",
      target: { os: "darwin", arch: "arm64" },
      runtime: { kind: "electron", electronVersion: "43.2.0", electronMajor: 43, modulesAbi: 148 },
      pnpmVersion: "11.19.0"
    });
    const harnessEntries = [
      { name: "harness/runtime-metadata.json", body: metadata },
      { name: "harness/node_modules/@deepseek-ai/dsh/package.json", body: JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.8" }) },
      { name: "harness/node_modules/@deepseek-ai/dsh/lib/bin.js", body: "dsh" },
      { name: "harness/node_modules/pnpm/package.json", body: JSON.stringify({ name: "pnpm", version: "11.19.0" }) },
      { name: "harness/node_modules/pnpm/bin/pnpm.cjs", body: "pnpm" },
      { name: "harness/node_modules/.bin/pnpm", body: "pnpm" },
      { name: "harness/node_modules/.bin/node", body: "node" }
    ];
    const harness = await archive(harnessEntries);
    const plugin = await archive([
      { name: "package.json", body: JSON.stringify({ name: "@senguoyun/dsh-arkme", version: "0.1.18", dsh: { bundle: { patch: "./cordis.patch.yml" } } }) },
      { name: "cordis.patch.yml", body: "[]" },
      { name: "lib/index.js", body: "plugin" },
      { name: "lib/client.js", body: "client" }
    ]);
    const harnessArtifact = artifact(harness, "https://d.jiwo.cc/harness.tar.zst");
    const pluginArtifact = artifact(plugin, "https://d.jiwo.cc/plugin.tar.zst");
    const manifest: ElectronRuntimeManifest = {
      schemaVersion: 1,
      releaseId: "electron-runtime-v1-11111111111111111111111111111111",
      channel: "stable",
      publishedAt: "2026-08-27T00:00:00Z",
      target: { os: "darwin", arch: "arm64" },
      minShellVersion: "0.2.0",
      runtimeApiVersion: 1,
      dataSchemaVersion: 1,
      electron: { major: 43, modulesAbi: 148 },
      pnpmVersion: "11.19.0",
      artifacts: {
        harness: { version: "0.1.0-rc.8", versionCode: 1, modulesAbi: 148, entry: "harness/node_modules/@deepseek-ai/dsh/lib/bin.js", metadata: "harness/runtime-metadata.json", ...harnessArtifact },
        requiredPlugin: { version: "0.1.18", versionCode: 1, name: "@senguoyun/dsh-arkme", target: "harness/node_modules/@senguoyun/dsh-arkme", ...pluginArtifact }
      }
    };
    const bodies = new Map([[harnessArtifact.url, harness], [pluginArtifact.url, plugin]]);

    await installElectronRuntimeRelease(manifest, path.join(root, "staging"), {
      downloadsPath: path.join(root, "downloads"),
      fetcher: async input => {
        const body = bodies.get(String(input));
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array(body));
      }
    });

    await expect(readFile(path.join(root, "staging", manifest.artifacts.harness.entry), "utf8")).resolves.toBe("dsh");
    await expect(readFile(path.join(root, "staging", manifest.artifacts.requiredPlugin.target, "lib", "index.js"), "utf8")).resolves.toBe("plugin");
    await writeFile(path.join(root, "staging", manifest.artifacts.requiredPlugin.target, "lib", "index.js"), "tampered");
    const tamperedValidation = validateInstalledElectronRuntime(manifest, path.join(root, "staging"));
    await expect(tamperedValidation).rejects.toBeInstanceOf(RuntimeArtifactValidationError);
    await expect(tamperedValidation).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });

    const harnessWithNode = await archive([...harnessEntries, { name: "node/bin/node", body: "standalone node" }]);
    const bundledNodeManifest = structuredClone(manifest);
    Object.assign(bundledNodeManifest.artifacts.harness, artifact(harnessWithNode, "https://d.jiwo.cc/harness-with-node.tar.zst"));
    const bundledBodies = new Map([[bundledNodeManifest.artifacts.harness.url, harnessWithNode], [pluginArtifact.url, plugin]]);
    await expect(installElectronRuntimeRelease(bundledNodeManifest, path.join(root, "staging-with-node"), {
      downloadsPath: path.join(root, "downloads-with-node"),
      fetcher: async input => {
        const body = bundledBodies.get(String(input));
        return body === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(body));
      }
    })).rejects.toThrow(/standalone Node/i);

    const reservedFileHarness = await archive([
      ...harnessEntries,
      { name: "runtime-environment.json", body: '{"environment":"prod"}' }
    ]);
    const reservedFileManifest = structuredClone(manifest);
    Object.assign(
      reservedFileManifest.artifacts.harness,
      artifact(reservedFileHarness, "https://d.jiwo.cc/harness-with-receipt.tar.zst")
    );
    const reservedBodies = new Map([
      [reservedFileManifest.artifacts.harness.url, reservedFileHarness],
      [pluginArtifact.url, plugin]
    ]);
    await expect(installElectronRuntimeRelease(
      reservedFileManifest,
      path.join(root, "staging-with-reserved-file"),
      {
        downloadsPath: path.join(root, "downloads-with-reserved-file"),
        fetcher: async input => {
          const body = reservedBodies.get(String(input));
          return body === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(body));
        }
      }
    )).rejects.toMatchObject({
      name: "RuntimeArtifactValidationError",
      code: "RESERVED_RUNTIME_FILE"
    });
  });
});
