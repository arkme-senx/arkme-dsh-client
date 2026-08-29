import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  buildProcessTerminationPlan,
  HarnessProcessSupervisor,
  type HarnessState,
  type ManagedChild
} from "../src/harness-supervisor.js";
import * as supervisorModule from "../src/harness-supervisor.js";
import {
  activateOptionalExtensionRecovery,
  prepareOptionalExtensionRecovery
} from "../src/optional-extension-recovery.js";

const bundledEnvironment = supervisorModule as typeof supervisorModule & {
  withBundledPackageManagerEnvironment(
    environment: NodeJS.ProcessEnv,
    packageManagerBinPath: string,
    nodeExecPath: string,
    packageManagerCliPath: string,
    delimiter?: string
  ): NodeJS.ProcessEnv;
};

class FakeChild extends EventEmitter implements ManagedChild {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

async function createHarness(overrides: {
  health?: (context: { spawnCount: number; children: FakeChild[] }) => Promise<boolean>;
  apiReady?: () => Promise<boolean>;
  port?: number;
  useRealApiReadiness?: boolean;
  useRealWorkspaceRegistration?: boolean;
  registerWorkspace?: (url: string, workspacePath: string, signal: AbortSignal) => Promise<void>;
  waitForExit?: () => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  closeLog?: () => Promise<void>;
  managedRestartPlanExists?: () => Promise<boolean>;
  runManagedRestartHelper?: (input: {
    mode: "finalize" | "rollback";
    planPath: string;
    healthUrl?: string;
    signal: AbortSignal;
  }) => Promise<void>;
  optionalExtensionRecovery?: { environment: "prod" | "test"; runtimeReleaseId?: string };
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "jotmo-harness-supervisor-"));
  const dshHome = path.join(root, "dsh");
  const child = new FakeChild();
  const children = [child];
  const states: HarnessState[] = [];
  const signals: NodeJS.Signals[] = [];
  let spawnIndex = 0;
  const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => {
    const spawned = children[spawnIndex] ?? new FakeChild();
    if (children[spawnIndex] === undefined) children.push(spawned);
    spawnIndex += 1;
    return spawned;
  });
  let now = 0;
  const sleep = overrides.sleep ?? (async (milliseconds: number) => {
    now += milliseconds;
  });

  const supervisor = new HarnessProcessSupervisor(
    {
      execPath: "/Applications/arkme.app/Contents/MacOS/arkme",
      dshBinPath: "/runtime/@deepseek-ai/dsh/lib/bin.js",
      dshHome,
      logPath: path.join(root, "logs", "harness.log"),
      packageManagerBinPath: "/runtime/node_modules/.bin",
      packageManagerCliPath: "/runtime/node_modules/pnpm/bin/pnpm.cjs",
      inheritedEnv: { PATH: "/usr/bin" },
      managedRestart: {
        helperPath: "/arkme-plugin/lib/extension-profile-restart-helper.js",
        planPath: path.join(dshHome, "arkme-self", "desktop-managed-extension-restart.json"),
        releaseId: "electron-runtime-v1-0123456789abcdef0123456789abcdef"
      },
      ...(overrides.optionalExtensionRecovery === undefined ? {} : {
        optionalExtensionRecovery: {
          dshHome,
          ...overrides.optionalExtensionRecovery
        }
      }),
      directoryPickerBridge: { url: "http://127.0.0.1:41235/choose-directory", token: "test-token" }
    },
    {
      allocatePort: async () => overrides.port ?? 41234,
      spawn,
      checkHealth: overrides.health === undefined
        ? async () => true
        : async () => await overrides.health!({ spawnCount: spawnIndex, children }),
      ...(overrides.useRealApiReadiness ? {} : {
        checkApiReady: overrides.apiReady ?? (async () => true)
      }),
      sleep,
      now: () => now,
      signalProcessGroup: async (_pid, signal) => {
        signals.push(signal);
      },
      waitForExit: overrides.waitForExit ?? (async () => true),
      ...(overrides.useRealWorkspaceRegistration ? {} : {
        registerWorkspace: overrides.registerWorkspace ?? (async () => undefined)
      }),
      ...(overrides.closeLog === undefined ? {} : { closeLog: overrides.closeLog }),
      ...(overrides.managedRestartPlanExists === undefined
        ? {}
        : { managedRestartPlanExists: overrides.managedRestartPlanExists }),
      ...(overrides.runManagedRestartHelper === undefined
        ? {}
        : { runManagedRestartHelper: overrides.runManagedRestartHelper })
    }
  );
  supervisor.onState((state) => states.push(state));

  return { child, children, dshHome, root, signals, spawn, states, supervisor };
}

async function writeBrokenOptionalExtensionProfile(dshHome: string): Promise<{
  profilePath: string;
  sourcePath: string;
  originalText: string;
}> {
  const profileDirectory = path.join(dshHome, "profiles", "web");
  const sourcePath = path.join(dshHome, "development", "dsh-arkme-peer-portrait");
  await Promise.all([
    mkdir(profileDirectory, { recursive: true }),
    mkdir(sourcePath, { recursive: true })
  ]);
  const originalText = `${JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-base": "0.1.1-rc.2",
      "@senguoyun/dsh-arkme": "link:/runtime/dsh-arkme",
      "@senguoyun/dsh-arkme-peer-portrait": `link:${sourcePath}`
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@senguoyun/dsh-arkme",
          "@senguoyun/dsh-arkme-peer-portrait"
        ]
      }
    }
  }, undefined, 2)}\n`;
  const profilePath = path.join(profileDirectory, "package.json");
  await writeFile(profilePath, originalText);
  return { profilePath, sourcePath, originalText };
}

describe("HarnessProcessSupervisor", () => {
  test("replaces the Windows Path key without leaving a competing PATH value", () => {
    expect(bundledEnvironment.withBundledPackageManagerEnvironment?.(
      { Path: "C:\\Windows", PATH: "C:\\stale" },
      "C:\\arkme\\runtime-bin",
      "C:\\arkme\\arkme.exe",
      "C:\\arkme\\resources\\pnpm\\bin\\pnpm.cjs",
      ";"
    )).toEqual({
      Path: "C:\\arkme\\runtime-bin;C:\\Windows",
      ARKME_NODE_EXEC_PATH: "C:\\arkme\\arkme.exe",
      ARKME_PNPM_CLI_PATH: "C:\\arkme\\resources\\pnpm\\bin\\pnpm.cjs",
      ELECTRON_RUN_AS_NODE: "1"
    });
  });

  test("uses taskkill for a Windows process tree", () => {
    expect(buildProcessTerminationPlan(4242, "SIGTERM", "win32")).toEqual({
      kind: "taskkill",
      args: ["/PID", "4242", "/T"]
    });
    expect(buildProcessTerminationPlan(4242, "SIGKILL", "win32")).toEqual({
      kind: "taskkill",
      args: ["/PID", "4242", "/T", "/F"]
    });
  });

  test("starts dsh web without opening an external browser and reports readiness", async () => {
    const { dshHome, root, spawn, states, supervisor } = await createHarness();

    await supervisor.start("/Users/test/project");

    expect(spawn).toHaveBeenCalledWith(
      "/Applications/arkme.app/Contents/MacOS/arkme",
      [
        "--expose-internals",
        "/runtime/@deepseek-ai/dsh/lib/bin.js",
        "web",
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "41234"
      ],
      expect.objectContaining({
        cwd: "/Users/test/project",
        detached: true,
        env: expect.objectContaining({
          DSH_HOME: dshHome,
          ELECTRON_RUN_AS_NODE: "1",
          ARKME_DIRECTORY_PICKER_BRIDGE_URL: "http://127.0.0.1:41235/choose-directory",
          ARKME_DIRECTORY_PICKER_BRIDGE_TOKEN: "test-token",
          ARKME_NODE_EXEC_PATH: "/Applications/arkme.app/Contents/MacOS/arkme",
          ARKME_PNPM_CLI_PATH: "/runtime/node_modules/pnpm/bin/pnpm.cjs",
          ARKME_DESKTOP_MANAGED_RESTART: "1",
          ARKME_DESKTOP_MANAGED_RESTART_PLAN_PATH: path.join(
            dshHome,
            "arkme-self",
            "desktop-managed-extension-restart.json"
          ),
          ARKME_HARNESS_LOG_PATH: path.join(root, "logs", "harness.log"),
          DSH_PROFILE_FIRST_BUNDLES: "@senguoyun/dsh-arkme",
          DSH_INSTALLED_MODULE_BASE_PATH: "/runtime/@deepseek-ai/dsh/lib/bin.js",
          PATH: `/runtime/node_modules/.bin${path.delimiter}/usr/bin`
        })
      })
    );
    expect(states).toEqual([
      { kind: "starting", workspacePath: "/Users/test/project" },
      {
        kind: "ready",
        workspacePath: "/Users/test/project",
        url: "http://127.0.0.1:41234/"
      }
    ]);
  });

  test("waits for a complete DSH API response before registering the startup workspace", async () => {
    let hostDescribeAttempts = 0;
    let workspaceRegistrationAttempts = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = chunks.length === 0
          ? undefined
          : JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rpcId?: string };

        if (request.url === "/api/host.describe") {
          hostDescribeAttempts += 1;
          if (hostDescribeAttempts === 1) {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            type: "server-response",
            rpcId: body?.rpcId,
            result: {
              ok: true,
              value: {
                version: "0.1.0-rc.8",
                cwd: "/Users/test/project",
                attachedSessions: 0,
                home: "/Users/test",
                canOpenPath: true
              }
            }
          }));
          return;
        }

        if (request.url === "/api/workspace.create") {
          workspaceRegistrationAttempts += 1;
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            type: "server-response",
            rpcId: body?.rpcId,
            result: {
              ok: true,
              value: {
                workspace: {
                  workspaceId: "workspace-1",
                  path: "/Users/test/project",
                  title: "project",
                  sessionIds: [],
                  createdAt: "2026-08-20T00:00:00.000Z",
                  updatedAt: "2026-08-20T00:00:00.000Z"
                },
                created: true
              }
            }
          }));
          return;
        }

        response.writeHead(404).end();
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("API readiness test server did not bind");

    try {
      const { states, supervisor } = await createHarness({
        port: address.port,
        useRealApiReadiness: true,
        useRealWorkspaceRegistration: true
      });

      await supervisor.start("/Users/test/project", { timeoutMs: 1_000, pollIntervalMs: 10 });

      expect(hostDescribeAttempts).toBe(2);
      expect(workspaceRegistrationAttempts).toBe(1);
      expect(states.at(-1)).toMatchObject({ kind: "ready" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("falls back to manual workspace selection immediately on HTTP 404", async () => {
    let workspaceRegistrationAttempts = 0;
    const server = createServer((request, response) => {
      void (async () => {
        for await (const _chunk of request) {
          // Consume the request before replying, as the real DSH server does.
        }
        workspaceRegistrationAttempts += 1;
        response.writeHead(404).end();
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("workspace retry test server did not bind");

    try {
      const { states, supervisor } = await createHarness({
        port: address.port,
        useRealWorkspaceRegistration: true
      });

      await supervisor.start("/Users/test/project", { timeoutMs: 1_000, pollIntervalMs: 10 });

      expect(workspaceRegistrationAttempts).toBe(1);
      expect(states.at(-1)).toEqual({
        kind: "ready",
        workspacePath: "/Users/test/project",
        url: `http://127.0.0.1:${address.port}/`,
        requiresWorkspaceSelection: true
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("degrades to a usable Harness when its API never becomes ready", async () => {
    const apiReady = vi.fn(async () => false);
    const registerWorkspace = vi.fn(async () => undefined);
    const { signals, states, supervisor } = await createHarness({ apiReady, registerWorkspace });

    await supervisor.start("/Users/test/project", { timeoutMs: 500, pollIntervalMs: 250 });

    expect(apiReady).toHaveBeenCalledTimes(2);
    expect(registerWorkspace).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
    expect(states.at(-1)).toEqual({
      kind: "ready",
      workspacePath: "/Users/test/project",
      url: "http://127.0.0.1:41234/",
      requiresWorkspaceSelection: true
    });
  });

  test("registers the startup workspace before reporting readiness", async () => {
    let receivedRequest: Record<string, unknown> | undefined;
    let releaseRegistration!: () => void;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        receivedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        await new Promise<void>((registrationComplete) => {
          releaseRegistration = registrationComplete;
        });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          type: "server-response",
          rpcId: receivedRequest?.rpcId,
          result: {
            ok: true,
            value: {
              workspace: {
                workspaceId: "workspace-1",
                path: "/Users/test/project",
                title: "project",
                sessionIds: [],
                createdAt: "2026-08-20T00:00:00.000Z",
                updatedAt: "2026-08-20T00:00:00.000Z"
              },
              created: true
            }
          }
        }));
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("workspace test server did not bind");

    try {
      const { states, supervisor } = await createHarness({
        port: address.port,
        useRealWorkspaceRegistration: true
      });
      const starting = supervisor.start("/Users/test/project");

      await vi.waitFor(() => expect(receivedRequest).toBeDefined());
      expect(receivedRequest).toMatchObject({
        type: "client-request",
        rpcId: expect.any(String),
        method: "workspace.create",
        payload: { path: "/Users/test/project" }
      });
      expect(states).toEqual([{ kind: "starting", workspacePath: "/Users/test/project" }]);

      releaseRegistration();
      await starting;
      expect(states.at(-1)).toEqual({
        kind: "ready",
        workspacePath: "/Users/test/project",
        url: `http://127.0.0.1:${address.port}/`
      });
    } finally {
      releaseRegistration?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("stops before readiness when DSH rejects workspace registration", async () => {
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rpcId: string };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: {
            ok: false,
            error: {
              code: "workspace-unavailable",
              message: "workspace registry unavailable",
              details: {}
            }
          }
        }));
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("workspace test server did not bind");

    try {
      const { signals, states, supervisor } = await createHarness({
        port: address.port,
        useRealWorkspaceRegistration: true
      });

      await expect(supervisor.start("/Users/test/project")).rejects.toThrow(
        "Workspace registration failed: workspace registry unavailable"
      );
      expect(signals).toEqual(["SIGTERM"]);
      expect(states).toHaveLength(2);
      expect(states[0]).toEqual({ kind: "starting", workspacePath: "/Users/test/project" });
      expect(states[1]).toMatchObject({
        kind: "failed",
        workspacePath: "/Users/test/project",
        message: "Workspace registration failed: workspace registry unavailable"
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("stops before readiness when DSH returns an incomplete workspace registration", async () => {
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rpcId: string };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value: { created: true } }
        }));
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("workspace test server did not bind");

    try {
      const { signals, states, supervisor } = await createHarness({
        port: address.port,
        useRealWorkspaceRegistration: true
      });

      await expect(supervisor.start("/Users/test/project")).rejects.toThrow(
        "Workspace registration returned an invalid response"
      );
      expect(signals).toEqual(["SIGTERM"]);
      expect(states.at(-1)).toMatchObject({ kind: "failed" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("stops before readiness when DSH exits during workspace registration", async () => {
    let receivedRequest: Record<string, unknown> | undefined;
    let releaseRegistration!: () => void;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        receivedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        await new Promise<void>((registrationComplete) => {
          releaseRegistration = registrationComplete;
        });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          type: "server-response",
          rpcId: receivedRequest?.rpcId,
          result: {
            ok: true,
            value: {
              workspace: {
                workspaceId: "workspace-1",
                path: "/Users/test/project",
                title: "project",
                sessionIds: [],
                createdAt: "2026-08-20T00:00:00.000Z",
                updatedAt: "2026-08-20T00:00:00.000Z"
              },
              created: true
            }
          }
        }));
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("workspace test server did not bind");

    try {
      const { child, signals, states, supervisor } = await createHarness({
        port: address.port,
        useRealWorkspaceRegistration: true
      });
      const starting = supervisor.start("/Users/test/project");

      await vi.waitFor(() => expect(receivedRequest).toBeDefined());
      child.exit(17);
      releaseRegistration();

      await expect(starting).rejects.toThrow(
        "Harness exited before workspace registration with code 17"
      );
      expect(signals).toEqual([]);
      expect(states).toEqual([
        { kind: "starting", workspacePath: "/Users/test/project" },
        expect.objectContaining({
          kind: "failed",
          workspacePath: "/Users/test/project",
          message: "Harness exited before workspace registration with code 17"
        })
      ]);
    } finally {
      releaseRegistration?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("reports stderr when the process exits after becoming ready", async () => {
    const { child, states, supervisor } = await createHarness();
    await supervisor.start("/Users/test/project");

    expect(child.stderr.listenerCount("data")).toBe(1);
    child.stderr.emit("data", Buffer.from("provider crashed\n"));
    child.exit(17);
    await new Promise((resolve) => setImmediate(resolve));

    expect(states.at(-1)).toMatchObject({
      kind: "failed",
      workspacePath: "/Users/test/project",
      message: expect.stringContaining("provider crashed")
    });
  });

  test("automatically replaces a Harness process that requests a supervised restart", async () => {
    const { child, spawn, states, supervisor } = await createHarness();
    await supervisor.start("/Users/test/project");

    expect(spawn.mock.calls[0]?.[2]?.env).toMatchObject({
      ARKME_DESKTOP_MANAGED_RESTART: "1"
    });
    child.exit(75);

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(states.some((state) => state.kind === "failed")).toBe(false);
    expect(states.at(-1)).toMatchObject({
      kind: "ready",
      workspacePath: "/Users/test/project"
    });
  });

  test("does not spawn a replacement when app shutdown races the managed handoff", async () => {
    let releaseLog!: () => void;
    const closeLog = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseLog = resolve; });
    });
    const { child, spawn, supervisor } = await createHarness({ closeLog });
    await supervisor.start("/Users/test/project");

    child.exit(75);
    await vi.waitFor(() => expect(closeLog).toHaveBeenCalled());
    const stopping = supervisor.stop("quit");
    releaseLog();
    await stopping;
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("rolls back a pending extension plan and starts the previous profile when validation fails", async () => {
    const runManagedRestartHelper = vi.fn(async (input: { mode: "finalize" | "rollback" }) => {
      if (input.mode === "finalize") throw new Error("extension did not become active");
    });
    const { spawn, states, supervisor } = await createHarness({
      managedRestartPlanExists: async () => true,
      runManagedRestartHelper,
    });

    await supervisor.start("/Users/test/project");

    expect(runManagedRestartHelper.mock.calls.map(([input]) => input.mode)).toEqual([
      "finalize",
      "rollback"
    ]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(states.some((state) => state.kind === "failed")).toBe(false);
    expect(states.at(-1)).toMatchObject({ kind: "ready" });
  });

  test("re-applies an active quarantine after managed runtime rollback restores its Profile", async () => {
    let planExists = true;
    let profilePath = "";
    let originalText = "";
    const runManagedRestartHelper = vi.fn(async (input: { mode: "finalize" | "rollback" }) => {
      if (input.mode === "finalize") throw new Error("candidate runtime health failed");
      await writeFile(profilePath, originalText);
      planExists = false;
    });
    const harness = await createHarness({
      optionalExtensionRecovery: { environment: "test" },
      managedRestartPlanExists: async () => planExists,
      runManagedRestartHelper
    });
    const profile = await writeBrokenOptionalExtensionProfile(harness.dshHome);
    profilePath = profile.profilePath;
    originalText = profile.originalText;
    const quarantine = await prepareOptionalExtensionRecovery({
      dshHome: harness.dshHome,
      environment: "test",
      failureText: `Bundle failed to load ${path.join(profile.sourcePath, "index.js")}`
    });
    await activateOptionalExtensionRecovery(quarantine!);

    await harness.supervisor.start("/Users/test/project");

    expect(runManagedRestartHelper.mock.calls.map(([input]) => input.mode)).toEqual([
      "finalize",
      "rollback"
    ]);
    const manifest = JSON.parse(await readFile(profile.profilePath, "utf8")) as {
      dsh: { profile: { bundles: string[] } };
    };
    expect(manifest.dsh.profile.bundles).not.toContain("@senguoyun/dsh-arkme-peer-portrait");
    const receipt = JSON.parse(await readFile(quarantine!.receiptPath, "utf8")) as { phase: string };
    expect(receipt.phase).toBe("active");
  });

  test("archives an unmanaged restart plan without executing it in the current Release Set", async () => {
    const runManagedRestartHelper = vi.fn(async () => undefined);
    const { dshHome, supervisor } = await createHarness({ runManagedRestartHelper });
    const planPath = path.join(dshHome, "arkme-self", "desktop-managed-extension-restart.json");
    const businessStatePath = path.join(dshHome, "arkme-self", "test", "state.json");
    await mkdir(path.dirname(businessStatePath), { recursive: true });
    await writeFile(planPath, '{"schemaVersion":1,"targetVersion":"0.1.19"}\n', { flag: "wx" });
    await writeFile(businessStatePath, '{"pendingByUser":{"7":[]}}\n', { flag: "wx" });

    await supervisor.start("/Users/test/project");

    expect(runManagedRestartHelper).not.toHaveBeenCalled();
    await expect(access(planPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(businessStatePath, "utf8")).resolves.toBe('{"pendingByUser":{"7":[]}}\n');
    const archiveDirectory = path.join(dshHome, "arkme-self", "restart-plan-archive");
    const archived = await readdir(archiveDirectory);
    expect(archived).toHaveLength(1);
    await expect(readFile(path.join(archiveDirectory, archived[0]!), "utf8"))
      .resolves.toBe('{"schemaVersion":1,"targetVersion":"0.1.19"}\n');
  });

  test("retains and finalizes a restart plan created by the current Release Set", async () => {
    let planPath = "";
    const runManagedRestartHelper = vi.fn(async (_input: {
      mode: "finalize" | "rollback";
      planPath: string;
      healthUrl?: string;
      signal: AbortSignal;
    }) => { await unlink(planPath); });
    const { dshHome, supervisor } = await createHarness({ runManagedRestartHelper });
    planPath = path.join(dshHome, "arkme-self", "desktop-managed-extension-restart.json");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 3,
      runtimeReleaseId: "electron-runtime-v1-0123456789abcdef0123456789abcdef"
    }), { flag: "wx" });
    await supervisor.start("/Users/test/project");

    expect(runManagedRestartHelper).toHaveBeenCalledTimes(1);
    expect(runManagedRestartHelper.mock.calls[0]?.[0]).toMatchObject({ mode: "finalize", planPath });
    await expect(access(planPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(dshHome, "arkme-self", "restart-plan-archive")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rolls back a pending extension plan when the changed profile cannot start", async () => {
    let healthChecks = 0;
    let planExists = true;
    const runManagedRestartHelper = vi.fn(async (_input: { mode: "finalize" | "rollback" }) => {
      planExists = false;
    });
    const { spawn, states, supervisor } = await createHarness({
      health: async () => {
        healthChecks += 1;
        return healthChecks > 120;
      },
      managedRestartPlanExists: async () => planExists,
      runManagedRestartHelper,
    });

    await supervisor.start("/Users/test/project", { timeoutMs: 30_000, pollIntervalMs: 250 });

    expect(runManagedRestartHelper).toHaveBeenCalledTimes(1);
    expect(runManagedRestartHelper.mock.calls[0]?.[0]).toMatchObject({ mode: "rollback" });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(states.some((state) => state.kind === "failed")).toBe(false);
    expect(states.at(-1)).toMatchObject({ kind: "ready" });
  });

  test("quarantines one optional extension and retries the same Harness once", async () => {
    const failedSpawns = new Set<number>();
    let sourcePath = "";
    const harness = await createHarness({
      optionalExtensionRecovery: {
        environment: "test",
        runtimeReleaseId: "electron-runtime-v1-0123456789abcdef0123456789abcdef"
      },
      health: async ({ spawnCount, children }) => {
        if (spawnCount === 1 && !failedSpawns.has(spawnCount)) {
          failedSpawns.add(spawnCount);
          children[0]!.stderr.emit("data", Buffer.from(
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@senguoyun/dsh-arkme'\n"
          ));
          children[0]!.stderr.emit("data", Buffer.from(
            `imported from ${path.join(sourcePath, "lib", "index.js")}\n`
          ));
          children[0]!.stderr.emit("data", Buffer.from("Cordis bundle loader failed\n"));
          children[0]!.exit(1);
          return false;
        }
        return spawnCount === 2;
      }
    });
    const profile = await writeBrokenOptionalExtensionProfile(harness.dshHome);
    sourcePath = profile.sourcePath;

    await harness.supervisor.start("/Users/test/project");

    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.states.at(-1)).toMatchObject({ kind: "ready" });
    const manifest = JSON.parse(await readFile(profile.profilePath, "utf8")) as {
      dsh: { profile: { bundles: string[] } };
    };
    expect(manifest.dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@senguoyun/dsh-arkme"
    ]);
    const quarantineRoot = path.join(
      harness.dshHome,
      "arkme-self",
      "desktop-extension-quarantine"
    );
    const quarantineDirectories = await readdir(quarantineRoot);
    expect(quarantineDirectories).toHaveLength(1);
    const receipt = JSON.parse(await readFile(path.join(
      quarantineRoot,
      quarantineDirectories[0]!,
      "receipt.json"
    ), "utf8")) as { phase: string; entries: Array<{ packageName: string }> };
    expect(receipt).toMatchObject({
      phase: "active",
      entries: [{ packageName: "@senguoyun/dsh-arkme-peer-portrait" }]
    });
  });

  test("restores the Profile when the optional-extension retry also fails", async () => {
    const failedSpawns = new Set<number>();
    let sourcePath = "";
    const harness = await createHarness({
      optionalExtensionRecovery: { environment: "prod" },
      health: async ({ spawnCount, children }) => {
        if (!failedSpawns.has(spawnCount)) {
          failedSpawns.add(spawnCount);
          const child = children[spawnCount - 1]!;
          child.stderr.emit("data", Buffer.from(
            `Cordis bundle loader failed importing ${path.join(sourcePath, "lib", "index.js")}\n`
          ));
          child.exit(1);
        }
        return false;
      }
    });
    const profile = await writeBrokenOptionalExtensionProfile(harness.dshHome);
    sourcePath = profile.sourcePath;

    await expect(harness.supervisor.start("/Users/test/project")).rejects.toThrow();

    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(await readFile(profile.profilePath, "utf8")).toBe(profile.originalText);
    const quarantineRoot = path.join(
      harness.dshHome,
      "arkme-self",
      "desktop-extension-quarantine"
    );
    const quarantineDirectories = await readdir(quarantineRoot);
    const receipt = JSON.parse(await readFile(path.join(
      quarantineRoot,
      quarantineDirectories[0]!,
      "receipt.json"
    ), "utf8")) as { phase: string };
    expect(receipt.phase).toBe("restored");
  });

  test("rolls back a managed restart before considering optional-extension recovery", async () => {
    let planExists = true;
    const runManagedRestartHelper = vi.fn(async () => { planExists = false; });
    let sourcePath = "";
    const harness = await createHarness({
      optionalExtensionRecovery: { environment: "prod" },
      managedRestartPlanExists: async () => planExists,
      runManagedRestartHelper,
      health: async ({ spawnCount, children }) => {
        if (spawnCount === 1) {
          children[0]!.stderr.emit("data", Buffer.from(
            `Cordis bundle loader failed importing ${path.join(sourcePath, "index.js")}\n`
          ));
          children[0]!.exit(1);
          return false;
        }
        return true;
      }
    });
    const profile = await writeBrokenOptionalExtensionProfile(harness.dshHome);
    sourcePath = profile.sourcePath;

    await harness.supervisor.start("/Users/test/project");

    expect(runManagedRestartHelper).toHaveBeenCalledTimes(1);
    expect(runManagedRestartHelper).toHaveBeenCalledWith(expect.objectContaining({ mode: "rollback" }));
    expect(await readFile(profile.profilePath, "utf8")).toBe(profile.originalText);
    await expect(access(path.join(
      harness.dshHome,
      "arkme-self",
      "desktop-extension-quarantine"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not retry or mutate the Profile for a non-loader startup failure", async () => {
    const harness = await createHarness({
      optionalExtensionRecovery: { environment: "prod" },
      health: async ({ children }) => {
        children[0]!.stderr.emit("data", Buffer.from("connect ECONNREFUSED 127.0.0.1:443\n"));
        children[0]!.exit(1);
        return false;
      }
    });
    const profile = await writeBrokenOptionalExtensionProfile(harness.dshHome);

    await expect(harness.supervisor.start("/Users/test/project")).rejects.toThrow("ECONNREFUSED");

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(await readFile(profile.profilePath, "utf8")).toBe(profile.originalText);
  });

  test("times out when the web server never becomes healthy", async () => {
    const { states, supervisor } = await createHarness({
      health: async () => false,
      waitForExit: async () => true
    });

    await expect(
      supervisor.start("/Users/test/project", { timeoutMs: 500, pollIntervalMs: 250 })
    ).rejects.toThrow("did not become ready within 500ms");
    expect(states.at(-1)).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("did not become ready within 500ms")
    });
  });

  test("escalates from SIGTERM to SIGKILL after the shutdown timeout", async () => {
    let waits = 0;
    const { signals, supervisor } = await createHarness({
      waitForExit: async () => {
        waits += 1;
        return waits > 1;
      }
    });
    await supervisor.start("/Users/test/project");

    await supervisor.stop("quit");

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
