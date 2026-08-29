export function assertRuntimeFreeResources(resourcesPath: string): Promise<void>;
export function assertRuntimeFreePaths(paths: string[]): void;
export function normalizeArchivePath(relativePath: string): string;
export function resolvePackagedSmokeEnvironment(rawConfig: string | Buffer): {
  environment: "prod" | "test";
  userDataDirectoryName: "Arkme Harness" | "Arkme Harness Test";
};
