import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  developmentPnpmBinDirectory,
  developmentArkmePluginPath,
  developmentDshBinPath,
  packagedArkmePluginPath,
  packagedDshBinPath,
  readPackagedTestPluginPath,
  resolveArkmePluginPath,
  resolveArkmePluginPathForLaunch,
  resolveManagedExtensionRestartPaths
} from "../src/runtime-path.js";
import * as runtimePath from "../src/runtime-path.js";

const bundledPnpmPath = runtimePath as typeof runtimePath & {
  packagedPnpmBinDirectory(resourcesPath: string): string;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("packagedDshBinPath", () => {
  test("resolves the bundled pnpm command directory from packaged resources", () => {
    expect(bundledPnpmPath.packagedPnpmBinDirectory?.(
      "/Applications/arkme.app/Contents/Resources"
    )).toBe(path.join(
      "/Applications/arkme.app/Contents/Resources",
      "app.asar.unpacked",
      "node_modules",
      ".bin"
    ));
  });

  test("resolves the workspace runtime pnpm command directory in development", () => {
    expect(developmentPnpmBinDirectory(
      "file:///Users/test/jotmo-harness/dist/main.js"
    )).toBe(path.join(
      "/Users/test/jotmo-harness",
      "runtime",
      "node_modules",
      ".bin"
    ));
  });

  test("resolves the CLI from unpacked production dependencies", () => {
    expect(packagedDshBinPath("/Applications/arkme.app/Contents/Resources")).toBe(
      path.join(
        "/Applications/arkme.app/Contents/Resources",
        "app.asar.unpacked",
        "node_modules",
        "@deepseek-ai",
        "dsh",
        "lib",
        "bin.js"
      )
    );
  });

  test("resolves the installed CLI in development", async () => {
    const result = developmentDshBinPath(import.meta.url);

    expect(result.endsWith(path.join("@deepseek-ai", "dsh", "lib", "bin.js"))).toBe(true);
    await expect(access(result)).resolves.toBeUndefined();
  });

  test("resolves the embedded plugin from unpacked production dependencies", async () => {
    expect(packagedArkmePluginPath(
      "/Applications/arkme.app/Contents/Resources"
    )).toBe(
      path.join(
        "/Applications/arkme.app/Contents/Resources",
        "app.asar.unpacked",
        "node_modules",
        "@senguoyun",
        "dsh-arkme"
      )
    );
  });

  test("uses and normalizes an explicit local plugin path in development", () => {
    expect(developmentArkmePluginPath(import.meta.url, {
      ARKME_PLUGIN_PATH: "../arkme-dsh-plugin"
    })).toBe(path.resolve("../arkme-dsh-plugin"));
  });

  test("ignores a local plugin override in a packaged application", () => {
    expect(resolveArkmePluginPath(
      true,
      "/Applications/arkme.app/Contents/Resources",
      import.meta.url,
      { ARKME_PLUGIN_PATH: "/tmp/untrusted-plugin" }
    )).toBe(path.join(
      "/Applications/arkme.app/Contents/Resources",
      "app.asar.unpacked/node_modules/@senguoyun/dsh-arkme"
    ));
  });

  test("uses the explicit local plugin recorded by a packaged test application", () => {
    expect(resolveArkmePluginPath(
      true,
      "/Applications/arkme.app/Contents/Resources",
      import.meta.url,
      { ARKME_PLUGIN_PATH: "/tmp/untrusted-plugin" },
      "/workspace/arkme-dsh-plugin"
    )).toBe("/workspace/arkme-dsh-plugin");
  });

  test("reads an absolute local plugin path from a packaged test marker", async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), "arkme-test-resources-"));
    temporaryDirectories.push(resourcesPath);
    const pluginPath = path.join(resourcesPath, "..", "arkme-dsh-plugin");
    await writeFile(path.join(resourcesPath, "ARKME_TEST_PLUGIN.json"), JSON.stringify({
      schemaVersion: 1,
      source: "local",
      pluginPath
    }));
    await expect(readPackagedTestPluginPath(resourcesPath)).resolves.toBe(pluginPath);
  });

  test("keeps a normal packaged application on its embedded plugin when no test marker exists", async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), "arkme-production-resources-"));
    temporaryDirectories.push(resourcesPath);

    await expect(readPackagedTestPluginPath(resourcesPath)).resolves.toBeUndefined();
  });

  test("rejects a packaged test marker that does not contain an absolute local path", async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), "arkme-invalid-resources-"));
    temporaryDirectories.push(resourcesPath);
    await writeFile(path.join(resourcesPath, "ARKME_TEST_PLUGIN.json"), JSON.stringify({
      schemaVersion: 1,
      source: "local",
      pluginPath: "../arkme-dsh-plugin"
    }));

    await expect(readPackagedTestPluginPath(resourcesPath)).rejects.toThrow(
      "Invalid packaged test plugin marker"
    );
  });

  test("rejects a packaged marker that is not explicitly a versioned local source", async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), "arkme-wrong-source-resources-"));
    temporaryDirectories.push(resourcesPath);
    await writeFile(path.join(resourcesPath, "ARKME_TEST_PLUGIN.json"), JSON.stringify({
      schemaVersion: 2,
      source: "git",
      pluginPath: "/workspace/arkme-dsh-plugin"
    }));

    await expect(readPackagedTestPluginPath(resourcesPath)).rejects.toThrow(
      "Invalid packaged test plugin marker"
    );
  });

  test("resolves a packaged test launch through its marker instead of the embedded plugin", async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), "arkme-test-launch-"));
    temporaryDirectories.push(resourcesPath);
    const pluginPath = "/workspace/arkme-dsh-plugin";
    await writeFile(path.join(resourcesPath, "ARKME_TEST_PLUGIN.json"), JSON.stringify({
      schemaVersion: 1,
      source: "local",
      pluginPath
    }));
    await expect(resolveArkmePluginPathForLaunch(
      true,
      resourcesPath,
      import.meta.url,
      { ARKME_PLUGIN_PATH: "/tmp/untrusted-plugin" }
    )).resolves.toBe(pluginPath);
  });

  test("resolves the installed plugin workspace in development without an override", async () => {
    vi.stubEnv("ARKME_PLUGIN_PATH", "/tmp/ambient-arkme-plugin-must-be-ignored");
    try {
      const result = developmentArkmePluginPath(import.meta.url, {});
      const manifest = JSON.parse(
        await readFile(path.join(result, "package.json"), "utf8")
      ) as { name: string };

      expect(manifest).toMatchObject({
        name: "@senguoyun/dsh-arkme"
      });
      await expect(access(path.join(result, "lib", "index.js"))).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("keeps managed extension restart ownership inside the desktop supervisor", () => {
    expect(resolveManagedExtensionRestartPaths(
      "/Applications/arkme.app/Contents/Resources/app.asar.unpacked/node_modules/@senguoyun/dsh-arkme",
      "/Users/test/Library/Application Support/Arkme Harness/dsh",
      "electron-runtime-v1-0123456789abcdef0123456789abcdef"
    )).toEqual({
      helperPath: "/Applications/arkme.app/Contents/Resources/app.asar.unpacked/node_modules/@senguoyun/dsh-arkme/lib/extension-profile-restart-helper.js",
      planPath: "/Users/test/Library/Application Support/Arkme Harness/dsh/arkme-self/desktop-managed-extension-restart.json",
      releaseId: "electron-runtime-v1-0123456789abcdef0123456789abcdef"
    });
  });
});
