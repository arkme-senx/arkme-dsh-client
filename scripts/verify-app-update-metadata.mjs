import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

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

if (metadata?.version !== manifest.version) {
  throw new Error(`${metadataName} version does not match package.json`);
}
if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
  throw new Error(`${metadataName} does not contain update files`);
}

const extension = platform === "darwin" ? ".zip" : ".exe";
const updateFile = metadata.files.find(file => typeof file?.url === "string" && file.url.endsWith(extension));
if (updateFile === undefined) throw new Error(`${metadataName} does not contain a ${extension} update package`);

const filename = path.basename(updateFile.url);
if (!new RegExp(`(?:^|[-_.])vc${manifest.versionCode}(?:[-_.]|$)`, "i").test(filename)) {
  throw new Error(`${filename} does not contain vc${manifest.versionCode}`);
}
const artifactPath = path.join(releaseDirectory, filename);
const artifact = await stat(artifactPath);
if (!Number.isSafeInteger(updateFile.size) || updateFile.size !== artifact.size) {
  throw new Error(`${metadataName} size does not match ${filename}`);
}
const digest = createHash("sha512").update(await readFile(artifactPath)).digest("base64");
if (typeof updateFile.sha512 !== "string" || updateFile.sha512 !== digest) {
  throw new Error(`${metadataName} SHA-512 does not match ${filename}`);
}

const expectedDownloadURL = argument("--download-url") ?? process.env.ARKME_UPDATE_DOWNLOAD_URL?.trim();
if (expectedDownloadURL) {
  const expected = new URL(expectedDownloadURL);
  const resolvedMetadataURL = new URL(updateFile.url, new URL(".", expected)).href;
  if (resolvedMetadataURL !== expected.href) {
    throw new Error("Published download URL does not exactly match update metadata");
  }
}

const files = await readdir(releaseDirectory);
const matchingArtifacts = files.filter(file => file === filename);
if (matchingArtifacts.length !== 1) throw new Error(`Expected exactly one ${filename} artifact`);

console.log(`Verified ${metadataName}: ${filename}, ${artifact.size} bytes, SHA-512 OK`);
