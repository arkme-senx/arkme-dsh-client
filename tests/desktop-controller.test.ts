import { describe, expect, test, vi } from "vitest";
import {
  DesktopController,
  type HarnessSupervisorPort
} from "../src/desktop-controller.js";
import type { HarnessState } from "../src/harness-supervisor.js";

class FakeSupervisor implements HarnessSupervisorPort {
  readonly start = vi.fn(async () => undefined);
  readonly restart = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  private listener: ((state: HarnessState) => void) | null = null;

  onState(listener: (state: HarnessState) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(state: HarnessState): void {
    this.listener?.(state);
  }
}

function setup(
  lastWorkspace: string | null,
  selection: string | null = null,
  defaultWorkspace = "/Users/test/Arkme Harness/workspace"
) {
  const supervisor = new FakeSupervisor();
  const renderState = vi.fn(async () => undefined);
  const chooseWorkspace = vi.fn(async () => selection);
  const ensureDefaultWorkspace = vi.fn(async () => defaultWorkspace);
  const saveWorkspace = vi.fn(async () => undefined);
  const controller = new DesktopController(supervisor, {
    chooseWorkspace,
    ensureDefaultWorkspace,
    loadWorkspace: async () => lastWorkspace,
    renderState,
    saveWorkspace
  });
  return {
    chooseWorkspace,
    controller,
    ensureDefaultWorkspace,
    renderState,
    saveWorkspace,
    supervisor
  };
}

describe("DesktopController", () => {
  test("starts the last valid workspace without opening the picker", async () => {
    const { chooseWorkspace, controller, supervisor } = setup("/Users/test/project");

    await expect(controller.initialize()).resolves.toBe(true);

    expect(chooseWorkspace).not.toHaveBeenCalled();
    expect(supervisor.start).toHaveBeenCalledWith("/Users/test/project");
  });

  test("creates and persists the default workspace before the first start", async () => {
    const {
      chooseWorkspace,
      controller,
      ensureDefaultWorkspace,
      saveWorkspace,
      supervisor
    } = setup(null);

    await expect(controller.initialize()).resolves.toBe(true);

    expect(chooseWorkspace).not.toHaveBeenCalled();
    expect(ensureDefaultWorkspace).toHaveBeenCalledOnce();
    expect(saveWorkspace).toHaveBeenCalledWith("/Users/test/Arkme Harness/workspace");
    expect(supervisor.start).toHaveBeenCalledWith("/Users/test/Arkme Harness/workspace");
  });

  test("propagates default workspace creation failures without opening the picker", async () => {
    const { chooseWorkspace, controller, ensureDefaultWorkspace, supervisor } = setup(null);
    ensureDefaultWorkspace.mockRejectedValueOnce(new Error("workspace unavailable"));

    await expect(controller.initialize()).rejects.toThrow("workspace unavailable");

    expect(chooseWorkspace).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  test("switches workspace only after a new directory is selected", async () => {
    const { controller, saveWorkspace, supervisor } = setup(
      "/Users/test/project",
      "/Users/test/other"
    );
    await controller.initialize();

    await controller.chooseAndSwitchWorkspace();

    expect(saveWorkspace).toHaveBeenCalledWith("/Users/test/other");
    expect(supervisor.restart).toHaveBeenCalledWith("/Users/test/other");
  });

  test("retries the current workspace", async () => {
    const { controller, supervisor } = setup("/Users/test/project");
    await controller.initialize();

    await controller.retry();

    expect(supervisor.restart).toHaveBeenCalledWith("/Users/test/project");
  });

  test("forwards process states to the desktop view", async () => {
    const { controller, renderState, supervisor } = setup("/Users/test/project");
    await controller.initialize();
    const state: HarnessState = {
      kind: "ready",
      workspacePath: "/Users/test/project",
      url: "http://127.0.0.1:41234/"
    };

    supervisor.emit(state);
    await new Promise((resolve) => setImmediate(resolve));

    expect(renderState).toHaveBeenCalledWith(state);
  });

  test("opens the workspace picker only once after registration falls back", async () => {
    const { chooseWorkspace, controller, renderState, supervisor } = setup(
      "/Users/test/project",
      null
    );
    await controller.initialize();
    const state: HarnessState = {
      kind: "ready",
      workspacePath: "/Users/test/project",
      url: "http://127.0.0.1:41234/",
      requiresWorkspaceSelection: true
    };

    supervisor.emit(state);
    await vi.waitFor(() => expect(chooseWorkspace).toHaveBeenCalledOnce());
    supervisor.emit(state);
    await new Promise((resolve) => setImmediate(resolve));

    expect(renderState).toHaveBeenCalledWith(state);
    expect(chooseWorkspace).toHaveBeenCalledOnce();
    expect(supervisor.restart).not.toHaveBeenCalled();
  });

  test("saves and restarts with the manually selected workspace after registration falls back", async () => {
    const { controller, saveWorkspace, supervisor } = setup(
      "/Users/test/project",
      "/Users/test/other"
    );
    await controller.initialize();

    supervisor.emit({
      kind: "ready",
      workspacePath: "/Users/test/project",
      url: "http://127.0.0.1:41234/",
      requiresWorkspaceSelection: true
    });
    await vi.waitFor(() => expect(supervisor.restart).toHaveBeenCalledOnce());

    expect(saveWorkspace).toHaveBeenCalledWith("/Users/test/other");
    expect(supervisor.restart).toHaveBeenCalledWith("/Users/test/other");
  });
});
