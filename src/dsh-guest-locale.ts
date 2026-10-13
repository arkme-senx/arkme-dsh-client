import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, isMap, parseDocument } from "yaml";

/** Carry presentation across logout without copying account settings or secrets.
 * Harness remains the language owner, via its public settings.yaml locale.preference.
 * The target guest Harness is not running while the scope store switches to it.
 */
export async function inheritGuestLocale(sourceHome: string, guestHome: string): Promise<void> {
  let temporaryPath: string | undefined;
  try {
    const source = await readSettings(sourceHome);
    const preference: unknown = source.getIn(["locale", "preference"]);
    // Match the shipped Harness's open language-id schema, including language packs.
    if (preference !== undefined && (typeof preference !== "string"
      || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(preference))) {
      throw new Error("Invalid locale preference");
    }
    const target = await readSettings(guestHome);
    if (target.getIn(["locale", "preference"]) === preference) return;
    if (preference === undefined) target.deleteIn(["locale", "preference"]);
    else target.setIn(["locale", "preference"], preference);

    await mkdir(guestHome, { recursive: true });
    const targetPath = path.join(guestHome, "settings.yaml");
    temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, target.toString(), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch {
    // A presentation preference must never prevent credentials being revoked.
    // Do not log YAML parser errors: their excerpts can contain private settings.
    console.warn("Could not retain the login-screen language; existing settings were preserved.");
  } finally {
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readSettings(home: string): Promise<Document> {
  let text: string;
  try { text = await readFile(path.join(home, "settings.yaml"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Document({});
    throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) {
    throw new Error("Invalid settings document");
  }
  return document;
}
