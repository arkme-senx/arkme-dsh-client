import electron from "electron";
import { fileURLToPath } from "node:url";
import { runDevelopment } from "./development-plugin.mjs";

await runDevelopment({
  projectRoot: fileURLToPath(new URL("..", import.meta.url)),
  workingDirectory: process.cwd(),
  environment: process.env,
  electronExecutable: electron
});
