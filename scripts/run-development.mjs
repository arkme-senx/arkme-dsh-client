import electron from "electron";
import { fileURLToPath } from "node:url";
import { runDevelopment } from "./development-plugin.mjs";

import { verifyElectronRuntime } from "./verify-electron-runtime.mjs";

await verifyElectronRuntime();
await runDevelopment({
  projectRoot: fileURLToPath(new URL("..", import.meta.url)),
  workingDirectory: process.cwd(),
  environment: process.env,
  electronExecutable: electron
});
