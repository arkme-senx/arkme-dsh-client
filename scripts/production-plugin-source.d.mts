export interface ProductionPluginSource {
  packageName: string;
  packageVersion: string;
  repository: string;
  commit: string;
  dependencySpec: string;
}

export function assertProductionManifestReferencesCatalog(
  manifest: unknown,
  manifestName: "root" | "runtime"
): void;

export function readProductionPluginSource(options: {
  workspaceManifestPath: string;
  lockfilePath: string;
}): Promise<ProductionPluginSource>;

export function stageRuntimeWithStableProductionSource(options: {
  readSource: () => Promise<ProductionPluginSource>;
  resetRuntime: () => Promise<void>;
  deployRuntime: () => Promise<void>;
  materializeRuntime: () => Promise<void>;
}): Promise<ProductionPluginSource>;

export function verifyRuntimePlugin(options: {
  pluginDir: string;
  runtimeRoot: string;
  source: ProductionPluginSource;
}): Promise<{
  packageName: string;
  packageVersion: string;
}>;

export function writePluginProvenance(options: {
  pluginDir: string;
  source: ProductionPluginSource;
  packageVersion: string;
}): Promise<string>;

export function validatePackagedPluginMetadata(options: {
  manifest: unknown;
  provenance: unknown;
  expectedSource: ProductionPluginSource;
}): void;

export function verifyRuntimePluginProvenance(options: {
  pluginDir: string;
  runtimeRoot: string;
  source: ProductionPluginSource;
}): Promise<{
  packageName: string;
  packageVersion: string;
}>;

export function prepareRuntimePlugin(options: {
  pluginDir: string;
  runtimeRoot: string;
  source: ProductionPluginSource;
  importPlugin: (pluginEntry: string) => Promise<void>;
}): Promise<{
  packageName: string;
  packageVersion: string;
  provenancePath: string;
}>;

export function prepareRuntimePluginTransaction(options: {
  pluginDir: string;
  runtimeRoot: string;
  source: ProductionPluginSource;
  importPlugin: (pluginEntry: string) => Promise<void>;
  finalizeRuntime: () => Promise<void>;
}): Promise<{
  packageName: string;
  packageVersion: string;
  provenancePath: string;
}>;
