import { valid as validSemver } from "semver";

const VERSION = "43.2.0";
const MAJOR = 43;
const MODULES_ABI = 148;
const PNPM_VERSION = "11.19.0";

export function assertElectronHarnessVersion(version) {
  if (typeof version !== "string" || validSemver(version) !== version) {
    throw new Error(`Electron Harness version ${version}; expected an exact semver version`);
  }
}

export function assertElectronHarnessRuntime({ electronVersion, modulesAbi }) {
  if (electronVersion !== VERSION) {
    throw new Error(`Electron runtime version ${electronVersion}; expected ${VERSION}`);
  }
  if (String(modulesAbi) !== String(MODULES_ABI)) {
    throw new Error(`Electron modules ABI ${modulesAbi}; expected ${MODULES_ABI}`);
  }
}

export function resolveElectronHarnessTarget(platform, arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return { os: "darwin", arch };
  }
  if (platform === "win32" && arch === "x64") return { os: "windows", arch: "x64" };
  if (platform === "linux" && arch === "x64") return { os: "linux", arch: "x64", libc: "glibc" };
  throw new Error(`Unsupported Electron Harness target: ${platform}/${arch}`);
}

export function electronHarnessArtifactName(target, version) {
  const suffix = target.libc === undefined
    ? `${target.os}-${target.arch}`
    : `${target.os}-${target.arch}-${target.libc}`;
  return `harness-electron43-${suffix}-${version}.tar.zst`;
}

export function electronHarnessMetadata({ target, version, buildId }) {
  assertElectronHarnessVersion(version);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(buildId)) {
    throw new Error("Electron Harness buildId must be a portable non-empty identity");
  }
  return {
    schemaVersion: 1,
    component: "electron-harness",
    version,
    buildId,
    target,
    runtime: {
      kind: "electron",
      electronVersion: VERSION,
      electronMajor: MAJOR,
      modulesAbi: MODULES_ABI
    },
    pnpmVersion: PNPM_VERSION
  };
}
