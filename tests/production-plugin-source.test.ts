import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import * as productionPluginSourceModule from "../scripts/production-plugin-source.mjs";
import {
  assertProductionManifestReferencesCatalog,
  prepareRuntimePlugin,
  readProductionPluginSource,
  validatePackagedPluginMetadata,
  verifyRuntimePlugin,
  verifyRuntimePluginProvenance,
  writePluginProvenance
} from "../scripts/production-plugin-source.mjs";

const packageName = "@senguoyun/dsh-arkme";
const commit = "e817cb21e3923c8e903d68d442f3227c9e6c78ef";
const dependencySpec =
  `git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#${commit}`;
const tarball =
  `https://codeload.github.com/arkme-senx/arkme-dsh-plugin/tar.gz/${commit}`;
const peerSuffix = "(2e4ae8833cffc2b8e2a560f0f5496f1a)";
const gitAllowBuildsKey = `${packageName}@${dependencySpec}`;
const tarballAllowBuildsKey = `${packageName}@${tarball}`;
const allowBuildsKey = gitAllowBuildsKey;
const packageResolutionKey = `${packageName}@${tarball}`;
const snapshotKey = `${packageResolutionKey}${peerSuffix}`;
const productionIntegrity =
  "sha512-bCBOmvdcR+wrLluFEbHtjntX4t7r476oNEV6faZ22oa1Si+eX6Jgu/jysR+w3dgTRN/swByyH55oK00ZOCxnuw==";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [realWorkspaceManifest, realLockfileManifest] = await Promise.all([
  readFile(path.join(projectRoot, "pnpm-workspace.yaml"), "utf8"),
  readFile(path.join(projectRoot, "pnpm-lock.yaml"), "utf8")
]);
const temporaryDirectories: string[] = [];

type ProductionPluginSource = PackagedMetadataInput["expectedSource"];
type LockfileFixture = Record<string, any>;

interface RuntimeTransactionOptions {
  pluginDir: string;
  runtimeRoot: string;
  source: ProductionPluginSource;
  importPlugin: (pluginEntry: string) => Promise<void>;
  finalizeRuntime: () => Promise<void>;
}

const productionPluginSourceExtensions = productionPluginSourceModule as unknown as {
  stageRuntimeWithStableProductionSource(options: {
    readSource: () => Promise<ProductionPluginSource>;
    resetRuntime: () => Promise<void>;
    deployRuntime: () => Promise<void>;
    materializeRuntime: () => Promise<void>;
  }): Promise<ProductionPluginSource>;
  prepareRuntimePluginTransaction(options: RuntimeTransactionOptions): Promise<{
    packageName: string;
    packageVersion: string;
    provenancePath: string;
  }>;
};

interface PackagedMetadataInput {
  manifest: { name: string; version: string };
  provenance: {
    schemaVersion: number;
    source: string;
    repository: string;
    commit: string;
    packageName: string;
    packageVersion: string;
  };
  expectedSource: {
    packageName: string;
    packageVersion: string;
    repository: string;
    commit: string;
    dependencySpec: string;
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("production plugin source", () => {
  test("reads the commit-pinned catalog source through the runtime lock resolution", async () => {
    const project = await createProject();

    await expect(readProductionPluginSource(project)).resolves.toEqual({
      packageName,
      packageVersion: "0.1.29",
      repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
      commit,
      dependencySpec
    });
  });

  test("accepts only pnpm's git and codeload build coordinates for the pinned commit", async () => {
    const workspace = workspaceManifest().replace(
      `  '${gitAllowBuildsKey}': true\n  '${tarballAllowBuildsKey}': true`,
      `  '${tarballAllowBuildsKey}': true\n  '${gitAllowBuildsKey}': true`
    );
    const project = await createProject({ workspaceManifest: workspace });

    await expect(readProductionPluginSource(project)).resolves.toMatchObject({
      packageName,
      packageVersion: "0.1.29",
      commit
    });
  });

  test.each([
    ["a branch", "main"],
    ["a tag", "v0.1.29"],
    ["a short SHA", commit.slice(0, 12)]
  ])("rejects %s instead of a full commit", async (_description, ref) => {
    const project = await createProject({
      workspaceManifest: workspaceManifest(dependencySpec.replace(commit, ref))
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "must end with a full 40-character Git commit"
    );
  });

  test("rejects a missing production catalog", async () => {
    const project = await createProject({ workspaceManifest: "packages:\n  - .\n  - runtime\n" });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "production catalog is missing @senguoyun/dsh-arkme"
    );
  });

  test("rejects another repository even when its lock resolution is internally consistent", async () => {
    const project = await createProject({
      workspaceManifest: workspaceManifest().replaceAll(
        "arkme-senx/arkme-dsh-plugin",
        "someone/arkme-fork"
      ),
      lockfile: lockfileManifest().replaceAll(
        "arkme-senx/arkme-dsh-plugin",
        "someone/arkme-fork"
      )
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "must equal the exact production dependency"
    );
  });

  test("rejects another full commit even when its lock resolution is internally consistent", async () => {
    const otherCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const project = await createProject({
      workspaceManifest: workspaceManifest().replaceAll(commit, otherCommit),
      lockfile: lockfileManifest().replaceAll(commit, otherCommit)
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "must equal the exact production dependency"
    );
  });

  test.each([
    ["root" as const, { devDependencies: { [packageName]: "workspace:*" } }],
    ["runtime" as const, { dependencies: { [packageName]: "workspace:*" } }]
  ])("rejects a %s manifest that bypasses the production catalog", (manifestName, manifest) => {
    expect(() => assertProductionManifestReferencesCatalog(manifest, manifestName)).toThrow(
      `${manifestName} manifest must reference @senguoyun/dsh-arkme as catalog:production`
    );
  });

  test("rejects the root production dependency in dependencies", () => {
    expect(() => assertProductionManifestReferencesCatalog({
      dependencies: { [packageName]: "catalog:production" }
    }, "root")).toThrow("root manifest must declare @senguoyun/dsh-arkme only in devDependencies");
  });

  test("rejects the runtime production dependency in devDependencies", () => {
    expect(() => assertProductionManifestReferencesCatalog({
      devDependencies: { [packageName]: "catalog:production" }
    }, "runtime")).toThrow(
      "runtime manifest must declare @senguoyun/dsh-arkme only in dependencies"
    );
  });

  test.each([
    ["root" as const, {
      dependencies: { [packageName]: "catalog:production" },
      devDependencies: { [packageName]: "catalog:production" }
    }],
    ["runtime" as const, {
      dependencies: { [packageName]: "catalog:production" },
      devDependencies: { [packageName]: "catalog:production" }
    }]
  ])("rejects duplicate production declarations in the %s manifest", (manifestName, manifest) => {
    expect(() => assertProductionManifestReferencesCatalog(manifest, manifestName)).toThrow(
      `${manifestName} manifest must declare @senguoyun/dsh-arkme only in`
    );
  });

  test("rejects a missing root lockfile importer dependency", async () => {
    const project = await createProject({
      lockfile: lockfileManifest().replace(rootImporterBlock(), "  .: {}\n")
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile root importer must declare @senguoyun/dsh-arkme in devDependencies"
    );
  });

  test("rejects a root lockfile importer dependency in the wrong section", async () => {
    const project = await createProject({
      lockfile: mutateLockfile((lockfile) => {
        const importer = lockfile.importers["."];
        importer.dependencies[packageName] = importer.devDependencies[packageName];
        delete importer.devDependencies[packageName];
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile root importer must declare @senguoyun/dsh-arkme in devDependencies"
    );
  });

  test("rejects a runtime lockfile importer dependency in the wrong section", async () => {
    const project = await createProject({
      lockfile: lockfileManifest().replace(
        runtimeImporterBlock(),
        runtimeImporterBlock().replace("dependencies", "devDependencies")
      )
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile runtime importer must declare @senguoyun/dsh-arkme in dependencies"
    );
  });

  test("rejects a missing runtime lockfile importer dependency", async () => {
    const project = await createProject({
      lockfile: lockfileManifest().replace(runtimeImporterBlock(), "  runtime: {}\n")
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile runtime importer must declare @senguoyun/dsh-arkme in dependencies"
    );
  });

  test.each([
    ["root", rootImporterBlock()],
    ["runtime", runtimeImporterBlock()]
  ])("rejects catalog reference drift in the %s lockfile importer", async (
    importerName,
    importerBlock
  ) => {
    const project = await createProject({
      lockfile: lockfileManifest().replace(
        importerBlock,
        importerBlock.replace("specifier: catalog:production", "specifier: workspace:*")
      )
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      `lockfile ${importerName} importer must reference @senguoyun/dsh-arkme as catalog:production`
    );
  });

  test("rejects root and runtime importer coordinate drift", async () => {
    const mirrorTarball = `https://mirror.example/arkme-dsh-plugin/${commit}`;
    const project = await createProject({
      lockfile: lockfileManifest().replace(
        rootImporterBlock(),
        rootImporterBlock().replace(tarball, mirrorTarball)
      )
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile root importer version must resolve to the exact production tarball"
    );
  });

  test("rejects a non-production importer coordinate even when both importers agree", async () => {
    const mirrorTarball = `https://mirror.example/arkme-dsh-plugin/${commit}`;
    const project = await createProject({
      lockfile: lockfileManifest().replaceAll(tarball, mirrorTarball)
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "importer version must resolve to the exact production tarball"
    );
  });

  test("rejects a lockfile catalog version other than 0.1.29", async () => {
    const project = await createProject({
      lockfile: lockfileManifest().replace("      version: 0.1.29", "      version: 0.1.5")
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile production catalog version must be 0.1.29"
    );
  });

  test("rejects a lockfile package version other than 0.1.29", async () => {
    const project = await createProject({
      lockfile: mutateLockfile((lockfile) => {
        lockfile.packages[packageResolutionKey].version = "0.1.5";
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile package version must be 0.1.29"
    );
  });

  test.each([
    ["a different tarball", `tarball: ${tarball}`, `tarball: https://mirror.example/plugin/${commit}`],
    ["gitHosted false", "gitHosted: true", "gitHosted: false"],
    ["an empty integrity", `integrity: ${productionIntegrity}`, "integrity: ''"]
  ])("rejects package resolution with %s", async (_description, before, after) => {
    const project = await createProject({ lockfile: lockfileManifest().replace(before, after) });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile package resolution must exactly describe the pinned Git tarball"
    );
  });

  test("rejects a non-empty integrity that differs from the reviewed production artifact", async () => {
    const project = await createProject({
      lockfile: mutateLockfile((lockfile) => {
        lockfile.packages[packageResolutionKey].resolution.integrity =
          "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile package integrity must equal the reviewed production integrity"
    );
  });

  test("rejects an arbitrary peer suffix even when importers and snapshot agree", async () => {
    const unreviewedPeerSuffix = "(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)";
    const project = await createProject({
      lockfile: mutateLockfile((lockfile) => {
        lockfile.importers["."].devDependencies[packageName].version =
          `${tarball}${unreviewedPeerSuffix}`;
        lockfile.importers.runtime.dependencies[packageName].version =
          `${tarball}${unreviewedPeerSuffix}`;
        lockfile.snapshots[`${packageResolutionKey}${unreviewedPeerSuffix}`] =
          lockfile.snapshots[snapshotKey];
        delete lockfile.snapshots[snapshotKey];
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "importer version must equal the exact production resolution"
    );
  });

  test.each([
    ["engine metadata", (lockfile: LockfileFixture) => {
      lockfile.packages[packageResolutionKey].engines.node = ">=24.0.0";
    }],
    ["peer dependency metadata", (lockfile: LockfileFixture) => {
      lockfile.packages[packageResolutionKey].peerDependencies.react = "^19.0.0";
    }],
    ["an additional package field", (lockfile: LockfileFixture) => {
      lockfile.packages[packageResolutionKey].deprecated = "fixture drift";
    }]
  ])("rejects production package entry drift in %s", async (_description, mutate) => {
    const project = await createProject({ lockfile: mutateLockfile(mutate) });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile production package entry fingerprint mismatch"
    );
  });

  test.each([
    ["a modified dependency value", (lockfile: LockfileFixture) => {
      lockfile.snapshots[snapshotKey].dependencies.semver = "7.8.4";
    }],
    ["a deleted dependency", (lockfile: LockfileFixture) => {
      delete lockfile.snapshots[snapshotKey].dependencies.semver;
    }],
    ["an added dependency", (lockfile: LockfileFixture) => {
      lockfile.snapshots[snapshotKey].dependencies["unexpected-package"] = "1.0.0";
    }],
    ["an additional snapshot field", (lockfile: LockfileFixture) => {
      lockfile.snapshots[snapshotKey].optionalDependencies = { fixture: "1.0.0" };
    }],
    ["a modified transitive peer dependency", (lockfile: LockfileFixture) => {
      lockfile.snapshots[snapshotKey].transitivePeerDependencies[0] = "different-peer";
    }]
  ])("rejects production snapshot drift in %s", async (_description, mutate) => {
    const project = await createProject({ lockfile: mutateLockfile(mutate) });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile production snapshot fingerprint mismatch"
    );
  });

  test("treats transitive peer dependency array order as set-like lockfile semantics", async () => {
    const project = await createProject({
      lockfile: mutateLockfile((lockfile) => {
        lockfile.snapshots[snapshotKey].transitivePeerDependencies.reverse();
      })
    });

    await expect(readProductionPluginSource(project)).resolves.toMatchObject({
      packageName,
      commit
    });
  });

  test("rejects an additional Arkme snapshot key outside the reviewed fingerprint", async () => {
    const project = await createProject({
      lockfile: mutateLockfile((lockfile) => {
        lockfile.snapshots[`${packageResolutionKey}(unreviewed)`] =
          structuredClone(lockfile.snapshots[snapshotKey]);
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile must contain exactly the reviewed production snapshot key"
    );
  });

  test("rejects pnpm 11 dangerouslyAllowAllBuilds global build bypass", async () => {
    const project = await createProject({
      workspaceManifest: mutateWorkspaceManifest((workspace) => {
        workspace.dangerouslyAllowAllBuilds = true;
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "dangerouslyAllowAllBuilds must not enable dependency builds globally"
    );
  });

  test("rejects single-field drift in the complete reviewed allowBuilds policy", async () => {
    const project = await createProject({
      workspaceManifest: mutateWorkspaceManifest((workspace) => {
        workspace.allowBuilds.electron = false;
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "allowBuilds must exactly match the reviewed production build policy"
    );
  });

  test("rejects a snapshot that is not a mapping", async () => {
    const project = await createProject({
      lockfile: mutateLockfile((lockfile) => {
        lockfile.snapshots[snapshotKey] = [];
      })
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile snapshot must be a mapping"
    );
  });

  test.each([
    ["missing", workspaceManifest().replace(/\nallowBuilds:[\s\S]*$/, "")],
    ["missing git coordinate", workspaceManifest().replace(
      `  '${gitAllowBuildsKey}': true\n`,
      ""
    )],
    ["missing codeload coordinate", workspaceManifest().replace(
      `  '${tarballAllowBuildsKey}': true\n`,
      ""
    )],
    ["package-level", workspaceManifest().replace(allowBuildsKey, packageName)],
    ["another commit", workspaceManifest().replace(
      allowBuildsKey,
      allowBuildsKey.replace(commit, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    )],
    ["false", workspaceManifest().replace(`'${allowBuildsKey}': true`, `'${allowBuildsKey}': false`)],
    ["additional Arkme grant", workspaceManifest().replace(
      `  '${allowBuildsKey}': true`,
      `  '${allowBuildsKey}': true\n  '${packageName}': true`
    )]
  ])("rejects a %s Arkme allowBuilds configuration", async (_description, manifest) => {
    const project = await createProject({ workspaceManifest: manifest });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "allowBuilds must contain exactly the pinned Arkme build grant"
    );
  });

  test("rejects a missing package resolution", async () => {
    const project = await createProject({
      lockfile: lockfileManifest().replace(
        /\npackages:\n[\s\S]*?(?=\nsnapshots:)/,
        "\npackages:\n"
      )
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile package resolution is missing"
    );
  });

  test("rejects a missing snapshot for the runtime resolution", async () => {
    const project = await createProject({
      lockfile: lockfileManifest().replace(/\nsnapshots:[\s\S]*$/, "\nsnapshots:\n")
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      "lockfile snapshot is missing"
    );
  });

  test("reports both commits when the package resolution differs from the catalog", async () => {
    const resolvedCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const project = await createProject({
      lockfile: lockfileManifest().replace(
        `tar.gz/${commit}}`,
        `tar.gz/${resolvedCommit}}`
      )
    });

    await expect(readProductionPluginSource(project)).rejects.toThrow(
      new RegExp(`${commit}.*${resolvedCommit}`)
    );
  });

  test("preflights production source before reset/deploy and rereads after materialization", async () => {
    const source = validPackagedMetadata().expectedSource;
    const operations: string[] = [];
    let reads = 0;

    await expect(productionPluginSourceExtensions.stageRuntimeWithStableProductionSource({
      readSource: async () => {
        reads += 1;
        operations.push(reads === 1 ? "source:preflight" : "source:post-deploy");
        return structuredClone(source);
      },
      resetRuntime: async () => {
        operations.push("runtime:reset");
      },
      deployRuntime: async () => {
        operations.push("runtime:deploy");
      },
      materializeRuntime: async () => {
        operations.push("runtime:materialize");
      }
    })).resolves.toEqual(source);
    expect(operations).toEqual([
      "source:preflight",
      "runtime:reset",
      "runtime:deploy",
      "runtime:materialize",
      "source:post-deploy"
    ]);
  });

  test("rejects production source changed between preflight and post-deploy reread", async () => {
    const source = validPackagedMetadata().expectedSource;
    let reads = 0;

    await expect(productionPluginSourceExtensions.stageRuntimeWithStableProductionSource({
      readSource: async () => {
        reads += 1;
        return reads === 1
          ? structuredClone(source)
          : { ...source, packageVersion: "0.1.5" };
      },
      resetRuntime: async () => undefined,
      deployRuntime: async () => undefined,
      materializeRuntime: async () => undefined
    })).rejects.toThrow("production plugin source changed during runtime deployment");
    expect(reads).toBe(2);
  });

  test("verifies a self-contained runtime plugin and returns its manifest identity", async () => {
    const fixture = await createRuntimePlugin();

    await expect(verifyRuntimePlugin(fixture)).resolves.toEqual({
      packageName,
      packageVersion: "0.1.29"
    });
  });

  test.each([
    "package.json",
    "cordis.patch.yml",
    path.join("lib", "index.js"),
    path.join("lib", "client.js")
  ])("rejects a runtime plugin missing %s", async (relativePath) => {
    const fixture = await createRuntimePlugin();
    await rm(path.join(fixture.pluginDir, relativePath), { force: true });

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(relativePath);
  });

  test("rejects a runtime plugin with the wrong package name", async () => {
    const fixture = await createRuntimePlugin({ name: "@example/wrong-plugin" });

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      `runtime plugin package name must be ${packageName}`
    );
  });

  test("rejects a runtime plugin with an empty package version", async () => {
    const fixture = await createRuntimePlugin({ version: "" });

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      "runtime plugin package version must be a non-empty string"
    );
  });

  test("rejects a runtime plugin whose version differs from the production source", async () => {
    const fixture = await createRuntimePlugin({ version: "0.1.5" });

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      "runtime plugin package version must equal production source version 0.1.29"
    );
  });

  test("rejects a runtime plugin with the wrong bundle patch", async () => {
    const fixture = await createRuntimePlugin({ patch: "./wrong.patch.yml" });

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      "runtime plugin bundle patch must be ./cordis.patch.yml"
    );
  });

  test("rejects a runtime plugin directory outside the runtime root", async () => {
    const runtimeFixture = await createRuntimePlugin();
    const outsideFixture = await createRuntimePlugin();

    await expect(verifyRuntimePlugin({
      ...outsideFixture,
      runtimeRoot: runtimeFixture.runtimeRoot
    })).rejects.toThrow("runtime plugin must be contained within the runtime root");
  });

  test("rejects a runtime plugin that remains a symbolic link to outside the runtime", async () => {
    const runtimeFixture = await createRuntimePlugin();
    const outsideFixture = await createRuntimePlugin();
    await rm(runtimeFixture.pluginDir, { recursive: true, force: true });
    await symlink(outsideFixture.pluginDir, runtimeFixture.pluginDir, "junction");

    await expect(verifyRuntimePlugin(runtimeFixture)).rejects.toThrow(
      "runtime plugin must be a real directory, not a symbolic link"
    );
  });

  test("rejects a required runtime path that is a directory instead of a file", async () => {
    const fixture = await createRuntimePlugin();
    const patchPath = path.join(fixture.pluginDir, "cordis.patch.yml");
    await rm(patchPath, { force: true });
    await mkdir(patchPath);

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      "runtime plugin required path must be a regular file: cordis.patch.yml"
    );
  });

  test("rejects a required runtime file that is an external symbolic link", async () => {
    const fixture = await createRuntimePlugin();
    const outsideFile = path.join(path.dirname(fixture.runtimeRoot), "outside-client.js");
    const clientEntry = path.join(fixture.pluginDir, "lib", "client.js");
    await writeFile(outsideFile, "export {};\n");
    await rm(clientEntry);
    await symlink(outsideFile, clientEntry, "file");

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      "runtime plugin required path must be a regular file: lib/client.js"
    );
  });

  test("rejects an external directory symlink anywhere in the runtime plugin tree", async () => {
    const fixture = await createRuntimePlugin();
    const outsideDirectory = path.join(path.dirname(fixture.runtimeRoot), "outside-assets");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(fixture.pluginDir, "external-assets"), "dir");

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      "runtime plugin tree must not contain symbolic links: external-assets"
    );
  });

  test("rejects an internal symbolic link elsewhere in the runtime plugin tree", async () => {
    const fixture = await createRuntimePlugin();
    await writeFile(path.join(fixture.pluginDir, "README.md"), "fixture\n");
    await symlink(
      path.join(fixture.pluginDir, "README.md"),
      path.join(fixture.pluginDir, "README-LINK.md"),
      "file"
    );

    await expect(verifyRuntimePlugin(fixture)).rejects.toThrow(
      "runtime plugin tree must not contain symbolic links: README-LINK.md"
    );
  });

  test("writes exact formatted provenance from the verified production source", async () => {
    const fixture = await createRuntimePlugin();
    const provenancePath = await writePluginProvenance({
      pluginDir: fixture.pluginDir,
      source: fixture.source,
      packageVersion: "0.1.29"
    });

    expect(provenancePath).toBe(path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"));
    const provenanceText = await readFile(provenancePath, "utf8");
    expect(JSON.parse(provenanceText)).toEqual({
      schemaVersion: 1,
      source: "git",
      repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
      commit,
      packageName,
      packageVersion: "0.1.29"
    });
    expect(provenanceText).toBe(`${JSON.stringify({
      schemaVersion: 1,
      source: "git",
      repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
      commit,
      packageName,
      packageVersion: "0.1.29"
    }, null, 2)}\n`);
    expect(await provenanceTempFiles(fixture.pluginDir)).toEqual([]);
  });

  test("cleans the same-directory temporary provenance file when atomic publication fails", async () => {
    const fixture = await createRuntimePlugin();
    await mkdir(path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"));

    await expect(writePluginProvenance({
      pluginDir: fixture.pluginDir,
      source: fixture.source,
      packageVersion: "0.1.29"
    })).rejects.toThrow();
    expect(await provenanceTempFiles(fixture.pluginDir)).toEqual([]);
  });

  test("rejects provenance package version drift from the verified production source", async () => {
    const fixture = await createRuntimePlugin();

    await expect(writePluginProvenance({
      pluginDir: fixture.pluginDir,
      source: fixture.source,
      packageVersion: "0.1.5"
    })).rejects.toThrow("provenance package version must equal production source version 0.1.29");
    await expect(readFile(
      path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("prepares a runtime plugin in verify, provenance, import, final-validation order", async () => {
    const fixture = await createRuntimePlugin();
    const observations: string[] = [];

    const result = await prepareRuntimePlugin({
      ...fixture,
      importPlugin: async (pluginEntry) => {
        observations.push("import");
        expect(pluginEntry).toBe(path.join(fixture.pluginDir, "lib", "index.js"));
        const provenance = JSON.parse(await readFile(
          path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
          "utf8"
        ));
        expect(provenance.packageVersion).toBe("0.1.29");
      }
    });

    expect(observations).toEqual(["import"]);
    expect(result).toEqual({
      packageName,
      packageVersion: "0.1.29",
      provenancePath: path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json")
    });
    await expect(verifyRuntimePluginProvenance(fixture)).resolves.toEqual({
      packageName,
      packageVersion: "0.1.29"
    });
  });

  test("does not write provenance or import when runtime verification fails", async () => {
    const fixture = await createRuntimePlugin({ version: "0.1.5" });
    let imported = false;

    await expect(prepareRuntimePlugin({
      ...fixture,
      importPlugin: async () => {
        imported = true;
      }
    })).rejects.toThrow("runtime plugin package version must equal production source version");
    expect(imported).toBe(false);
    await expect(readFile(
      path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes provenance and propagates the original error when plugin import fails", async () => {
    const fixture = await createRuntimePlugin();
    const importError = new Error("fixture plugin import failed");

    await expect(prepareRuntimePlugin({
      ...fixture,
      importPlugin: async () => {
        throw importError;
      }
    })).rejects.toBe(importError);
    await expect(readFile(
      path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects provenance corrupted by the import smoke before preparation completes", async () => {
    const fixture = await createRuntimePlugin();

    await expect(prepareRuntimePlugin({
      ...fixture,
      importPlugin: async () => {
        await writeFile(
          path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
          JSON.stringify({ commit: "corrupted" })
        );
      }
    })).rejects.toThrow("runtime plugin source metadata is inconsistent");
    await expect(readFile(
      path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps provenance only after the complete late runtime transaction succeeds", async () => {
    const fixture = await createRuntimePlugin();
    const operations: string[] = [];

    const result = await productionPluginSourceExtensions.prepareRuntimePluginTransaction({
      ...fixture,
      importPlugin: async () => {
        operations.push("plugin:import");
      },
      finalizeRuntime: async () => {
        operations.push("runtime:worker-prune-rebuild");
        await expect(readFile(
          path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
          "utf8"
        )).resolves.toContain(`"commit": "${commit}"`);
      }
    });

    expect(operations).toEqual(["plugin:import", "runtime:worker-prune-rebuild"]);
    expect(result.provenancePath).toBe(
      path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json")
    );
    await expect(readFile(result.provenancePath, "utf8")).resolves.toContain(
      `"commit": "${commit}"`
    );
    expect(await provenanceTempFiles(fixture.pluginDir)).toEqual([]);
  });

  test("rolls provenance back when a late worker/prune/rebuild operation fails", async () => {
    const fixture = await createRuntimePlugin();
    const rebuildError = new Error("fixture Electron rebuild failed");

    await expect(productionPluginSourceExtensions.prepareRuntimePluginTransaction({
      ...fixture,
      importPlugin: async () => undefined,
      finalizeRuntime: async () => {
        throw rebuildError;
      }
    })).rejects.toBe(rebuildError);
    await expect(readFile(
      path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(await provenanceTempFiles(fixture.pluginDir)).toEqual([]);
  });

  test("rolls provenance back when the transaction's final verification fails", async () => {
    const fixture = await createRuntimePlugin();

    await expect(productionPluginSourceExtensions.prepareRuntimePluginTransaction({
      ...fixture,
      importPlugin: async () => undefined,
      finalizeRuntime: async () => {
        await writeFile(
          path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
          JSON.stringify({ commit: "corrupted-after-rebuild" })
        );
      }
    })).rejects.toThrow("runtime plugin source metadata is inconsistent");
    await expect(readFile(
      path.join(fixture.pluginDir, "PLUGIN_PROVENANCE.json"),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(await provenanceTempFiles(fixture.pluginDir)).toEqual([]);
  });

  test("accepts packaged metadata only when manifest, provenance, and production source agree", () => {
    expect(() => validatePackagedPluginMetadata(validPackagedMetadata())).not.toThrow();
  });

  test.each([
    ["provenance schemaVersion", (input: PackagedMetadataInput) => {
      input.provenance.schemaVersion = 2;
    }],
    ["provenance source", (input: PackagedMetadataInput) => {
      input.provenance.source = "workspace";
    }],
    ["provenance repository", (input: PackagedMetadataInput) => {
      input.provenance.repository = "git@example.com:someone/fork.git";
    }],
    ["provenance commit", (input: PackagedMetadataInput) => {
      input.provenance.commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    }],
    ["provenance package name", (input: PackagedMetadataInput) => {
      input.provenance.packageName = "@example/wrong-plugin";
    }],
    ["provenance package version", (input: PackagedMetadataInput) => {
      input.provenance.packageVersion = "0.1.5";
    }],
    ["manifest name", (input: PackagedMetadataInput) => {
      input.manifest.name = "@example/wrong-plugin";
    }],
    ["manifest version", (input: PackagedMetadataInput) => {
      input.manifest.version = "0.1.5";
    }],
    ["expected source version", (input: PackagedMetadataInput) => {
      input.expectedSource.packageVersion = "0.1.5";
    }]
  ])("rejects packaged metadata drift in %s", (_description, mutate) => {
    const input = validPackagedMetadata();
    mutate(input);

    expect(() => validatePackagedPluginMetadata(input)).toThrow(
      "Packaged Arkme plugin source metadata is inconsistent"
    );
  });

  test("keeps runtime preparation on the tested production orchestration without vendor fallback", async () => {
    const [script, packagedSmoke] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts", "prepare-runtime.mjs"), "utf8"),
      readFile(path.join(process.cwd(), "scripts", "packaged-smoke.mjs"), "utf8")
    ]);
    const stagingStart = script.indexOf("await stageRuntimeWithStableProductionSource({");
    const stagingEnd = script.indexOf("\n\nawait assertRuntimeDependency", stagingStart);
    const stagingBlock = script.slice(stagingStart, stagingEnd);
    const transactionStart = script.indexOf("await prepareRuntimePluginTransaction({");
    const transactionEnd = script.indexOf("\n\nasync function run", transactionStart);
    const transactionBlock = script.slice(transactionStart, transactionEnd);
    const afterTransaction = script.slice(transactionEnd);

    expect(script).not.toContain(["vendor", "arkme-dsh-plugin"].join("/"));
    expect(script).not.toContain("materializeWorkspacePackage");
    expect(script).not.toContain(["UPSTREAM", "COMMIT"].join("_"));
    expect(script).toContain("await stageRuntimeWithStableProductionSource({");
    expect(script).toContain("readSource: () => readProductionPluginSource({");
    expect(stagingBlock).toContain("await rm(runtimeRoot");
    expect(stagingBlock).toContain("buildRuntimeDeployArgs({ storePath, runtimeRoot })");
    expect(stagingBlock).toContain("materializeRuntimeNodeModules(runtimeRoot)");
    expect(script).toContain("await prepareRuntimePluginTransaction({");
    expect(script).not.toContain("await prepareRuntimePlugin({");
    expect(script).not.toContain("await verifyRuntimePluginProvenance({");
    expect(transactionBlock).toContain("finalizeRuntime: async () => {");
    expect(transactionBlock).toContain("harness-runtime");
    expect(transactionBlock).toContain("disableNodePtySpectreMitigation");
    expect(transactionBlock).toContain("const directoryPickerWorker");
    expect(transactionBlock).toContain("await pruneRuntimeFiles(runtimeRoot)");
    expect(transactionBlock).toContain("buildElectronRebuildArgs({");
    expect(afterTransaction).not.toContain("const directoryPickerWorker");
    expect(afterTransaction).not.toContain("await pruneRuntimeFiles(runtimeRoot)");
    expect(afterTransaction).not.toContain("buildElectronRebuildArgs({");
    expect(packagedSmoke).toContain("release.artifacts.requiredPlugin.version");
    expect(packagedSmoke).toContain("state.probationReleaseId === undefined");
    expect(packagedSmoke).not.toContain("validatePackagedPluginMetadata({");
  });
});

function validPackagedMetadata(): PackagedMetadataInput {
  return {
    manifest: { name: packageName, version: "0.1.29" },
    provenance: {
      schemaVersion: 1,
      source: "git",
      repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
      commit,
      packageName,
      packageVersion: "0.1.29"
    },
    expectedSource: {
      packageName,
      packageVersion: "0.1.29",
      repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
      commit,
      dependencySpec
    }
  };
}

async function createRuntimePlugin(manifest: {
  name?: string;
  version?: string;
  patch?: string;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-runtime-plugin-"));
  temporaryDirectories.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const pluginDir = path.join(
    runtimeRoot,
    "node_modules",
    "@senguoyun",
    "dsh-arkme"
  );
  await mkdir(path.join(pluginDir, "lib"), { recursive: true });
  await Promise.all([
    writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
      name: manifest.name ?? packageName,
      version: manifest.version ?? "0.1.29",
      dsh: { bundle: { patch: manifest.patch ?? "./cordis.patch.yml" } }
    })),
    writeFile(path.join(pluginDir, "cordis.patch.yml"), "[]\n"),
    writeFile(path.join(pluginDir, "lib", "index.js"), "export {};\n"),
    writeFile(path.join(pluginDir, "lib", "client.js"), "export {};\n")
  ]);
  return {
    runtimeRoot,
    pluginDir,
    source: {
      packageName,
      packageVersion: "0.1.29",
      repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
      commit,
      dependencySpec
    }
  };
}

async function createProject(options: {
  workspaceManifest?: string;
  lockfile?: string;
  rootManifest?: object;
  runtimeManifest?: object;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-production-source-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "runtime"));

  const workspaceManifestPath = path.join(root, "pnpm-workspace.yaml");
  const lockfilePath = path.join(root, "pnpm-lock.yaml");
  await Promise.all([
    writeFile(workspaceManifestPath, options.workspaceManifest ?? workspaceManifest()),
    writeFile(lockfilePath, options.lockfile ?? lockfileManifest()),
    writeFile(path.join(root, "package.json"), JSON.stringify(
      options.rootManifest ?? { devDependencies: { [packageName]: "catalog:production" } }
    )),
    writeFile(path.join(root, "runtime", "package.json"), JSON.stringify(
      options.runtimeManifest ?? { dependencies: { [packageName]: "catalog:production" } }
    ))
  ]);

  return { workspaceManifestPath, lockfilePath };
}

function workspaceManifest(specifier = dependencySpec) {
  return realWorkspaceManifest.replace(dependencySpec, specifier);
}

function lockfileManifest() {
  return realLockfileManifest;
}

function rootImporterBlock() {
  return lockfileSection(realLockfileManifest, "  .:\n", "\n  runtime:\n");
}

function runtimeImporterBlock() {
  return lockfileSection(realLockfileManifest, "  runtime:\n", "\npackages:\n");
}

function mutateLockfile(mutate: (lockfile: LockfileFixture) => void) {
  const lockfile = parse(realLockfileManifest) as LockfileFixture;
  mutate(lockfile);
  return stringify(lockfile, { lineWidth: 0 });
}

function mutateWorkspaceManifest(mutate: (workspace: LockfileFixture) => void) {
  const workspace = parse(realWorkspaceManifest) as LockfileFixture;
  mutate(workspace);
  return stringify(workspace, { lineWidth: 0 });
}

function lockfileSection(text: string, startMarker: string, endMarker: string) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Cannot find lockfile section from ${startMarker.trim()}`);
  }
  return text.slice(start, end);
}

async function provenanceTempFiles(pluginDir: string) {
  return (await readdir(pluginDir)).filter((entry) => (
    entry.startsWith(".PLUGIN_PROVENANCE.json.") && entry.endsWith(".tmp")
  ));
}
