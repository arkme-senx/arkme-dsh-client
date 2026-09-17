import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, test, vi } from "vitest";

// Exercise the real main-process handlers without booting Electron or touching an account.
function mainHandlers() {
  const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["renderState", "revealAttestedHarness", "attestDesktopAccountScope"]);
  const handlers = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text ?? ""));
  expect(handlers).toHaveLength(names.size);
  return ts.transpileModule(handlers.map(handler => handler.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
}

function fixture() {
  const previous = { kind: "ready", workspacePath: "/workspace", url: "http://127.0.0.1:55451/" };
  const loadURL = vi.fn(async (_url: string) => undefined);
  const context = createContext({
    URL, mainWindow: { isDestroyed: () => false, isVisible: () => true, loadURL, webContents: { id: 1 } },
    lastHarnessReadyState: previous, bufferedHarnessReadyState: previous,
    holdCandidateNavigation: false, accountScopeReady: true, activeHarnessOrigin: previous.url,
    accountScopeTransition: null, activeAccountScope: {},
    desktopSessionSelection: { invalidate: vi.fn(), prepare: vi.fn(async () => true) },
    accountScopeStore: { reconcile: async () => ({ status: "ready", launch: {} }) },
    refreshAccountScopeMenu: async () => undefined,
    logDiagnostic: () => undefined, desktopNotifications: { markHarnessLoading: () => undefined },
    createStatusPageUrl: () => "file:///status.html", statusHtmlPath: "", runtimeEnvironment: "prod",
    harnessAuthSession: null, deepLinks: { peek: () => undefined },
    renderAccountScopeWaiting: async () => { await loadURL("file:///waiting.html"); },
    renderRuntimeProgressPage: null
  });
  runInContext(mainHandlers(), context);
  return { context, loadURL };
}

describe("managed restart page lifetime", () => {
  test("does not reopen the stopped server when the new process attests its account", async () => {
    const { context, loadURL } = fixture();
    await context.renderState({ kind: "starting", workspacePath: "/workspace" });
    loadURL.mockClear();
    await expect(context.attestDesktopAccountScope({ kind: "account", userId: 1 })).resolves.toEqual({ status: "ready" });
    expect(loadURL).not.toHaveBeenCalled();
    expect(context.bufferedHarnessReadyState).toBeNull();
    await context.renderState({ kind: "ready", workspacePath: "/workspace", url: "http://127.0.0.1:55721/" });
    expect(loadURL).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:55721/");
  });

  test("still reveals the current ready page when account attestation arrives afterwards", async () => {
    const { context, loadURL } = fixture();
    await context.revealAttestedHarness();
    expect(loadURL).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:55451/");
  });
  test("invalidates the previous process even when the window has been closed", async () => {
    const { context } = fixture();
    context.mainWindow = null;
    await context.renderState({ kind: "starting", workspacePath: "/workspace" });
    expect(context.lastHarnessReadyState).toBeNull();
    expect(context.bufferedHarnessReadyState).toBeNull();
  });

  test("keeps the candidate navigation gate and buffers only the new process", async () => {
    const { context, loadURL } = fixture();
    context.holdCandidateNavigation = true;
    await context.renderState({ kind: "starting", workspacePath: "/workspace" });
    loadURL.mockClear();
    await context.attestDesktopAccountScope({ kind: "account", userId: 1 });
    expect(loadURL).not.toHaveBeenCalled();
    expect(context.holdCandidateNavigation).toBe(true);
    const current = { kind: "ready", workspacePath: "/workspace", url: "http://127.0.0.1:55721/" };
    await context.renderState(current);
    expect(context.bufferedHarnessReadyState).toEqual(current);
    expect(loadURL).not.toHaveBeenCalled();
    context.holdCandidateNavigation = false;
    await context.revealAttestedHarness();
    expect(loadURL).toHaveBeenCalledExactlyOnceWith(current.url);
  });

  test("waits for account attestation when the new server becomes ready first", async () => {
    const { context, loadURL } = fixture();
    context.accountScopeReady = false;
    await context.renderState({ kind: "starting", workspacePath: "/workspace" });
    const current = { kind: "ready", workspacePath: "/workspace", url: "http://127.0.0.1:55721/" };
    await context.renderState(current);
    expect(loadURL).not.toHaveBeenCalledWith(current.url);
    loadURL.mockClear();
    await context.attestDesktopAccountScope({ kind: "account", userId: 1 });
    expect(loadURL).toHaveBeenCalledExactlyOnceWith(current.url);
  });

});
