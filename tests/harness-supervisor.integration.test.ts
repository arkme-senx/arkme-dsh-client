import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { HarnessProcessSupervisor } from "../src/harness-supervisor.js";

const fixturePath = fileURLToPath(new URL("fixtures/mock-dsh.mjs", import.meta.url));

async function waitForMockPid(dshHome: string): Promise<number> {
  const pidPath = path.join(dshHome, "mock.pid");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(pidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Mock Harness did not publish its PID at ${pidPath}`);
}

describe.skipIf(process.platform === "win32")("HarnessProcessSupervisor integration", () => {
  test("manages a real loopback HTTP child process and removes it on stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jotmo-harness-integration-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "jotmo-harness-workspace-"));
    const dshHome = path.join(root, "dsh");
    const supervisor = new HarnessProcessSupervisor({
      execPath: process.execPath,
      dshBinPath: fixturePath,
      dshHome,
      logPath: path.join(root, "logs", "harness.log"),
      packageManagerBinPath: path.join(root, "runtime-bin"),
      packageManagerCliPath: path.join(root, "pnpm", "bin", "pnpm.cjs"),
      managedRestart: {
        helperPath: fixturePath,
        planPath: path.join(dshHome, "missing-managed-restart-plan.json")
      }
    });

    await supervisor.start(workspace, { timeoutMs: 5_000, pollIntervalMs: 50 });
    const readyState = supervisor.getState();
    expect(readyState).toMatchObject({ kind: "ready", workspacePath: workspace });
    if (readyState?.kind !== "ready") throw new Error("Harness did not become ready");

    const response = await fetch(readyState.url);
    expect(await response.text()).toContain("Mock Harness");
    const childPid = await waitForMockPid(dshHome);

    await supervisor.stop("quit");

    expect(() => process.kill(childPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
    await expect(fetch(readyState.url)).rejects.toThrow();
    await expect(access(path.join(root, "logs", "harness.log"))).resolves.toBeUndefined();
  });

  test("replaces and retains ownership of a real child that requests a managed restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jotmo-harness-managed-restart-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "jotmo-harness-workspace-"));
    const dshHome = path.join(root, "dsh");
    const supervisor = new HarnessProcessSupervisor({
      execPath: process.execPath,
      dshBinPath: fixturePath,
      dshHome,
      logPath: path.join(root, "logs", "harness.log"),
      packageManagerBinPath: path.join(root, "runtime-bin"),
      packageManagerCliPath: path.join(root, "pnpm", "bin", "pnpm.cjs"),
      managedRestart: {
        helperPath: fixturePath,
        planPath: path.join(dshHome, "missing-managed-restart-plan.json")
      }
    });

    await supervisor.start(workspace, { timeoutMs: 5_000, pollIntervalMs: 50 });
    const firstState = supervisor.getState();
    if (firstState?.kind !== "ready") throw new Error("Harness did not become ready");
    const firstPid = await waitForMockPid(dshHome);
    expect(Number(await readFile(path.join(dshHome, "mock.ppid"), "utf8"))).toBe(process.pid);
    await fetch(new URL("managed-restart", firstState.url));

    const deadline = Date.now() + 5_000;
    let replacementPid = firstPid;
    while (Date.now() < deadline) {
      replacementPid = Number(await readFile(path.join(dshHome, "mock.pid"), "utf8"));
      if (replacementPid !== firstPid && supervisor.getState()?.kind === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(replacementPid).not.toBe(firstPid);
    expect(() => process.kill(firstPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(() => process.kill(replacementPid, 0)).not.toThrow();
    expect(Number(await readFile(path.join(dshHome, "mock.ppid"), "utf8"))).toBe(process.pid);
    expect(JSON.parse(await readFile(path.join(dshHome, "mock-workspace-registrations.json"), "utf8"))).toEqual({
      count: 2,
      mostRecentCreated: false
    });

    await supervisor.stop("quit");
    expect(() => process.kill(replacementPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
  });
});
