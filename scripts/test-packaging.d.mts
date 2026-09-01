import type { DevelopmentCommand, DevelopmentPlugin } from "./development-plugin.mjs";

export interface TestPackagingOptions {
  projectRoot: string;
  workingDirectory: string;
  environment?: Record<string, string | undefined>;
  pnpmExecutable?: string;
  resolveInstalledPlugin?: () => string | Promise<string>;
  runCommand?: (command: DevelopmentCommand) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  log?: (message: string) => void;
}

export function buildTestPackagingCommands(options: {
  projectRoot: string;
  pluginPath: string;
  pnpmExecutable: string;
  environment?: Record<string, string>;
}): readonly DevelopmentCommand[];

export function buildTestAppAdHocSigningCommands(options: {
  projectRoot: string;
  appPath: string;
  environment?: Record<string, string>;
}): readonly DevelopmentCommand[];

export function buildTestPackagingSpawnEnvironment(
  commandEnvironment: Record<string, string> | undefined,
  inheritedEnvironment?: Record<string, string | undefined>
): Record<string, string | undefined> | undefined;

export function writePackagedTestPluginMarker(options: {
  appPath: string;
  plugin: Pick<DevelopmentPlugin, "path" | "version">;
}): Promise<void>;

export function runTestPackaging(options: TestPackagingOptions): Promise<{
  appPath: string;
  plugin: DevelopmentPlugin & { source: "local" };
}>;
