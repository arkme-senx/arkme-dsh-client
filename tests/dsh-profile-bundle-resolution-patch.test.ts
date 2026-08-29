import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function writePackage(directory: string, name: string, version: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name, version })}\n`,
    "utf8"
  );
}

describe("packaged DSH profile bundle resolution patch", () => {
  test("prefers the Profile copy only for explicitly allowlisted bundles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-dsh-profile-resolution-"));
    temporaryDirectories.push(root);
    const appBootRoot = path.join(root, "dsh-app-boot");
    const appBootModule = path.join(appBootRoot, "lib", "index.js");
    const installAnchor = path.join(
      root,
      "runtime",
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "package.json"
    );
    const profileDirectory = path.join(root, "profile");
    const runtimeArkme = path.join(
      root,
      "runtime",
      "node_modules",
      "@senguoyun",
      "dsh-arkme"
    );
    const profileArkme = path.join(
      profileDirectory,
      "node_modules",
      "@senguoyun",
      "dsh-arkme"
    );
    const runtimeBase = path.join(
      root,
      "runtime",
      "node_modules",
      "@deepseek-ai",
      "dsh-base"
    );
    const profileBase = path.join(
      profileDirectory,
      "node_modules",
      "@deepseek-ai",
      "dsh-base"
    );

    await mkdir(path.dirname(appBootModule), { recursive: true });
    await mkdir(path.dirname(installAnchor), { recursive: true });
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(
      path.join(appBootRoot, "package.json"),
      `${JSON.stringify({ type: "module" })}\n`,
      "utf8"
    );
    await writeFile(installAnchor, "{}\n", "utf8");
    await writeFile(path.join(profileDirectory, "package.json"), "{}\n", "utf8");
    await Promise.all([
      writePackage(runtimeArkme, "@senguoyun/dsh-arkme", "0.1.17"),
      writePackage(profileArkme, "@senguoyun/dsh-arkme", "0.1.22"),
      writePackage(runtimeBase, "@deepseek-ai/dsh-base", "0.1.0-rc.8"),
      writePackage(profileBase, "@deepseek-ai/dsh-base", "9.9.9"),
    ]);
    await writeFile(appBootModule, `
import { createRequire } from "node:module";
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

class Include {
  constructor(ctx) {
    this.ctx = ctx;
  }

  import(name) {
    return ["profile-default", name];
  }
}

class Group {}

function ensureSymlink(link, target) {
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    stat = void 0;
  }
  if (stat !== void 0) {
    if (!stat.isSymbolicLink()) throw new Error("not a symlink");
    if (readlinkSync(link) === target) return;
    unlinkSync(link);
  }
  symlinkSync(target, link, "junction");
}

function packageDirFromAnchor(anchor, packageName) {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
}

function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
  for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
    const dir = packageDirFromAnchor(anchor, packageName);
    if (dir !== void 0) return dir;
  }
  throw new Error(binName + ": cannot resolve " + packageName);
}

async function mountRootInclude(ctx, absoluteConfigPath, patches = [], bareModuleBaseUrl) {
  ctx.loader.builtins.include = bareModuleBaseUrl === void 0 ? Include : class HostResolvedRootInclude extends Include {
    import(name, getOuterStack) {
      const specifier = isAbsolute(name) ? pathToFileURL(name).href : name;
      if (name.startsWith(".") || name.startsWith("cordis:")) return super.import(specifier, getOuterStack);
      const internal = this.ctx.loader.internal;
      if (internal === void 0) return super.import(specifier, getOuterStack);
      return internal.import(specifier, bareModuleBaseUrl, {});
    }
  };
  ctx.loader.builtins.group = Group;
  return ctx.loader.builtins.include;
}

export { ensureSymlink, mountRootInclude, resolveBundleDir };
`, "utf8");

    const patchScript = fileURLToPath(
      new URL("../scripts/patch-dsh-profile-bundle-resolution.mjs", import.meta.url)
    );
    const patch = spawnSync(process.execPath, [patchScript, appBootRoot], {
      encoding: "utf8"
    });
    expect(patch.status, patch.stderr).toBe(0);
    expect(await readFile(appBootModule, "utf8")).toContain(
      "readlinkSync(link) === target && existsSync(join(link, \"package.json\"))"
    );

    const module = await import(`${pathToFileURL(appBootModule).href}?test=${Date.now()}`) as {
      resolveBundleDir: (
        binName: string,
        packageName: string,
        installAnchor: string,
        profileDirectory: string
      ) => string;
      mountRootInclude: (
        context: unknown,
        absoluteConfigPath: string
      ) => Promise<new (context: unknown) => {
        import: (name: string) => unknown;
      }>;
    };
    const previous = process.env.DSH_PROFILE_FIRST_BUNDLES;
    const previousInstalledBase = process.env.DSH_INSTALLED_MODULE_BASE_PATH;
    process.env.DSH_PROFILE_FIRST_BUNDLES = "@senguoyun/dsh-arkme";
    process.env.DSH_INSTALLED_MODULE_BASE_PATH = installAnchor;
    try {
      expect(module.resolveBundleDir(
        "dsh",
        "@senguoyun/dsh-arkme",
        installAnchor,
        profileDirectory
      )).toBe(profileArkme);
      expect(module.resolveBundleDir(
        "dsh",
        "@deepseek-ai/dsh-base",
        installAnchor,
        profileDirectory
      )).toBe(runtimeBase);

      const imported: Array<[string, string]> = [];
      const context = {
        loader: {
          builtins: {} as Record<string, unknown>,
          internal: {
            import: (name: string, baseUrl: string) => {
              imported.push([name, baseUrl]);
              return name;
            }
          }
        }
      };
      const RootInclude = await module.mountRootInclude(
        context,
        path.join(profileDirectory, "cordis.root.yml")
      );
      const include = new RootInclude(context);
      include.import("@senguoyun/dsh-arkme");
      include.import("@deepseek-ai/dsh-client-ui-commands");
      include.import("@arkme-local/ext-f325fca40e7e6546");

      expect(imported).toEqual([
        [
          "@senguoyun/dsh-arkme",
          pathToFileURL(path.join(profileDirectory, "cordis.root.yml")).href
        ],
        ["@deepseek-ai/dsh-client-ui-commands", pathToFileURL(installAnchor).href],
        [
          "@arkme-local/ext-f325fca40e7e6546",
          pathToFileURL(path.join(profileDirectory, "cordis.root.yml")).href
        ]
      ]);
    } finally {
      if (previous === undefined) delete process.env.DSH_PROFILE_FIRST_BUNDLES;
      else process.env.DSH_PROFILE_FIRST_BUNDLES = previous;
      if (previousInstalledBase === undefined) delete process.env.DSH_INSTALLED_MODULE_BASE_PATH;
      else process.env.DSH_INSTALLED_MODULE_BASE_PATH = previousInstalledBase;
    }
  });
});
