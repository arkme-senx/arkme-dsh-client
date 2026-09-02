import { readFile } from "node:fs/promises";

export const MAX_APP_VERSION_CODE = 2_147_483_647;

export function parseAppVersionCode(manifest: unknown): number {
  const versionCode = manifest && typeof manifest === "object"
    ? (manifest as { versionCode?: unknown }).versionCode
    : undefined;
  if (!Number.isSafeInteger(versionCode) || (versionCode as number) <= 0 || (versionCode as number) > MAX_APP_VERSION_CODE) {
    throw new Error("Arkme application Version Code must be a positive integer");
  }
  return versionCode as number;
}

export async function readAppVersionCode(manifestPath: string): Promise<number> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  return parseAppVersionCode(manifest);
}
