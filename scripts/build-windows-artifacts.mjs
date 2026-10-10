import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { patchInstallSection, patchShortcutMacros, patchInstallModePage, validateReleaseIdentity } from "./windows-migration-policy.mjs";

const require = createRequire(import.meta.url);
const electronBuilderEntry = require.resolve("electron-builder");
const electronBuilderRequire = createRequire(electronBuilderEntry);
const nsisUtil = electronBuilderRequire(
  "app-builder-lib/out/targets/nsis/nsisUtil.js"
);
const originalTemplatesDir = nsisUtil.nsisTemplatesDir;
const originalCopyElevate = nsisUtil.CopyElevateHelper.prototype.copy;
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "arkme-nsis-templates-"));
const patchedTemplatesDir = path.join(temporaryRoot, "nsis");

try {
  await cp(originalTemplatesDir, patchedTemplatesDir, { recursive: true });
  const installSectionPath = path.join(
    patchedTemplatesDir,
    "installSection.nsh"
  );
  const installSection = await readFile(installSectionPath, "utf8");
  const hiddenDetailsDirective = "SetDetailsPrint none";
  const directiveCount = installSection.split(hiddenDetailsDirective).length - 1;

  if (directiveCount !== 1) {
    throw new Error(
      `Expected exactly one electron-builder NSIS detail directive, found ${directiveCount}`
    );
  }

  await writeFile(
    installSectionPath,
    patchInstallSection(installSection.replace(hiddenDetailsDirective, "SetDetailsPrint both"))
  );
  const shortcutsPath = path.join(patchedTemplatesDir, 'include/installer.nsh');
  await writeFile(shortcutsPath, patchShortcutMacros(await readFile(shortcutsPath, 'utf8')));
  const modePath = path.join(patchedTemplatesDir, 'multiUserUi.nsh');
  await writeFile(modePath, patchInstallModePage(await readFile(modePath, 'utf8')));
  nsisUtil.nsisTemplatesDir = patchedTemplatesDir;

  const manifest = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8")
  );
  const config = structuredClone(manifest.build);
  // The programmatic builder API treats extends as a filesystem path on Windows.
  if (typeof config.extends === "string" && config.extends.startsWith("file:")) {
    config.extends = path.resolve(config.extends.slice(5));
  }
  validateReleaseIdentity({ appId: config.appId, unsigned: process.env.ARKME_WINDOWS_ALLOW_UNSIGNED === "1" });
  const manifestPath = path.join(temporaryRoot, "windows-migration-manifest.json");
  const includePath = path.join(temporaryRoot, "production-migration.nsh");
  // The manifest is embedded in the signed installer, outside the writable installed payload.
  const writePayloadManifest = async (appOutDir) => {
    const entries = [];
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Release payload contains a link: ${absolute}`);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) entries.push({ path: path.relative(appOutDir, absolute).split(path.sep).join("/"), size: (await stat(absolute)).size, sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
      }
    }
    await visit(appOutDir);
    if (!entries.some(entry => entry.path === "arkme.exe") || !entries.some(entry => entry.path === "resources/app.asar")) throw new Error("Unexpected production Windows executable layout");
    await writeFile(manifestPath, JSON.stringify({ version: manifest.version, versionCode: manifest.versionCode, files: entries,
      registryMetadata: { displayName: `${config.productName} ${manifest.version}`, publisher: typeof manifest.author === 'string' ? manifest.author : manifest.author?.name, description: manifest.description } }));
  };
  config.afterSign = async ({ appOutDir, electronPlatformName }) => {
    if (electronPlatformName === "win32") await writePayloadManifest(appOutDir);
  };
  // NSIS adds and signs elevate.exe after afterSign. Hash the final payload
  // before NSIS archives it, so migration also installs the elevation helper.
  nsisUtil.CopyElevateHelper.prototype.copy = async function(appOutDir, target) {
    await originalCopyElevate.call(this, appOutDir, target);
    await writePayloadManifest(appOutDir);
    await cp(manifestPath, path.join(path.dirname(appOutDir), 'windows-migration-manifest.json'));
  };
  const nsisPath = value => path.resolve(value).replaceAll('$', () => '$$').replaceAll('"', '$\\"');
  await writeFile(includePath, [
    '!define JIWO_MIGRATION',
    `!define JIWO_VERSION_CODE ${manifest.versionCode}`,
    `!define JIWO_MIGRATION_SCRIPT "${nsisPath("build/windows-migration.ps1")}"`,
    `!define JIWO_MIGRATION_MANIFEST "${nsisPath(manifestPath)}"`,
    `!define JIWO_MIGRATION_INCLUDE "${nsisPath("build/windows-migration.nsh")}"`,
    `!include "${nsisPath("build/nsis-installer-ui.nsh")}"`,
  ].join("\n"));
  config.nsis = { ...config.nsis, include: includePath };
  const outputDirectory = process.env.ARKME_WINDOWS_OUTPUT_DIR?.trim();

  if (outputDirectory) {
    config.directories = {
      ...config.directories,
      output: outputDirectory
    };
  }


  const { Arch, Platform, build } = require("electron-builder");
  await build({
    targets: Platform.WINDOWS.createTarget(["nsis", "zip"], Arch.x64),
    config,
    publish: "never"
  });
} finally {
  nsisUtil.nsisTemplatesDir = originalTemplatesDir;
  nsisUtil.CopyElevateHelper.prototype.copy = originalCopyElevate;
  await rm(temporaryRoot, { recursive: true, force: true });
}
