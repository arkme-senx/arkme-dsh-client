import path from "node:path";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  buildRuntimeEnvironment,
  buildArchitectureLaunch,
  pruneTargetSpecificNodePtyArtifacts,
  resolvePackagedAppRoot,
  resolveRuntimeArchitecture,
  runtimeDirectory
} from "../scripts/runtime-architecture.mjs";
import { materializeRuntimeNodeModules } from "../scripts/materialize-runtime-node-modules.mjs";

describe("macOS runtime architecture", () => {
  test("prepares only concrete Intel or Apple Silicon runtimes", () => {
    expect(resolveRuntimeArchitecture("x64", "arm64")).toBe("x64");
    expect(resolveRuntimeArchitecture("arm64", "x64")).toBe("arm64");
    expect(resolveRuntimeArchitecture(undefined, "arm64")).toBe("arm64");
    expect(() => resolveRuntimeArchitecture("universal", "arm64")).toThrow(
      "Unsupported runtime architecture: universal"
    );
  });

  test("makes pnpm select native packages for the target architecture", () => {
    const original = { PATH: "/usr/bin", npm_config_cpu: "arm64" };
    const environment = buildRuntimeEnvironment(original, "x64");

    expect(environment).toEqual({
      PATH: "/usr/bin",
      npm_config_arch: "x64",
      npm_config_cpu: "x64"
    });
    expect(original).toEqual({ PATH: "/usr/bin", npm_config_cpu: "arm64" });
  });

  test("keeps each concrete runtime in an architecture-specific staging directory", () => {
    expect(runtimeDirectory("/project", "x64")).toBe(
      path.join("/project", ".runtime", "dsh-x64")
    );
    expect(runtimeDirectory("/project", "arm64")).toBe(
      path.join("/project", ".runtime", "dsh-arm64")
    );
  });

  test("allows packaged smoke verification to target the Universal app", () => {
    expect(resolvePackagedAppRoot("release/mac-universal/arkme.app", "/project")).toBe(
      path.join("/project", "release", "mac-universal", "arkme.app")
    );
    expect(resolvePackagedAppRoot(undefined, "/project")).toBe(
      path.join("/project", "release", "mac-arm64", "arkme.app")
    );
  });

  test("can launch the packaged app under Rosetta for an Intel smoke test", () => {
    expect(buildArchitectureLaunch("/Arkme.app/Contents/MacOS/arkme", ["web"], "x64")).toEqual({
      command: "/usr/bin/arch",
      args: ["-x86_64", "/Arkme.app/Contents/MacOS/arkme", "web"]
    });
    expect(buildArchitectureLaunch("/Arkme.app/Contents/MacOS/arkme", ["web"], undefined)).toEqual({
      command: "/Arkme.app/Contents/MacOS/arkme",
      args: ["web"]
    });
  });

  test("removes node-pty target-only output while preserving dual-architecture prebuilds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-runtime-architecture-"));
    const targetOnly = path.join(
      root,
      "node_modules",
      "node-pty",
      "bin",
      "darwin-x64-148",
      "node-pty.node"
    );
    const reusable = path.join(
      root,
      "node_modules",
      "node-pty",
      "prebuilds",
      "darwin-x64",
      "pty.node"
    );
    const rebuiltPty = path.join(
      root,
      "node_modules",
      "node-pty",
      "build",
      "Release",
      "pty.node"
    );
    const rebuiltHelper = path.join(
      root,
      "node_modules",
      "node-pty",
      "build",
      "Release",
      "spawn-helper"
    );
    const buildMetadata = path.join(
      root,
      "node_modules",
      "node-pty",
      "build",
      "Makefile"
    );
    await mkdir(path.dirname(targetOnly), { recursive: true });
    await mkdir(path.dirname(reusable), { recursive: true });
    await writeFile(targetOnly, "target-only");
    await writeFile(reusable, "reusable");
    await mkdir(path.dirname(rebuiltPty), { recursive: true });
    await writeFile(rebuiltPty, "pty-binary");
    await writeFile(rebuiltHelper, "helper-binary");
    await writeFile(buildMetadata, "architecture-specific metadata");

    await pruneTargetSpecificNodePtyArtifacts(root);

    await expect(stat(path.dirname(path.dirname(targetOnly)))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(stat(reusable)).resolves.toBeDefined();
    await expect(stat(rebuiltPty)).resolves.toBeDefined();
    await expect(stat(rebuiltHelper)).resolves.toBeDefined();
    await expect(stat(buildMetadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("drops pnpm-generated absolute command shims before installing portable runtime shims", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-runtime-shims-"));
    const nodeModules = path.join(root, "node_modules");
    const generatedShim = path.join(nodeModules, ".bin", "cordis");
    try {
      await mkdir(path.join(nodeModules, ".pnpm"), { recursive: true });
      await mkdir(path.dirname(generatedShim), { recursive: true });
      await writeFile(path.join(nodeModules, ".modules.yaml"), "storeDir: /private/build/store\n");
      await writeFile(
        generatedShim,
        "#!/bin/sh\n# cmd-shim-target=/private/build/.runtime/dsh-x64/node_modules/cordis/bin.js\n"
      );

      await materializeRuntimeNodeModules(root);

      await expect(stat(path.join(root, "node_modules", ".bin"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(stat(path.join(root, "node_modules", ".modules.yaml"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
