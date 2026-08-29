import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createRuntimePluginSeed } from "../scripts/runtime-plugin-seed.mjs";
import {
  completePluginInstallBootstrap,
  preparePluginInstallBootstrap,
  profilePluginDirectory
} from "../src/plugin-install-bootstrap.js";
import { provisionArkmeWebProfile } from "../src/plugin-profile.js";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform !== "win32")("Windows plugin installer repair", () => {
  test("preserves a junction target and repairs two same-version installer runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-windows-install-repair-"));
    try {
      const resourcesPath = path.join(root, "resources");
      const seedDirectory = path.join(resourcesPath, "arkme-plugin-seed");
      const dshHome = path.join(root, "user-data", "dsh");
      const embeddedTarget = path.join(root, "installed-app-plugin");
      const profilePluginDir = profilePluginDirectory(dshHome, "web");
      const receiptPath = path.join(
        dshHome,
        "arkme-self",
        "desktop-plugin-bootstrap.json"
      );
      await createPlugin(embeddedTarget, "0.1.17");
      await writeFile(path.join(embeddedTarget, "sentinel.txt"), "keep");
      await mkdir(path.dirname(profilePluginDir), { recursive: true });
      await symlink(embeddedTarget, profilePluginDir, "junction");
      await createRuntimePluginSeed({
        pluginDir: embeddedTarget,
        seedDir: seedDirectory,
        pack: directory => packPlugin(embeddedTarget, directory)
      });

      await runInstallerBootstrap({ resourcesPath, dshHome, root });

      expect(await readFile(path.join(embeddedTarget, "sentinel.txt"), "utf8")).toBe("keep");
      expect(await readFile(path.join(embeddedTarget, "lib", "index.js"), "utf8"))
        .toBe("embedded");
      expect((await lstat(profilePluginDir)).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await readFile(path.join(profilePluginDir, "package.json"), "utf8")))
        .toMatchObject({ version: "0.1.17" });

      await unlink(receiptPath);
      await runInstallerBootstrap({ resourcesPath, dshHome, root });

      expect(await readFile(path.join(embeddedTarget, "sentinel.txt"), "utf8")).toBe("keep");
      expect(await readFile(path.join(embeddedTarget, "lib", "index.js"), "utf8"))
        .toBe("embedded");
      expect((await lstat(profilePluginDir)).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await readFile(path.join(profilePluginDir, "package.json"), "utf8")))
        .toMatchObject({ version: "0.1.17" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("preserves a verified independently updated plugin when an installer refreshes its receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-windows-independent-update-"));
    try {
      const resourcesPath = path.join(root, "resources");
      const seedDirectory = path.join(resourcesPath, "arkme-plugin-seed");
      const dshHome = path.join(root, "user-data", "dsh");
      const embeddedTarget = path.join(root, "embedded-plugin");
      const profileDir = path.join(dshHome, "profiles", "web");
      const profilePluginDir = profilePluginDirectory(dshHome, "web");
      const independentArtifact = path.join(
        dshHome,
        "arkme-self",
        "prod",
        "plugin-cache",
        "0.1.23",
        "dsh-arkme-0.1.23.tgz"
      );
      const independentBytes = Buffer.from("verified independent plugin artifact");
      await createPlugin(embeddedTarget, "0.1.22");
      await createRuntimePluginSeed({
        pluginDir: embeddedTarget,
        seedDir: seedDirectory,
        pack: directory => packPlugin(embeddedTarget, directory)
      });
      await createPlugin(profilePluginDir, "0.1.23");
      await mkdir(path.dirname(independentArtifact), { recursive: true });
      await writeFile(independentArtifact, independentBytes);
      await writeFile(
        path.join(path.dirname(independentArtifact), "plugin-update-install-receipt.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          packageName: "@senguoyun/dsh-arkme",
          targetVersion: "0.1.23",
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

      const preparation = await preparePluginInstallBootstrap({
        resourcesPath,
        dshHome,
        appVersion: "0.1.5",
        profileName: "web"
      });
      expect(preparation.resetRequired).toBe(true);
      const provisioned = await provisionArkmeWebProfile({
        dshHome,
        embeddedArtifact: preparation.artifact,
        appVersion: "0.1.5",
        dshVersion: "0.1.0-rc.8",
        packageManager: packageManagerFixture(root)
      });
      await completePluginInstallBootstrap({
        dshHome,
        appVersion: "0.1.5",
        profileName: "web",
        artifact: preparation.artifact,
        selectedPluginVersion: provisioned.version
      });

      expect(provisioned).toMatchObject({ source: "independent", version: "0.1.23" });
      expect(JSON.parse(await readFile(path.join(profilePluginDir, "package.json"), "utf8")))
        .toMatchObject({ version: "0.1.23" });
      expect(await readFile(independentArtifact)).toEqual(independentBytes);
      expect(JSON.parse(await readFile(path.join(
        dshHome,
        "arkme-self",
        "desktop-plugin-bootstrap.json"
      ), "utf8"))).toMatchObject({ version: "0.1.22" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function runInstallerBootstrap(options: {
  resourcesPath: string;
  dshHome: string;
  root: string;
}): Promise<void> {
  const preparation = await preparePluginInstallBootstrap({
    resourcesPath: options.resourcesPath,
    dshHome: options.dshHome,
    appVersion: "0.1.5",
    profileName: "web"
  });
  expect(preparation.resetRequired).toBe(true);
  const provisioned = await provisionArkmeWebProfile({
    dshHome: options.dshHome,
    embeddedArtifact: preparation.artifact,
    packageManager: packageManagerFixture(options.root)
  });
  await completePluginInstallBootstrap({
    dshHome: options.dshHome,
    appVersion: "0.1.5",
    profileName: "web",
    artifact: preparation.artifact,
    selectedPluginVersion: provisioned.version
  });
}

async function createPlugin(pluginDir: string, version: string): Promise<void> {
  await mkdir(path.join(pluginDir, "lib"), { recursive: true });
  await writeFile(path.join(pluginDir, "package.json"), `${JSON.stringify({
    name: "@senguoyun/dsh-arkme",
    version,
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }, null, 2)}\n`);
  await writeFile(path.join(pluginDir, "cordis.patch.yml"), "[]\n");
  await writeFile(path.join(pluginDir, "lib", "index.js"), "embedded");
  await writeFile(path.join(pluginDir, "lib", "client.js"), "export default {};\n");
}

async function packPlugin(pluginDir: string, destination: string): Promise<string> {
  const packageManager = packageManagerFixture(path.dirname(destination));
  await execFileAsync(
    packageManager.executable,
    [
      ...packageManager.prefixArgs,
      "pack",
      "--pack-destination",
      destination
    ],
    { cwd: pluginDir, env: packageManager.environment }
  );
  const artifact = (await readdir(destination)).find(name => name.endsWith(".tgz"));
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
