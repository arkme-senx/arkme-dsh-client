import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

describe("runtime native-module rebuild", () => {
  test("deploys production runtime with a hoisted node linker", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "runtime-rebuild.mjs")
    ).href;
    const program = `
      import { buildRuntimeDeployArgs } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify(buildRuntimeDeployArgs({
        storePath: "C:/store",
        runtimeRoot: "C:/runtime"
      })));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "--prefer-offline",
      "--store-dir",
      "C:/store",
      "--filter",
      "@jotmo/harness-runtime",
      "deploy",
      "--prod",
      "--legacy",
      "C:/runtime"
    ]);
  });

  test("prunes source maps from packaged runtime", async () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "runtime-rebuild.mjs")
    ).href;
    const program = `
      import { isRuntimeFilePrunable } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify([
        isRuntimeFilePrunable("node_modules/foo/index.js.map"),
        isRuntimeFilePrunable("node_modules/foo/index.js")
      ]));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, false]);
  });

  test("prunes documentation and debug artifacts but preserves runtime and native build inputs", async () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "runtime-rebuild.mjs")
    ).href;
    const program = `
      import { isRuntimeFilePrunable } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify([
        isRuntimeFilePrunable("node_modules/foo/index.ts"),
        isRuntimeFilePrunable("node_modules/foo/README.md"),
        isRuntimeFilePrunable("node_modules/foo/CHANGELOG.zh-CN.md"),
        isRuntimeFilePrunable("node_modules/foo/config/skills/example/SKILL.md"),
        isRuntimeFilePrunable("node_modules/foo/native.pdb"),
        isRuntimeFilePrunable("node_modules/foo/binding.gyp"),
        isRuntimeFilePrunable("node_modules/foo/src/pty.cc"),
        isRuntimeFilePrunable("node_modules/foo/src/pty.h"),
        isRuntimeFilePrunable("node_modules/foo/index.js"),
        isRuntimeFilePrunable("node_modules/foo/native.node"),
        isRuntimeFilePrunable("node_modules/foo/package.json")
      ]));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      false,
      true,
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false
    ]);
  });

  test("targets Windows x64 when preparing a Windows x64 package", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "runtime-rebuild.mjs")
    ).href;
    const program = `
      import { buildElectronRebuildArgs } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify(buildElectronRebuildArgs({
        rebuildCli: "C:/tools/rebuild/cli.js",
        electronVersion: "43.2.0",
        platform: "win32",
        arch: "x64",
        moduleDir: "C:/project/.runtime/dsh"
      })));
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "C:/tools/rebuild/cli.js",
      "--version",
      "43.2.0",
      "--platform",
      "win32",
      "--arch",
      "x64",
      "--module-dir",
      "C:/project/.runtime/dsh",
      "--which-module",
      "node-pty",
      "--sequential",
      "--force"
    ]);
  });

  test("uses a shell only when spawning a Windows command script", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "runtime-rebuild.mjs")
    ).href;
    const program = `
      import { buildSpawnOptions } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify({
        pnpm: buildSpawnOptions({ platform: "win32", command: "pnpm.cmd" }),
        node: buildSpawnOptions({ platform: "win32", command: "node" }),
        mac: buildSpawnOptions({ platform: "darwin", command: "pnpm" })
      }));
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      pnpm: { shell: true },
      node: {},
      mac: {}
    });
  });

  test("can remove node-pty's unavailable Spectre build requirement", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "runtime-rebuild.mjs")
    ).href;
    const program = `
      import { disableNodePtySpectreMitigation } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(disableNodePtySpectreMitigation(
        "'msvs_configuration_attributes': { 'SpectreMitigation': 'Spectre' }"
      ));
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "'msvs_configuration_attributes': { 'SpectreMitigation': 'false' }"
    );
  });
});
