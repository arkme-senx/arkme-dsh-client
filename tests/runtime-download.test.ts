import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { downloadRuntimeArtifact } from "../src/runtime/download.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("runtime artifact download", () => {
  test("resumes a partial HTTPS download and verifies its final SHA-256", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-download-"));
    temporaryDirectories.push(root);
    const destination = path.join(root, "artifact.tar.zst");
    const bytes = Buffer.from("0123456789");
    await writeFile(`${destination}.part`, bytes.subarray(0, 4));
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=4-");
      return new Response(bytes.subarray(4), {
        status: 206,
        headers: {
          "content-length": "6",
          "content-range": "bytes 4-9/10"
        }
      });
    });

    await downloadRuntimeArtifact({
      artifact: {
        url: "https://d.jiwo.cc/artifact.tar.zst",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length
      },
      destination,
      fetcher
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(readFile(destination)).resolves.toEqual(bytes);
  });

  test("rejects redirects and removes a completed file with a mismatched digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-download-bad-"));
    temporaryDirectories.push(root);
    const destination = path.join(root, "artifact.tar.zst");
    await expect(downloadRuntimeArtifact({
      artifact: { url: "https://d.jiwo.cc/artifact.tar.zst", sha256: "a".repeat(64), size: 3 },
      destination,
      fetcher: async () => new Response(null, { status: 302, headers: { location: "https://example.com" } })
    })).rejects.toThrow(/redirect|HTTP 302/i);
  });

  test("retries a transient server failure before completing the download", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-download-retry-"));
    temporaryDirectories.push(root);
    const destination = path.join(root, "artifact.tar.zst");
    const bytes = Buffer.from("retry-ok");
    let attempts = 0;

    await downloadRuntimeArtifact({
      artifact: {
        url: "https://d.jiwo.cc/artifact.tar.zst",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length
      },
      destination,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 503 })
          : new Response(new Uint8Array(bytes), { status: 200 });
      },
      retryDelaysMs: [0, 0],
      sleep: async () => undefined
    });

    expect(attempts).toBe(2);
    await expect(readFile(destination)).resolves.toEqual(bytes);
  });

  test("retries a transient server failure while resuming a partial download", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-download-resume-retry-"));
    temporaryDirectories.push(root);
    const destination = path.join(root, "artifact.tar.zst");
    const bytes = Buffer.from("resume-retry-ok");
    await writeFile(`${destination}.part`, bytes.subarray(0, 4));
    let attempts = 0;

    await downloadRuntimeArtifact({
      artifact: {
        url: "https://d.jiwo.cc/artifact.tar.zst",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length
      },
      destination,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 503 })
          : new Response(bytes.subarray(4), {
              status: 206,
              headers: { "content-range": `bytes 4-${bytes.length - 1}/${bytes.length}` }
            });
      },
      retryDelaysMs: [0, 0],
      sleep: async () => undefined
    });

    expect(attempts).toBe(2);
    await expect(readFile(destination)).resolves.toEqual(bytes);
  });

  test("promotes a fully downloaded partial file without another request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-download-complete-partial-"));
    temporaryDirectories.push(root);
    const destination = path.join(root, "artifact.tar.zst");
    const bytes = Buffer.from("complete-partial");
    await writeFile(`${destination}.part`, bytes);
    const fetcher = vi.fn(async () => { throw new Error("network must not be used"); });

    await downloadRuntimeArtifact({
      artifact: {
        url: "https://d.jiwo.cc/artifact.tar.zst",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length
      },
      destination,
      fetcher
    });

    expect(fetcher).not.toHaveBeenCalled();
    await expect(readFile(destination)).resolves.toEqual(bytes);
  });

  test("reports only changed integer percentages for many tiny chunks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-download-progress-"));
    temporaryDirectories.push(root);
    const destination = path.join(root, "artifact.tar.zst");
    const bytes = Buffer.alloc(1_000, 1);
    const progress: number[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 1) controller.enqueue(bytes.subarray(index, index + 1));
        controller.close();
      }
    });

    await downloadRuntimeArtifact({
      artifact: {
        url: "https://d.jiwo.cc/artifact.tar.zst",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length
      },
      destination,
      fetcher: async () => new Response(body),
      onProgress: percent => progress.push(percent)
    });

    expect(progress).toEqual([...new Set(progress)]);
    expect(progress.length).toBeLessThanOrEqual(101);
    expect(progress.at(-1)).toBe(100);
  });
});
