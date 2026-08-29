import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("bundled pnpm shim", () => {
  test("runs the packaged pnpm CLI through the app-owned Node executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-bundled-pnpm-"));
    temporaryDirectories.push(root);
    const nodeModules = path.join(root, "node_modules");
    const cli = path.join(nodeModules, "pnpm", "bin", "pnpm.cjs");
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");

    const installer = spawnSync(
      process.execPath,
      [path.resolve("scripts", "install-bundled-pnpm-shim.mjs"), nodeModules, "darwin"],
      { encoding: "utf8" }
    );
    expect(installer.status, installer.stderr).toBe(0);

    const command = path.join(nodeModules, ".bin", "pnpm");
    await chmod(command, 0o755);
    const result = spawnSync(command, ["--version", "with spaces"], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ARKME_NODE_EXEC_PATH: process.execPath
      }
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["--version", "with spaces"]);
  });

  test("provides a Node command for pnpm lifecycle scripts without system Node", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-bundled-node-"));
    temporaryDirectories.push(root);
    const nodeModules = path.join(root, "node_modules");
    const cli = path.join(nodeModules, "pnpm", "bin", "pnpm.cjs");
    const probe = path.join(root, "probe.cjs");
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "process.exit(0)\n");
    await writeFile(probe, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");

    const installer = spawnSync(
      process.execPath,
      [path.resolve("scripts", "install-bundled-pnpm-shim.mjs"), nodeModules, "darwin"],
      { encoding: "utf8" }
    );
    expect(installer.status, installer.stderr).toBe(0);

    const result = spawnSync(path.join(nodeModules, ".bin", "node"), [probe, "lifecycle"], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ARKME_NODE_EXEC_PATH: process.execPath
      }
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["lifecycle"]);
  });

  test("creates a Windows command shim for the packaged Electron runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-bundled-pnpm-win-"));
    temporaryDirectories.push(root);
    const nodeModules = path.join(root, "node_modules");
    const cli = path.join(nodeModules, "pnpm", "bin", "pnpm.cjs");
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "process.exit(0)\n");

    const installer = spawnSync(
      process.execPath,
      [path.resolve("scripts", "install-bundled-pnpm-shim.mjs"), nodeModules, "win32"],
      { encoding: "utf8" }
    );
    expect(installer.status, installer.stderr).toBe(0);

    const command = await readFile(path.join(nodeModules, ".bin", "pnpm.cmd"), "utf8");
    expect(command).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(command).toContain("%ARKME_NODE_EXEC_PATH%");
    expect(command).toContain("%~dp0..\\pnpm\\bin\\pnpm.cjs");
    expect(command).toContain("%*");
    const nodeCommand = await readFile(path.join(nodeModules, ".bin", "node.cmd"), "utf8");
    expect(nodeCommand).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(nodeCommand).toContain('"%ARKME_NODE_EXEC_PATH%" %*');
  });
});
