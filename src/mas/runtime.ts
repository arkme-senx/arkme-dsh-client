import { existsSync, readFileSync } from "node:fs";
import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseElectronRuntimeManifest } from "../runtime/manifest.js";

export function isMasChannel(resources: string, packaged: boolean, mas: boolean): boolean {
  if (!packaged) return false;
  const marker = path.join(resources, "jiwo-mas.json");
  if (!existsSync(marker)) {
    if (mas) throw new Error("MAS_CHANNEL_MISSING: refusing website runtime fallback");
    return false;
  }
  const value = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
  if (!mas || value.schemaVersion !== 1 || value.distribution !== "mas" || value.policyRevision !== 2
    || value.appId !== "com.senqisi.Jotmo" || value.environment !== "prod") {
    throw new Error("MAS_CHANNEL_INVALID");
  }
  return true;
}

export async function resolveMasRuntime(resources: string, arch: string, version: string) {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`MAS_UNSUPPORTED_ARCH: ${arch}`);
  const frozen = JSON.parse(await readFile(path.join(resources, "frozen.json"), "utf8"));
  if (frozen.channel.version !== version) throw new Error("MAS_VERSION_MISMATCH");
  const manifest = parseElectronRuntimeManifest(frozen.manifests[arch], {
    os: "darwin", arch, shellVersion: version, electronMajor: 43, modulesAbi: 148
  }, { requiredShellVersionCode: frozen.channel.releaseSetShellVersionCode ?? frozen.channel.versionCode });
  const root = path.join(resources, "embedded", arch);
  const policy = JSON.parse(await readFile(path.join(root, "mas-policy.json"), "utf8"));
  if (policy.revision !== 2 || policy.pluginCodeUnmodified !== true || policy.credentialServicePrefix !== "com.senqisi.dsh-arkme.mas" || policy.releaseId !== manifest.releaseId) throw new Error("MAS_POLICY_MISMATCH");
  const dshBinPath = path.join(root, manifest.artifacts.harness.entry);
  const arkmePluginPath = path.join(root, manifest.artifacts.requiredPlugin.target);
  const packageManagerBinPath = path.join(root, "harness/node_modules/.bin");
  const packageManagerCliPath = path.join(root, "harness/node_modules/pnpm/bin/pnpm.cjs");
  await Promise.all([dshBinPath, path.join(arkmePluginPath, "lib/index.js"), packageManagerCliPath].map(file => access(file)));
  return { dshBinPath, arkmePluginPath, packageManagerBinPath, packageManagerCliPath, runtimeManaged: false };
}

// Bookmarks remain in the MAS container and are never imported from website settings.
export class MasBookmarks {
  private readonly releases = new Map<string, () => void>();
  constructor(private readonly filename: string, private readonly start: (bookmark: string) => () => void) {}
  async restore(): Promise<void> {
    let values: Record<string, string>;
    try { values = JSON.parse(await readFile(this.filename, "utf8")) as Record<string, string>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const [directory, bookmark] of Object.entries(values)) {
      try { this.releases.set(directory, this.start(bookmark)); }
      catch { /* Re-select the directory when its grant is revoked. */ }
    }
  }
  async remember(directory: string, bookmark: string): Promise<void> {
    let values: Record<string, string> = {};
    try { values = JSON.parse(await readFile(this.filename, "utf8")) as Record<string, string>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const release = this.start(bookmark);
    this.releases.get(directory)?.();
    this.releases.set(directory, release);
    values[directory] = bookmark;
    await mkdir(path.dirname(this.filename), { recursive: true });
    await writeFile(this.filename, JSON.stringify(values), { mode: 0o600 });
  }
  close(): void { for (const release of this.releases.values()) release(); this.releases.clear(); }
}
