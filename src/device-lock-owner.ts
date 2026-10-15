import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DeviceLockStore, LockBinding, LockReport, PersistedDeviceLock } from "./device-lock-store.js";

interface Operation { id: string; kind: "lock" | "unlock" | "logout"; state: string; session_id: string; lock_cycle: string; next_lock_cycle?: string; authorization: string; expires_at: number; dispatched_at: number }
interface Device { client_id: number; session_id: string; actual_lock?: "locked" | "unlocked"; lock_cycle?: string; report_sequence: number; operation?: Operation }
export interface DeviceLockSnapshot {
  supported: boolean; locked: boolean; sessionEnded: boolean; needsCredentials: boolean;
  platform: "macos" | "windows"; message: string; operationState?: string;
  sessionId?: string; userId?: number; clientId?: number;
}
interface Options {
  store: DeviceLockStore;
  baseURL: string;
  platform: "macos" | "windows";
  name: string;
  authenticate(signal: AbortSignal): Promise<boolean>;
  available(): Promise<boolean>;
  changed(snapshot: DeviceLockSnapshot): void;
  fetch?: typeof fetch;
  now?: () => number;
}

export class DesktopDeviceLockOwner {
  private state: PersistedDeviceLock;
  private token = "";
  private available = false;
  private needsCredentials = false;
  private message = "";
  private operationState: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private syncTask: Promise<DeviceLockSnapshot> | undefined;
  private authentication: AbortController | undefined;
  private fence = 0;
  private readonly now: () => number;
  private clock: { server: number; monotonic: number } | undefined;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? fetch;
    const initial: PersistedDeviceLock = { schemaVersion: 1, locked: false, ended: false, cycle: randomBytes(24).toString("hex"), sequence: 0 };
    try { this.state = options.store.read() ?? initial; }
    catch { this.state = { ...initial, locked: true }; this.message = "正在恢复锁定状态"; }
    const url = new URL(options.baseURL);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.port !== "" || ![ "api.jotmo.cc", "jotmo.senguo.me"].includes(url.hostname)) throw new Error("Invalid device control authority");
  }

  get protected(): boolean { return this.state.locked || this.state.ended; }
  snapshot(): DeviceLockSnapshot {
    return { supported: this.available, locked: this.protected, sessionEnded: this.state.ended,
      needsCredentials: this.needsCredentials, platform: this.options.platform, message: this.message,
      ...(this.operationState === undefined ? {} : { operationState: this.operationState }),
      ...(this.state.binding === undefined ? {} : { sessionId: this.state.binding.sessionId, userId: this.state.binding.userId, clientId: this.state.binding.clientId }) };
  }
  async initialize(): Promise<void> { this.available = await this.options.available(); this.emit(); }
  private emit(): void { this.options.changed(this.snapshot()); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work);
    this.tail = task.catch(error => {
      if (!this.state.ended) { this.message = error instanceof Error && /[\u4e00-\u9fff]/u.test(error.message) ? error.message : "暂时无法完成操作，请重试"; this.emit(); }
    });
    return task;
  }
  private save(next: PersistedDeviceLock): void { this.options.store.write(next); this.state = next; this.emit(); }
  private report(operationId?: string, notApplied = false): void {
    const report: LockReport = { sequence: this.state.sequence + 1, lock_cycle: this.state.cycle,
      actual_lock: this.state.locked ? "locked" : "unlocked", ...(operationId === undefined ? {} : { operation_id: operationId }), ...(notApplied ? { not_applied: true } : {}) };
    this.save({ ...this.state, sequence: report.sequence, pendingReport: report });
  }
  private apply(locked: boolean, cycle: string, operationId?: string): void {
    const sequence = this.state.sequence + 1;
    const pendingReport: LockReport = { sequence, actual_lock: locked ? "locked" : "unlocked", lock_cycle: cycle,
      ...(operationId === undefined ? {} : { operation_id: operationId }) };
    this.save({ ...this.state, locked, cycle, sequence, pendingReport });
  }
  private serverNow(): number { return this.clock === undefined ? this.now() : this.clock.server + performance.now() - this.clock.monotonic; }
  private endSession(): void {
    this.authentication?.abort(); this.fence++;
    this.save({ ...this.state, ended: true }); this.message = "此电脑已退出登录，正在清理登录信息"; this.emit();
  }
  private async post<T>(route: string, body: object, publicRequest = false): Promise<T> {
    const started = performance.now();
    const response = await this.fetch(new URL(`/api/${publicRequest ? "public/" : ""}v1/device-control/${route}`, this.options.baseURL), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000),
      headers: { "Content-Type": "application/json", ...(publicRequest ? {} : { Authorization: `Bearer ${this.token}` }) }, body: JSON.stringify(body)
    });
    const serverTime = Number(response.headers.get("X-Jotmo-Server-Time"));
    if (Number.isSafeInteger(serverTime) && serverTime > 0) {
      const monotonic = performance.now();
      // A conservative upper bound includes the whole request round trip;
      // later wall-clock changes cannot prolong an authorization window.
      this.clock = { server: serverTime + monotonic - started, monotonic };
    }
    if (!publicRequest && response.status === 403 && response.headers.get("X-Jotmo-Auth-Failure") === "session_ended") {
      this.endSession();
      throw new Error("session-ended");
    }
    if (!publicRequest && (response.status === 401 || response.status === 403)) {
      const binding = this.state.binding;
      if (binding !== undefined) {
        const result = await this.post<{ ended: boolean }>("session-status", { user_id: binding.userId, client_id: binding.clientId,
          session_id: binding.sessionId, receipt_token: binding.cleanupToken }, true).catch(() => undefined);
        if (result?.ended === true) { this.endSession(); throw new Error("session-ended"); }
      }
      this.needsCredentials = true; this.emit();
    }
    if (!response.ok) throw new Error("暂时无法获取设备状态，请重试");
    const raw = await response.text(); if (raw.length > 65_536) throw new Error("设备响应无效");
    const result = JSON.parse(raw) as { code?: number; data?: T };
    if (result.code !== 200 || result.data === undefined) throw new Error("设备请求未完成，请重试");
    return result.data;
  }

  bind(accessToken: string): Promise<DeviceLockSnapshot> {
    if (accessToken.length > 8192 || accessToken.split(".").length !== 3) return Promise.reject(new Error("无效登录凭据"));
    return this.serial(async () => {
      const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")) as { user_id?: number; client_id?: number };
      if (!Number.isSafeInteger(claims.user_id) || !Number.isSafeInteger(claims.client_id) || (claims.user_id ?? 0) <= 0 || (claims.client_id ?? 0) <= 0) throw new Error("无效设备身份");
      this.token = accessToken;
      // The response proves the token's identity; decoded JWT fields alone never
      // authorize a new binding, release a lock or supply authentication proof.
      const device = await this.post<Device>("register", { platform: this.options.platform, name: this.options.name, capability: "unknown" });
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(device.session_id) || device.client_id !== claims.client_id) throw new Error("设备会话校验失败");
      const previous = this.state.binding;
      const same = previous !== undefined && previous.userId === claims.user_id && previous.sessionId === device.session_id;
      this.needsCredentials = false;
      if (!same) {
        this.authentication?.abort(); this.fence++;
        this.save({ schemaVersion: 1, locked: this.state.locked, ended: false, cycle: randomBytes(24).toString("hex"), sequence: 0,
          binding: { userId: claims.user_id!, clientId: claims.client_id!, sessionId: device.session_id, cleanupToken: randomBytes(32).toString("hex") },
          ...(this.state.pendingCleanup === undefined ? {} : { pendingCleanup: this.state.pendingCleanup }) });
      }
      const binding = this.state.binding!;
      await this.post("cleanup-enroll", { token_hash: createHash("sha256").update(Buffer.from(binding.cleanupToken, "hex")).digest("hex") });
      if (this.state.pendingReport === undefined && device.actual_lock === "locked" && !this.state.locked) {
        // Server evidence can strengthen local protection after disk recovery.
        this.save({ ...this.state, locked: true, cycle: device.lock_cycle!, sequence: device.report_sequence });
      }
      if (this.state.pendingReport === undefined) { this.state.sequence = Math.max(this.state.sequence, device.report_sequence); this.report(); }
      await this.flushReport(); await this.retryCleanup(); this.emit(); return this.snapshot();
    });
  }

  lock(): Promise<DeviceLockSnapshot> {
    this.authentication?.abort(); this.fence++;
    return this.serial(async () => {
      if (!this.available || this.state.binding === undefined || this.state.ended) throw new Error("当前设备暂不能锁定，请稍后重试");
      // An explicit lock starts a new authorization cycle even if already
      // protected. An earlier phone approval must never release this lock.
      this.apply(true, randomBytes(24).toString("hex"));
      this.operationState = undefined;
      this.message = "你可以在手机即我首页的设备状态栏解锁。"; this.emit();
      try { await this.flushReport(); } catch { this.message = "已在此电脑锁定，恢复连接后同步状态"; this.emit(); }
      return this.snapshot();
    });
  }

  requestUnlock(): Promise<DeviceLockSnapshot> {
    return this.serial(async () => {
      if (!this.state.locked || this.state.ended || this.state.binding === undefined) return this.snapshot();
      await this.flushReport();
      const device = await this.post<Device>("dispatch", {});
      if (device.operation !== undefined && ["awaiting_confirmation", "awaiting_execution", "reconciling"].includes(device.operation.state)) {
        await this.execute(device.operation, true); return this.snapshot();
      }
      const binding = this.state.binding;
      const result = await this.post<Device>("command", { client_id: binding.clientId, session_id: binding.sessionId, lock_cycle: this.state.cycle,
        request_id: randomUUID(), kind: "unlock", expires_at: Math.floor(this.serverNow()) + 110_000 });
      this.operationState = result.operation?.state;
      this.message = result.operation?.authorization === "native" ? "请使用电脑密码验证身份" : "请在手机即我上确认解锁"; this.emit();
      const dispatched = await this.post<Device>("dispatch", {});
      if (dispatched.operation !== undefined) await this.execute(dispatched.operation, true);
      return this.snapshot();
    });
  }

  synchronize(): Promise<DeviceLockSnapshot> {
    if (this.syncTask !== undefined) return this.syncTask;
    const task = this.authentication !== undefined
      ? this.post("dispatch", {}).then(() => this.snapshot(), () => this.snapshot())
      : this.serial(async () => {
      if (this.state.binding === undefined || this.state.ended) { await this.retryCleanup(); return this.snapshot(); }
      if (this.token === "") {
        const b = this.state.binding;
        const result = await this.post<{ ended: boolean }>("session-status", { user_id: b.userId, client_id: b.clientId, session_id: b.sessionId, receipt_token: b.cleanupToken }, true);
        if (result.ended === true) this.endSession();
        else { this.needsCredentials = true; this.emit(); }
        return this.snapshot();
      }
      try {
        await this.flushReport(); const d = await this.post<Device>("dispatch", {});
        if (d.operation !== undefined) await this.execute(d.operation, false);
        await this.retryCleanup();
      } catch (error) { if (!this.state.ended) { this.message = error instanceof Error ? error.message : "设备状态同步失败，请重试"; this.emit(); } }
      return this.snapshot();
    });
    this.syncTask = task.finally(() => { this.syncTask = undefined; });
    return this.syncTask;
  }

  private async execute(op: Operation, allowNative: boolean): Promise<void> {
    const binding = this.state.binding;
    this.operationState = op.state;
    if (binding === undefined || op.session_id !== binding.sessionId || op.lock_cycle !== this.state.cycle) return;
    if (op.state === "awaiting_confirmation") { this.message = "请在手机即我上确认解锁"; this.emit(); return; }
    if (op.state !== "awaiting_execution" && op.state !== "reconciling") return;
    if (op.dispatched_at <= 0 || this.clock === undefined) return;
    if (op.state === "reconciling" || op.expires_at <= this.serverNow()) { this.report(op.id, true); await this.flushReport(); this.message = "本次请求已过期，请重新解锁"; this.emit(); return; }
    if (op.kind === "lock" && op.next_lock_cycle !== undefined && /^[A-Za-z0-9_-]{16,128}$/.test(op.next_lock_cycle)) {
      this.authentication?.abort(); this.fence++;
      this.apply(true, op.next_lock_cycle, op.id); await this.flushReport(); return;
    }
    if (op.kind !== "unlock" || !this.state.locked) return;
    const fence = this.fence;
    if (op.authorization === "native") {
      if (!allowNative) return;
      this.authentication = new AbortController();
      const timeout = setTimeout(() => this.authentication?.abort(), Math.max(1, op.expires_at - this.serverNow()));
      let success = false;
      try { success = await this.options.authenticate(this.authentication.signal); }
      finally { clearTimeout(timeout); this.authentication = undefined; }
      if (!success || fence !== this.fence || op.expires_at <= this.serverNow()) {
        if (fence === this.fence) { this.report(op.id, true); await this.flushReport(); }
        this.message = "验证未完成，电脑仍保持锁定"; this.emit(); return;
      }
      // Recheck durable authority after the native dialog, before consuming its
      // one-use result. Revocation/new-cycle races must leave content protected.
      const current = await this.post<Device>("dispatch", {});
      if (current.operation?.id !== op.id || current.operation.state !== "awaiting_execution" || current.lock_cycle !== op.lock_cycle) return;
    } else if (op.authorization !== "mobile") return;
    if (fence !== this.fence || this.state.binding?.sessionId !== op.session_id || this.state.cycle !== op.lock_cycle || op.expires_at <= this.serverNow()) return;
    this.fence++;
    this.apply(false, this.state.cycle, op.id); this.message = ""; this.emit(); await this.flushReport();
  }

  private async flushReport(): Promise<void> {
    const pending = this.state.pendingReport; if (pending === undefined) return;
    await this.post("report", pending);
    if (this.state.pendingReport === pending) { const { pendingReport: _, ...next } = this.state; this.save(next); }
  }

  logout(expectedSessionId?: string): Promise<DeviceLockSnapshot> {
    this.authentication?.abort(); this.fence++;
    return this.serial(async () => {
      const binding = this.state.binding;
      if (expectedSessionId !== undefined && binding?.sessionId !== expectedSessionId) throw new Error("登录会话已变化，请重试");
      if (binding === undefined || this.state.ended) return this.snapshot();
      await this.post("command", { client_id: binding.clientId, session_id: binding.sessionId, lock_cycle: this.state.cycle,
        request_id: randomUUID(), kind: "logout", expires_at: Math.floor(this.serverNow()) + 110_000 });
      this.save({ ...this.state, ended: true }); return this.snapshot();
    });
  }
  completeLocalLogout(): Promise<DeviceLockSnapshot> {
    return this.serial(async () => {
      if (!this.state.ended && this.state.binding === undefined) return this.snapshot();
      if (!this.state.ended || this.state.binding === undefined) throw new Error("服务端尚未确认退出登录");
      const pendingCleanup = this.state.binding;
      this.token = "";
      this.save({ schemaVersion: 1, locked: false, ended: false, cycle: randomBytes(24).toString("hex"), sequence: 0, pendingCleanup });
      this.message = ""; this.operationState = undefined; this.emit();
      await this.retryCleanup(); return this.snapshot();
    });
  }
  private async retryCleanup(): Promise<void> {
    const pending = this.state.pendingCleanup; if (pending === undefined) return;
    try {
      await this.post("cleanup", { user_id: pending.userId, client_id: pending.clientId, session_id: pending.sessionId, receipt_token: pending.cleanupToken }, true);
      const { pendingCleanup: _, ...next } = this.state; this.save(next);
    } catch { /* Keep the narrowly scoped receipt until recovery, without delaying login UI. */ }
  }
  close(): void { this.authentication?.abort(); this.fence++; this.token = ""; }
}
