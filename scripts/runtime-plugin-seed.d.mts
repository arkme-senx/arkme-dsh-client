export interface RuntimePluginSeedManifest {
  schemaVersion: 1;
  packageName: "@senguoyun/dsh-arkme";
  version: string;
  artifactFileName: "dsh-arkme.tgz";
  artifactSha512: string;
}

export const RUNTIME_PLUGIN_SEED_DIRECTORY: "arkme-plugin-seed";
export const RUNTIME_PLUGIN_SEED_MANIFEST: "manifest.json";
export const RUNTIME_PLUGIN_SEED_ARTIFACT: "dsh-arkme.tgz";

export function buildRuntimePluginPackArgs(destinationDirectory: string): string[];

export function createRuntimePluginSeed(options: {
  pluginDir: string;
  seedDir: string;
  pack: (destinationDirectory: string) => Promise<string>;
}): Promise<RuntimePluginSeedManifest>;
