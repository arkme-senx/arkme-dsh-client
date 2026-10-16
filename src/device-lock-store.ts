import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";

export interface LockReport { sequence: number; actual_lock: "locked" | "unlocked"; lock_cycle: string; operation_id?: string; not_applied?: boolean; unlock_source?: "native" }
export interface LockBinding { userId: number; clientId: number; sessionId: string; cleanupToken: string }
export interface PersistedDeviceLock {
  schemaVersion: 1;
  locked: boolean;
  ended: boolean;
  cycle: string;
  sequence: number;
  binding?: LockBinding;
  pendingReport?: LockReport;
  pendingCleanup?: LockBinding;
}
export interface DeviceLockStore { read(): PersistedDeviceLock | undefined; write(state: PersistedDeviceLock): void }

export class FileDeviceLockStore implements DeviceLockStore {
  constructor(private readonly file: string) {}
  read(): PersistedDeviceLock | undefined {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (raw.length > 16_384) throw new Error("锁定状态文件无效");
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") throw new Error("锁定状态文件无效");
    const state = value as PersistedDeviceLock;
    if (state.schemaVersion !== 1 || typeof state.locked !== "boolean" || typeof state.ended !== "boolean"
      || !/^[A-Za-z0-9_-]{16,128}$/.test(state.cycle) || !Number.isSafeInteger(state.sequence) || state.sequence < 0) throw new Error("锁定状态文件无效");
    for (const identity of [state.binding, state.pendingCleanup]) {
      if (identity !== undefined && (!Number.isSafeInteger(identity.userId) || identity.userId <= 0
        || !Number.isSafeInteger(identity.clientId) || identity.clientId <= 0
        || !/^[A-Za-z0-9_-]{16,128}$/.test(identity.sessionId) || !/^[a-f0-9]{64}$/.test(identity.cleanupToken))) throw new Error("锁定会话文件无效");
    }
    if (state.pendingReport !== undefined && (state.pendingReport.sequence !== state.sequence
      || state.pendingReport.lock_cycle !== state.cycle || state.pendingReport.actual_lock !== (state.locked ? "locked" : "unlocked"))) throw new Error("锁定回执文件无效");
    if (state.pendingReport?.unlock_source !== undefined && (state.pendingReport.unlock_source !== "native"
      || state.pendingReport.actual_lock !== "unlocked" || state.pendingReport.operation_id !== undefined || state.pendingReport.not_applied)) throw new Error("锁定回执文件无效");
    return state;
  }
  write(state: PersistedDeviceLock): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    const descriptor = openSync(temporary, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, this.file);
  }
}
