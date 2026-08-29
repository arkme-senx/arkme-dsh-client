import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTestPackaging } from "./test-packaging.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await runTestPackaging({
  projectRoot,
  workingDirectory: process.cwd()
});
