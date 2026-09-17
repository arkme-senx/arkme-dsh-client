import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DshAccountScopeLaunch } from "./dsh-account-scope.js";

export interface SelectionSender {
  webContentsId: number;
  isMainFrame: boolean;
  url: string;
}

interface SubagentAddress {
  parentSessionId: string;
  childSessionId: string;
  mode: "one-shot" | "continuable";
}
interface Selection {
  sessionId: string | null;
  subagentAddress?: SubagentAddress;
}
interface PreparedSelection extends Selection {
  ready: boolean;
  origin: string;
  file: string | null;
  writable: boolean;
  lease: string | null;
}

/** Main-process authority. Neither file paths nor account identities come from IPC. */
export class DesktopSessionSelection {
  private readonly pages = new Map<number, PreparedSelection>();
  private writeTail: Promise<void> = Promise.resolve();

  /** Revoke old documents immediately, including preparations still awaiting disk I/O. */
  invalidate(webContentsId?: number): void {
    if (webContentsId === undefined) this.pages.clear();
    else this.pages.delete(webContentsId);
  }

  async prepare(webContentsId: number, url: string, scope: DshAccountScopeLaunch, writable = true): Promise<boolean> {
    const state: PreparedSelection = {
      origin: new URL(url).origin,
      file: scope.owner.kind === "account" ? path.join(path.dirname(scope.settingsPath), "session-selection.json") : null,
      ready: false, writable, sessionId: null, lease: null
    };
    this.pages.set(webContentsId, state);
    // A reload must observe all previously acknowledged/accepted writes.
    await this.flush();
    if (state.file !== null) Object.assign(state, await readSelection(state.file));
    state.ready = true;
    return this.pages.get(webContentsId) === state;
  }

  /** Disk is read before navigation; preload's synchronous IPC only reads this tiny cache. */
  bootstrap(sender: SelectionSender): (Selection & { lease: string | null }) | null {
    const state = this.authorized(sender);
    if (state === undefined) return null;
    state.lease = state.writable && state.file !== null ? randomUUID() : null;
    return { lease: state.lease, sessionId: state.sessionId,
      ...(state.subagentAddress === undefined ? {} : { subagentAddress: { ...state.subagentAddress } }) };
  }

  async save(sender: SelectionSender, value: unknown): Promise<boolean> {
    const state = this.authorized(sender);
    if (state === undefined || state.file === null || state.lease === null || !isRecord(value)
      || value.lease !== state.lease) return false;
    const selection = parseSelection(value);
    if (selection === null) return false;
    // Capture the file and selection BEFORE awaiting. Account switches can never redirect this write.
    const file = state.file;
    const mutation = this.writeTail.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, ...selection, updatedAt: Date.now() })}\n`,
          { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
        delete state.subagentAddress;
        Object.assign(state, selection);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writeTail = mutation.catch(() => undefined);
    await mutation;
    return true;
  }

  async flush(): Promise<void> { await this.writeTail; }

  private authorized(sender: SelectionSender): PreparedSelection | undefined {
    if (!sender.isMainFrame) return undefined;
    const state = this.pages.get(sender.webContentsId);
    try { return state?.ready && state.origin === new URL(sender.url).origin ? state : undefined; }
    catch { return undefined; }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/u.test(value);
}

function parseSelection(value: Record<string, unknown>): Selection | null {
  if (!validSessionId(value.sessionId)) return null;
  if (value.subagentAddress === undefined) return { sessionId: value.sessionId };
  const address = value.subagentAddress;
  if (!isRecord(address) || !validSessionId(address.parentSessionId) || address.childSessionId !== value.sessionId
    || address.parentSessionId === address.childSessionId || (address.mode !== "one-shot" && address.mode !== "continuable")) return null;
  return { sessionId: value.sessionId, subagentAddress: {
    parentSessionId: address.parentSessionId, childSessionId: value.sessionId, mode: address.mode
  } };
}

async function readSelection(file: string): Promise<Selection> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { sessionId: null };
    // An unreadable disk is not proof that the previous selection is absent.
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { sessionId: null }; }
  return (isRecord(value) && value.version === 1 && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
    ? parseSelection(value) : null) ?? { sessionId: null };
}
