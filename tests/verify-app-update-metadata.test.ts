import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/verify-app-update-metadata.mjs", import.meta.url));
const roots: string[] = [];
const bytes = Buffer.from("test update payload");
const sha512 = createHash("sha512").update(bytes).digest("base64");
const feedURL = "https://updates.example.test/0.2.6-vc3/";

async function fixture(platform: "darwin" | "win32", overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkme-update-metadata-test-"));
  roots.push(root);
  const filename = platform === "darwin" ? "arkme-0.2.6-vc3-universal.zip" : "arkme-0.2.6-vc3-x64.exe";
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.2.6", versionCode: 3 }));
  await writeFile(path.join(root, filename), bytes);
  await writeFile(path.join(root, platform === "darwin" ? "latest-mac.yml" : "latest.yml"), stringify({
    version: "0.2.6",
    files: [
      { url: platform === "darwin" ? "arkme.dmg" : "arkme-portable.zip", sha512, size: bytes.length },
      { url: filename, sha512, size: bytes.length, ...overrides },
    ],
  }));
  return { root, filename };
}

function verify(root: string, platform: string, extra: string[] = []) {
  const { ARKME_UPDATE_DOWNLOAD_URL: _old, ARKME_UPDATE_FEED_URL: _feed, ...env } = process.env;
  return exec(process.execPath, [script, "--platform", platform, "--release-dir", root, "--update-feed-url", feedURL, ...extra], { cwd: root, env });
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("release metadata verification CLI", () => {
  test.each(["darwin", "win32"] as const)("verifies %s update payload against the feed without a website URL", async platform => {
    const { root, filename } = await fixture(platform);
    await expect(verify(root, platform)).resolves.toMatchObject({ stdout: expect.stringContaining(`${filename}, ${bytes.length} bytes, SHA-512 OK`) });
  });

  test("accepts an absolute update artifact URL inside the feed", async () => {
    const { root } = await fixture("darwin", { url: `${feedURL}arkme-0.2.6-vc3-universal.zip` });
    await expect(verify(root, "darwin")).resolves.toMatchObject({ stdout: expect.stringContaining("SHA-512 OK") });
  });

  test.each([
    { overrides: { size: 999 }, message: /size does not match/ },
    { overrides: { sha512: Buffer.alloc(64, 2).toString("base64") }, message: /SHA-512 does not match/ },
    { overrides: { url: "arkme-0.2.6-vc2-universal.zip" }, message: /Version Code/ },
    { overrides: { url: "https://other.example.test/arkme-0.2.6-vc3.zip" }, message: /不在自动更新目录/ },
  ])("rejects invalid release artifact $overrides", async ({ overrides, message }) => {
    const { root } = await fixture("darwin", overrides);
    await expect(verify(root, "darwin")).rejects.toThrow(message);
  });

  test("explains the replacement for the obsolete website URL validation flag", async () => {
    const { root } = await fixture("darwin");
    await expect(verify(root, "darwin", ["--download-url", "https://downloads.example.test/arkme.dmg.zip"])).rejects.toThrow(/Website download URLs are independent/);
  });
});
