import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { resolveAppUpdateMetadata } from "../src/app-update-metadata.ts";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const platform = argument("--platform");
if (platform !== "darwin" && platform !== "win32") {
  throw new Error("--platform must be darwin or win32");
}
const releaseDirectory = path.resolve(argument("--release-dir") ?? "release");
const metadataName = platform === "darwin" ? "latest-mac.yml" : "latest.yml";
const metadataPath = path.join(releaseDirectory, metadataName);
const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const metadata = parse(await readFile(metadataPath, "utf8"));

if (argument("--download-url") || process.env.ARKME_UPDATE_DOWNLOAD_URL?.trim()) {
  throw new Error("Website download URLs are independent of updates; use --update-feed-url / ARKME_UPDATE_FEED_URL instead of --download-url / ARKME_UPDATE_DOWNLOAD_URL");
}
const feedURL = argument("--update-feed-url") ?? (process.env.ARKME_UPDATE_FEED_URL?.trim() || "https://updates.invalid/");
const { file: updateFile, url: updateURL, filename } = resolveAppUpdateMetadata(metadata, {
  version: manifest.version,
  versionCode: manifest.versionCode,
  feedURL,
  platform,
  arch: platform === "darwin" ? "arm64" : "x64",
});
const relativePath = decodeURIComponent(updateURL.pathname.slice(new URL(feedURL).pathname.length));
const artifactPath = path.join(releaseDirectory, relativePath);
const artifact = await stat(artifactPath);
if (!Number.isSafeInteger(updateFile.size) || updateFile.size !== artifact.size) {
  throw new Error(`${metadataName} size does not match ${filename}`);
}
const digest = createHash("sha512").update(await readFile(artifactPath)).digest("base64");
if (typeof updateFile.sha512 !== "string" || updateFile.sha512 !== digest) {
  throw new Error(`${metadataName} SHA-512 does not match ${filename}`);
}

const files = await readdir(path.dirname(artifactPath));
const matchingArtifacts = files.filter(file => file === filename);
if (matchingArtifacts.length !== 1) throw new Error(`Expected exactly one ${filename} artifact`);

console.log(`Verified ${metadataName}: ${filename}, ${artifact.size} bytes, SHA-512 OK`);
