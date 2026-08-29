import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  completePluginInstallBootstrap,
  preparePluginInstallBootstrap,
  profilePluginDirectory
} from "../src/plugin-install-bootstrap.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("plugin install bootstrap", () => {
  test("does not delete the current Profile or plugin update state when the receipt needs refresh", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.root, "installed-app-plugin");
    const sentinel = path.join(target, "sentinel.txt");
    const pluginPath = profilePluginDirectory(fixture.dshHome, "web");
    const stateDirectory = path.join(fixture.dshHome, "arkme-self", "prod");
    const database = path.join(stateDirectory, "arkme.db");
    const otherExtension = path.join(
      fixture.dshHome,
      "profiles",
      "web",
      "node_modules",
      "@example",
      "other-extension",
      "package.json"
    );
    await mkdir(target, { recursive: true });
    await writeFile(sentinel, "keep installation target");
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await symlink(target, pluginPath, "junction");
    await mkdir(path.join(stateDirectory, "plugin-cache", "0.1.22"), { recursive: true });
    await writeFile(path.join(stateDirectory, "plugin-cache", "0.1.22", "plugin.tgz"), "old");
    await writeFile(path.join(stateDirectory, "plugin-update-state.json"), "{}");
    await writeFile(path.join(stateDirectory, "plugin-update-install-state.json"), "{}");
    await writeFile(path.join(stateDirectory, "plugin-update-plan-old.json"), "{}");
    await writeFile(database, "keep database");
    await mkdir(path.dirname(otherExtension), { recursive: true });
    await writeFile(otherExtension, JSON.stringify({ name: "other-extension" }));

    const result = await preparePluginInstallBootstrap({
      resourcesPath: fixture.resourcesPath,
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web"
    });

    expect(result.resetRequired).toBe(true);
    expect((await lstat(pluginPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("keep installation target");
    expect(await readFile(path.join(stateDirectory, "plugin-cache", "0.1.22", "plugin.tgz"), "utf8"))
      .toBe("old");
    expect(await readFile(path.join(stateDirectory, "plugin-update-state.json"), "utf8"))
      .toBe("{}");
    expect(await readFile(path.join(stateDirectory, "plugin-update-install-state.json"), "utf8"))
      .toBe("{}");
    expect(await readFile(path.join(stateDirectory, "plugin-update-plan-old.json"), "utf8"))
      .toBe("{}");
    expect(await readFile(database, "utf8")).toBe("keep database");
    expect(await readFile(otherExtension, "utf8")).toContain("other-extension");
    expect(await readFile(result.artifact.artifactPath)).toEqual(fixture.artifactBytes);
  });

  test("rejects a corrupt seed before changing the existing Profile", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.root, "installed-app-plugin");
    const sentinel = path.join(target, "sentinel.txt");
    const pluginPath = profilePluginDirectory(fixture.dshHome, "web");
    await mkdir(target, { recursive: true });
    await writeFile(sentinel, "unchanged");
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await symlink(target, pluginPath, "junction");
    await writeFile(
      path.join(fixture.resourcesPath, "arkme-plugin-seed", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.17",
        artifactFileName: "dsh-arkme.tgz",
        artifactSha512: "0".repeat(128)
      })
    );

    await expect(preparePluginInstallBootstrap({
      resourcesPath: fixture.resourcesPath,
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web"
    })).rejects.toThrow("seed digest mismatch");

    expect((await lstat(pluginPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    await expect(access(path.join(
      fixture.dshHome,
      "arkme-self",
      "plugin-seed",
      "0.1.17",
      "dsh-arkme.tgz"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps the current plugin when the installer bootstrap receipt matches", async () => {
    const fixture = await createFixture();
    const pluginPath = profilePluginDirectory(fixture.dshHome, "web");
    const stateDirectory = path.join(fixture.dshHome, "arkme-self", "prod");
    const cachedArtifact = path.join(stateDirectory, "plugin-cache", "0.1.22", "plugin.tgz");
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "keep.txt"), "current online update");
    await mkdir(path.dirname(cachedArtifact), { recursive: true });
    await writeFile(cachedArtifact, "keep cache until another installer runs");
    await mkdir(path.join(fixture.dshHome, "arkme-self"), { recursive: true });
    await writeFile(
      path.join(fixture.dshHome, "arkme-self", "desktop-plugin-bootstrap.json"),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: "0.1.5",
        packageName: "@senguoyun/dsh-arkme",
        version: "0.1.17",
        artifactSha512: createHash("sha512").update(fixture.artifactBytes).digest("hex"),
        completedAtMillis: 1
      })
    );

    const result = await preparePluginInstallBootstrap({
      resourcesPath: fixture.resourcesPath,
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web"
    });

    expect(result.resetRequired).toBe(false);
    expect(await readFile(path.join(pluginPath, "keep.txt"), "utf8"))
      .toBe("current online update");
    expect(await readFile(cachedArtifact, "utf8"))
      .toBe("keep cache until another installer runs");
  });

  test("writes the bootstrap receipt only after a healthy physical plugin exists", async () => {
    const fixture = await createFixture();
    const preparation = await preparePluginInstallBootstrap({
      resourcesPath: fixture.resourcesPath,
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web"
    });
    const receiptPath = path.join(
      fixture.dshHome,
      "arkme-self",
      "desktop-plugin-bootstrap.json"
    );

    await expect(completePluginInstallBootstrap({
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web",
      artifact: preparation.artifact,
      selectedPluginVersion: preparation.artifact.version
    })).rejects.toThrow("installed Arkme plugin");
    await expect(access(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });

    await createHealthyPlugin(preparation.profilePluginDir, "0.1.17");
    await completePluginInstallBootstrap({
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web",
      artifact: preparation.artifact,
      selectedPluginVersion: preparation.artifact.version
    });

    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      appVersion: "0.1.5",
      packageName: "@senguoyun/dsh-arkme",
      version: "0.1.17",
      artifactSha512: preparation.artifact.artifactSha512
    });
  });

  test("validates the selected independent plugin while the receipt tracks the embedded seed", async () => {
    const fixture = await createFixture("0.1.22");
    const preparation = await preparePluginInstallBootstrap({
      resourcesPath: fixture.resourcesPath,
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web"
    });
    await createHealthyPlugin(preparation.profilePluginDir, "0.1.23");

    await completePluginInstallBootstrap({
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web",
      artifact: preparation.artifact,
      selectedPluginVersion: "0.1.23"
    });

    expect(JSON.parse(await readFile(path.join(
      fixture.dshHome,
      "arkme-self",
      "desktop-plugin-bootstrap.json"
    ), "utf8"))).toMatchObject({
      packageName: "@senguoyun/dsh-arkme",
      version: "0.1.22",
      artifactSha512: preparation.artifact.artifactSha512
    });
  });

  test("defers replacement of an old physical core plugin until profile provisioning", async () => {
    const fixture = await createFixture();
    const pluginPath = profilePluginDirectory(fixture.dshHome, "web");
    const otherExtension = path.join(
      fixture.dshHome,
      "profiles",
      "web",
      "node_modules",
      "@example",
      "other-extension",
      "package.json"
    );
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "old.txt"), "remove core plugin");
    await mkdir(path.dirname(otherExtension), { recursive: true });
    await writeFile(otherExtension, "keep other extension");

    await preparePluginInstallBootstrap({
      resourcesPath: fixture.resourcesPath,
      dshHome: fixture.dshHome,
      appVersion: "0.1.5",
      profileName: "web"
    });

    expect(await readFile(path.join(pluginPath, "old.txt"), "utf8")).toBe("remove core plugin");
    expect(await readFile(otherExtension, "utf8")).toBe("keep other extension");
  });
});

async function createHealthyPlugin(pluginDir: string, version: string): Promise<void> {
  await mkdir(path.join(pluginDir, "lib"), { recursive: true });
  await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
    name: "@senguoyun/dsh-arkme",
    version,
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }));
  await writeFile(path.join(pluginDir, "cordis.patch.yml"), "[]\n");
  await writeFile(path.join(pluginDir, "lib", "index.js"), "export {};\n");
  await writeFile(path.join(pluginDir, "lib", "client.js"), "export {};\n");
}

async function createFixture(seedVersion = "0.1.17"): Promise<{
  root: string;
  resourcesPath: string;
  dshHome: string;
  artifactBytes: Buffer;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "arkme-plugin-bootstrap-"));
  roots.push(root);
  const resourcesPath = path.join(root, "resources");
  const seedDirectory = path.join(resourcesPath, "arkme-plugin-seed");
  const dshHome = path.join(root, "user-data", "dsh");
  const artifactBytes = Buffer.from("bundled plugin seed");
  await mkdir(seedDirectory, { recursive: true });
  await writeFile(path.join(seedDirectory, "dsh-arkme.tgz"), artifactBytes);
  await writeFile(path.join(seedDirectory, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    packageName: "@senguoyun/dsh-arkme",
    version: seedVersion,
    artifactFileName: "dsh-arkme.tgz",
    artifactSha512: createHash("sha512").update(artifactBytes).digest("hex")
  }));
  return { root, resourcesPath, dshHome, artifactBytes };
}
