export type RuntimeArchitecture = "arm64" | "x64";

export function resolveRuntimeArchitecture(
  configuredArchitecture: string | undefined,
  hostArchitecture: string
): RuntimeArchitecture;

export function buildRuntimeEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  architecture: RuntimeArchitecture
): NodeJS.ProcessEnv;

export function runtimeDirectory(
  projectRoot: string,
  architecture: RuntimeArchitecture
): string;

export function resolvePackagedAppRoot(
  configuredPath: string | undefined,
  projectRoot: string
): string;

export function buildArchitectureLaunch(
  executable: string,
  args: string[],
  architecture: string | undefined
): { command: string; args: string[] };

export function pruneTargetSpecificNodePtyArtifacts(
  runtimeRoot: string
): Promise<void>;
