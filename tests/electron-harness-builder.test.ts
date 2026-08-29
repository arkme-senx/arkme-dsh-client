import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function writePackage(
  nodeModules: string,
  name: string,
  metadata: Record<string, unknown> = {}
) {
  const packageRoot = path.join(nodeModules, ...name.split("/"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", ...metadata })}\n`
  );
  return packageRoot;
}

type FixtureTarget = {
  os: "darwin" | "windows" | "linux";
  arch: "arm64" | "x64";
  suffix: string;
  libc?: "glibc";
};

async function writeNativeFixture(source: string, target: FixtureTarget) {
  const packageOs = target.os === "windows" ? "win32" : target.os;
  const nodeAddonSuffix = target.os === "windows"
    ? `win32-${target.arch}-msvc`
    : target.os === "linux"
      ? `linux-${target.arch}-gnu`
      : target.suffix;
  const packageMetadata = {
    os: [packageOs],
    cpu: [target.arch],
    ...(target.libc ? { libc: [target.libc] } : {})
  };

  const addon = await writePackage(
    source,
    `node-addon-require-builtin-${nodeAddonSuffix}`,
    packageMetadata
  );
  await mkdir(path.join(addon, "prebuilt"), { recursive: true });
  await writeFile(
    path.join(addon, "prebuilt", `${nodeAddonSuffix}-napi-v9.node`),
    target.suffix
  );

  const koffi = await writePackage(
    source,
    `@koromix/koffi-${target.suffix}`,
    packageMetadata
  );
  const koffiPlatform = `${packageOs}_${target.arch}`;
  await mkdir(path.join(koffi, koffiPlatform), { recursive: true });
  await writeFile(path.join(koffi, koffiPlatform, "koffi.node"), target.suffix);

  const sharp = await writePackage(
    source,
    `@img/sharp-${target.suffix}`,
    packageMetadata
  );
  await mkdir(path.join(sharp, "lib"), { recursive: true });
  await writeFile(
    path.join(sharp, "lib", `sharp-${target.suffix}-0.35.3.node`),
    target.suffix
  );
  if (target.os === "windows") {
    await writeFile(path.join(sharp, "lib", "libvips-42.dll"), target.suffix);
    await writeFile(path.join(sharp, "lib", "libvips-cpp-8.18.3.dll"), target.suffix);
  } else {
    const libvips = await writePackage(
      source,
      `@img/sharp-libvips-${target.suffix}`,
      packageMetadata
    );
    await mkdir(path.join(libvips, "lib"), { recursive: true });
    await writeFile(
      path.join(
        libvips,
        "lib",
        target.os === "darwin" ? "libvips-cpp.8.18.3.dylib" : "libvips-cpp.so.8.18.3"
      ),
      target.suffix
    );
  }
}

async function writeBuildFixture(root: string) {
  const source = path.join(root, "node_modules");
  const dsh = await writePackage(source, "@deepseek-ai/dsh", { version: "0.1.0-rc.8" });
  await mkdir(path.join(dsh, "lib"), { recursive: true });
  await writeFile(path.join(dsh, "lib", "bin.js"), "export {};\n");
  const pnpm = await writePackage(source, "pnpm", { version: "11.19.0" });
  await mkdir(path.join(pnpm, "bin"), { recursive: true });
  await writeFile(path.join(pnpm, "bin", "pnpm.cjs"), "process.exit(0);\n");

  const targets: FixtureTarget[] = [
    { os: "darwin", arch: "arm64", suffix: "darwin-arm64" },
    { os: "darwin", arch: "x64", suffix: "darwin-x64" },
    { os: "windows", arch: "x64", suffix: "win32-x64" },
    { os: "linux", arch: "x64", suffix: "linux-x64", libc: "glibc" }
  ];
  for (const target of targets) await writeNativeFixture(source, target);

  const nodePty = await writePackage(source, "node-pty");
  for (const target of targets) {
    const prebuild = path.join(nodePty, "prebuilds", target.suffix);
    await mkdir(prebuild, { recursive: true });
    if (target.os === "windows") {
      await writeFile(path.join(prebuild, "conpty.node"), target.suffix);
      await writeFile(path.join(prebuild, "conpty_console_list.node"), target.suffix);
      await mkdir(path.join(prebuild, "conpty"), { recursive: true });
      await writeFile(path.join(prebuild, "conpty", "conpty.dll"), target.suffix);
      await writeFile(path.join(prebuild, "conpty", "OpenConsole.exe"), target.suffix);
    } else {
      await writeFile(path.join(prebuild, "pty.node"), target.suffix);
      if (target.os === "darwin") {
        await writeFile(path.join(prebuild, "spawn-helper"), target.suffix);
      }
    }
  }
  return { source, targets };
}

describe("cross-platform Electron Harness artifacts", () => {
  test("keeps only Linux x64 native packages while embedding pnpm and Electron metadata", async () => {
    const builder = await import("../scripts/runtime/electron-harness-artifacts.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-harness-target-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "node_modules");
    const harnessRoot = path.join(root, "harness");

    const dsh = await writePackage(source, "@deepseek-ai/dsh", { version: "0.1.0-rc.8" });
    await mkdir(path.join(dsh, "lib"), { recursive: true });
    await writeFile(path.join(dsh, "lib", "bin.js"), "export {};\n");
    const pnpm = await writePackage(source, "pnpm", { version: "11.19.0" });
    await mkdir(path.join(pnpm, "bin"), { recursive: true });
    await writeFile(path.join(pnpm, "bin", "pnpm.cjs"), "process.exit(0);\n");
    await writePackage(source, "@senguoyun/dsh-arkme");

    await writePackage(source, "node-addon-require-builtin-linux-x64-gnu", {
      os: ["linux"], cpu: ["x64"], libc: ["glibc"]
    });
    await writePackage(source, "node-addon-require-builtin-win32-x64-msvc", {
      os: ["win32"], cpu: ["x64"]
    });
    await writePackage(source, "@koromix/koffi-linux-x64", {
      os: ["linux"], cpu: ["x64"]
    });
    await writePackage(source, "@koromix/koffi-win32-x64", {
      os: ["win32"], cpu: ["x64"]
    });
    await writePackage(source, "@img/sharp-linux-x64", {
      os: ["linux"], cpu: ["x64"], libc: ["glibc"]
    });
    await writePackage(source, "@img/sharp-libvips-linux-x64", {
      os: ["linux"], cpu: ["x64"], libc: ["glibc"]
    });
    await writePackage(source, "@img/sharp-win32-x64", {
      os: ["win32"], cpu: ["x64"]
    });

    const nodePty = await writePackage(source, "node-pty");
    for (const platform of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]) {
      const prebuild = path.join(nodePty, "prebuilds", platform);
      await mkdir(prebuild, { recursive: true });
      await writeFile(
        path.join(prebuild, platform === "win32-x64" ? "conpty.node" : "pty.node"),
        platform
      );
    }
    const hostBuild = path.join(nodePty, "build", "Release");
    await mkdir(hostBuild, { recursive: true });
    await writeFile(path.join(hostBuild, "pty.node"), "darwin-arm64");
    await writeFile(path.join(hostBuild, "spawn-helper"), "darwin-arm64");
    await mkdir(path.join(source, ".pnpm", "private"), { recursive: true });
    await writeFile(path.join(source, ".pnpm", "private", "package.json"), "{}\n");

    await builder.prepareElectronHarnessTarget({
      sourceModules: source,
      harnessRoot,
      target: { os: "linux", arch: "x64", libc: "glibc" },
      version: "0.1.0-rc.8",
      buildId: "electron43-20260827-2"
    });

    expect(JSON.parse(await readFile(path.join(harnessRoot, "runtime-metadata.json"), "utf8")))
      .toEqual({
        schemaVersion: 1,
        component: "electron-harness",
        version: "0.1.0-rc.8",
        buildId: "electron43-20260827-2",
        target: { os: "linux", arch: "x64", libc: "glibc" },
        runtime: {
          kind: "electron",
          electronVersion: "43.2.0",
          electronMajor: 43,
          modulesAbi: 148
        },
        pnpmVersion: "11.19.0"
      });
    expect(await readFile(path.join(harnessRoot, "node_modules", ".bin", "pnpm"), "utf8"))
      .toContain("ELECTRON_RUN_AS_NODE=1");
    await expect(stat(path.join(harnessRoot, "node_modules", ".pnpm"))).rejects.toThrow();
    await expect(stat(path.join(harnessRoot, "node_modules", "@senguoyun", "dsh-arkme")))
      .rejects.toThrow();
    await expect(stat(path.join(
      harnessRoot,
      "node_modules",
      "node-addon-require-builtin-win32-x64-msvc"
    ))).rejects.toThrow();
    await expect(stat(path.join(harnessRoot, "node_modules", "@koromix", "koffi-win32-x64")))
      .rejects.toThrow();
    await expect(stat(path.join(harnessRoot, "node_modules", "@img", "sharp-win32-x64")))
      .rejects.toThrow();
    expect(await readFile(path.join(
      harnessRoot,
      "node_modules",
      "node-pty",
      "prebuilds",
      "linux-x64",
      "pty.node"
    ), "utf8")).toBe("linux-x64");
    await expect(stat(path.join(
      harnessRoot,
      "node_modules",
      "node-pty",
      "build"
    ))).rejects.toThrow();
    await expect(stat(path.join(
      harnessRoot,
      "node_modules",
      "node-pty",
      "prebuilds",
      "win32-x64"
    ))).rejects.toThrow();
  });

  test("writes four Electron 43 archives with one shared build identity", async () => {
    const builder = await import("../scripts/runtime/electron-harness-artifacts.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-harness-build-"));
    temporaryDirectories.push(root);
    const { source } = await writeBuildFixture(root);
    const output = path.join(root, "output");

    const result = await builder.buildElectronHarnessArtifacts({
      sourceModules: source,
      output,
      version: "0.1.0-rc.8",
      buildId: "electron43-20260827-2"
    });

    expect(result.artifacts.map((artifact: { file: string }) => artifact.file)).toEqual([
      "harness-electron43-darwin-arm64-0.1.0-rc.8.tar.zst",
      "harness-electron43-darwin-x64-0.1.0-rc.8.tar.zst",
      "harness-electron43-windows-x64-0.1.0-rc.8.tar.zst",
      "harness-electron43-linux-x64-glibc-0.1.0-rc.8.tar.zst"
    ]);
    expect(result.artifacts.every((artifact: { buildId: string }) =>
      artifact.buildId === "electron43-20260827-2"
    )).toBe(true);
    expect(result.artifacts.every((artifact: { sha256: string }) =>
      /^[a-f0-9]{64}$/.test(artifact.sha256)
    )).toBe(true);
    expect(result.artifacts.every((artifact: { size: number; unpackedSize: number }) =>
      artifact.size > 0 && artifact.unpackedSize > 0
    )).toBe(true);
    expect(JSON.parse(await readFile(path.join(output, "artifact-metadata.json"), "utf8")))
      .toEqual(result);
    const checksums = (await readFile(path.join(output, "SHA256SUMS"), "utf8"))
      .trim()
      .split("\n");
    expect(checksums).toHaveLength(4);
    expect(checksums.every(line => /^[a-f0-9]{64}  harness-electron43-.+\.tar\.zst$/.test(line)))
      .toBe(true);
  });

  test("rejects mismatched Harness and pnpm package versions before publishing output", async () => {
    const builder = await import("../scripts/runtime/electron-harness-artifacts.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-harness-versions-"));
    temporaryDirectories.push(root);
    const { source } = await writeBuildFixture(root);
    await writeFile(
      path.join(source, "@deepseek-ai", "dsh", "package.json"),
      `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.7" })}\n`
    );

    await expect(builder.buildElectronHarnessArtifacts({
      sourceModules: source,
      output: path.join(root, "output"),
      version: "0.1.0-rc.8",
      buildId: "electron43-version-mismatch"
    })).rejects.toThrow(/@deepseek-ai\/dsh.*0\.1\.0-rc\.7.*0\.1\.0-rc\.8/);
    await expect(stat(path.join(root, "output"))).rejects.toThrow();

    await writeFile(
      path.join(source, "@deepseek-ai", "dsh", "package.json"),
      `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.8" })}\n`
    );
    await writeFile(
      path.join(source, "pnpm", "package.json"),
      `${JSON.stringify({ name: "pnpm", version: "11.18.0" })}\n`
    );
    await expect(builder.buildElectronHarnessArtifacts({
      sourceModules: source,
      output: path.join(root, "output"),
      version: "0.1.0-rc.8",
      buildId: "electron43-version-mismatch"
    })).rejects.toThrow(/pnpm.*11\.18\.0.*11\.19\.0/);
  });

  test("rejects a mixed DSH dependency closure before publishing output", async () => {
    const builder = await import("../scripts/runtime/electron-harness-artifacts.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-harness-dsh-closure-"));
    temporaryDirectories.push(root);
    const { source } = await writeBuildFixture(root);
    const carrier = await writePackage(source, "fixture-carrier");
    await writePackage(
      path.join(carrier, "node_modules"),
      "@deepseek-ai/dsh-llm-pi-ai",
      { version: "0.1.0-rc.9" }
    );

    await expect(builder.buildElectronHarnessArtifacts({
      sourceModules: source,
      output: path.join(root, "output"),
      version: "0.1.0-rc.8",
      buildId: "electron43-mixed-dsh-closure"
    })).rejects.toThrow(
      /@deepseek-ai\/dsh-llm-pi-ai version 0\.1\.0-rc\.9; expected 0\.1\.0-rc\.8/
    );
    await expect(stat(path.join(root, "output"))).rejects.toThrow();
  });

  test("rejects a package shell when its target native binary is missing", async () => {
    const builder = await import("../scripts/runtime/electron-harness-artifacts.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-harness-native-"));
    temporaryDirectories.push(root);
    const { source } = await writeBuildFixture(root);
    await rm(path.join(
      source,
      "@koromix",
      "koffi-linux-x64",
      "linux_x64",
      "koffi.node"
    ));

    await expect(builder.buildElectronHarnessArtifacts({
      sourceModules: source,
      output: path.join(root, "output"),
      version: "0.1.0-rc.8",
      buildId: "electron43-missing-native"
    })).rejects.toThrow(/koffi-linux-x64.*koffi\.node/);
    await expect(stat(path.join(root, "output"))).rejects.toThrow();
  });

  test("does not turn a committed output into a reported failure when cleanup fails", async () => {
    const builder = await import("../scripts/runtime/electron-harness-artifacts.mjs");
    const warnings: string[] = [];
    await expect(builder.cleanupElectronHarnessBuildPaths({
      paths: ["staging", "temporary"],
      suppressErrors: true,
      remove: async () => { throw new Error("cleanup denied"); },
      warn: message => warnings.push(message)
    })).resolves.toBeUndefined();
    expect(warnings).toHaveLength(2);

    await expect(builder.cleanupElectronHarnessBuildPaths({
      paths: ["staging"],
      suppressErrors: false,
      remove: async () => { throw new Error("cleanup denied"); },
      warn: () => undefined
    })).rejects.toThrow(/cleanup denied/);
  });
});
