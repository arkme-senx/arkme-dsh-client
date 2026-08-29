import { execFile as nodeExecFile, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { allocateLoopbackPort } from "./port.js";
import { prepareManagedRestartPlan } from "./managed-restart-plan.js";
import {
  activateOptionalExtensionRecovery,
  enforceActiveOptionalExtensionRecoveries,
  loadPendingOptionalExtensionRecovery,
  prepareOptionalExtensionRecovery,
  restoreOptionalExtensionRecovery,
  type OptionalExtensionRecoveryConfig,
  type OptionalExtensionRecoveryTransaction
} from "./optional-extension-recovery.js";

const execFile = promisify(nodeExecFile);

export type HarnessState =
  | { kind: "starting"; workspacePath: string }
  | {
    kind: "ready";
    workspacePath: string;
    url: string;
    requiresWorkspaceSelection?: true;
  }
  | {
    kind: "failed";
    workspacePath?: string;
    message: string;
    logPath: string;
    displayTitle?: string;
    suggestion?: string;
    technicalDetails?: string;
    showWorkspaceAction?: boolean;
    showReloadRuntimeAction?: boolean;
  }
  | { kind: "stopping"; workspacePath: string };

export type StopReason = "quit" | "restart" | "failure";

export type ProcessTerminationPlan =
  | { kind: "signal"; pid: number; signal: NodeJS.Signals }
  | { kind: "taskkill"; args: string[] };

export function buildProcessTerminationPlan(
  pid: number,
  signal: NodeJS.Signals,
  platform = process.platform
): ProcessTerminationPlan {
  if (platform === "win32") {
    return {
      kind: "taskkill",
      args: ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])]
    };
  }
  return { kind: "signal", pid: -pid, signal };
}

export interface ManagedChild extends EventEmitter {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

interface SupervisorConfig {
  execPath: string;
  dshBinPath: string;
  dshHome: string;
  logPath: string;
  packageManagerBinPath: string;
  packageManagerCliPath: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  managedRestart?: { helperPath: string; planPath: string; releaseId?: string };
  optionalExtensionRecovery?: OptionalExtensionRecoveryConfig;
  directoryPickerBridge?: { url: string; token: string };
}

interface StartOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface SupervisorDependencies {
  allocatePort: () => Promise<number>;
  spawn: (command: string, args: string[], options: SpawnOptions) => ManagedChild;
  checkHealth: (url: string) => Promise<boolean>;
  checkApiReady: (url: string) => Promise<boolean>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  signalProcessGroup: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  waitForExit: (child: ManagedChild, timeoutMs: number) => Promise<boolean>;
  closeLog: (log: WriteStream) => Promise<void>;
  registerWorkspace: (url: string, workspacePath: string, signal: AbortSignal) => Promise<void>;
  managedRestartPlanExists: (planPath: string) => Promise<boolean>;
  runManagedRestartHelper: (input: {
    execPath: string;
    helperPath: string;
    planPath: string;
    dshHome: string;
    environment: NodeJS.ProcessEnv;
    mode: "finalize" | "rollback";
    healthUrl?: string;
    signal: AbortSignal;
  }) => Promise<void>;
  appendLifecycle: (
    logPath: string,
    event: string,
    details: Record<string, unknown>
  ) => Promise<void>;
}

interface RunningHarness {
  child: ManagedChild;
  expectedStop: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  log: WriteStream;
  logClose: Promise<void> | null;
  startupError: Error | null;
  tail: string;
  workspacePath: string;
}

// Windows can spend several seconds loading the bundled Electron/Node runtime,
// resolving the pnpm workspace and letting Defender scan native dependencies.
// Keep the watchdog long enough for a cold start while still surfacing a real
// deadlock instead of waiting indefinitely.
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_WORKSPACE_REGISTRATION_TIMEOUT_MS = 15_000;
const WORKSPACE_REGISTRATION_ATTEMPT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCE_EXIT_TIMEOUT_MS = 1_000;
const MAX_TAIL_LENGTH = 16_384;
const DESKTOP_MANAGED_RESTART_EXIT_CODE = 75;

export function withBundledPackageManagerEnvironment(
  environment: NodeJS.ProcessEnv,
  packageManagerBinPath: string,
  nodeExecPath: string,
  packageManagerCliPath: string,
  delimiter = path.delimiter
): NodeJS.ProcessEnv {
  const result = { ...environment };
  const pathKeys = Object.keys(result).filter((key) => key.toLowerCase() === "path");
  const pathKey = pathKeys.find((key) => key === "Path")
    ?? pathKeys.find((key) => key === "PATH")
    ?? pathKeys[0]
    ?? "PATH";
  const inheritedPath = result[pathKey] ?? "";
  for (const key of pathKeys) delete result[key];
  result[pathKey] = inheritedPath === ""
    ? packageManagerBinPath
    : `${packageManagerBinPath}${delimiter}${inheritedPath}`;
  result.ARKME_NODE_EXEC_PATH = nodeExecPath;
  result.ARKME_PNPM_CLI_PATH = packageManagerCliPath;
  // The packaged executable is Electron rather than a standalone Node binary.
  // Without Node mode, invoking `process.execPath pnpm.cjs ...` merely launches
  // another desktop instance and can exit successfully without running pnpm.
  result.ELECTRON_RUN_AS_NODE = "1";
  return result;
}

export class HarnessProcessSupervisor {
  private readonly config: SupervisorConfig;
  private readonly dependencies: SupervisorDependencies;
  private readonly listeners = new Set<(state: HarnessState) => void>();
  private current: RunningHarness | null = null;
  private state: HarnessState | null = null;
  private lifecycleGeneration = 0;
  private managedRestartAbort: AbortController | null = null;
  private managedRestartTask: Promise<void> | null = null;

  constructor(config: SupervisorConfig, dependencies: Partial<SupervisorDependencies> = {}) {
    this.config = config;
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  onState(listener: (state: HarnessState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): HarnessState | null {
    return this.state;
  }

  async start(workspacePath: string, options: StartOptions = {}): Promise<void> {
    await this.startInternal(workspacePath, options);
  }

  private async startInternal(
    workspacePath: string,
    options: StartOptions,
    signal = new AbortController().signal
  ): Promise<void> {
    try {
      if (this.config.managedRestart?.releaseId !== undefined) {
        await prepareManagedRestartPlan(
          this.config.managedRestart.planPath,
          this.config.managedRestart.releaseId
        );
      }
      if (this.config.optionalExtensionRecovery !== undefined) {
        const reappliedPackages = await enforceActiveOptionalExtensionRecoveries(
          this.config.optionalExtensionRecovery
        );
        if (reappliedPackages.length > 0) {
          await this.recordSupervisorLifecycle("optional-extension-recovery-quarantined", {
            reason: "active-receipt-reapplied",
            packages: reappliedPackages
          });
        }
      }
      let optionalRecovery = this.config.optionalExtensionRecovery === undefined
        ? undefined
        : await loadPendingOptionalExtensionRecovery(this.config.optionalExtensionRecovery);
      let launched: { running: RunningHarness; url: string };
      try {
        launched = await this.launch(workspacePath, options, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (await this.hasPendingManagedRestartPlan()) {
          await this.runManagedRestartHelper("rollback", undefined, signal);
          await this.reapplyActiveOptionalExtensionQuarantine();
          try {
            launched = await this.launch(workspacePath, options, signal);
          } catch (rollbackLaunchError) {
            const recovered = await this.recoverOptionalExtensionLaunch(
              rollbackLaunchError,
              workspacePath,
              options,
              signal,
              optionalRecovery
            );
            launched = recovered.launched;
            optionalRecovery = recovered.transaction;
          }
        } else {
          const recovered = await this.recoverOptionalExtensionLaunch(
            error,
            workspacePath,
            options,
            signal,
            optionalRecovery
          );
          launched = recovered.launched;
          optionalRecovery = recovered.transaction;
        }
      }

      if (await this.hasPendingManagedRestartPlan()) {
        try {
          await this.runManagedRestartHelper(
            "finalize",
            launched.url,
            signal
          );
        } catch (error) {
          await this.stopRunningProcess(launched.running, true);
          if (signal.aborted) throw error;
          await this.runManagedRestartHelper("rollback", undefined, signal);
          await this.reapplyActiveOptionalExtensionQuarantine();
          try {
            launched = await this.launch(workspacePath, options, signal);
          } catch (rollbackLaunchError) {
            const recovered = await this.recoverOptionalExtensionLaunch(
              rollbackLaunchError,
              workspacePath,
              options,
              signal,
              optionalRecovery
            );
            launched = recovered.launched;
            optionalRecovery = recovered.transaction;
          }
        }
      }

      let workspaceRegistered: boolean;
      try {
        workspaceRegistered = await this.registerWorkspaceWhenApiReady(
          launched.running,
          launched.url,
          workspacePath,
          Math.min(
            options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS,
            DEFAULT_WORKSPACE_REGISTRATION_TIMEOUT_MS
          ),
          options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
          signal
        );
        this.assertRunningBeforeReady(launched.running);
      } catch (error) {
        await this.stopRunningProcess(launched.running, false);
        throw error;
      }
      signal.throwIfAborted();
      if (optionalRecovery !== undefined) {
        await activateOptionalExtensionRecovery(optionalRecovery);
        await this.recordSupervisorLifecycle("optional-extension-recovery-retry-succeeded", {
          quarantineId: optionalRecovery.receipt.quarantineId,
          packages: optionalRecovery.receipt.entries.map((entry) => entry.packageName)
        });
      }
      this.emit({
        kind: "ready",
        workspacePath,
        url: launched.url,
        ...(workspaceRegistered ? {} : { requiresWorkspaceSelection: true })
      });
    } catch (error) {
      if (signal.aborted) {
        const running = this.current;
        if (running !== null) await this.stopRunningProcess(running, true);
        throw error;
      }
      const message = this.failureMessage(error, "");
      this.emit({ kind: "failed", workspacePath, message, logPath: this.config.logPath });
      throw new Error(message, { cause: error });
    }
  }

  private async recoverOptionalExtensionLaunch(
    error: unknown,
    workspacePath: string,
    options: StartOptions,
    signal: AbortSignal,
    pending: OptionalExtensionRecoveryTransaction | undefined
  ): Promise<{
    launched: { running: RunningHarness; url: string };
    transaction: OptionalExtensionRecoveryTransaction;
  }> {
    const config = this.config.optionalExtensionRecovery;
    if (config === undefined) throw error;
    if (pending !== undefined) {
      await this.recordSupervisorLifecycle("optional-extension-recovery-retry-failed", {
        quarantineId: pending.receipt.quarantineId,
        packages: pending.receipt.entries.map((entry) => entry.packageName)
      });
      await restoreOptionalExtensionRecovery(pending);
      await this.recordSupervisorLifecycle("optional-extension-recovery-profile-restored", {
        quarantineId: pending.receipt.quarantineId
      });
      throw error;
    }

    const transaction = await prepareOptionalExtensionRecovery({
      ...config,
      failureText: error instanceof Error ? error.message : String(error)
    });
    if (transaction === undefined) throw error;
    await this.recordSupervisorLifecycle("optional-extension-recovery-detected", {
      quarantineId: transaction.receipt.quarantineId,
      mode: transaction.receipt.mode,
      packages: transaction.receipt.entries.map((entry) => entry.packageName)
    });
    await this.recordSupervisorLifecycle("optional-extension-recovery-quarantined", {
      quarantineId: transaction.receipt.quarantineId,
      packages: transaction.receipt.entries.map((entry) => entry.packageName)
    });
    try {
      return {
        launched: await this.launch(workspacePath, options, signal),
        transaction
      };
    } catch (retryError) {
      if (signal.aborted) throw retryError;
      await this.recordSupervisorLifecycle("optional-extension-recovery-retry-failed", {
        quarantineId: transaction.receipt.quarantineId,
        packages: transaction.receipt.entries.map((entry) => entry.packageName)
      });
      try {
        await restoreOptionalExtensionRecovery(transaction);
        await this.recordSupervisorLifecycle("optional-extension-recovery-profile-restored", {
          quarantineId: transaction.receipt.quarantineId
        });
      } catch (restoreError) {
        throw new Error(
          `${this.failureMessage(error, "")}\n\n自动停用扩展后仍无法启动，并且无法恢复扩展配置：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          { cause: retryError }
        );
      }
      throw new Error(
        `${this.failureMessage(error, "")}\n\n自动停用扩展后仍无法启动，已恢复原扩展配置。`,
        { cause: retryError }
      );
    }
  }

  private async recordSupervisorLifecycle(
    event: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await this.dependencies.appendLifecycle(this.config.logPath, event, details);
  }

  private async reapplyActiveOptionalExtensionQuarantine(): Promise<void> {
    if (this.config.optionalExtensionRecovery === undefined) return;
    const packages = await enforceActiveOptionalExtensionRecoveries(
      this.config.optionalExtensionRecovery
    );
    if (packages.length === 0) return;
    await this.recordSupervisorLifecycle("optional-extension-recovery-quarantined", {
      reason: "managed-profile-rollback-reapplied",
      packages
    });
  }

  private async launch(
    workspacePath: string,
    options: StartOptions,
    signal: AbortSignal
  ): Promise<{ running: RunningHarness; url: string }> {
    if (this.current !== null) {
      throw new Error("Harness is already running");
    }

    signal.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    await Promise.all([
      mkdir(this.config.dshHome, { recursive: true }),
      mkdir(path.dirname(this.config.logPath), { recursive: true })
    ]);

    signal.throwIfAborted();
    const port = await this.dependencies.allocatePort();
    signal.throwIfAborted();
    const url = `http://127.0.0.1:${port}/`;
    const log = createWriteStream(this.config.logPath, { flags: "a", mode: 0o600 });
    const inheritedEnv = withBundledPackageManagerEnvironment(
      this.config.inheritedEnv ?? process.env,
      this.config.packageManagerBinPath,
      this.config.execPath,
      this.config.packageManagerCliPath
    );
    const child = this.dependencies.spawn(
      this.config.execPath,
      [
        "--expose-internals",
        this.config.dshBinPath,
        "web",
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        String(port)
      ],
      {
        cwd: workspacePath,
        detached: true,
        env: {
          ...inheritedEnv,
          DSH_HOME: this.config.dshHome,
          DSH_PROFILE_FIRST_BUNDLES: "@senguoyun/dsh-arkme",
          DSH_INSTALLED_MODULE_BASE_PATH: this.config.dshBinPath,
          ELECTRON_RUN_AS_NODE: "1",
          ...(this.config.managedRestart === undefined ? {} : {
            ARKME_DESKTOP_MANAGED_RESTART: "1",
            ARKME_DESKTOP_MANAGED_RESTART_PLAN_PATH: this.config.managedRestart.planPath
          }),
          ARKME_HARNESS_LOG_PATH: this.config.logPath,
          ...(this.config.directoryPickerBridge === undefined ? {} : {
            ARKME_DIRECTORY_PICKER_BRIDGE_URL: this.config.directoryPickerBridge.url,
            ARKME_DIRECTORY_PICKER_BRIDGE_TOKEN: this.config.directoryPickerBridge.token
          })
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const running: RunningHarness = {
      child,
      expectedStop: false,
      exit: null,
      log,
      logClose: null,
      startupError: null,
      tail: "",
      workspacePath
    };
    this.current = running;
    this.attachProcessListeners(running);
    this.recordLifecycle(running, "spawned", {
      pid: child.pid ?? null,
      port,
      timeoutMs,
      workspacePath
    });
    this.emit({ kind: "starting", workspacePath });

    try {
      await this.waitUntilReady(running, url, timeoutMs, pollIntervalMs, signal);
      this.recordLifecycle(running, "ready", { url });
      return { running, url };
    } catch (error) {
      await this.stopRunningProcess(running, false);
      const message = this.failureMessage(error, running.tail);
      throw new Error(message, { cause: error });
    }
  }

  async restart(workspacePath: string): Promise<void> {
    await this.stop("restart");
    await this.start(workspacePath);
  }

  async stop(_reason: StopReason): Promise<void> {
    this.lifecycleGeneration += 1;
    this.managedRestartAbort?.abort(new Error("Harness shutdown interrupted managed restart"));
    const managedRestartTask = this.managedRestartTask;
    const running = this.current;
    if (running !== null) {
      this.emit({ kind: "stopping", workspacePath: running.workspacePath });
      await this.stopRunningProcess(running, true);
    }
    await managedRestartTask;
    const replacement = this.current;
    if (replacement !== null && replacement !== running) {
      this.emit({ kind: "stopping", workspacePath: replacement.workspacePath });
      await this.stopRunningProcess(replacement, true);
    }
  }

  private attachProcessListeners(running: RunningHarness): void {
    running.child.stdout?.on("data", (chunk: Buffer | string) => {
      this.recordOutput(running, "stdout", chunk);
    });
    running.child.stderr?.on("data", (chunk: Buffer | string) => {
      this.recordOutput(running, "stderr", chunk);
    });
    running.child.once("error", (error: Error) => {
      running.startupError = error;
      this.recordLifecycle(running, "process-error", { message: error.message });
    });
    running.child.once(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        running.exit = { code, signal };
        this.recordLifecycle(running, "process-exit", { code, signal });
        if (running.expectedStop || this.current !== running) return;
        if (this.state?.kind !== "ready") return;
        if (signal === null && code === DESKTOP_MANAGED_RESTART_EXIT_CODE) {
          setImmediate(() => {
            const task = this.handleManagedRestart(running);
            this.managedRestartTask = task;
            void task.finally(() => {
              if (this.managedRestartTask === task) this.managedRestartTask = null;
            });
          });
          return;
        }
        setImmediate(() => this.handleUnexpectedExit(running, code, signal));
      }
    );
  }

  private assertRunningBeforeReady(running: RunningHarness): void {
    if (running.startupError !== null) throw running.startupError;
    if (running.exit !== null) {
      const { code, signal } = running.exit;
      throw new Error(
        signal === null
          ? `Harness exited before workspace registration with code ${code ?? "unknown"}`
          : `Harness exited before workspace registration with signal ${signal}`
      );
    }
    if (this.current !== running) {
      throw new Error("Harness stopped before workspace registration completed");
    }
  }

  private async registerWorkspaceWhenApiReady(
    running: RunningHarness,
    url: string,
    workspacePath: string,
    timeoutMs: number,
    pollIntervalMs: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const deadline = this.dependencies.now() + timeoutMs;
    let apiChecks = 0;
    let registrationAttempts = 0;
    let lastTransientMessage = "DSH API did not become ready";

    while (this.dependencies.now() < deadline) {
      signal.throwIfAborted();
      this.assertRunningBeforeReady(running);
      apiChecks += 1;

      if (await this.dependencies.checkApiReady(url)) {
        registrationAttempts += 1;
        const remaining = deadline - this.dependencies.now();
        const attemptSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(
            1,
            Math.min(WORKSPACE_REGISTRATION_ATTEMPT_TIMEOUT_MS, remaining)
          ))
        ]);
        try {
          await this.dependencies.registerWorkspace(url, workspacePath, attemptSignal);
          this.assertRunningBeforeReady(running);
          this.recordLifecycle(running, "workspace-registered", {
            apiChecks,
            registrationAttempts
          });
          return true;
        } catch (error) {
          if (signal.aborted) throw error;
          if (!isTransientWorkspaceRegistrationError(error)) throw error;
          lastTransientMessage = error.message;
          if (error.status === 404) {
            this.recordLifecycle(running, "workspace-registration-degraded", {
              timeoutMs,
              apiChecks,
              registrationAttempts,
              reason: lastTransientMessage
            });
            return false;
          }
        }
      }

      signal.throwIfAborted();
      this.assertRunningBeforeReady(running);
      const remaining = deadline - this.dependencies.now();
      if (remaining > 0) {
        await this.dependencies.sleep(Math.min(pollIntervalMs, remaining));
      }
    }

    this.assertRunningBeforeReady(running);
    this.recordLifecycle(running, "workspace-registration-degraded", {
      timeoutMs,
      apiChecks,
      registrationAttempts,
      reason: lastTransientMessage
    });
    return false;
  }

  private async handleManagedRestart(running: RunningHarness): Promise<void> {
    if (running.expectedStop || this.current !== running) return;
    const generation = this.lifecycleGeneration;
    const abort = new AbortController();
    this.managedRestartAbort = abort;
    try {
      running.expectedStop = true;
      this.current = null;
      await this.closeRunningLog(running);
      if (generation !== this.lifecycleGeneration || abort.signal.aborted) return;
      await this.startInternal(running.workspacePath, {}, abort.signal);
    } catch (error) {
      // startInternal() emits a failed state for real startup/recovery errors.
      // Cancellation is intentionally silent because stop() owns that state.
      if (!abort.signal.aborted && this.state?.kind !== "failed") {
        this.emit({
          kind: "failed",
          workspacePath: running.workspacePath,
          message: this.failureMessage(error, running.tail),
          logPath: this.config.logPath
        });
      }
    } finally {
      if (this.managedRestartAbort === abort) this.managedRestartAbort = null;
    }
  }

  private handleUnexpectedExit(
    running: RunningHarness,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (running.expectedStop || this.current !== running) return;
    this.current = null;
    void this.closeRunningLog(running);
    const exitDescription = signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
    const message = this.failureMessage(
      new Error(`Harness exited unexpectedly with ${exitDescription}`),
      running.tail
    );
    this.emit({
      kind: "failed",
      workspacePath: running.workspacePath,
      message,
      logPath: this.config.logPath
    });
  }

  private recordOutput(
    running: RunningHarness,
    stream: "stdout" | "stderr",
    chunk: Buffer | string
  ): void {
    const text = chunk.toString();
    running.log.write(`[${stream}] ${text}`);
    running.tail = `${running.tail}${text}`.slice(-MAX_TAIL_LENGTH);
  }

  private async waitUntilReady(
    running: RunningHarness,
    url: string,
    timeoutMs: number,
    pollIntervalMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const deadline = this.dependencies.now() + timeoutMs;
    let healthChecks = 0;
    let firstHealthFailureLogged = false;
    while (this.dependencies.now() < deadline) {
      signal.throwIfAborted();
      if (running.startupError !== null) throw running.startupError;
      if (running.exit !== null) {
        const { code, signal } = running.exit;
        throw new Error(
          signal === null
            ? `Harness exited before startup with code ${code ?? "unknown"}`
            : `Harness exited before startup with signal ${signal}`
        );
      }

      healthChecks += 1;
      if (await this.dependencies.checkHealth(url)) {
        this.recordLifecycle(running, "health-ready", { healthChecks });
        return;
      }
      if (!firstHealthFailureLogged) {
        firstHealthFailureLogged = true;
        this.recordLifecycle(running, "health-waiting", { url });
      }
      signal.throwIfAborted();
      const remaining = deadline - this.dependencies.now();
      if (remaining > 0) {
        await this.dependencies.sleep(Math.min(pollIntervalMs, remaining));
      }
    }
    this.recordLifecycle(running, "startup-timeout", {
      timeoutMs,
      healthChecks,
      pid: running.child.pid ?? null
    });
    throw new Error(`Harness did not become ready within ${timeoutMs}ms`);
  }

  private recordLifecycle(
    running: RunningHarness,
    event: string,
    details: Record<string, unknown> = {}
  ): void {
    running.log.write(`[supervisor] ${event} ${JSON.stringify(details)}\n`);
  }

  private async stopRunningProcess(running: RunningHarness, markExpected: boolean): Promise<void> {
    running.expectedStop = markExpected || running.expectedStop;
    const pid = running.child.pid;
    if (pid !== undefined && running.exit === null) {
      this.recordLifecycle(running, "process-stop-requested", {
        pid,
        expected: running.expectedStop
      });
      await this.dependencies.signalProcessGroup(pid, "SIGTERM");
      const exited = await this.dependencies.waitForExit(running.child, SHUTDOWN_TIMEOUT_MS);
      if (!exited) {
        this.recordLifecycle(running, "process-force-stop-requested", { pid });
        await this.dependencies.signalProcessGroup(pid, "SIGKILL");
        await this.dependencies.waitForExit(running.child, FORCE_EXIT_TIMEOUT_MS);
      }
    }

    if (this.current === running) this.current = null;
    await this.closeRunningLog(running);
  }

  private async closeRunningLog(running: RunningHarness): Promise<void> {
    running.logClose ??= this.dependencies.closeLog(running.log);
    await running.logClose;
  }

  private async hasPendingManagedRestartPlan(): Promise<boolean> {
    return this.config.managedRestart !== undefined
      && await this.dependencies.managedRestartPlanExists(this.config.managedRestart.planPath);
  }

  private async runManagedRestartHelper(
    mode: "finalize" | "rollback",
    healthUrl: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const managedRestart = this.config.managedRestart;
    if (managedRestart === undefined) throw new Error("Managed restart is not configured");
    const environment = withBundledPackageManagerEnvironment(
      this.config.inheritedEnv ?? process.env,
      this.config.packageManagerBinPath,
      this.config.execPath,
      this.config.packageManagerCliPath
    );
    await this.dependencies.runManagedRestartHelper({
      execPath: this.config.execPath,
      helperPath: managedRestart.helperPath,
      planPath: managedRestart.planPath,
      dshHome: this.config.dshHome,
      environment: {
        ...environment,
        DSH_HOME: this.config.dshHome,
        ELECTRON_RUN_AS_NODE: "1"
      },
      mode,
      ...(healthUrl === undefined ? {} : { healthUrl }),
      signal
    });
  }

  private failureMessage(error: unknown, tail: string): string {
    const base = error instanceof Error ? error.message : String(error);
    const details = tail.trim();
    return details.length === 0 ? base : `${base}\n\n${details}`;
  }

  private emit(state: HarnessState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

async function registerDshWorkspace(
  url: string,
  workspacePath: string,
  signal: AbortSignal
): Promise<void> {
  const rpcId = randomUUID();
  let response: Response;
  try {
    response = await fetch(new URL("/api/workspace.create", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: "workspace.create",
        payload: { path: workspacePath }
      }),
      signal
    });
  } catch (error) {
    throw new TransientWorkspaceRegistrationError(
      `Workspace registration failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { cause: error }
    );
  }
  if (!response.ok) {
    const message = `Workspace registration failed: HTTP ${response.status}`;
    if (isTransientHttpStatus(response.status)) {
      throw new TransientWorkspaceRegistrationError(message, response.status);
    }
    throw new Error(message);
  }

  const body: unknown = await response.json();
  if (!isWorkspaceRegistrationResponse(body, rpcId)) {
    throw new Error("Workspace registration returned an invalid response");
  }
  if (body.result.ok) return;

  throw new Error(`Workspace registration failed: ${body.result.error.message}`);
}

class TransientWorkspaceRegistrationError extends Error {
  override readonly name = "TransientWorkspaceRegistrationError";

  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

function isTransientWorkspaceRegistrationError(
  error: unknown
): error is TransientWorkspaceRegistrationError {
  return error instanceof TransientWorkspaceRegistrationError;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 404
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

async function checkDshApiReady(url: string): Promise<boolean> {
  const rpcId = randomUUID();
  try {
    const response = await fetch(new URL("/api/host.describe", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: "host.describe",
        payload: {}
      }),
      signal: AbortSignal.timeout(1_000)
    });
    if (!response.ok) return false;
    return isHostDescribeResponse(await response.json(), rpcId);
  } catch {
    return false;
  }
}

function isHostDescribeResponse(body: unknown, rpcId: string): boolean {
  if (!isRecord(body)
    || body.type !== "server-response"
    || body.rpcId !== rpcId
    || !isRecord(body.result)
    || body.result.ok !== true
    || !isRecord(body.result.value)) {
    return false;
  }
  const value = body.result.value;
  return typeof value.version === "string"
    && typeof value.cwd === "string"
    && (value.provider === undefined || typeof value.provider === "string")
    && (value.model === undefined || typeof value.model === "string")
    && typeof value.attachedSessions === "number"
    && Number.isInteger(value.attachedSessions)
    && value.attachedSessions >= 0
    && typeof value.home === "string"
    && typeof value.canOpenPath === "boolean";
}

interface WorkspaceRegistrationResponse {
  type: "server-response";
  rpcId: string;
  result: WorkspaceRegistrationResult;
}

type WorkspaceRegistrationResult =
  | {
    ok: true;
    value: {
      workspace: {
        workspaceId: string;
        path: string;
        title: string;
        sessionIds: string[];
        createdAt: string;
        updatedAt: string;
      };
      created: boolean;
    };
  }
  | {
    ok: false;
    error: { code: string; message: string; details: Record<string, unknown> };
  };

function isWorkspaceRegistrationResponse(
  body: unknown,
  rpcId: string
): body is WorkspaceRegistrationResponse {
  if (!isRecord(body)) return false;
  const response = body;
  if (response.type !== "server-response" || response.rpcId !== rpcId) return false;
  if (!isRecord(response.result)) return false;
  const result = response.result;
  if (result.ok === true) return isWorkspaceRegistrationValue(result.value);
  if (result.ok !== false || !isRecord(result.error)) return false;
  const error = result.error;
  return typeof error.code === "string"
    && typeof error.message === "string"
    && isRecord(error.details);
}

function isWorkspaceRegistrationValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.created !== "boolean" || !isRecord(value.workspace)) return false;
  const workspace = value.workspace;
  return typeof workspace.workspaceId === "string"
    && typeof workspace.path === "string"
    && typeof workspace.title === "string"
    && Array.isArray(workspace.sessionIds)
    && workspace.sessionIds.every((sessionId) => typeof sessionId === "string")
    && typeof workspace.createdAt === "string"
    && typeof workspace.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultDependencies: SupervisorDependencies = {
  allocatePort: allocateLoopbackPort,
  spawn: (command, args, options) => nodeSpawn(command, args, options) as ManagedChild,
  checkHealth: async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  },
  checkApiReady: checkDshApiReady,
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
  now: () => Date.now(),
  signalProcessGroup: async (pid, signal) => {
    try {
      const plan = buildProcessTerminationPlan(pid, signal);
      if (plan.kind === "taskkill") {
        try {
          await execFile("taskkill.exe", plan.args);
        } catch {
          // The child may have exited between the check and taskkill, or the
          // tree may contain a process we cannot terminate. Shutdown is best
          // effort; never replace the original startup/runtime error with a
          // taskkill diagnostic.
        }
      } else {
        process.kill(plan.pid, plan.signal);
      }
    } catch (error) {
      if (!isNoSuchProcessError(error)) throw error;
    }
  },
  waitForExit: async (child, timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  },
  closeLog: async (log) => {
    if (log.closed || log.destroyed) return;
    await new Promise<void>((resolve) => log.end(resolve));
  },
  registerWorkspace: registerDshWorkspace,
  managedRestartPlanExists: async (planPath) => {
    try {
      await access(planPath);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  },
  runManagedRestartHelper: async (input) => {
    const args = [
      input.helperPath,
      input.mode === "finalize" ? "--managed-finalize" : "--managed-rollback",
      input.planPath,
      ...(input.healthUrl === undefined ? [] : [input.healthUrl])
    ];
    await execFile(input.execPath, args, {
      env: input.environment,
      maxBuffer: 2 * 1024 * 1024,
      signal: input.signal
    });
  },
  appendLifecycle: async (logPath, event, details) => {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `[supervisor] ${event} ${JSON.stringify(details)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
};

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ESRCH" ||
      (error as { code?: unknown }).code === 128)
  );
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
