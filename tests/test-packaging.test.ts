import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildTestAppAdHocSigningCommands,
  buildTestPackagingCommands,
  buildTestPackagingSpawnEnvironment,
  runTestPackaging,
  writePackagedTestPluginMarker
} from "../scripts/test-packaging.mjs";

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("test application packaging", () => {
  test("uses an isolated local test identity instead of the installed Arkme identity", () => {
    const config = require("../electron-builder.local-test-config.cjs") as {
      appId: string;
      productName: string;
      protocols: Array<{ name: string; schemes: string[] }>;
    };
    expect(config.appId).toBe("cc.jiwo.arkme.local-test");
    expect(config.productName).toBe("arkme Local Test");
    expect(config.protocols).toEqual([
      { name: "Arkme Local Test Extension Share", schemes: ["arkme-local-test"] }
    ]);
  });
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
          "--config",
          "electron-builder.local-test-config.cjs",
          "--mac",
          "--arm64",
          "--dir",
          "--config.directories.output=release-test",
          "--config.mac.forceCodeSigning=false"
        ],
        cwd: "/workspace/jotmo-harness",
        environment: {
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
        }
      }
    ]);
  });

  test("re-signs the marker-mutated test app ad-hoc before strict verification", () => {
    expect(buildTestAppAdHocSigningCommands({
      projectRoot: "/workspace/jotmo-harness",
      appPath: "/workspace/jotmo-harness/release-test/mac-arm64/arkme Local Test.app"
    })).toEqual([
      {
        command: "/usr/bin/codesign",
        args: [
          "--force",
          "--deep",
          "--sign",
          "-",
          "/workspace/jotmo-harness/release-test/mac-arm64/arkme Local Test.app"
        ],
        cwd: "/workspace/jotmo-harness",
        environment: {
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
        }
      },
      {
        command: "/usr/bin/codesign",
        args: [
          "--verify",
          "--deep",
          "--strict",
          "--verbose=2",
          "/workspace/jotmo-harness/release-test/mac-arm64/arkme Local Test.app"
        ],
        cwd: "/workspace/jotmo-harness",
        environment: {
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
        }
      }
    ]);
  });

  test("strips production signing credentials from the test builder process", () => {
    expect(buildTestPackagingSpawnEnvironment(
      { CSC_IDENTITY_AUTO_DISCOVERY: "false", TEST_ONLY: "1" },
      {
        PATH: "/usr/bin",
        CSC_LINK: "DeveloperID.p12",
        CSC_KEY_PASSWORD: "secret",
        APPLE_ID: "release@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "secret",
        APPLE_TEAM_ID: "PRODTEAM"
      }
    )).toEqual({
      PATH: "/usr/bin",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      TEST_ONLY: "1"
    });
  });

  test("records the external local plugin path in the test app marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-test-package-"));
    temporaryDirectories.push(root);
    const appPath = path.join(root, "release-test", "mac-arm64", "arkme Local Test.app");
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
    const markerVersionsSeenByCodesign: string[] = [];

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
        if (command.command === "/usr/bin/codesign") {
          const marker = JSON.parse(await readFile(path.join(
            projectRoot,
            "release-test",
            "mac-arm64",
            "arkme Local Test.app",
            "Contents",
            "Resources",
            "ARKME_TEST_PLUGIN.json"
          ), "utf8"));
          markerVersionsSeenByCodesign.push(marker.packageVersion);
        }
        return { code: 0, signal: null };
      },
      log: () => {}
    });

    expect(result).toEqual({
      appPath: path.join(projectRoot, "release-test", "mac-arm64", "arkme Local Test.app"),
      plugin: { path: pluginPath, source: "local", version: "0.1.8" }
    });
    expect(commands).toHaveLength(6);
    expect(commands.slice(4)).toEqual(buildTestAppAdHocSigningCommands({
      projectRoot,
      appPath: result.appPath,
      environment: {}
    }));
    expect(markerVersionsSeenByCodesign).toEqual(["0.1.8", "0.1.8"]);
    const marker = JSON.parse(await readFile(
      path.join(result.appPath, "Contents", "Resources", "ARKME_TEST_PLUGIN.json"),
      "utf8"
    ));
    expect(marker.pluginPath).toBe(pluginPath);
    expect(marker.packageVersion).toBe("0.1.8");
  });

  test.each([
    { failingCommandIndex: 4, label: "ad-hoc signing" },
    { failingCommandIndex: 5, label: "strict signature verification" }
  ])("propagates $label failure from pack:test", async ({ failingCommandIndex }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-test-sign-failure-"));
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
    let commandIndex = 0;

    await expect(runTestPackaging({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      pnpmExecutable: "pnpm-test",
      resolveInstalledPlugin: () => {
        throw new Error("production fallback must not be used");
      },
      runCommand: async (command) => {
        if (command.cwd === pluginPath) {
          await mkdir(path.join(pluginPath, "lib"));
          await Promise.all([
            writeFile(path.join(pluginPath, "lib", "index.js"), "export {};\n"),
            writeFile(path.join(pluginPath, "lib", "client.js"), "export {};\n")
          ]);
        }
        const code = commandIndex === failingCommandIndex ? 1 : 0;
        commandIndex += 1;
        return { code, signal: null };
      },
      log: () => {}
    })).rejects.toThrow(/Command failed: \/usr\/bin\/codesign/);

    expect(commandIndex).toBe(failingCommandIndex + 1);
  });
});
