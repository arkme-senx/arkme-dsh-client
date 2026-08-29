import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { extract, type Headers } from "tar-stream";
import { RuntimeArtifactValidationError, runtimeFailureScope } from "./errors.js";

export interface RuntimeArchiveLimits {
  maxEntries?: number;
  maxUnpackedBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 500_000;
const DEFAULT_MAX_UNPACKED_BYTES = 12 * 1024 * 1024 * 1024;

export async function extractTarZstd(
  source: Buffer | string,
  destination: string,
  limits: RuntimeArchiveLimits = {}
): Promise<void> {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxUnpackedBytes = limits.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(maxUnpackedBytes) || maxUnpackedBytes <= 0) {
    throw new Error("Runtime archive limits are invalid");
  }
  await mkdir(destination, { recursive: true });
  const unpack = extract();
  let entries = 0;
  let unpackedBytes = 0;
  let entryFailure: Error | undefined;

  unpack.on("entry", (header, stream, next) => {
    void handleEntry(header, stream).then(next, error => {
      entryFailure = error instanceof Error ? error : new Error(String(error));
      stream.resume();
      next(entryFailure);
    });
  });

  const handleEntry = async (header: Headers, stream: NodeJS.ReadableStream): Promise<void> => {
    entries += 1;
    if (entries > maxEntries) throw new RuntimeArtifactValidationError("ARCHIVE_ENTRY_LIMIT", `Runtime archive exceeds ${maxEntries} entries`, "install");
    const relativePath = validatePortableArchivePath(header.name, header.type === "directory");
    if (header.type !== "file" && header.type !== "directory") {
      throw new RuntimeArtifactValidationError("ARCHIVE_ENTRY_TYPE_INVALID", `Runtime archive entry ${relativePath} is not a regular file or directory`, "install");
    }
    const size = header.size ?? 0;
    if (size < 0 || unpackedBytes > maxUnpackedBytes - size) {
      throw new RuntimeArtifactValidationError("ARCHIVE_SIZE_LIMIT", `Runtime archive exceeds ${maxUnpackedBytes} unpacked bytes`, "install");
    }
    unpackedBytes += size;
    const outputPath = path.join(destination, ...relativePath.split("/"));
    if (header.type === "directory") {
      await mkdir(outputPath, { recursive: true, mode: 0o755 });
      stream.resume();
      return;
    }
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o755 });
    const mode = (header.mode ?? 0) & 0o111 ? 0o755 : 0o644;
    await pipeline(stream, createWriteStream(outputPath, { flags: "wx", mode }));
  };

  const input = Buffer.isBuffer(source) ? Readable.from(source) : createReadStream(source);
  try {
    await pipeline(input, createZstdDecompress(), unpack);
  } catch (error) {
    const failure = entryFailure ?? error;
    if (
      failure instanceof RuntimeArtifactValidationError
      || runtimeFailureScope(failure) === "environment"
      || isMissingFile(failure)
    ) {
      throw failure;
    }
    throw new RuntimeArtifactValidationError(
      "ARCHIVE_INVALID",
      "Runtime archive could not be decoded as tar.zst",
      "install",
      { cause: failure }
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function validatePortableArchivePath(rawName: string, directory: boolean): string {
  const name = directory ? rawName.replace(/\/$/, "") : rawName;
  if (
    name === ""
    || name.includes("\\")
    || name.startsWith("/")
    || /^[A-Za-z]:/.test(name)
    || name.includes("\0")
  ) {
    throw new RuntimeArtifactValidationError("ARCHIVE_PATH_INVALID", "Runtime archive contains an unsafe path", "install");
  }
  const normalized = path.posix.normalize(name);
  if (normalized !== name || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new RuntimeArtifactValidationError("ARCHIVE_PATH_TRAVERSAL", "Runtime archive contains an unsafe path traversal entry", "install");
  }
  return normalized;
}
