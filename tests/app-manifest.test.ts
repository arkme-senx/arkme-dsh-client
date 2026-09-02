import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { configDefaults } from "vitest/config";
import { parse } from "yaml";
import vitestConfig from "../vitest.config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const obsoleteSyncScript = ["sync", "plugin"].join(":");
const obsoleteVendorPath = ["vendor", "arkme-dsh-plugin"].join("/");

describe("application manifest", () => {
  test("declares a positive integer Version Code and validates it before builds", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { versionCode?: unknown; scripts: Record<string, string> };

    expect(manifest.versionCode).toBe(3);
    expect(manifest.scripts.build).toContain("node scripts/validate-app-version-code.mjs");
  });

  test("includes the package Version Code in every production artifact filename", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { version: string; versionCode: number };
    const electronBuilderEntry = require.resolve("electron-builder");
    const electronBuilderRequire = createRequire(electronBuilderEntry);
    const { getConfig } = electronBuilderRequire(
      "app-builder-lib/out/util/config/config.js"
    ) as {
      getConfig: (projectDirectory: string, configPath: null, configFromOptions: null) => Promise<{ artifactName: string }>;
    };
    const { expandMacro } = electronBuilderRequire(
      "app-builder-lib/out/util/macroExpander.js"
    ) as {
      expandMacro: (
        pattern: string,
        architecture: string,
        appInfo: { productName: string; sanitizedProductName: string; version: string },
        extra: { ext: string },
      ) => string;
    };
    const config = await getConfig(projectRoot, null, null);
    const appInfo = {
      productName: "arkme",
      sanitizedProductName: "arkme",
      version: manifest.version,
    };

    for (const [architecture, extension, expected] of [
      ["universal", "dmg", "arkme-0.2.4-vc3-universal.dmg"],
      ["universal", "zip", "arkme-0.2.4-vc3-universal.zip"],
      ["x64", "exe", "arkme-0.2.4-vc3-x64.exe"],
      ["x64", "AppImage", "arkme-0.2.4-vc3-x64.AppImage"],
    ] as const) {
      expect(expandMacro(config.artifactName, architecture, appInfo, { ext: extension })).toBe(expected);
    }
  });

  test("uses the commit-pinned production catalog outside the vendor workspace", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { devDependencies: Record<string, string> };
    const workspaceManifest = parse(await readFile(
      path.join(projectRoot, "pnpm-workspace.yaml"), "utf8"
    )) as {
      packages: string[];
      catalogs: { production: Record<string, string> };
    };

    expect(manifest.devDependencies["@senguoyun/dsh-arkme"]).toBe(
      "catalog:production"
    );
    expect(manifest.devDependencies.yaml).toBe("2.9.0");
    expect(workspaceManifest.packages).toEqual([".", "runtime"]);
    expect(workspaceManifest.catalogs.production["@senguoyun/dsh-arkme"]).toBe(
      "git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#e817cb21e3923c8e903d68d442f3227c9e6c78ef"
    );
  });

  test("packages the client under the arkme product name", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as {
      name: string;
      build: { appId: string; productName: string };
    };

    expect(manifest.name).toBe("arkme");
    expect(manifest.build.productName).toBe("arkme");
  });

  test("uses the public application identity", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { build: { appId: string } };

    expect(manifest.build.appId).toBe("com.senx.arkme.harness");
  });

  test("registers the arkme URL protocol for packaged macOS and Windows clients", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { build: { protocols?: Array<{ name: string; schemes: string[] }> } };

    expect(manifest.build.protocols).toEqual([{
      name: "Arkme Extension Share",
      schemes: ["arkme"]
    }]);
  });

  test("packages the client with the custom arkme icon", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { build: { mac: { icon: string } } };

    expect(manifest.build.mac.icon).toBe("build/icon.icns");
    const icon = await readFile(path.join(projectRoot, manifest.build.mac.icon));
    expect(icon.subarray(0, 4).toString("ascii")).toBe("icns");
  });

  test("declares the macOS location usage shown before recording a snapshot location", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as {
      build: {
        mac: {
          entitlements?: string;
          entitlementsInherit?: string;
          extendInfo?: {
            NSLocationUsageDescription?: string;
            NSLocationWhenInUseUsageDescription?: string;
          };
        };
      };
    };

    const expected = "Arkme 仅在你开启位置记录后，将当前位置写入你发送的快记快照。";
    expect(manifest.build.mac.extendInfo).toEqual({
      NSLocationUsageDescription: expected,
      NSLocationWhenInUseUsageDescription: expected
    });
    expect(manifest.build.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(manifest.build.mac.entitlementsInherit).toBeUndefined();
    const entitlements = await readFile(
      path.join(projectRoot, "build", "entitlements.mac.plist"),
      "utf8"
    );
    for (const key of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.personal-information.location"
    ]) {
      expect(entitlements).toContain(`<key>${key}</key>\n  <true/>`);
    }
  });

  test("pins the browser-process CoreLocation FFI as a production dependency", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(manifest.dependencies?.koffi).toBe("3.1.5");
    expect(manifest.devDependencies?.koffi).toBeUndefined();
  });

  test("packages a runtime-free shell and gates distributable builds on dynamic runtime smoke", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string>; build: { linux?: { target?: unknown } } };

    expect(manifest.scripts["verify:packaged"]).toBe("node scripts/packaged-smoke.mjs");
    expect(manifest.scripts.dist).toContain("node scripts/packaged-smoke.mjs --platform darwin");
    expect(manifest.scripts["dist:win"]).toContain(
      "node scripts/packaged-smoke.mjs --platform win32"
    );
    expect(manifest.scripts["dist:linux"]).toContain(
      "node scripts/packaged-smoke.mjs --platform linux"
    );
    expect(manifest.scripts.pack).not.toContain("prepare:runtime");
    expect(manifest.scripts.dist).not.toContain("prepare:runtime");
    expect(manifest.scripts["dist:win"]).not.toContain("prepare:runtime");
    expect(manifest.scripts["dist:linux"]).not.toContain("prepare:runtime");
    expect(manifest.build).not.toHaveProperty("extraResources");
    expect(manifest.build).not.toHaveProperty("beforePack");
    expect(manifest.build.linux?.target).toEqual([{ target: "AppImage", arch: ["x64"] }]);
  });

  test("gates macOS artifacts on signature verification", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string>; build: { mac: { forceCodeSigning?: boolean } } };

    expect(manifest.scripts["verify:mac-signature"]).toBe(
      "node scripts/verify-macos-signature.mjs"
    );
    expect(manifest.scripts.pack).toContain(
      "node scripts/verify-macos-signature.mjs release/mac-universal/arkme.app"
    );
    expect(manifest.scripts.dist).toContain(
      "node scripts/verify-macos-signature.mjs release/mac-universal/arkme.app"
    );
    expect(manifest.build.mac.forceCodeSigning).toBe(true);
  });

  test("packages the macOS notification permission addon outside ASAR", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as {
      optionalDependencies?: Record<string, string>;
      build: { asarUnpack?: string[] };
    };

    expect(manifest.optionalDependencies?.["@arkme/macos-notification-permission"])
      .toBe("file:./native/macos-notification-permission");
    expect(manifest.build.asarUnpack).toContain(
      "node_modules/@arkme/macos-notification-permission/build/Release/*.node"
    );
  });

  test("provides an isolated unsigned macOS package command for the test runtime service", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["build:test"]).toContain(
      "ARKME_RUNTIME_SERVICE_BASE_URL=https://jotmo.senguo.me"
    );
    expect(manifest.scripts["dist:test:mac"]).toContain("--universal");
    expect(manifest.scripts["dist:test:mac"]).toContain("forceCodeSigning=false");
    expect(manifest.scripts["dist:test:mac"]).toContain("release-test-dynamic");
    expect(manifest.scripts["dist:test:mac"]).toContain("packaged-smoke.mjs --platform darwin");
  });

  test("builds distributable macOS artifacts as Universal binaries", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as {
      scripts: Record<string, string>;
      build: {
        beforePack?: string;
        mac: { target: Array<{ arch: string[] }>; x64ArchFiles?: string };
      };
    };
    const workspaceManifest = parse(await readFile(
      path.join(projectRoot, "pnpm-workspace.yaml"),
      "utf8"
    )) as { supportedArchitectures?: { os?: string[]; cpu?: string[] } };

    expect(manifest.scripts.dist).toContain("--universal");
    expect(manifest.scripts.dist).toContain(
      "ARKME_PACKAGED_APP_ROOT=release/mac-universal/arkme.app"
    );
    expect(manifest.build.beforePack).toBeUndefined();
    expect(manifest.build.mac.target.every(({ arch }) => arch.includes("universal"))).toBe(true);
    expect(manifest.build.mac.x64ArchFiles).toBe(
      "**/{*darwin-arm64*,*darwin-x64*}/**/*"
    );
    expect(workspaceManifest.supportedArchitectures).toEqual({
      os: ["darwin", "win32", "linux"],
      cpu: ["x64", "arm64"],
      libc: ["glibc"]
    });
  });

  test("ships the exact pnpm CLI used for profile plugin operations", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "runtime", "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };

    expect(manifest.dependencies.pnpm).toBe("11.19.0");
  });

  test("shows Windows installation progress without restoring legacy runtime validation", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as {
      scripts: Record<string, string>;
      build: {
        extraResources?: Array<{ from: string; to: string }>;
        nsis?: { include?: string; oneClick?: boolean };
      };
    };

    expect(manifest.build.extraResources).toBeUndefined();
    expect(manifest.build.nsis).toEqual({
      oneClick: false,
      include: "build/nsis-installer-ui.nsh"
    });
    const installerUiPath = manifest.build.nsis?.include;
    if (installerUiPath === undefined) {
      throw new Error("Windows installer UI include is not configured");
    }
    const installerUi = await readFile(
      path.join(projectRoot, installerUiPath),
      "utf8"
    );
    expect(installerUi).toContain("!macro customWelcomePage");
    expect(installerUi).toContain("ShowInstDetails show");
    expect(installerUi).toContain("!macro customInstallMode");
    expect(installerUi).toContain('StrCpy $isForceCurrentInstall "1"');
    expect(installerUi).toContain("!define MUI_FINISHPAGE_NOAUTOCLOSE");
    expect(installerUi).not.toMatch(/customHeader|IfFileExists|Abort/);
    expect(manifest.scripts["build:windows-artifacts"]).toBe(
      "node scripts/build-windows-artifacts.mjs"
    );
    expect(manifest.scripts["dist:win"]).toContain(
      "pnpm run build:windows-artifacts"
    );
    await expect(
      access(path.join(projectRoot, "build", "installer.nsh"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("starts development through the local plugin launcher", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts.dev).toBe("node scripts/run-development.mjs");
    expect(manifest.scripts).not.toHaveProperty(obsoleteSyncScript);
    expect(Object.values(manifest.scripts).join(" ")).not.toContain(obsoleteSyncScript);
    expect(Object.values(manifest.scripts).join(" ")).not.toContain(obsoleteVendorPath);
  });

  test("exports separate public identities for production and test builds", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as {
      scripts: Record<string, string>;
      build: { appId: string; productName: string; protocols: Array<{ schemes: string[] }> };
    };
    const testConfigModule = await import(
      `${pathToFileURL(path.join(projectRoot, "electron-builder.test-config.cjs")).href}?test=${Date.now()}`
    );
    const testBuild = testConfigModule.default as typeof manifest.build;

    expect(manifest.build).toMatchObject({
      appId: "com.senx.arkme.harness",
      productName: "arkme",
      protocols: [{ schemes: ["arkme"] }]
    });
    expect(testBuild).toMatchObject({
      appId: "cc.jiwo.arkme.test",
      productName: "arkme Test",
      protocols: [{ schemes: ["arkme-test"] }]
    });
    expect(manifest.scripts["dist:test:mac"]).toContain("--config electron-builder.test-config.cjs");
    expect(manifest.scripts["dist:test:win"]).toContain("--config electron-builder.test-config.cjs");
    expect(manifest.scripts["dist:test:linux"]).toContain("--config electron-builder.test-config.cjs");
  });

  test("exposes unambiguous packaged production and test shell runners", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["run:prod"]).toBe("node scripts/run-packaged-shell.mjs prod");
    expect(manifest.scripts["run:test"]).toBe("node scripts/run-packaged-shell.mjs test");
  });

  test("exposes a reusable local-plugin test packaging command", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["pack:test"]).toBe("node scripts/run-test-packaging.mjs");
  });

  test("keeps Vitest discovery out of dependencies, Git metadata, and SDD workspaces", () => {
    const exclude = vitestConfig.test?.exclude;

    expect(exclude).toEqual([
      ...configDefaults.exclude,
      "**/.superpowers/**"
    ]);
  });
});
