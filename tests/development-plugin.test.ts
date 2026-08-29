import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildDevelopmentCommands,
  resolveDevelopmentPlugin,
  resolveLocalTestPlugin,
  runDevelopment
} from "../scripts/development-plugin.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("development plugin selection", () => {
  test("uses an explicit valid local plugin path", async () => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin");
    const installedPlugin = await createPlugin(projectRoot, "installed", "0.1.7");

    const selected = await resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: process.cwd(),
      environment: { ARKME_PLUGIN_PATH: localPlugin },
      resolveInstalledPlugin: () => installedPlugin
    });

    expect(selected).toEqual({
      path: path.resolve(localPlugin),
      source: "local",
      version: "0.1.8"
    });
  });

  test("resolves an explicit relative path from the caller working directory", async () => {
    const projectRoot = await createProject();
    const callerDirectory = path.join(projectRoot, "caller");
    await mkdir(callerDirectory);
    const localPlugin = await createPlugin(callerDirectory, "plugin");

    const selected = await resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: callerDirectory,
      environment: { ARKME_PLUGIN_PATH: "plugin" },
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      }
    });

    expect(selected.path).toBe(localPlugin);
    expect(selected.source).toBe("local");
  });

  test("rejects a missing explicit path without using the installed fallback", async () => {
    const projectRoot = await createProject();
    let fallbackCalls = 0;
    const missingPath = path.join(projectRoot, "missing-plugin");

    await expect(resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: { ARKME_PLUGIN_PATH: "missing-plugin" },
      resolveInstalledPlugin: () => {
        fallbackCalls += 1;
        return path.join(projectRoot, "installed");
      }
    })).rejects.toThrow(`ARKME_PLUGIN_PATH points to an invalid plugin: ${missingPath}`);

    expect(fallbackCalls).toBe(0);
  });

  test("uses the sibling plugin when no explicit path is set", async () => {
    const workspaceRoot = await createTemporaryDirectory();
    const projectRoot = path.join(workspaceRoot, "jotmo-harness");
    await mkdir(projectRoot);
    const siblingPlugin = await createPlugin(workspaceRoot, "arkme-dsh-plugin");

    const selected = await resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      }
    });

    expect(selected).toEqual({ path: siblingPlugin, source: "local", version: "0.1.8" });
  });

  test("uses the installed production plugin when no sibling is available", async () => {
    const projectRoot = await createProject();
    const installedPlugin = await createPlugin(projectRoot, "installed", "0.1.7");

    const selected = await resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      resolveInstalledPlugin: () => installedPlugin
    });

    expect(selected).toEqual({
      path: installedPlugin,
      source: "production",
      version: "0.1.7"
    });
  });

  test("refuses an installed production fallback for a packaged test application", async () => {
    const projectRoot = await createProject();
    const installedPlugin = await createPlugin(projectRoot, "installed", "0.1.7");
    await expect(resolveLocalTestPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      resolveInstalledPlugin: () => installedPlugin
    })).rejects.toThrow("Test packaging requires a local Arkme plugin");
  });

  test.each([
    ["wrong package name", { name: "wrong", version: "0.1.8", patch: "./cordis.patch.yml" }],
    ["empty version", { name: "@senguoyun/dsh-arkme", version: "", patch: "./cordis.patch.yml" }],
    ["wrong patch path", { name: "@senguoyun/dsh-arkme", version: "0.1.8", patch: "./wrong.yml" }]
  ])("rejects a local plugin with %s", async (_description, manifest) => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin", manifest.version, manifest);

    await expect(resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: { ARKME_PLUGIN_PATH: localPlugin },
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      }
    })).rejects.toThrow(`Invalid Arkme plugin at ${localPlugin}`);
  });

  test("selects a fresh local plugin without generated build outputs", async () => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin", "0.1.8", undefined, false);

    await expect(resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: { ARKME_PLUGIN_PATH: localPlugin },
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      }
    })).resolves.toEqual({ path: localPlugin, source: "local", version: "0.1.8" });
  });

  test("rejects a local plugin whose cordis patch is a directory", async () => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await replaceFileWithDirectory(path.join(localPlugin, "cordis.patch.yml"));

    await expect(runDevelopment({
      projectRoot,
      workingDirectory: projectRoot,
      environment: { ARKME_PLUGIN_PATH: localPlugin },
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      },
      pnpmExecutable: "pnpm-test",
      electronExecutable: "electron-test",
      log: () => {},
      runCommand: async (command) => {
        calls.push(command);
        return { code: 0, signal: null };
      }
    })).rejects.toThrow(
      `required path is not a regular file: cordis.patch.yml`
    );

    expect(calls).toEqual([]);
  });

  test("rejects an installed plugin whose generated build output is incomplete", async () => {
    const projectRoot = await createProject();
    const installedPlugin = await createPlugin(projectRoot, "installed", "0.1.8", undefined, false);

    await expect(resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      resolveInstalledPlugin: () => installedPlugin
    })).rejects.toThrow(`Invalid Arkme plugin at ${installedPlugin}`);
  });

  test.each([
    "cordis.patch.yml",
    "lib/index.js",
    "lib/client.js"
  ])("rejects an installed plugin whose %s is a directory", async (relativePath) => {
    const projectRoot = await createProject();
    const installedPlugin = await createPlugin(projectRoot, "installed", "0.1.7");
    await replaceFileWithDirectory(path.join(installedPlugin, relativePath));

    await expect(resolveDevelopmentPlugin({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      resolveInstalledPlugin: () => installedPlugin
    })).rejects.toThrow(`required path is not a regular file: ${relativePath}`);
  });
});

describe("development commands", () => {
  test("builds the local plugin before compiling and launching Harness", () => {
    const localPlugin = "/plugins/arkme";
    const commands = buildDevelopmentCommands({
      projectRoot: "/harness",
      environment: { PATH: "/bin" },
      plugin: { path: localPlugin, source: "local", version: "0.1.8" },
      pnpmExecutable: "pnpm",
      electronExecutable: "/harness/node_modules/.bin/electron"
    });

    expect(commands.map(({ command, args }) => [command, args])).toEqual([
      ["pnpm", ["run", "build"]],
      ["pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"]],
      [process.execPath, ["scripts/copy-static.mjs"]],
      ["/harness/node_modules/.bin/electron", ["."]]
    ]);
    expect(commands.at(-1)?.environment?.ARKME_PLUGIN_PATH).toBe(localPlugin);
  });

  test("uses a custom environment for every local development child", () => {
    const environment = { PATH: "/custom/bin", HARNESS_ENV: "injected" };
    const commands = buildDevelopmentCommands({
      projectRoot: "/harness",
      environment,
      plugin: { path: "/plugins/arkme", source: "local", version: "0.1.8" },
      pnpmExecutable: "pnpm",
      electronExecutable: "electron"
    });

    expect(commands.slice(0, -1).map((command) => command.environment)).toEqual([
      environment,
      environment,
      environment
    ]);
    expect(commands.at(-1)?.environment).toEqual({
      ...environment,
      ARKME_PLUGIN_PATH: "/plugins/arkme"
    });
  });

  test("leaves child environments undefined when no custom environment is provided", () => {
    const commands = buildDevelopmentCommands({
      projectRoot: "/harness",
      plugin: { path: "/installed/arkme", source: "production", version: "0.1.7" },
      pnpmExecutable: "pnpm",
      electronExecutable: "electron"
    });

    expect(commands.map((command) => command.environment)).toEqual([
      undefined,
      undefined,
      undefined
    ]);
  });

  test("inherits the parent environment when adding the local plugin path to Electron", () => {
    vi.stubEnv("HARNESS_PARENT_ENV_TEST", "inherited");
    try {
      const commands = buildDevelopmentCommands({
        projectRoot: "/harness",
        plugin: { path: "/plugins/arkme", source: "local", version: "0.1.8" },
        pnpmExecutable: "pnpm",
        electronExecutable: "electron"
      });

      expect(commands.slice(0, -1).map((command) => command.environment)).toEqual([
        undefined,
        undefined,
        undefined
      ]);
      expect(commands.at(-1)?.environment).toMatchObject({
        HARNESS_PARENT_ENV_TEST: "inherited",
        ARKME_PLUGIN_PATH: "/plugins/arkme"
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("omits the plugin build and preserves the custom environment for production fallback", () => {
    const commands = buildDevelopmentCommands({
      projectRoot: "/harness",
      environment: { PATH: "/bin" },
      plugin: { path: "/installed/arkme", source: "production", version: "0.1.7" },
      pnpmExecutable: "pnpm",
      electronExecutable: "electron"
    });

    expect(commands.map(({ command, args }) => [command, args])).toEqual([
      ["pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"]],
      [process.execPath, ["scripts/copy-static.mjs"]],
      ["electron", ["."]]
    ]);
    expect(commands.map((command) => command.environment)).toEqual([
      { PATH: "/bin" },
      { PATH: "/bin" },
      { PATH: "/bin" }
    ]);
  });

  test("runs the local workflow in order and rejects a failed command", async () => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin", "0.1.8", undefined, false);
    const calls: Array<{ command: string; args: readonly string[]; environment?: Record<string, string> }> = [];

    await runDevelopment({
      projectRoot,
      workingDirectory: projectRoot,
      environment: { ARKME_PLUGIN_PATH: localPlugin },
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      },
      pnpmExecutable: "pnpm-test",
      electronExecutable: "electron-test",
      log: () => {},
      runCommand: async (command) => {
        calls.push(command);
        if (calls.length === 1) {
          await writeFile(path.join(localPlugin, "lib", "index.js"), "");
          await writeFile(path.join(localPlugin, "lib", "client.js"), "");
        }
        return { code: 0, signal: null };
      }
    });

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["pnpm-test", ["run", "build"]],
      ["pnpm-test", ["exec", "tsc", "-p", "tsconfig.build.json"]],
      [process.execPath, ["scripts/copy-static.mjs"]],
      ["electron-test", ["."]]
    ]);
    expect(calls.at(-1)?.environment?.ARKME_PLUGIN_PATH).toBe(localPlugin);
  });

  test("logs the selected local plugin by default", async () => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDevelopment({
        projectRoot,
        workingDirectory: projectRoot,
        environment: { ARKME_PLUGIN_PATH: localPlugin },
        resolveInstalledPlugin: () => {
          throw new Error("installed fallback must not be used");
        },
        pnpmExecutable: "pnpm-test",
        electronExecutable: "electron-test",
        runCommand: async () => ({ code: 0, signal: null })
      });

      expect(consoleLog).toHaveBeenCalledWith(
        `Using local Arkme plugin 0.1.8 at ${localPlugin}`
      );
    } finally {
      consoleLog.mockRestore();
    }
  });

  test("logs the selected production fallback plugin by default", async () => {
    const projectRoot = await createProject();
    const installedPlugin = await createPlugin(projectRoot, "installed", "0.1.7");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDevelopment({
        projectRoot,
        workingDirectory: projectRoot,
        environment: {},
        resolveInstalledPlugin: () => installedPlugin,
        pnpmExecutable: "pnpm-test",
        electronExecutable: "electron-test",
        runCommand: async () => ({ code: 0, signal: null })
      });

      expect(consoleLog).toHaveBeenCalledWith(
        `Using production Arkme plugin 0.1.7 at ${installedPlugin}`
      );
    } finally {
      consoleLog.mockRestore();
    }
  });

  test("stays silent when an empty logger is injected", async () => {
    const projectRoot = await createProject();
    const installedPlugin = await createPlugin(projectRoot, "installed", "0.1.7");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDevelopment({
        projectRoot,
        workingDirectory: projectRoot,
        environment: {},
        resolveInstalledPlugin: () => installedPlugin,
        pnpmExecutable: "pnpm-test",
        electronExecutable: "electron-test",
        log: () => {},
        runCommand: async () => ({ code: 0, signal: null })
      });

      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });

  test("stops after the local build when required generated outputs are still missing", async () => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin", "0.1.8", undefined, false);
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await expect(runDevelopment({
      projectRoot,
      workingDirectory: projectRoot,
      environment: { ARKME_PLUGIN_PATH: localPlugin },
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      },
      pnpmExecutable: "pnpm-test",
      electronExecutable: "electron-test",
      log: () => {},
      runCommand: async (command) => {
        calls.push(command);
        return { code: 0, signal: null };
      }
    })).rejects.toThrow(`Invalid Arkme plugin at ${localPlugin}`);

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["pnpm-test", ["run", "build"]]
    ]);
  });

  test.each([
    "lib/index.js",
    "lib/client.js"
  ])("stops after the local build when %s is a directory", async (relativePath) => {
    const projectRoot = await createProject();
    const localPlugin = await createPlugin(projectRoot, "plugin", "0.1.8", undefined, false);
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await expect(runDevelopment({
      projectRoot,
      workingDirectory: projectRoot,
      environment: { ARKME_PLUGIN_PATH: localPlugin },
      resolveInstalledPlugin: () => {
        throw new Error("installed fallback must not be used");
      },
      pnpmExecutable: "pnpm-test",
      electronExecutable: "electron-test",
      log: () => {},
      runCommand: async (command) => {
        calls.push(command);
        if (calls.length === 1) {
          for (const output of ["lib/index.js", "lib/client.js"]) {
            if (output === relativePath) {
              await mkdir(path.join(localPlugin, output));
            } else {
              await writeFile(path.join(localPlugin, output), "");
            }
          }
        }
        return { code: 0, signal: null };
      }
    })).rejects.toThrow(`required path is not a regular file: ${relativePath}`);

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["pnpm-test", ["run", "build"]]
    ]);
  });

  test("reports a failed command with its command, code, and signal", async () => {
    const projectRoot = await createProject();
    const installedPlugin = await createPlugin(projectRoot, "installed");

    await expect(runDevelopment({
      projectRoot,
      workingDirectory: projectRoot,
      environment: {},
      resolveInstalledPlugin: () => installedPlugin,
      pnpmExecutable: "pnpm-test",
      electronExecutable: "electron-test",
      log: () => {},
      runCommand: async () => ({ code: 2, signal: "SIGTERM" })
    })).rejects.toThrow("Command failed: pnpm-test exec tsc -p tsconfig.build.json (code 2, signal SIGTERM)");
  });
});

async function createProject(): Promise<string> {
  return createTemporaryDirectory();
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arkme-development-plugin-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createPlugin(
  parentDirectory: string,
  name: string,
  version = "0.1.8",
  manifestOverrides: { name: string; version: string; patch: string } = {
    name: "@senguoyun/dsh-arkme",
    version,
    patch: "./cordis.patch.yml"
  },
  includeBuildOutputs = true
): Promise<string> {
  const pluginDirectory = path.join(parentDirectory, name);
  await mkdir(path.join(pluginDirectory, "lib"), { recursive: true });
  await writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({
    name: manifestOverrides.name,
    version: manifestOverrides.version,
    dsh: { bundle: { patch: manifestOverrides.patch } },
    scripts: { build: "node build.mjs" }
  }));
  const files = ["cordis.patch.yml", ...(includeBuildOutputs ? ["lib/index.js", "lib/client.js"] : [])];
  await Promise.all(files
    .map((file) => writeFile(path.join(pluginDirectory, file), "")));
  return pluginDirectory;
}

async function replaceFileWithDirectory(filePath: string): Promise<void> {
  await rm(filePath);
  await mkdir(filePath);
}
