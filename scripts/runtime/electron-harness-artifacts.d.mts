import type { ElectronHarnessTarget } from "./electron-harness-lib.mjs";

export interface ElectronHarnessArtifact {
  target: ElectronHarnessTarget;
  version: string;
  buildId: string;
  runtime: {
    kind: "electron";
    electronVersion: "43.2.0";
    electronMajor: 43;
    modulesAbi: 148;
  };
  pnpmVersion: "11.19.0";
  file: string;
  sha256: string;
  size: number;
  unpackedSize: number;
}

export interface ElectronHarnessBuildResult {
  schemaVersion: 1;
  component: "electron-harness";
  builtAt: string;
  version: string;
  buildId: string;
  runtime: ElectronHarnessArtifact["runtime"];
  pnpmVersion: "11.19.0";
  artifacts: ElectronHarnessArtifact[];
}

export function cleanupElectronHarnessBuildPaths(options: {
  paths: Array<string | undefined>;
  suppressErrors: boolean;
  remove?: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  warn?: (message: string) => void;
}): Promise<void>;

export function prepareElectronHarnessTarget(options: {
  sourceModules: string;
  harnessRoot: string;
  target: ElectronHarnessTarget;
  version: string;
  buildId: string;
}): Promise<Record<string, unknown>>;

export function buildElectronHarnessArtifacts(options: {
  sourceModules: string;
  output: string;
  version: string;
  buildId: string;
}): Promise<ElectronHarnessBuildResult>;
