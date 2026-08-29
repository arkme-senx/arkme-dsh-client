import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { Arch } from "electron-builder";
import {
  resolveRuntimeArchitecture,
  runtimeDirectory
} from "./runtime-architecture.mjs";

export default async function selectRuntimeBeforePack(context) {
  const projectRoot = context.packager.projectDir;
  const architecture = resolveRuntimeArchitecture(Arch[context.arch], process.arch);
  const source = runtimeDirectory(projectRoot, architecture);
  const destination = path.join(projectRoot, ".runtime", "dsh");

  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}
