import type {
  HarnessState,
  StopReason
} from "./harness-supervisor.js";

export interface HarnessSupervisorPort {
  start(workspacePath: string): Promise<void>;
  restart(workspacePath: string): Promise<void>;
  stop(reason: StopReason): Promise<void>;
  onState(listener: (state: HarnessState) => void): () => void;
}

interface DesktopControllerDependencies {
  chooseWorkspace: () => Promise<string | null>;
  ensureDefaultWorkspace: () => Promise<string>;
  loadWorkspace: () => Promise<string | null>;
  renderState: (state: HarnessState) => Promise<void>;
  saveWorkspace: (workspacePath: string) => Promise<void>;
}

export class DesktopController {
  private workspacePath: string | null = null;
  private fallbackWorkspacePickerShown = false;

  constructor(
    private readonly supervisor: HarnessSupervisorPort,
    private readonly dependencies: DesktopControllerDependencies
  ) {
    this.supervisor.onState((state) => {
      void this.handleState(state).catch(() => undefined);
    });
  }

  private async handleState(state: HarnessState): Promise<void> {
    const shouldOpenFallbackPicker = state.kind === "ready"
      && state.requiresWorkspaceSelection === true
      && !this.fallbackWorkspacePickerShown;
    if (shouldOpenFallbackPicker) this.fallbackWorkspacePickerShown = true;

    await this.dependencies.renderState(state);
    if (shouldOpenFallbackPicker) await this.chooseAndSwitchWorkspace();
  }

  getCurrentWorkspace(): string | null {
    return this.workspacePath;
  }

  async initialize(): Promise<boolean> {
    const savedWorkspace = await this.dependencies.loadWorkspace();
    const workspace = savedWorkspace ?? (await this.dependencies.ensureDefaultWorkspace());

    if (savedWorkspace === null) {
      await this.dependencies.saveWorkspace(workspace);
    }
    this.workspacePath = workspace;
    await this.supervisor.start(workspace);
    return true;
  }

  async retry(): Promise<void> {
    if (this.workspacePath !== null) {
      await this.supervisor.restart(this.workspacePath);
    }
  }

  async chooseAndSwitchWorkspace(): Promise<boolean> {
    const workspace = await this.dependencies.chooseWorkspace();
    if (workspace === null) return false;

    await this.dependencies.saveWorkspace(workspace);
    this.workspacePath = workspace;
    await this.supervisor.restart(workspace);
    return true;
  }

  async stop(reason: StopReason): Promise<void> {
    await this.supervisor.stop(reason);
  }
}
