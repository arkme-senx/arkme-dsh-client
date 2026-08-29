import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESOLVER_PATTERN = /^([ \t]*)function resolveBundleDir\(binName, packageName, installAnchor, profileDir\) \{\r?\n([ \t]*)for \(const anchor of \[installAnchor, join\(profileDir, "package\.json"\)\]\) \{/gm;
const MOUNT_PATTERN = /^([ \t]*)async function mountRootInclude\(ctx, absoluteConfigPath, patches = \[\], bareModuleBaseUrl\) \{\r?\n([ \t]*)ctx\.loader\.builtins\.include = bareModuleBaseUrl === void 0 \? Include : class HostResolvedRootInclude extends Include \{/gm;
const HOST_IMPORT_PATTERN = /^([ \t]*)return internal\.import\(specifier, bareModuleBaseUrl, \{\}\);$/gm;
const ROUTER_V1_PATTERN = /^([ \t]*)const moduleBaseUrl = profileFirstModules\.has\(name\)\r?\n[ \t]*\? profileModuleBaseUrl\r?\n[ \t]*: installedModuleBaseUrl;$/gm;
const SYMLINK_PATTERN = /^([ \t]*)if \(readlinkSync\(link\) === target\) return;$/gm;
const RESOLVER_PATCH_MARKER = "process.env.DSH_PROFILE_FIRST_BUNDLES";
const MODULE_ROUTER_PATCH_MARKER = "process.env.DSH_INSTALLED_MODULE_BASE_PATH";
const MODULE_ROUTER_V2_MARKER = "const installedModuleDir = installedModuleBasePath";
const SYMLINK_PATCH_MARKER = "readlinkSync(link) === target && existsSync(join(link, \"package.json\"))";

function replacement(functionIndentation, bodyIndentation) {
  const nested = `${bodyIndentation}${bodyIndentation.includes("\t") ? "\t" : "  "}`;
  return [
    `${functionIndentation}function resolveBundleDir(binName, packageName, installAnchor, profileDir) {`,
    `${bodyIndentation}const profileAnchor = join(profileDir, "package.json");`,
    `${bodyIndentation}const profileFirstBundles = new Set(`,
    `${nested}(process.env.DSH_PROFILE_FIRST_BUNDLES ?? "")`,
    `${nested}  .split(",")`,
    `${nested}  .map((name) => name.trim())`,
    `${nested}  .filter((name) => name !== "")`,
    `${bodyIndentation});`,
    `${bodyIndentation}const anchors = profileFirstBundles.has(packageName)`,
    `${nested}? [profileAnchor, installAnchor]`,
    `${nested}: [installAnchor, profileAnchor];`,
    `${bodyIndentation}for (const anchor of anchors) {`,
  ].join("\n");
}

function mountReplacement(functionIndentation, bodyIndentation) {
  const nested = `${bodyIndentation}${bodyIndentation.includes("\t") ? "\t" : "  "}`;
  return [
    `${functionIndentation}async function mountRootInclude(ctx, absoluteConfigPath, patches = [], bareModuleBaseUrl) {`,
    `${bodyIndentation}const installedModuleBasePath = process.env.DSH_INSTALLED_MODULE_BASE_PATH;`,
    `${bodyIndentation}const installedModuleBaseUrl = bareModuleBaseUrl ?? (installedModuleBasePath === void 0`,
    `${nested}? void 0`,
    `${nested}: pathToFileURL(installedModuleBasePath).href);`,
    `${bodyIndentation}const profileModuleBaseUrl = pathToFileURL(absoluteConfigPath).href;`,
    `${bodyIndentation}const profileFirstModules = new Set(`,
    `${nested}(process.env.DSH_PROFILE_FIRST_BUNDLES ?? "")`,
    `${nested}  .split(",")`,
    `${nested}  .map((name) => name.trim())`,
    `${nested}  .filter((name) => name !== "")`,
    `${bodyIndentation});`,
    `${bodyIndentation}ctx.loader.builtins.include = installedModuleBaseUrl === void 0 ? Include : class HostResolvedRootInclude extends Include {`,
  ].join("\n");
}

function hostImportReplacement(indentation) {
  return [
    `${indentation}const installedModuleDir = installedModuleBasePath === void 0`,
    `${indentation}\t? void 0`,
    `${indentation}\t: packageDirFromAnchor(installedModuleBasePath, name);`,
    `${indentation}const moduleBaseUrl = profileFirstModules.has(name) || installedModuleDir === void 0`,
    `${indentation}\t? profileModuleBaseUrl`,
    `${indentation}\t: installedModuleBaseUrl;`,
  ].join("\n");
}

export async function patchDshProfileBundleResolution(appBootRoot) {
  const modulePath = path.join(appBootRoot, "lib", "index.js");
  const source = await readFile(modulePath, "utf8");
  let patched = source;

  if (!patched.includes(RESOLVER_PATCH_MARKER)) {
    const occurrences = [...patched.matchAll(RESOLVER_PATTERN)];
    if (occurrences.length !== 1) {
      throw new Error(`Expected one DSH bundle resolver, found ${occurrences.length}`);
    }
    const functionIndentation = occurrences[0][1] ?? "";
    const bodyIndentation = occurrences[0][2] ?? "\t";
    patched = patched.replace(
      RESOLVER_PATTERN,
      replacement(functionIndentation, bodyIndentation)
    );
  }

  if (!patched.includes(MODULE_ROUTER_PATCH_MARKER)) {
    const mountOccurrences = [...patched.matchAll(MOUNT_PATTERN)];
    const importOccurrences = [...patched.matchAll(HOST_IMPORT_PATTERN)];
    if (mountOccurrences.length !== 1 || importOccurrences.length !== 1) {
      throw new Error(
        `Expected one DSH root include and host import, found ${mountOccurrences.length} and ${importOccurrences.length}`
      );
    }
    const functionIndentation = mountOccurrences[0][1] ?? "";
    const bodyIndentation = mountOccurrences[0][2] ?? "\t";
    patched = patched.replace(
      MOUNT_PATTERN,
      mountReplacement(functionIndentation, bodyIndentation)
    );
    patched = patched.replace(
      HOST_IMPORT_PATTERN,
      (_line, indentation) => [
        hostImportReplacement(indentation),
        `${indentation}return internal.import(specifier, moduleBaseUrl, {});`,
      ].join("\n")
    );
  } else if (!patched.includes(MODULE_ROUTER_V2_MARKER)) {
    const routerOccurrences = [...patched.matchAll(ROUTER_V1_PATTERN)];
    if (routerOccurrences.length !== 1) {
      throw new Error(`Expected one DSH v1 module router, found ${routerOccurrences.length}`);
    }
    patched = patched.replace(
      ROUTER_V1_PATTERN,
      (_line, indentation) => hostImportReplacement(indentation)
    );
  }

  if (!patched.includes(SYMLINK_PATCH_MARKER)) {
    const symlinkOccurrences = [...patched.matchAll(SYMLINK_PATTERN)];
    if (symlinkOccurrences.length !== 1) {
      throw new Error(`Expected one DSH installation fallback link check, found ${symlinkOccurrences.length}`);
    }
    patched = patched.replace(
      SYMLINK_PATTERN,
      (_line, indentation) => `${indentation}if (readlinkSync(link) === target && existsSync(join(link, "package.json"))) return;`
    );
  }

  if (patched === source) return modulePath;
  const temporary = `${modulePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, patched, { encoding: "utf8", flag: "wx" });
    await rename(temporary, modulePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return modulePath;
}

async function main() {
  const appBootRoot = process.argv[2];
  if (appBootRoot === undefined || appBootRoot.trim() === "") {
    throw new Error("DSH app-boot package path is required");
  }
  await patchDshProfileBundleResolution(path.resolve(appBootRoot));
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
