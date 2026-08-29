export interface DevelopmentPlugin {
  path: string;
  source: "local" | "production";
  version: string;
}

export interface DevelopmentCommand {
  command: string;
  args: readonly string[];
  cwd: string;
  environment?: Record<string, string>;
}

export function resolveDevelopmentPlugin(options: {
  projectRoot: string;
  workingDirectory: string;
  environment: Record<string, string | undefined>;
  resolveInstalledPlugin: () => string | Promise<string>;
}): Promise<DevelopmentPlugin>;

export function resolveLocalTestPlugin(options: {
  projectRoot: string;
  workingDirectory: string;
  environment: Record<string, string | undefined>;
  resolveInstalledPlugin?: () => string | Promise<string>;
}): Promise<DevelopmentPlugin & { source: "local" }>;

export function buildDevelopmentCommands(options: {
  projectRoot: string;
  environment?: Record<string, string>;
  plugin: DevelopmentPlugin;
  pnpmExecutable: string;
  electronExecutable: string;
}): readonly DevelopmentCommand[];

export function runDevelopment(options: {
  projectRoot: string;
  workingDirectory: string;
  environment?: Record<string, string | undefined>;
  electronExecutable: string;
  resolveInstalledPlugin?: () => string | Promise<string>;
  pnpmExecutable?: string;
  platform?: NodeJS.Platform;
  runCommand?: (command: DevelopmentCommand) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  log?: (message: string) => void;
}): Promise<void>;
