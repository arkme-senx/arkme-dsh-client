import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveRuntimeEnvironment,
  resolveRuntimeServiceOrigin
} from "../dist/runtime/service-config.js";

const source = path.resolve("src", "ui");
const destination = path.resolve("dist", "ui");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
const serviceBaseUrl = resolveRuntimeServiceOrigin(process.env.ARKME_RUNTIME_SERVICE_BASE_URL);
await writeFile(
  path.resolve("dist", "runtime-service-config.json"),
  `${JSON.stringify({
    environment: resolveRuntimeEnvironment(serviceBaseUrl),
    serviceBaseUrl
  }, null, 2)}\n`
);
