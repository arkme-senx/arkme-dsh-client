import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronBuilderEntry = require.resolve("electron-builder");
const electronBuilderRequire = createRequire(electronBuilderEntry);
const nsisUtil = electronBuilderRequire(
  "app-builder-lib/out/targets/nsis/nsisUtil.js"
);
const originalTemplatesDir = nsisUtil.nsisTemplatesDir;
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
    installSection.replace(hiddenDetailsDirective, "SetDetailsPrint both")
  );
  nsisUtil.nsisTemplatesDir = patchedTemplatesDir;

  const manifest = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8")
  );
  const config = structuredClone(manifest.build);
  const outputDirectory = process.env.ARKME_WINDOWS_OUTPUT_DIR?.trim();

  if (outputDirectory) {
    config.directories = {
      ...config.directories,
      output: outputDirectory
    };
  }

  if (process.env.ARKME_WINDOWS_ALLOW_UNSIGNED === "1") {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    config.win.forceCodeSigning = false;
    config.win.signtoolOptions = null;
  }

  const { Arch, Platform, build } = require("electron-builder");
  await build({
    targets: Platform.WINDOWS.createTarget(["nsis", "zip"], Arch.x64),
    config,
    publish: "never"
  });
} finally {
  nsisUtil.nsisTemplatesDir = originalTemplatesDir;
  await rm(temporaryRoot, { recursive: true, force: true });
}
