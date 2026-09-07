export declare function incompatibleShellNativeDependencyPaths(
  root: string,
  platform?: NodeJS.Platform
): string[];

export declare function pruneIncompatibleShellNativeDependencies(
  root?: string,
  platform?: NodeJS.Platform
): Promise<void>;
