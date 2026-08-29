export interface ElectronHarnessTarget {
  os: "darwin" | "windows" | "linux";
  arch: "arm64" | "x64";
  libc?: "glibc";
}

export function assertElectronHarnessVersion(version: string): void;
export function assertElectronHarnessRuntime(options: {
  electronVersion: string | undefined;
  modulesAbi: string | number | undefined;
}): void;
export function resolveElectronHarnessTarget(platform: string, arch: string): ElectronHarnessTarget;
export function electronHarnessArtifactName(target: ElectronHarnessTarget, version: string): string;
export function electronHarnessMetadata(options: {
  target: ElectronHarnessTarget;
  version: string;
  buildId: string;
}): Record<string, unknown>;
