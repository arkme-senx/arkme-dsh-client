import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  commitRuntimeManagedProfileTransaction,
  provisionArkmeWebProfile,
  recoverRuntimeManagedProfileTransaction,
  rollbackRuntimeManagedProfileTransaction
} from "../src/plugin-profile.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("provisionArkmeWebProfile", () => {
  test("initializes a web profile that resolves the embedded plugin without pnpm", async () => {
    const fixture = await createFixture("9.8.7-local");
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    });

    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const manifest = JSON.parse(
      await readFile(path.join(profileDir, "package.json"), "utf8")
    ) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(manifest.dependencies).toEqual({
      "@senguoyun/dsh-arkme": `link:${fixture.pluginDir}`
    });
    expect((manifest as { packageManager?: string }).packageManager).toBe("pnpm@11.19.0");
    expect(manifest.dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@senguoyun/dsh-arkme"
    ]);
    expect(await readFile(path.join(profileDir, "cordis.patch.yml"), "utf8")).toContain(
      "Your patch layer"
    );
    expect(await readFile(path.join(profileDir, "pnpm-workspace.yaml"), "utf8")).toContain(
      "autoInstallPeers: false"
    );
    const linkPath = path.join(
      profileDir,
      "node_modules",
      "@senguoyun",
      "dsh-arkme"
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await realpath(linkPath)).toBe(await realpath(fixture.pluginDir));
  });

  test("writes the complete test environment override after the plugin bundle patch", async () => {
    const fixture = await createFixture();

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      environment: "test"
    });

    const patch = await readFile(
      path.join(fixture.dshHome, "profiles", "web", "cordis.patch.yml"),
      "utf8"
    );
    expect(patch).toBe(`- id: arkme-self
  config:
    environment: test
    authBaseUrl: https://jotmo.senguo.me
    subjectBaseUrl: https://jotmo-subject.senguo.me
    recordBaseUrl: https://jotmo-record.senguo.me
    dataBaseUrl: https://jotmo-data.senguo.me
    chatBaseUrl: https://jotmo-chat.senguo.me
    botBaseUrl: https://jotmo-bot.senguo.me
    imBaseUrl: https://jotmo-im.senguo.me
    webrtcBaseUrl: https://jotmo-webrtc.senguo.me
    worldBaseUrl: https://jotmo-world.senguo.me
    relationBaseUrl: https://jotmo-relation.senguo.me
    intelligentBaseUrl: https://jotmo-intelligent.senguo.me
    audioBaseUrl: https://jotmo-audio.senguo.me
    shareWebsite: https://jotmo-app.senguo.me
    extensionPublishBaseUrl: ''
    allowProduction: false
    updateCheckEnabled: false
    updateServiceBaseUrl: https://jotmo.senguo.me
    dshRemoteFeatureEnabled: true
    dshRemoteRealtimeBaseUrl: https://jotmo-realtime.senguo.me
`);
    expect(patch).not.toContain("https://api.jotmo.cc");
  });

  test("repairs a modified test environment patch on the next profile initialization", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "cordis.patch.yml"), "- id: production-override\n");

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      environment: "test"
    });

    const patch = await readFile(path.join(profileDir, "cordis.patch.yml"), "utf8");
    expect(patch).toContain("environment: test");
    expect(patch).not.toContain("production-override");
  });

  test("installs a packaged artifact as a physical Profile directory", async () => {
    const fixture = await createFixture("0.1.17");
    const artifactPath = await packPlugin(fixture.pluginDir, path.join(fixture.root, "artifacts"));
    const artifactSha512 = createHash("sha512").update(await readFile(artifactPath)).digest("hex");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const packageManager = packageManagerFixture(fixture.root);

    const result = await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      embeddedArtifact: {
        artifactPath,
        artifactSha512,
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.17"
      },
      forceEmbedded: true,
      packageManager
    });

    expect(result).toMatchObject({
      profileDir,
      pluginDir: installedDir,
      source: "embedded",
      version: "0.1.17"
    });
    expect((await lstat(installedDir)).isSymbolicLink()).toBe(false);
    expect((await lstat(installedDir)).isDirectory()).toBe(true);
    const manifest = JSON.parse(
      await readFile(path.join(profileDir, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@senguoyun/dsh-arkme"]).toBe(`file:${artifactPath}`);
    expect(JSON.parse(await readFile(path.join(installedDir, "package.json"), "utf8")))
      .toMatchObject({ name: "@senguoyun/dsh-arkme", version: "0.1.17" });
  });

  test("migrates stale pnpm link metadata before installing a packaged artifact", async () => {
    const fixture = await createFixture("0.1.29");
    const artifactPath = await packPlugin(fixture.pluginDir, path.join(fixture.root, "artifacts"));
    const artifactSha512 = createHash("sha512").update(await readFile(artifactPath)).digest("hex");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const oldPluginDir = path.join(fixture.root, "old-app", "dsh-arkme");
    const extensionDir = path.join(fixture.root, "example-extension");
    const packageManager = packageManagerFixture(fixture.root);
    await createPlugin(oldPluginDir, "0.1.21");
    await createPlugin(extensionDir, "2.3.4");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: {
        "@senguoyun/dsh-arkme": `link:${oldPluginDir}`,
        "example-extension": `link:${extensionDir}`
      },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme", "example-extension"] } }
    }, null, 2)}\n`);
    await writeFile(
      path.join(profileDir, "pnpm-workspace.yaml"),
      "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
    );
    await execFileAsync(
      packageManager.executable,
      [
        ...(packageManager.prefixArgs ?? []),
        "install",
        ...(packageManager.installArgs ?? [])
      ],
      { cwd: profileDir, env: packageManager.environment }
    );

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies["@senguoyun/dsh-arkme"] = `file:${artifactPath}`;
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const rootLockPath = path.join(profileDir, "pnpm-lock.yaml");
    const staleRootLock = (await readFile(rootLockPath, "utf8")).replace(
      `specifier: link:${oldPluginDir}`,
      `specifier: file:${artifactPath}`
    );
    expect(staleRootLock).toContain("version: link:");
    expect(staleRootLock).toContain("old-app/dsh-arkme");
    await writeFile(rootLockPath, staleRootLock);
    await rm(installedDir, { recursive: true, force: true });

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      embeddedArtifact: {
        artifactPath,
        artifactSha512,
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.29"
      },
      packageManager
    });

    expect((await lstat(installedDir)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(path.join(installedDir, "package.json"), "utf8")))
      .toMatchObject({ version: "0.1.29" });
    expect(JSON.parse(await readFile(
      path.join(profileDir, "node_modules", "example-extension", "package.json"),
      "utf8"
    ))).toMatchObject({ version: "2.3.4" });
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      embeddedArtifact: {
        artifactPath,
        artifactSha512,
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.29"
      },
      packageManager
    });
    const backupRoot = path.join(profileDir, ".arkme-migration-backups");
    const backups = await readdir(backupRoot);
    expect(backups).toHaveLength(1);
    const backupDir = path.join(backupRoot, backups[0]!);
    await expect(readFile(path.join(backupDir, "pnpm-lock.yaml"), "utf8"))
      .resolves.toContain("version: link:");
    await expect(readFile(path.join(backupDir, "node_modules", ".pnpm", "lock.yaml"), "utf8"))
      .resolves.toContain("version: link:");
    await expect(readFile(path.join(backupDir, "node_modules", ".modules.yaml"), "utf8"))
      .resolves.toContain('"nodeLinker": "hoisted"');
    expect(JSON.parse(await readFile(path.join(backupDir, "migration.json"), "utf8")))
      .toMatchObject({
        schemaVersion: 1,
        reason: "legacy-managed-plugin-link",
        phase: "completed",
        detectedSources: ["root-lockfile-link", "virtual-store-lockfile-link"],
        plannedPaths: [
          "pnpm-lock.yaml",
          path.join("node_modules", ".pnpm", "lock.yaml"),
          path.join("node_modules", ".modules.yaml")
        ],
        movedPaths: [
          "pnpm-lock.yaml",
          path.join("node_modules", ".pnpm", "lock.yaml"),
          path.join("node_modules", ".modules.yaml")
        ],
        missingPaths: []
      });
  });

  test("resumes an interrupted legacy link metadata quarantine", async () => {
    const fixture = await createFixture("0.1.29");
    const artifactPath = await packPlugin(fixture.pluginDir, path.join(fixture.root, "artifacts"));
    const artifactSha512 = createHash("sha512").update(await readFile(artifactPath)).digest("hex");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const oldPluginDir = path.join(fixture.root, "old-app", "dsh-arkme");
    const packageManager = packageManagerFixture(fixture.root);
    await createPlugin(oldPluginDir, "0.1.21");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `link:${oldPluginDir}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);
    await writeFile(
      path.join(profileDir, "pnpm-workspace.yaml"),
      "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
    );
    await execFileAsync(
      packageManager.executable,
      [...(packageManager.prefixArgs ?? []), "install", ...(packageManager.installArgs ?? [])],
      { cwd: profileDir, env: packageManager.environment }
    );
    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies["@senguoyun/dsh-arkme"] = `file:${artifactPath}`;
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const rootLockPath = path.join(profileDir, "pnpm-lock.yaml");
    await writeFile(rootLockPath, (await readFile(rootLockPath, "utf8")).replace(
      `specifier: link:${oldPluginDir}`,
      `specifier: file:${artifactPath}`
    ));

    const backupDir = path.join(
      profileDir,
      ".arkme-migration-backups",
      "legacy-managed-link-interrupted"
    );
    const plannedPaths = [
      "pnpm-lock.yaml",
      path.join("node_modules", ".pnpm", "lock.yaml"),
      path.join("node_modules", ".modules.yaml")
    ];
    await mkdir(path.join(backupDir, "node_modules", ".pnpm"), { recursive: true });
    await writeFile(path.join(backupDir, "migration.json"), `${JSON.stringify({
      schemaVersion: 1,
      reason: "legacy-managed-plugin-link",
      phase: "pending",
      createdAtMillis: 1,
      detectedSources: ["root-lockfile-link", "virtual-store-lockfile-link"],
      plannedPaths,
      movedPaths: []
    }, null, 2)}\n`);
    await rename(rootLockPath, path.join(backupDir, "pnpm-lock.yaml"));
    await rename(
      path.join(profileDir, "node_modules", ".pnpm", "lock.yaml"),
      path.join(backupDir, "node_modules", ".pnpm", "lock.yaml")
    );

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      embeddedArtifact: {
        artifactPath,
        artifactSha512,
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.29"
      },
      packageManager
    });

    const receipt = JSON.parse(await readFile(path.join(backupDir, "migration.json"), "utf8")) as {
      phase: string;
      movedPaths: string[];
    };
    expect(receipt.phase).toBe("completed");
    expect(receipt.movedPaths).toEqual(plannedPaths);
    await expect(readFile(path.join(backupDir, "node_modules", ".modules.yaml"), "utf8"))
      .resolves.toContain('"nodeLinker": "hoisted"');
    expect(await readdir(path.join(profileDir, ".arkme-migration-backups")))
      .toEqual(["legacy-managed-link-interrupted"]);
    expect((await lstat(installedDir)).isSymbolicLink()).toBe(false);
  });

  test("forces the packaged artifact over a newer independently installed plugin", async () => {
    const fixture = await createFixture("0.1.17");
    const artifactPath = await packPlugin(fixture.pluginDir, path.join(fixture.root, "artifacts"));
    const artifactSha512 = createHash("sha512").update(await readFile(artifactPath)).digest("hex");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const independentArtifact = path.join(
      fixture.dshHome,
      "arkme-self",
      "prod",
      "plugin-cache",
      "0.1.18",
      "dsh-arkme-0.1.18.tgz"
    );
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, "newer plugin");
    await createPlugin(installedDir, "0.1.18");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    const result = await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      embeddedArtifact: {
        artifactPath,
        artifactSha512,
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.17"
      },
      forceEmbedded: true,
      packageManager: packageManagerFixture(fixture.root)
    });

    expect(result).toMatchObject({ source: "embedded", version: "0.1.17" });
    expect((await lstat(installedDir)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(path.join(installedDir, "package.json"), "utf8")))
      .toMatchObject({ version: "0.1.17" });
  });

  test("preserves a healthy receipt-based newer plugin during a normal artifact start", async () => {
    const fixture = await createFixture("0.1.17");
    const artifactPath = await packPlugin(fixture.pluginDir, path.join(fixture.root, "artifacts"));
    const artifactSha512 = createHash("sha512").update(await readFile(artifactPath)).digest("hex");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const independentArtifact = path.join(
      fixture.dshHome,
      "arkme-self",
      "prod",
      "plugin-cache",
      "0.1.18",
      "dsh-arkme-0.1.18.tgz"
    );
    const independentBytes = Buffer.from("verified newer plugin");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, independentBytes);
    await createPlugin(installedDir, "0.1.18");
    await writeFile(
      path.join(path.dirname(independentArtifact), "plugin-update-install-receipt.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packageName: "@senguoyun/dsh-arkme",
        targetVersion: "0.1.18",
        targetArtifactPath: independentArtifact,
        targetArtifactSha512: createHash("sha512").update(independentBytes).digest("hex"),
        appVersion: "0.1.5",
        dshVersion: "0.1.0-rc.8",
        installedAtMillis: 1
      }, null, 2)}\n`
    );
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);
    const staleLock = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@senguoyun/dsh-arkme':\n        specifier: file:${independentArtifact}\n        version: link:../../old-app/dsh-arkme\n`;
    await writeFile(path.join(profileDir, "pnpm-lock.yaml"), staleLock);
    await mkdir(path.join(profileDir, "node_modules", ".pnpm"), { recursive: true });
    await writeFile(path.join(profileDir, "node_modules", ".pnpm", "lock.yaml"), staleLock);
    await writeFile(path.join(profileDir, "node_modules", ".modules.yaml"), "legacy metadata\n");

    const result = await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      embeddedArtifact: {
        artifactPath,
        artifactSha512,
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.17"
      },
      forceEmbedded: false,
      appVersion: "0.1.5",
      dshVersion: "0.1.0-rc.8"
    });

    expect(result).toMatchObject({ source: "independent", version: "0.1.18" });
    expect(JSON.parse(await readFile(path.join(installedDir, "package.json"), "utf8")))
      .toMatchObject({ version: "0.1.18" });
    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@senguoyun/dsh-arkme"]).toBe(`file:${independentArtifact}`);
    await expect(lstat(path.join(profileDir, ".arkme-migration-backups")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(profileDir, "pnpm-lock.yaml"), "utf8"))
      .resolves.toBe(staleLock);
  });

  test("is idempotent and preserves existing profile settings", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "package.json"),
      `${JSON.stringify({
        name: "custom-web-profile",
        private: true,
        packageManager: "pnpm@10.0.0",
        dependencies: { "example-plugin": "2.0.0" },
        dsh: {
          customSetting: true,
          profile: {
            customProfileSetting: "keep-me",
            bundles: [
              "@deepseek-ai/dsh-base",
              "@deepseek-ai/dsh-web-app",
              "example-plugin"
            ]
          }
        },
        customRootSetting: "keep-me-too"
      }, null, 2)}\n`
    );
    await writeFile(path.join(profileDir, "cordis.patch.yml"), "- id: user-setting\n");
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      environment: "prod"
    });
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      environment: "prod"
    });

    const manifest = JSON.parse(
      await readFile(path.join(profileDir, "package.json"), "utf8")
    ) as {
      dependencies: Record<string, string>;
      dsh: {
        customSetting: boolean;
        profile: { customProfileSetting: string; bundles: string[] };
      };
      customRootSetting: string;
    };
    expect(manifest.dependencies).toEqual({
      "example-plugin": "2.0.0",
      "@senguoyun/dsh-arkme": `link:${fixture.pluginDir}`
    });
    expect((manifest as { packageManager?: string }).packageManager).toBe("pnpm@11.19.0");
    expect(manifest.dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "example-plugin",
      "@senguoyun/dsh-arkme"
    ]);
    expect(manifest.dsh.customSetting).toBe(true);
    expect(manifest.dsh.profile.customProfileSetting).toBe("keep-me");
    expect(manifest.customRootSetting).toBe("keep-me-too");
    expect(await readFile(path.join(profileDir, "cordis.patch.yml"), "utf8")).toBe(
      "- id: user-setting\n"
    );
  });

  test("repairs a stale managed plugin symlink after an app update", async () => {
    const fixture = await createFixture();
    const oldPluginDir = path.join(fixture.root, "old-plugin");
    const linkPath = path.join(
      fixture.dshHome,
      "profiles",
      "web",
      "node_modules",
      "@senguoyun",
      "dsh-arkme"
    );
    await mkdir(path.dirname(linkPath), { recursive: true });
    await mkdir(oldPluginDir);
    await symlink(oldPluginDir, linkPath, "junction");
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    });

    expect(await realpath(linkPath)).toBe(await realpath(fixture.pluginDir));
  });

  test("forces the release-set plugin when the Electron runtime manager owns updates", async () => {
    const fixture = await createFixture("0.1.18");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const independentPlugin = path.join(fixture.root, "independent-plugin");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await createPlugin(independentPlugin, "9.9.9");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "custom-profile",
      private: true,
      dependencies: {
        "example-plugin": "2.0.0",
        "@senguoyun/dsh-arkme": `file:${independentPlugin}`
      },
      customRootSetting: "keep-me",
      dsh: { profile: { bundles: ["example-plugin", "@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);
    await createPlugin(installedDir, "9.9.9");

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      environment: "prod",
      pluginDir: fixture.pluginDir,
      runtimeManaged: true,
      runtimeReleaseId: "electron-runtime-v1-22222222222222222222222222222222"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      customRootSetting: string;
      arkme: { desktopManaged: boolean; managedPlugin: { source: string; version: string } };
    };
    expect(manifest.dependencies).toMatchObject({
      "example-plugin": "2.0.0",
      "@senguoyun/dsh-arkme": `link:${fixture.pluginDir}`
    });
    expect(manifest.customRootSetting).toBe("keep-me");
    expect(manifest.arkme).toMatchObject({
      desktopManaged: true,
      managedPlugin: { source: "release-set", version: "0.1.18" }
    });
    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
  });

  test("switches a runtime-managed profile offline and can restore the exact previous profile", async () => {
    const fixture = await createFixture("0.1.20");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const previousPlugin = path.join(fixture.root, "previous-release-plugin");
    await createPlugin(previousPlugin, "0.1.19");
    await mkdir(path.dirname(installedDir), { recursive: true });
    await symlink(previousPlugin, installedDir, "junction");
    const previousManifest = `${JSON.stringify({
      name: "custom-profile",
      private: true,
      dependencies: {
        "keep-me": "1.0.0",
        "@senguoyun/dsh-arkme": `link:${previousPlugin}`
      },
      dsh: { profile: { bundles: ["keep-me", "@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`;
    await writeFile(path.join(profileDir, "package.json"), previousManifest);

    const provisioned = await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      environment: "test",
      pluginDir: fixture.pluginDir,
      runtimeManaged: true,
      runtimeReleaseId: "electron-runtime-v1-11111111111111111111111111111111",
      packageManager: { executable: path.join(fixture.root, "must-not-run-pnpm") }
    });

    expect(provisioned.runtimeTransaction).toBeDefined();
    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    expect(await readFile(path.join(profileDir, "package.json"), "utf8")).toContain(
      `link:${fixture.pluginDir}`
    );

    await rollbackRuntimeManagedProfileTransaction(provisioned.runtimeTransaction!);

    expect(await realpath(installedDir)).toBe(await realpath(previousPlugin));
    expect(await readFile(path.join(profileDir, "package.json"), "utf8")).toBe(previousManifest);
  });

  test("commits a runtime-managed Profile switch before removing rollback metadata", async () => {
    const fixture = await createFixture("0.1.20");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const provisioned = await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      environment: "test",
      pluginDir: fixture.pluginDir,
      runtimeManaged: true,
      runtimeReleaseId: "electron-runtime-v1-22222222222222222222222222222222"
    });

    await commitRuntimeManagedProfileTransaction(provisioned.runtimeTransaction!);

    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    await expect(readFile(
      path.join(profileDir, ".arkme-runtime-profile-transaction.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recoverRuntimeManagedProfileTransaction(fixture.dshHome, "test"))
      .resolves.toBe(false);
  });

  test("recovers a transaction interrupted before the existing Profile link was moved", async () => {
    const fixture = await createFixture("0.1.20");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const entryDirectory = path.join(profileDir, "node_modules", "@senguoyun");
    const installedDir = path.join(entryDirectory, "dsh-arkme");
    const previousPlugin = path.join(fixture.root, "previous-release-plugin");
    await createPlugin(previousPlugin, "0.1.19");
    await mkdir(entryDirectory, { recursive: true });
    await symlink(previousPlugin, installedDir, "junction");
    const previousManifest = `${JSON.stringify({ name: "dsh-profile-web", private: true }, null, 2)}\n`;
    await writeFile(path.join(profileDir, "package.json"), previousManifest);
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const journalPath = path.join(profileDir, ".arkme-runtime-profile-transaction.json");
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      environment: "test",
      releaseId: "electron-runtime-v1-33333333333333333333333333333333",
      phase: "prepared",
      candidatePluginDir: fixture.pluginDir,
      previousManifest,
      backupEntryName: `.dsh-arkme.runtime-previous-${transactionId}`,
      temporaryEntryName: `.dsh-arkme.runtime-candidate-${transactionId}`,
      createdAtMillis: Date.now()
    }));

    await expect(recoverRuntimeManagedProfileTransaction(fixture.dshHome, "test"))
      .resolves.toBe(true);

    expect(await realpath(installedDir)).toBe(await realpath(previousPlugin));
    expect(await readFile(path.join(profileDir, "package.json"), "utf8")).toBe(previousManifest);
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("finishes a committed Profile switch after a crash during backup cleanup", async () => {
    const fixture = await createFixture("0.1.20");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const entryDirectory = path.join(profileDir, "node_modules", "@senguoyun");
    const installedDir = path.join(entryDirectory, "dsh-arkme");
    await mkdir(entryDirectory, { recursive: true });
    await symlink(fixture.pluginDir, installedDir, "junction");
    const previousManifest = `${JSON.stringify({ name: "previous-profile", private: true }, null, 2)}\n`;
    const committedManifest = `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: { "@senguoyun/dsh-arkme": `link:${fixture.pluginDir}` }
    }, null, 2)}\n`;
    await writeFile(path.join(profileDir, "package.json"), committedManifest);
    const transactionId = "33333333-3333-4333-8333-333333333333";
    const journalPath = path.join(profileDir, ".arkme-runtime-profile-transaction.json");
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      environment: "test",
      releaseId: "electron-runtime-v1-66666666666666666666666666666666",
      phase: "committing",
      candidatePluginDir: fixture.pluginDir,
      previousManifest,
      backupEntryName: `.dsh-arkme.runtime-previous-${transactionId}`,
      temporaryEntryName: `.dsh-arkme.runtime-candidate-${transactionId}`,
      createdAtMillis: Date.now()
    }));

    await expect(recoverRuntimeManagedProfileTransaction(fixture.dshHome, "test"))
      .resolves.toBe(true);

    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    expect(await readFile(path.join(profileDir, "package.json"), "utf8")).toBe(committedManifest);
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to recover a Profile transaction written by another environment", async () => {
    const fixture = await createFixture("0.1.20");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    await mkdir(profileDir, { recursive: true });
    const transactionId = "22222222-2222-4222-8222-222222222222";
    const journalPath = path.join(profileDir, ".arkme-runtime-profile-transaction.json");
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      environment: "test",
      releaseId: "electron-runtime-v1-55555555555555555555555555555555",
      phase: "prepared",
      candidatePluginDir: fixture.pluginDir,
      previousManifest: null,
      backupEntryName: `.dsh-arkme.runtime-previous-${transactionId}`,
      temporaryEntryName: `.dsh-arkme.runtime-candidate-${transactionId}`,
      createdAtMillis: Date.now()
    }));

    await expect(recoverRuntimeManagedProfileTransaction(fixture.dshHome, "prod"))
      .rejects.toThrow(/environment mismatch/i);
    await expect(readFile(journalPath, "utf8")).resolves.toContain('"environment":"test"');
  });

  test("publishes the new app path before package-manager synchronization", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const linkPath = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const missingOldPlugin = path.join(fixture.root, "removed-old-app", "dsh-arkme");
    const observationPath = path.join(fixture.root, "observed-dependency.txt");
    const packageManagerProbe = path.join(fixture.root, "package-manager-probe.mjs");
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(missingOldPlugin, linkPath, "junction");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: { "@senguoyun/dsh-arkme": `link:${missingOldPlugin}` },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);
    await writeFile(packageManagerProbe, [
      'import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      'const manifest = JSON.parse(await readFile("package.json", "utf8"));',
      'const spec = manifest.dependencies["@senguoyun/dsh-arkme"];',
      'const linkPath = path.join(process.cwd(), "node_modules", "@senguoyun", "dsh-arkme");',
      'await mkdir(path.dirname(linkPath), { recursive: true });',
      'await rm(linkPath, { recursive: true, force: true });',
      'await symlink(spec.slice("link:".length), linkPath, "junction");',
      `await writeFile(${JSON.stringify(observationPath)}, JSON.stringify({ spec, nodeMode: process.env.ELECTRON_RUN_AS_NODE }));`
    ].join("\n"));

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      packageManager: { executable: process.execPath, prefixArgs: [packageManagerProbe] }
    });

    await expect(readFile(observationPath, "utf8")).resolves.toBe(JSON.stringify({
      spec: `link:${fixture.pluginDir}`,
      nodeMode: "1"
    }));
    expect(await realpath(linkPath)).toBe(await realpath(fixture.pluginDir));
  });

  test("rebases an aligned local plugin link after its DSH home moves into an account container", async () => {
    const fixture = await createFixture();
    const legacyDshHome = path.join(fixture.root, "legacy", "dsh");
    const legacyProfileDir = path.join(legacyDshHome, "profiles", "web");
    const legacyLinkPath = path.join(
      legacyProfileDir,
      "node_modules",
      "@senguoyun",
      "dsh-arkme"
    );
    const expectedSpecifier = `link:${fixture.pluginDir}`;
    await mkdir(path.dirname(legacyLinkPath), { recursive: true });
    await symlink(
      path.relative(path.dirname(legacyLinkPath), fixture.pluginDir),
      legacyLinkPath,
      "junction"
    );
    await writeFile(path.join(legacyProfileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": expectedSpecifier },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);
    await writeFile(path.join(legacyProfileDir, "pnpm-lock.yaml"), `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@senguoyun/dsh-arkme':
        specifier: ${expectedSpecifier}
        version: link:../../embedded-plugin
`);

    const movedDshHome = path.join(fixture.root, "dsh-containers", "scope-account", "dsh");
    await mkdir(path.dirname(movedDshHome), { recursive: true });
    await rename(legacyDshHome, movedDshHome);
    const movedLinkPath = path.join(
      movedDshHome,
      "profiles",
      "web",
      "node_modules",
      "@senguoyun",
      "dsh-arkme"
    );
    expect(await realpath(movedLinkPath).catch(() => null)).toBeNull();

    const packageManagerCalled = path.join(fixture.root, "package-manager-called");
    const packageManagerProbe = path.join(fixture.root, "package-manager-probe.mjs");
    await writeFile(packageManagerProbe, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(packageManagerCalled)}, "called");\n`);

    await provisionArkmeWebProfile({
      dshHome: movedDshHome,
      pluginDir: fixture.pluginDir,
      packageManager: { executable: process.execPath, prefixArgs: [packageManagerProbe] }
    });

    expect(await realpath(movedLinkPath)).toBe(await realpath(fixture.pluginDir));
    await expect(readFile(packageManagerCalled, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a package-manager no-op instead of masking a stale managed link", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const linkPath = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const missingOldPlugin = path.join(fixture.root, "removed-old-app", "dsh-arkme");
    const noOpPackageManager = path.join(fixture.root, "package-manager-no-op.mjs");
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(missingOldPlugin, linkPath, "junction");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: { "@senguoyun/dsh-arkme": `link:${missingOldPlugin}` },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);
    await writeFile(noOpPackageManager, "// Intentionally succeeds without materializing dependencies.\n");

    await expect(provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      packageManager: { executable: process.execPath, prefixArgs: [noOpPackageManager] }
    })).rejects.toThrow("did not materialize the embedded Arkme plugin");

    expect(await realpath(linkPath).catch(() => null)).toBeNull();
  });

  test("does not downgrade a newer healthy independently installed plugin to the embedded plugin", async () => {
    const fixture = await createFixture("0.1.4");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const independentArtifact = path.join(fixture.root, "plugin-cache", "0.1.5", "dsh-arkme-0.1.5.tgz");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, "independent tgz");
    await writeReleaseManifest(path.dirname(independentArtifact), {
      appVersionRange: ">=0.1.0",
      dshVersionRange: ">=0.1.0-rc.8"
    });
    await createPlugin(installedDir, "0.1.5");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      arkme?: { managedPlugin?: { source?: string; version?: string; sha512?: string; lastHealthCheck?: { healthy?: boolean } } };
    };
    expect(manifest.dependencies["@senguoyun/dsh-arkme"]).toBe(`file:${independentArtifact}`);
    expect((await lstat(installedDir)).isDirectory()).toBe(true);
    expect(manifest.arkme?.managedPlugin).toMatchObject({
      source: "independent",
      version: "0.1.5",
      lastHealthCheck: { healthy: true }
    });
    expect(manifest.arkme?.managedPlugin?.sha512).toMatch(/^[a-f0-9]{128}$/);
  });

  test("keeps a successfully updated plugin across a cold start on the same App and DSH versions", async () => {
    const fixture = await createFixture("0.1.4");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const stateDirectory = path.join(fixture.dshHome, "arkme-self", "prod");
    const independentArtifact = path.join(
      stateDirectory,
      "plugin-cache",
      "0.1.5",
      "dsh-arkme-0.1.5.tgz"
    );
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const artifactBytes = Buffer.from("verified independent tgz");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, artifactBytes);
    await createPlugin(installedDir, "0.1.5");
    await writeFile(path.join(path.dirname(independentArtifact), "plugin-update-install-receipt.json"), `${JSON.stringify({
      schemaVersion: 1,
      packageName: "@senguoyun/dsh-arkme",
      targetVersion: "0.1.5",
      targetArtifactPath: independentArtifact,
      targetArtifactSha512: createHash("sha512").update(artifactBytes).digest("hex"),
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8",
      installedAtMillis: 1
    }, null, 2)}\n`);
    await writeReleaseManifest(path.dirname(independentArtifact), {
      appVersionRange: ">=0.1.0",
      dshVersionRange: ">=0.1.0-rc.8"
    }, "0.1.5");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      arkme?: { managedPlugin?: { source?: string; version?: string } };
    };
    expect(manifest.dependencies["@senguoyun/dsh-arkme"]).toBe(`file:${independentArtifact}`);
    expect((await lstat(installedDir)).isDirectory()).toBe(true);
    expect(manifest.arkme?.managedPlugin).toMatchObject({ source: "independent", version: "0.1.5" });
  });

  test("falls back to the embedded plugin when the local install receipt belongs to another App version", async () => {
    const fixture = await createFixture("0.1.4");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const stateDirectory = path.join(fixture.dshHome, "arkme-self", "prod");
    const independentArtifact = path.join(
      stateDirectory,
      "plugin-cache",
      "0.1.5",
      "dsh-arkme-0.1.5.tgz"
    );
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    const artifactBytes = Buffer.from("verified independent tgz");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, artifactBytes);
    await createPlugin(installedDir, "0.1.5");
    await writeFile(path.join(path.dirname(independentArtifact), "plugin-update-install-receipt.json"), `${JSON.stringify({
      schemaVersion: 1,
      packageName: "@senguoyun/dsh-arkme",
      targetVersion: "0.1.5",
      targetArtifactPath: independentArtifact,
      targetArtifactSha512: createHash("sha512").update(artifactBytes).digest("hex"),
      appVersion: "0.2.0",
      dshVersion: "0.1.0-rc.8",
      installedAtMillis: 1
    }, null, 2)}\n`);
    await writeReleaseManifest(path.dirname(independentArtifact), {
      appVersionRange: ">=0.1.0",
      dshVersionRange: ">=0.1.0-rc.8"
    }, "0.1.5");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      arkme?: { managedPlugin?: { lastHealthCheck?: { reason?: string } } };
    };
    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    expect(manifest.arkme?.managedPlugin?.lastHealthCheck?.reason).toBe(
      "local install receipt does not match current app or DSH"
    );
  });

  test.each([
    {
      caseName: "has no receipt",
      artifactName: "dsh-arkme-0.1.5.tgz",
      reason: "local install receipt missing"
    },
    {
      caseName: "has an unexpected artifact filename",
      artifactName: "unexpected.tgz",
      reason: "independent plugin is outside managed plugin cache"
    }
  ])("does not use a legacy manifest when a managed cache artifact $caseName", async ({ artifactName, reason }) => {
    const fixture = await createFixture("0.1.4");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const independentArtifact = path.join(
      fixture.dshHome,
      "arkme-self",
      "prod",
      "plugin-cache",
      "0.1.5",
      artifactName
    );
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, "independent tgz");
    await writeReleaseManifest(path.dirname(independentArtifact), {
      appVersionRange: ">=0.1.0",
      dshVersionRange: ">=0.1.0-rc.8"
    }, "0.1.5");
    await createPlugin(installedDir, "0.1.5");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      arkme?: { managedPlugin?: { lastHealthCheck?: { reason?: string } } };
    };
    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    expect(manifest.arkme?.managedPlugin?.lastHealthCheck?.reason).toBe(reason);
  });

  test("falls back to the embedded plugin when the local install receipt artifact digest is stale", async () => {
    const fixture = await createFixture("0.1.4");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const stateDirectory = path.join(fixture.dshHome, "arkme-self", "prod");
    const independentArtifact = path.join(
      stateDirectory,
      "plugin-cache",
      "0.1.5",
      "dsh-arkme-0.1.5.tgz"
    );
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, "changed tgz");
    await createPlugin(installedDir, "0.1.5");
    await writeFile(path.join(path.dirname(independentArtifact), "plugin-update-install-receipt.json"), `${JSON.stringify({
      schemaVersion: 1,
      packageName: "@senguoyun/dsh-arkme",
      targetVersion: "0.1.5",
      targetArtifactPath: independentArtifact,
      targetArtifactSha512: "a".repeat(128),
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8",
      installedAtMillis: 1
    }, null, 2)}\n`);
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      arkme?: { managedPlugin?: { lastHealthCheck?: { reason?: string } } };
    };
    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    expect(manifest.arkme?.managedPlugin?.lastHealthCheck?.reason).toBe(
      "local install receipt artifact digest mismatch"
    );
  });

  test("uses SemVer ordering for prerelease independent plugin versions", async () => {
    const fixture = await createFixture("1.0.0-beta.2");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const independentArtifact = path.join(fixture.root, "plugin-cache", "1.0.0-beta.10", "dsh-arkme-1.0.0-beta.10.tgz");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, "independent tgz");
    await writeReleaseManifest(path.dirname(independentArtifact), {
      appVersionRange: ">=0.1.0",
      dshVersionRange: ">=0.1.0-rc.8"
    }, "1.0.0-beta.10");
    await createPlugin(installedDir, "1.0.0-beta.10");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      arkme?: { managedPlugin?: { source?: string; version?: string } };
    };
    expect(manifest.dependencies["@senguoyun/dsh-arkme"]).toBe(`file:${independentArtifact}`);
    expect(manifest.arkme?.managedPlugin).toMatchObject({
      source: "independent",
      version: "1.0.0-beta.10"
    });
  });

  test("falls back to the embedded plugin when a newer independent plugin is incompatible", async () => {
    const fixture = await createFixture("0.1.4");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const independentArtifact = path.join(fixture.root, "plugin-cache", "0.1.5", "dsh-arkme-0.1.5.tgz");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await mkdir(path.dirname(independentArtifact), { recursive: true });
    await writeFile(independentArtifact, "independent tgz");
    await writeReleaseManifest(path.dirname(independentArtifact), {
      appVersionRange: ">=9.0.0",
      dshVersionRange: ">=0.1.0-rc.8"
    });
    await createPlugin(installedDir, "0.1.5");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${independentArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      appVersion: "0.1.0",
      dshVersion: "0.1.0-rc.8"
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      arkme?: { managedPlugin?: { source?: string; version?: string; lastHealthCheck?: { healthy?: boolean; reason?: string } } };
    };
    expect(manifest.dependencies["@senguoyun/dsh-arkme"]).toBe(`link:${fixture.pluginDir}`);
    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    expect(manifest.arkme?.managedPlugin).toMatchObject({
      source: "embedded",
      version: "0.1.4",
      lastHealthCheck: { healthy: true, reason: "independent plugin incompatible with current app or DSH" }
    });
  });

  test("switches from an older independent plugin to the newer embedded plugin during migration", async () => {
    const fixture = await createFixture("0.1.4");
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const oldArtifact = path.join(fixture.root, "plugin-cache", "0.1.3", "dsh-arkme-0.1.3.tgz");
    const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await mkdir(path.dirname(oldArtifact), { recursive: true });
    await writeFile(oldArtifact, "old tgz");
    await createPlugin(installedDir, "0.1.3");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `file:${oldArtifact}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    });

    const manifest = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      arkme?: { managedPlugin?: { source?: string; version?: string; lastHealthCheck?: { healthy?: boolean; reason?: string } } };
    };
    expect(manifest.dependencies["@senguoyun/dsh-arkme"]).toBe(`link:${fixture.pluginDir}`);
    expect(await realpath(installedDir)).toBe(await realpath(fixture.pluginDir));
    expect(manifest.arkme?.managedPlugin).toMatchObject({
      source: "embedded",
      version: "0.1.4",
      lastHealthCheck: { healthy: true }
    });
  });

  test("keeps the embedded plugin link on the current app after a later pnpm add", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const oldPluginDir = path.join(fixture.root, "old-embedded-plugin");
    const extensionDir = path.join(fixture.root, "local-extension");
    const storeDir = path.join(fixture.root, "pnpm-store");
    const linkPath = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
    await createPlugin(oldPluginDir);
    await mkdir(extensionDir);
    await writeFile(path.join(extensionDir, "package.json"), `${JSON.stringify({
      name: "@arkme-local/ext-regression",
      version: "1.0.0",
      private: true
    }, null, 2)}\n`);
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(oldPluginDir, linkPath, "junction");
    await writeFile(path.join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      packageManager: "pnpm@11.19.0",
      dependencies: { "@senguoyun/dsh-arkme": `link:${oldPluginDir}` },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`);
    await writeFile(path.join(profileDir, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      '@senguoyun/dsh-arkme':\n        specifier: link:${oldPluginDir}\n        version: link:${oldPluginDir}\n`);
    await writeFile(path.join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");

    const pnpmCli = path.join(
      path.resolve(import.meta.dirname, ".."),
      "node_modules",
      ".pnpm",
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.cjs"
    );
    const packageManager = {
      executable: process.execPath,
      prefixArgs: [pnpmCli],
      installArgs: ["--store-dir", storeDir],
      environment: { ...process.env, CI: "false" }
    };
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      packageManager
    });
    await execFileAsync(
      packageManager.executable,
      [
        ...packageManager.prefixArgs,
        "add",
        `link:${extensionDir}`,
        ...packageManager.installArgs
      ],
      { cwd: profileDir, env: packageManager.environment }
    );

    expect(await realpath(linkPath)).toBe(await realpath(fixture.pluginDir));
    expect(await readFile(path.join(profileDir, "pnpm-lock.yaml"), "utf8")).toContain(
      `specifier: link:${fixture.pluginDir}`
    );
  });

  test("does not run pnpm when the managed profile link state is already aligned", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    });
    await writeFile(path.join(profileDir, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      '@senguoyun/dsh-arkme':\n        specifier: link:${fixture.pluginDir}\n        version: link:${fixture.pluginDir}\n`);

    await expect(provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      packageManager: { executable: path.join(fixture.root, "must-not-run-pnpm") }
    })).resolves.toMatchObject({ source: "embedded", version: "0.1.4" });
  });

  test("does not accept an aligned dependency from a different lockfile importer", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    });
    await writeFile(path.join(profileDir, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      unrelated:\n        specifier: 1.0.0\n        version: 1.0.0\n\n  packages/example:\n    dependencies:\n      '@senguoyun/dsh-arkme':\n        specifier: link:${fixture.pluginDir}\n        version: link:${fixture.pluginDir}\n`);

    await expect(provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      packageManager: { executable: path.join(fixture.root, "must-run-pnpm") }
    })).rejects.toThrow(`Failed to synchronize DSH profile dependencies at ${profileDir}`);
  });

  test("reports the profile directory when pnpm synchronization fails", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");

    await expect(provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir,
      packageManager: { executable: path.join(fixture.root, "missing-pnpm") }
    })).rejects.toThrow(`Failed to synchronize DSH profile dependencies at ${profileDir}`);
  });

  test("backs up a profile-local real plugin directory and repairs it", async () => {
    const fixture = await createFixture();
    const profileDir = path.join(fixture.dshHome, "profiles", "web");
    const linkPath = path.join(
      profileDir,
      "node_modules",
      "@senguoyun",
      "dsh-arkme"
    );
    await mkdir(linkPath, { recursive: true });
    const existingManifest = `${JSON.stringify({
      name: "user-managed-profile",
      private: true,
      dependencies: { "@senguoyun/dsh-arkme": "9.9.9" },
      dsh: { profile: { bundles: ["@senguoyun/dsh-arkme"] } }
    }, null, 2)}\n`;
    await writeFile(path.join(profileDir, "package.json"), existingManifest);

    await provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    });
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    const backups = (await import("node:fs/promises")).readdir(
      path.dirname(linkPath)
    );
    const backupNames = (await backups).filter((name) => name.startsWith("dsh-arkme.backup-"));
    expect(backupNames).toHaveLength(1);
    expect(await readFile(path.join(profileDir, "package.json"), "utf8")).not.toBe(
      existingManifest
    );
    const repairedManifest = JSON.parse(
      await readFile(path.join(profileDir, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(repairedManifest.dependencies["@senguoyun/dsh-arkme"])
      .toBe(`link:${fixture.pluginDir}`);
  });

  test.each([
    ["an empty version", async (fixture: Fixture) => {
      await writePluginManifest(fixture.pluginDir, {
        name: "@senguoyun/dsh-arkme",
        version: "",
        dsh: { bundle: { patch: "./cordis.patch.yml" } }
      });
    }],
    ["the wrong package name", async (fixture: Fixture) => {
      await writePluginManifest(fixture.pluginDir, {
        name: "@senguoyun/not-arkme",
        version: "9.8.7-local",
        dsh: { bundle: { patch: "./cordis.patch.yml" } }
      });
    }],
    ["the wrong patch path", async (fixture: Fixture) => {
      await writePluginManifest(fixture.pluginDir, {
        name: "@senguoyun/dsh-arkme",
        version: "9.8.7-local",
        dsh: { bundle: { patch: "./wrong.patch.yml" } }
      });
    }],
    ["a missing cordis patch", async (fixture: Fixture) => {
      await rm(path.join(fixture.pluginDir, "cordis.patch.yml"));
    }],
    ["a missing plugin entry point", async (fixture: Fixture) => {
      await rm(path.join(fixture.pluginDir, "lib", "index.js"));
    }],
    ["a missing plugin client", async (fixture: Fixture) => {
      await rm(path.join(fixture.pluginDir, "lib", "client.js"));
    }]
  ])("rejects a plugin with %s", async (_description, prepareFixture) => {
    const fixture = await createFixture();
    await prepareFixture(fixture);

    await expect(provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    })).rejects.toThrow();
  });

  test.each([
    "cordis.patch.yml",
    "lib/index.js",
    "lib/client.js"
  ])("rejects a plugin whose %s is a directory", async (relativePath) => {
    const fixture = await createFixture();
    await replaceFileWithDirectory(path.join(fixture.pluginDir, relativePath));

    await expect(provisionArkmeWebProfile({
      dshHome: fixture.dshHome,
      pluginDir: fixture.pluginDir
    })).rejects.toThrow(`required path is not a regular file: ${relativePath}`);
  });
});

interface Fixture {
  root: string;
  dshHome: string;
  pluginDir: string;
}

async function createFixture(version = "0.1.4"): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkme-profile-test-"));
  temporaryDirectories.push(root);
  const pluginDir = path.join(root, "embedded-plugin");
  await createPlugin(pluginDir, version);
  return {
    root,
    dshHome: path.join(root, "dsh-home"),
    pluginDir
  };
}

async function writePluginManifest(pluginDir: string, manifest: object): Promise<void> {
  await writeFile(path.join(pluginDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function replaceFileWithDirectory(filePath: string): Promise<void> {
  await rm(filePath);
  await mkdir(filePath);
}

async function createPlugin(pluginDir: string, version = "0.1.4"): Promise<void> {
  await mkdir(path.join(pluginDir, "lib"), { recursive: true });
  await writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: "@senguoyun/dsh-arkme",
      version,
      dsh: { bundle: { patch: "./cordis.patch.yml" } }
    }, null, 2)}\n`
  );
  await writeFile(path.join(pluginDir, "cordis.patch.yml"), "[]\n");
  await writeFile(path.join(pluginDir, "lib", "index.js"), "export function apply() {}\n");
  await writeFile(path.join(pluginDir, "lib", "client.js"), "export default {}\n");
}

async function packPlugin(pluginDir: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  const packageManager = packageManagerFixture(path.dirname(destination));
  await execFileAsync(
    packageManager.executable,
    [
      ...(packageManager.prefixArgs ?? []),
      "pack",
      "--pack-destination",
      destination
    ],
    { cwd: pluginDir, env: packageManager.environment }
  );
  const artifacts = (await readdir(destination)).filter(name => name.endsWith(".tgz"));
  expect(artifacts).toHaveLength(1);
  const artifact = artifacts[0];
  if (artifact === undefined) throw new Error("pnpm pack did not produce an artifact");
  return path.join(destination, artifact);
}

function packageManagerFixture(root: string) {
  return {
    executable: process.execPath,
    prefixArgs: [path.join(
      path.resolve(import.meta.dirname, ".."),
      "node_modules",
      ".pnpm",
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.cjs"
    )],
    installArgs: ["--store-dir", path.join(root, "pnpm-store")],
    environment: process.env
  };
}

async function writeReleaseManifest(
  directory: string,
  ranges: { appVersionRange: string; dshVersionRange: string },
  version = "0.1.5"
): Promise<void> {
  await writeFile(
    path.join(directory, "release-manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      packageName: "@senguoyun/dsh-arkme",
      version,
      artifactUrl: `https://arkme-releases.jotmo.cc/arkme-releases/plugin/${version}/dsh-arkme-${version}.tgz`,
      artifactSize: 15,
      sha512: "a".repeat(128),
      manifestSignature: "signature",
      ...ranges,
      notice: { level: "normal", title: "Update", summary: "Fixes" }
    }, null, 2)}\n`
  );
}
