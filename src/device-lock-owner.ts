import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DeviceLockStore, LockBinding, LockReport, PersistedDeviceLock } from "./device-lock-store.js";

interface Operation { id: string; kind: "lock" | "unlock" | "logout"; state: string; session_id: string; lock_cycle: string; next_lock_cycle?: string; authorization: string; expires_at: number; dispatched_at: number }
interface Device { client_id: number; session_id: string; actual_lock?: "locked" | "unlocked"; lock_cycle?: string; report_sequence: number; operation?: Operation }
export interface DeviceLockSnapshot {
  supported: boolean; locked: boolean; sessionEnded: boolean; needsCredentials: boolean;
  platform: "macos" | "windows"; message: string; operationState?: string;
  sessionId?: string; userId?: number; clientId?: number; loginKey?: string | undefined;
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
  private syncAgain = false;
  private closed = false;
  private authentication: AbortController | undefined;
  private mobileFallback: ReturnType<typeof setTimeout> | undefined;
  private fence = 0;
  private bindEpoch = 0;
  private requestedLogin = "";
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
      ...(this.state.pendingRegistration !== undefined ? { userId: this.state.pendingRegistration.userId, clientId: this.state.pendingRegistration.clientId, loginKey: this.state.pendingRegistration.loginKey } : this.state.binding === undefined ? {} : { sessionId: this.state.binding.sessionId, userId: this.state.binding.userId, clientId: this.state.binding.clientId, loginKey: this.state.binding.loginKey }) };
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
  private apply(locked: boolean, cycle: string, operationId?: string, native = false): void {
    const sequence = this.state.sequence + 1;
    const pendingReport: LockReport = { sequence, actual_lock: locked ? "locked" : "unlocked", lock_cycle: cycle,
      ...(operationId === undefined ? {} : { operation_id: operationId }), ...(native ? { unlock_source: "native" as const } : {}) };
    this.save({ ...this.state, locked, cycle, sequence, pendingReport });
  }
  private serverNow(): number { return this.clock === undefined ? this.now() : this.clock.server + performance.now() - this.clock.monotonic; }
  private endSession(): void {
    this.clearMobileFallback();
    this.authentication?.abort(); this.fence++;
    this.save({ ...this.state, ended: true }); this.message = "此电脑已退出登录，正在清理登录信息"; this.emit();
  }
  private async post<T>(route: string, body: object, publicRequest = false, timeoutMs = 8_000): Promise<T> {
    const started = performance.now();
    const response = await this.fetch(new URL(`/api/${publicRequest ? "public/" : ""}v1/device-control/${route}`, this.options.baseURL), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(publicRequest ? {} : { Authorization: `Bearer ${this.token}`, "X-Jotmo-Device-Instance": this.state.binding?.sessionId ?? "" }) }, body: JSON.stringify(body)
    });
    const serverTime = Number(response.headers.get("X-Jotmo-Server-Time"));
    if (Number.isSafeInteger(serverTime) && serverTime > 0) {
      const monotonic = performance.now();
      // A conservative upper bound includes the whole request round trip;
      // later wall-clock changes cannot prolong an authorization window.
      this.clock = { server: serverTime + monotonic - started, monotonic };
    }
    if (!publicRequest && response.status === 403 && response.headers.get("X-Jotmo-Device-Failure") === "instance_ended") {
      this.endSession();
      throw new Error("session-ended");
    }
    if (!publicRequest && (response.status === 401 || response.status === 403)) {
      const binding = this.state.binding;
      if (binding !== undefined) {
        const result = await this.post<{ ended: boolean }>("session-status", { user_id: binding.userId, client_id: binding.clientId,
          session_id: binding.sessionId, receipt_token: binding.cleanupToken }, true, timeoutMs).catch(() => undefined);
        if (result?.ended === true) { this.endSession(); throw new Error("session-ended"); }
      }
      this.needsCredentials = true; this.emit();
    }
    if (!response.ok) {
      if (route === "command" && response.status === 409) {
        throw new Error("设备状态已变化，请重试");
      }
      if (publicRequest && route === "cleanup" && response.status === 403) return { obsolete: true } as T;
      throw new Error("暂时无法获取设备状态，请重试");
    }
    const raw = await response.text(); if (raw.length > 65_536) throw new Error("设备响应无效");
    const result = JSON.parse(raw) as { code?: number; data?: T };
    if (result.code !== 200 || result.data === undefined) throw new Error("设备请求未完成，请重试");
    return result.data;
  }

  bind(accessToken: string, loginKey: string): Promise<DeviceLockSnapshot> {
    if (!/^[a-f0-9]{64}$/.test(loginKey) || accessToken.length > 8192 || accessToken.split(".").length !== 3) return Promise.reject(new Error("无效登录凭据"));
    let claims: { user_id?: number; client_id?: number };
    try { claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")); }
    catch { return Promise.reject(new Error("无效登录凭据")); }
    if (claims === null || !Number.isSafeInteger(claims.user_id) || !Number.isSafeInteger(claims.client_id) || (claims.user_id ?? 0) <= 0 || (claims.client_id ?? 0) <= 0) return Promise.reject(new Error("无效设备身份"));
    const identity = `${claims.user_id}:${claims.client_id}:${loginKey}`;
    if (identity !== this.requestedLogin) { this.requestedLogin = identity; this.bindEpoch++; }
    const epoch = this.bindEpoch;
    const assertCurrent = () => { if (epoch !== this.bindEpoch || this.closed) throw new Error("登录状态已变化，请重试"); };
    const sameLogin = (b: LockBinding | undefined) => b !== undefined && b.userId === claims.user_id && b.clientId === claims.client_id && b.loginKey === loginKey;
    if (!sameLogin(this.state.binding)) { this.clearMobileFallback(); this.authentication?.abort(); this.fence++; }
    return this.serial(async () => {
      assertCurrent(); this.token = accessToken;
      let binding = this.state.binding;
      let previous = "";
      if (!sameLogin(binding)) {
        let pending = this.state.pendingRegistration;
        if (!sameLogin(pending)) {
          pending = { userId: claims.user_id!, clientId: claims.client_id!, sessionId: `${claims.client_id}_${randomUUID()}`,
            loginKey, cleanupToken: randomBytes(32).toString("hex") };
          this.save({ ...this.state, pendingRegistration: pending });
        }
        if (pending!.previousSessionId === undefined) {
          const result = await this.post<{ session_id: string }>("registration", {}); assertCurrent();
          if (typeof result.session_id !== "string" || (result.session_id !== "" && !/^[A-Za-z0-9_-]{16,128}$/.test(result.session_id))) throw new Error("设备会话校验失败");
          pending = { ...pending!, previousSessionId: result.session_id };
          this.save({ ...this.state, pendingRegistration: pending });
        }
        binding = pending!; previous = pending!.previousSessionId!;
      }
      const device = await this.post<Device>("register", { platform: this.options.platform, name: this.options.name, capability: "unknown",
        session_id: binding!.sessionId, previous_session_id: previous });
      assertCurrent();
      if (device.session_id !== binding!.sessionId || device.client_id !== claims.client_id) throw new Error("设备会话校验失败");
      this.needsCredentials = false;
      if (!sameLogin(this.state.binding)) {
        this.clearMobileFallback(); this.authentication?.abort(); this.fence++;
        this.save({ schemaVersion: 1, locked: this.state.locked, ended: false, cycle: randomBytes(24).toString("hex"), sequence: 0,
          binding: { userId: binding!.userId, clientId: binding!.clientId, sessionId: binding!.sessionId, loginKey, cleanupToken: binding!.cleanupToken },
          ...(this.state.pendingCleanup === undefined ? {} : { pendingCleanup: this.state.pendingCleanup }) });
      }
      await this.post("cleanup-enroll", { token_hash: createHash("sha256").update(Buffer.from(binding!.cleanupToken, "hex")).digest("hex") }); assertCurrent();
      if (this.state.pendingReport === undefined && device.actual_lock === "locked" && !this.state.locked) {
        this.save({ ...this.state, locked: true, cycle: device.lock_cycle!, sequence: device.report_sequence });
      }
      if (this.state.pendingReport === undefined) { this.state.sequence = Math.max(this.state.sequence, device.report_sequence); this.report(); }
      await this.flushReport(); assertCurrent(); await this.retryCleanup(); this.emit(); return this.snapshot();
    });
  }

  async lock(): Promise<DeviceLockSnapshot> {
    if (this.closed || !this.available || this.state.ended) throw new Error("当前设备暂不能锁定，请稍后重试");
    this.clearMobileFallback();
    this.authentication?.abort(); this.fence++;
    // Local privacy cannot wait behind remote I/O or an open password dialog.
    // Persist a new cycle synchronously; every older proof is fenced by it.
    this.operationState = undefined;
    this.message = "你可以在手机即我首页的设备状态栏解锁。";
    this.apply(true, randomBytes(24).toString("hex"));
    // Reuse the single reconciliation owner. At most one follow-up is needed
    // if an in-flight report/dispatch captured the previous cycle.
    if (this.syncTask !== undefined) this.syncAgain = true;
    void this.synchronize().catch(() => undefined);
    return this.snapshot();
  }

  requestUnlock(): Promise<DeviceLockSnapshot> {
    const requestedFence = this.fence;
    return this.serial(async () => {
      if (requestedFence !== this.fence || !this.state.locked || this.state.ended) return this.snapshot();
      const fence = this.fence;
      let operation: Operation | undefined;
      let existing = false;
      try {
        if (this.state.binding !== undefined && this.token !== "") {
          await this.flushReport();
          const device = await this.post<Device>("dispatch", {});
          if (device.operation !== undefined && ["awaiting_confirmation", "awaiting_execution", "reconciling"].includes(device.operation.state)) {
            operation = device.operation; existing = true;
          } else {
            const binding = this.state.binding;
            await this.post<Device>("command", { client_id: binding.clientId, session_id: binding.sessionId, lock_cycle: this.state.cycle,
              request_id: randomUUID(), kind: "unlock", expires_at: Math.floor(this.serverNow()) + 110_000 });
            operation = (await this.post<Device>("dispatch", {})).operation;
          }
        }
      } catch { /* Unavailable phone/server evidence selects local OS authentication. */ }
      if (this.state.ended || fence !== this.fence) return this.snapshot();
      if (operation?.authorization === "mobile" && operation.state === "awaiting_confirmation" && !existing
        && operation.session_id === this.state.binding?.sessionId && operation.lock_cycle === this.state.cycle) {
        await this.execute(operation); this.waitForPhone();
      } else if (operation?.authorization === "native" || operation === undefined || operation.state === "awaiting_confirmation") {
        await this.authenticateLocally(operation);
      } else {
        try { await this.execute(operation); } catch { /* Local authentication remains available if reconciliation fails. */ }
        if (this.state.locked && !this.state.ended && fence === this.fence) await this.authenticateLocally();
      }
      return this.snapshot();
    });
  }

  private clearMobileFallback(): void { clearTimeout(this.mobileFallback); this.mobileFallback = undefined; }
  private waitForPhone(): void {
    this.clearMobileFallback();
    const fence = this.fence;
    this.mobileFallback = setTimeout(() => {
      this.mobileFallback = undefined;
      void this.serial(async () => {
        if (fence === this.fence && this.state.locked && !this.state.ended) await this.authenticateLocally();
      }).catch(() => undefined);
    }, 30_000);
    this.mobileFallback.unref();
  }

  private async authenticateLocally(operation?: Operation): Promise<void> {
    this.clearMobileFallback();
    if (!this.state.locked || this.state.ended) return;
    const fence = this.fence, cycle = this.state.cycle, sessionId = this.state.binding?.sessionId;
    const authentication = new AbortController();
    this.authentication = authentication;
    this.operationState = undefined; this.message = "请使用电脑密码验证身份"; this.emit();
    const timeout = setTimeout(() => authentication.abort(), 120_000);
    let success = false;
    try { success = await this.options.authenticate(authentication.signal); }
    finally { clearTimeout(timeout); this.authentication = undefined; }
    if (fence !== this.fence || this.state.ended || this.state.cycle !== cycle || this.state.binding?.sessionId !== sessionId) return;
    if (!success || authentication.signal.aborted) {
      if (operation?.authorization === "native" && operation.state === "awaiting_execution" && operation.dispatched_at > 0
        && operation.session_id === sessionId && operation.lock_cycle === cycle) {
        this.report(operation.id, true); await this.flushReport().catch(() => undefined);
      }
      this.message = "验证未完成，电脑仍保持锁定"; this.emit(); return;
    }
    // Observe reachable revocation/new lock intent, but network availability is
    // not an authority over this computer's successful OS authentication.
    if (sessionId !== undefined) {
      try {
        if (this.token === "") {
          const b = this.state.binding!;
          const status = await this.post<{ ended: boolean }>("session-status", { user_id: b.userId, client_id: b.clientId, session_id: b.sessionId, receipt_token: b.cleanupToken }, true, 2_000);
          if (status.ended) this.endSession();
        } else {
          const current = await this.post<Device>("dispatch", {}, false, 2_000);
          if (typeof current.session_id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(current.session_id)
            && current.session_id !== sessionId) { this.endSession(); return; }
          if (current.operation?.kind === "lock") await this.execute(current.operation);
        }
      } catch { /* Keep the durable local result and retry only its report later. */ }
    }
    if (fence !== this.fence || this.state.ended || this.state.cycle !== cycle || this.state.binding?.sessionId !== sessionId) return;
    this.fence++;
    this.apply(false, cycle, undefined, true); this.message = ""; this.emit();
    // Persistence above releases the UI immediately; failure retains the exact
    // receipt across restart instead of undoing a completed OS verification.
    if (sessionId !== undefined) await this.flushReport().catch(() => undefined);
  }

  synchronize(): Promise<DeviceLockSnapshot> {
    if (this.closed) return Promise.resolve(this.snapshot());
    if (this.syncTask !== undefined) return this.syncTask;
    const task = this.authentication !== undefined && !this.authentication.signal.aborted
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
        if (d.operation !== undefined) await this.execute(d.operation);
        await this.retryCleanup();
      } catch (error) { if (!this.state.ended) { this.message = error instanceof Error ? error.message : "设备状态同步失败，请重试"; this.emit(); } }
      return this.snapshot();
    });
    this.syncTask = task.finally(() => {
      this.syncTask = undefined;
      if (this.syncAgain) {
        this.syncAgain = false;
        if (!this.closed) void this.synchronize().catch(() => undefined);
      }
    });
    return this.syncTask;
  }

  private async execute(op: Operation): Promise<void> {
    if (this.closed) return;
    const binding = this.state.binding;
    if (binding === undefined || op.session_id !== binding.sessionId || op.lock_cycle !== this.state.cycle) return;
    this.operationState = op.state;
    if (op.state === "awaiting_confirmation") { this.message = "请在手机即我上确认解锁，也可使用电脑密码"; this.emit(); return; }
    if (op.state !== "awaiting_execution" && op.state !== "reconciling") return;
    if (op.dispatched_at <= 0 || this.clock === undefined) return;
    if (op.state === "reconciling" || op.expires_at <= this.serverNow()) { this.report(op.id, true); await this.flushReport(); this.message = "本次请求已过期，请重新解锁"; this.emit(); return; }
    if (op.kind === "lock" && op.next_lock_cycle !== undefined && /^[A-Za-z0-9_-]{16,128}$/.test(op.next_lock_cycle)) {
      this.clearMobileFallback();
      this.authentication?.abort(); this.fence++;
      this.apply(true, op.next_lock_cycle, op.id); await this.flushReport(); return;
    }
    if (op.kind !== "unlock" || !this.state.locked) return;
    const fence = this.fence;
    if (op.authorization !== "mobile") return;
    if (fence !== this.fence || this.state.binding?.sessionId !== op.session_id || this.state.cycle !== op.lock_cycle || op.expires_at <= this.serverNow()) return;
    this.fence++;
    this.clearMobileFallback();
    this.apply(false, this.state.cycle, op.id); this.message = ""; this.emit(); await this.flushReport();
  }

  private async flushReport(): Promise<void> {
    const pending = this.state.pendingReport; if (pending === undefined) return;
    await this.post("report", pending);
    if (this.state.pendingReport === pending) { const { pendingReport: _, ...next } = this.state; this.save(next); }
  }

  logout(expectedSessionId?: string, expectedLoginKey?: string): Promise<DeviceLockSnapshot> {
    const binding = this.state.binding;
    const login = this.state.pendingRegistration ?? binding;
    if (expectedLoginKey !== undefined && login !== undefined && login.loginKey !== expectedLoginKey) return Promise.reject(new Error("登录状态已变化，请重试"));
    if (expectedSessionId !== undefined && binding?.sessionId !== expectedSessionId) return Promise.reject(new Error("登录会话已变化，请重试"));
    this.clearMobileFallback(); this.authentication?.abort(); this.fence++; this.bindEpoch++;
    if (!this.state.ended) this.save({ ...this.state, ended: true });
    // Existing credential cleanup can proceed offline. Its narrow receipt is
    // persisted by completeLocalLogout and delivered after connectivity returns.
    return Promise.resolve(this.snapshot());
  }
  completeLocalLogout(): Promise<DeviceLockSnapshot> {
    return this.serial(async () => {
      if (!this.state.ended && this.state.binding === undefined) return this.snapshot();
      if (!this.state.ended) throw new Error("此实例尚未开始退出登录");
      const pendingCleanup = this.state.binding ?? this.state.pendingCleanup;
      this.token = "";
      this.save({ schemaVersion: 1, locked: false, ended: false, cycle: randomBytes(24).toString("hex"), sequence: 0, ...(pendingCleanup === undefined ? {} : { pendingCleanup }) });
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
  close(): void { this.closed = true; this.syncAgain = false; this.clearMobileFallback(); this.authentication?.abort(); this.fence++; this.token = ""; }
}
