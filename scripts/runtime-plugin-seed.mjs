import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const PLUGIN_NAME = "@senguoyun/dsh-arkme";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const RUNTIME_PLUGIN_SEED_DIRECTORY = "arkme-plugin-seed";
export const RUNTIME_PLUGIN_SEED_MANIFEST = "manifest.json";
export const RUNTIME_PLUGIN_SEED_ARTIFACT = "dsh-arkme.tgz";

export function buildRuntimePluginPackArgs(destinationDirectory) {
  return [
    "pack",
    "--config.ignore-scripts=true",
    "--pack-destination",
    destinationDirectory
  ];
}

export async function createRuntimePluginSeed({ pluginDir, seedDir, pack }) {
  const pluginManifest = JSON.parse(
    await readFile(path.join(pluginDir, "package.json"), "utf8")
  );
  if (
    pluginManifest.name !== PLUGIN_NAME
    || typeof pluginManifest.version !== "string"
    || !VERSION_PATTERN.test(pluginManifest.version)
  ) {
    throw new Error("runtime plugin seed package metadata is invalid");
  }

  const seedParent = path.dirname(seedDir);
  await mkdir(seedParent, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(seedParent, ".arkme-plugin-seed-pack-")
  );
  const nextDirectory = `${seedDir}.next-${process.pid}-${randomUUID()}`;
  try {
    const producedArtifact = path.resolve(await pack(temporaryDirectory));
    const relativeArtifact = path.relative(temporaryDirectory, producedArtifact);
    if (
      relativeArtifact === ".."
      || relativeArtifact.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeArtifact)
    ) {
      throw new Error("runtime plugin seed pack output escaped its temporary directory");
    }

    const artifactBytes = await readFile(producedArtifact);
    const manifest = {
      schemaVersion: 1,
      packageName: PLUGIN_NAME,
      version: pluginManifest.version,
      artifactFileName: RUNTIME_PLUGIN_SEED_ARTIFACT,
      artifactSha512: createHash("sha512").update(artifactBytes).digest("hex")
    };

    await mkdir(nextDirectory, { recursive: false });
    await copyFile(
      producedArtifact,
      path.join(nextDirectory, RUNTIME_PLUGIN_SEED_ARTIFACT)
    );
    await writeFile(
      path.join(nextDirectory, RUNTIME_PLUGIN_SEED_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" }
    );
    await rm(seedDir, { recursive: true, force: true });
    await rename(nextDirectory, seedDir);
    return manifest;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await rm(nextDirectory, { recursive: true, force: true });
  }
}
