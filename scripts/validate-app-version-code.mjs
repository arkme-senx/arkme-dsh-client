import { readFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve("package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Number.isSafeInteger(manifest.versionCode) || manifest.versionCode <= 0 || manifest.versionCode > 2_147_483_647) {
  throw new Error("package.json versionCode must be a positive integer");
}
