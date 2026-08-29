import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  buildRuntimePluginPackArgs,
  createRuntimePluginSeed
} from "../scripts/runtime-plugin-seed.mjs";

test("packs the already-built production plugin without rerunning lifecycle scripts", () => {
  expect(buildRuntimePluginPackArgs("/tmp/seed-output")).toEqual([
    "pack",
    "--config.ignore-scripts=true",
    "--pack-destination",
    "/tmp/seed-output"
  ]);
});

test("creates a fixed-name plugin seed and SHA-512 manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkme-seed-"));
  try {
    const pluginDir = path.join(root, "plugin");
    const seedDir = path.join(root, "seed");
    await mkdir(pluginDir);
    await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
      name: "@senguoyun/dsh-arkme",
      version: "0.1.17"
    }));
    const bytes = Buffer.from("valid packed plugin bytes");

    const manifest = await createRuntimePluginSeed({
      pluginDir,
      seedDir,
      pack: async directory => {
        const artifact = path.join(directory, "senguoyun-dsh-arkme-0.1.17.tgz");
        await writeFile(artifact, bytes);
        return artifact;
      }
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      packageName: "@senguoyun/dsh-arkme",
      version: "0.1.17",
      artifactFileName: "dsh-arkme.tgz",
      artifactSha512: createHash("sha512").update(bytes).digest("hex")
    });
    expect(await readFile(path.join(seedDir, "dsh-arkme.tgz"))).toEqual(bytes);
    expect(JSON.parse(await readFile(path.join(seedDir, "manifest.json"), "utf8")))
      .toEqual(manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
