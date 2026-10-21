import type { LocalPluginSource } from './production-plugin-source.mjs';
export function assertRuntimePluginReady(manifest: unknown, harnessVersion?: string): void;
export function stageLocalRuntimePlugin(options: { localPluginDir: string; pluginDir: string }): Promise<LocalPluginSource>;
