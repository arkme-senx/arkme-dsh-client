import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

export type ManagedRestartPlanPreparation =
  | { kind: "absent" }
  | { kind: "retained" }
  | { kind: "archived"; archivePath: string };

export async function prepareManagedRestartPlan(
  planPath: string,
  expectedReleaseId: string
): Promise<ManagedRestartPlanPreparation> {
  let raw: string;
  try {
    raw = await readFile(planPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { kind: "absent" };
    throw error;
  }

  if (belongsToRelease(raw, expectedReleaseId)) return { kind: "retained" };

  const archiveDirectory = path.join(path.dirname(planPath), "restart-plan-archive");
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  const archivePath = path.join(
    archiveDirectory,
    `${path.basename(planPath, path.extname(planPath))}-${Date.now()}-${randomUUID()}.json`
  );
  try {
    await rename(planPath, archivePath);
  } catch (error) {
    if (isMissingFile(error)) return { kind: "absent" };
    throw error;
  }
  return { kind: "archived", archivePath };
}

function belongsToRelease(raw: string, expectedReleaseId: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && (parsed as { runtimeReleaseId?: unknown }).runtimeReleaseId === expectedReleaseId;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
