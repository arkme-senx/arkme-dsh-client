import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildTestPackagingCommands,
  runTestPackaging,
  writePackagedTestPluginMarker
} from "../scripts/test-packaging.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("test application packaging", () => {
  test("builds the local plugin before Harness and an isolated unpacked application", async () => {
    expect(buildTestPackagingCommands({
      projectRoot: "/workspace/jotmo-harness",
      pluginPath: "/workspace/arkme-dsh-plugin",
      pnpmExecutable: "pnpm"
    })).toEqual([
      {
        command: "pnpm",
        args: ["run", "build"],
        cwd: "/workspace/arkme-dsh-plugin"
      },
      {
        command: "pnpm",
        args: ["run", "build"],
        cwd: "/workspace/jotmo-harness"
      },
      {
        command: process.execPath,
        args: ["scripts/prepare-runtime.mjs"],
        cwd: "/workspace/jotmo-harness"
      },
      {
        command: "pnpm",
        args: [
          "exec",
          "electron-builder",
          "--mac",
          "--arm64",
          "--dir",
          "--config.directories.output=release-test"
        ],
        cwd: "/workspace/jotmo-harness"
      }
    ]);
  });

  test("records the external local plugin path in the test app marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-test-package-"));
    temporaryDirectories.push(root);
    const appPath = path.join(root, "release-test", "mac-arm64", "arkme.app");
    const pluginPath = path.join(root, "arkme-dsh-plugin");
    await writePackagedTestPluginMarker({
      appPath,
      plugin: { path: pluginPath, version: "0.1.8" }
    });
    const marker = await readFile(
      path.join(appPath, "Contents", "Resources", "ARKME_TEST_PLUGIN.json"),
      "utf8"
    ).then(JSON.parse, () => null);

    expect(marker).toEqual({
      schemaVersion: 1,
      source: "local",
      pluginPath,
      packageName: "@senguoyun/dsh-arkme",
      packageVersion: "0.1.8"
    });
  });

  test("runs the reusable test pack flow against the sibling local plugin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-test-pack-flow-"));
    temporaryDirectories.push(root);
    const projectRoot = path.join(root, "jotmo-harness");
    const pluginPath = path.join(root, "arkme-dsh-plugin");
    await Promise.all([mkdir(projectRoot), mkdir(pluginPath)]);
    await writeFile(path.join(pluginPath, "package.json"), JSON.stringify({
      name: "@senguoyun/dsh-arkme",
      version: "0.1.8",
      scripts: { build: "build-local-plugin" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } }
    }));
    await writeFile(path.join(pluginPath, "cordis.patch.yml"), "[]\n");
    const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

    const result = await runTestPackaging({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      pnpmExecutable: "pnpm-test",
      resolveInstalledPlugin: () => {
        throw new Error("production fallback must not be used");
      },
      runCommand: async (command) => {
        commands.push(command);
        if (command.cwd === pluginPath) {
          await mkdir(path.join(pluginPath, "lib"));
          await Promise.all([
            writeFile(path.join(pluginPath, "lib", "index.js"), "export {};\n"),
            writeFile(path.join(pluginPath, "lib", "client.js"), "export {};\n")
          ]);
        }
        return { code: 0, signal: null };
      },
      log: () => {}
    });

    expect(result).toEqual({
      appPath: path.join(projectRoot, "release-test", "mac-arm64", "arkme.app"),
      plugin: { path: pluginPath, source: "local", version: "0.1.8" }
    });
    expect(commands).toHaveLength(4);
    const marker = JSON.parse(await readFile(
      path.join(result.appPath, "Contents", "Resources", "ARKME_TEST_PLUGIN.json"),
      "utf8"
    ));
    expect(marker.pluginPath).toBe(pluginPath);
    expect(marker.packageVersion).toBe("0.1.8");
  });
});
