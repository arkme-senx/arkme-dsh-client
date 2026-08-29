import path from "node:path";
import { cp, mkdir, rename, rm } from "node:fs/promises";

const supportedRuntimeArchitectures = new Set(["arm64", "x64"]);

export function resolveRuntimeArchitecture(configuredArchitecture, hostArchitecture) {
  const architecture = configuredArchitecture ?? hostArchitecture;
  if (!supportedRuntimeArchitectures.has(architecture)) {
    throw new Error(`Unsupported runtime architecture: ${architecture}`);
  }
  return architecture;
}

export function buildRuntimeEnvironment(environment, architecture) {
  return {
    ...environment,
    npm_config_arch: architecture,
    npm_config_cpu: architecture
  };
}

export function runtimeDirectory(projectRoot, architecture) {
  return path.join(projectRoot, ".runtime", `dsh-${architecture}`);
}

export function resolvePackagedAppRoot(configuredPath, projectRoot) {
  return path.resolve(
    projectRoot,
    configuredPath ?? "release/mac-arm64/arkme.app"
  );
}

export function buildArchitectureLaunch(executable, args, architecture) {
  if (architecture === undefined || architecture === "") {
    return { command: executable, args };
  }
  const resolvedArchitecture = resolveRuntimeArchitecture(architecture, process.arch);
  return {
    command: "/usr/bin/arch",
    args: [resolvedArchitecture === "x64" ? "-x86_64" : "-arm64", executable, ...args]
  };
}

export async function pruneTargetSpecificNodePtyArtifacts(runtimeRoot) {
  const nodePtyRoot = path.join(runtimeRoot, "node_modules", "node-pty");
  const buildRoot = path.join(nodePtyRoot, "build");
  const releaseRoot = path.join(buildRoot, "Release");
  const stagingRoot = path.join(nodePtyRoot, ".runtime-binaries");
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  try {
    for (const name of ["pty.node", "spawn-helper"]) {
      await cp(path.join(releaseRoot, name), path.join(stagingRoot, name));
    }
    await rm(buildRoot, { recursive: true, force: true });
    await mkdir(releaseRoot, { recursive: true });
    for (const name of ["pty.node", "spawn-helper"]) {
      await rename(path.join(stagingRoot, name), path.join(releaseRoot, name));
    }
    await rm(path.join(nodePtyRoot, "node-addon-api"), {
      recursive: true,
      force: true
    });
    await rm(path.join(nodePtyRoot, "bin"), { recursive: true, force: true });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
