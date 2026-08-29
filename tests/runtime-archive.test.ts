import { createZstdCompress } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, test } from "vitest";
import { pack } from "tar-stream";
import { extractTarZstd } from "../src/runtime/archive.js";
import {
  isDeterministicRuntimeArtifactError,
  RuntimeArtifactValidationError
} from "../src/runtime/errors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function archive(entries: Array<{ name: string; body?: string; type?: "file" | "symlink" }>): Promise<Buffer> {
  const tar = pack();
  for (const entry of entries) {
    if (entry.type === "symlink") tar.entry({ name: entry.name, type: "symlink", linkname: "target" });
    else tar.entry({ name: entry.name, mode: 0o755 }, entry.body ?? "");
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  await pipeline(tar, createZstdCompress(), sink);
  return Buffer.concat(chunks);
}

describe("runtime tar.zst extraction", () => {
  test("extracts regular portable paths and preserves executable bits", async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), "runtime-archive-"));
    temporaryDirectories.push(destination);
    const bytes = await archive([{ name: "harness/bin/run", body: "ok" }]);

    await extractTarZstd(bytes, destination, { maxEntries: 10, maxUnpackedBytes: 100 });

    await expect(readFile(path.join(destination, "harness", "bin", "run"), "utf8")).resolves.toBe("ok");
  });

  test.each([
    ["path traversal", [{ name: "../escape", body: "bad" }]],
    ["symlink", [{ name: "harness/link", type: "symlink" as const }]]
  ])("rejects %s entries", async (_name, entries) => {
    const destination = await mkdtemp(path.join(os.tmpdir(), "runtime-archive-unsafe-"));
    temporaryDirectories.push(destination);
    await expect(extractTarZstd(await archive(entries), destination)).rejects.toThrow(/unsafe|regular file|directory/i);
  });

  test("classifies an unreadable tar.zst as a deterministic artifact failure", async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), "runtime-archive-corrupt-"));
    temporaryDirectories.push(destination);

    await expect(extractTarZstd(Buffer.from("not-zstd"), destination))
      .rejects.toBeInstanceOf(RuntimeArtifactValidationError);
  });

  test("keeps a locally missing archive retryable instead of classifying the release as Bad", async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), "runtime-archive-missing-"));
    temporaryDirectories.push(destination);
    let failure: unknown;

    try {
      await extractTarZstd(path.join(destination, "missing.tar.zst"), destination);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "ENOENT" });
    expect(isDeterministicRuntimeArtifactError(failure)).toBe(false);
  });
});
