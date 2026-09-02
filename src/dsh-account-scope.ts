import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type DshAccountIdentity =
  | { kind: "guest" }
  | { kind: "account"; userId: number; claimCurrentGuest?: boolean };
export type DshAccountScopeOwner =
  | { kind: "legacy" }
  | { kind: "guest" }
  | { kind: "account"; accountRef: string };

export interface DshAccountScopeLaunch {
  containerRef: string;
  dshHome: string;
  settingsPath: string;
  logPath: string;
  runtimeScopeRef: string;
  owner: DshAccountScopeOwner;
}

export type DshAccountScopeReconcileResult = {
  status: "ready" | "relaunch";
  launch: DshAccountScopeLaunch;
};

export interface DshAccountScopeChoice {
  containerRef: string;
  active: boolean;
  createdAtMillis: number;
}

interface ScopeContainer {
  owner: Exclude<DshAccountScopeOwner, { kind: "legacy" }>;
  createdAtMillis: number;
  updatedAtMillis: number;
}

interface ScopeRegistry {
  version: 1;
  activeContainerRef: string;
  containers: Record<string, ScopeContainer>;
  accounts: Record<string, string>;
  pendingLegacy?: { targetContainerRef: string };
}

const REGISTRY_FILE = "dsh-account-scopes.json";
const CONTAINERS_DIRECTORY = "dsh-containers";
const LEGACY_CONTAINER_REF = "legacy";
const CONTAINER_REF_PATTERN = /^scope_[A-Za-z0-9_-]{3,120}$/u;
const ACCOUNT_REF_PATTERN = /^[a-f0-9]{64}$/u;

export class DshAccountScopeStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataPath: string,
    private readonly createContainerRef: () => string = () => `scope_${randomUUID().replaceAll("-", "")}`
  ) {}

  async configured(): Promise<boolean> { return await exists(this.registryPath); }

  async legacyLaunch(): Promise<DshAccountScopeLaunch> {
    const launch = this.paths(LEGACY_CONTAINER_REF, { kind: "legacy" });
    await Promise.all([
      mkdir(launch.dshHome, { recursive: true }),
      mkdir(path.dirname(launch.logPath), { recursive: true })
    ]);
    return launch;
  }

  async launch(): Promise<DshAccountScopeLaunch> {
    await this.recoverPendingLegacy();
    const registry = await this.readRegistry();
    if (registry !== undefined) return await this.ensureLaunch(registry.activeContainerRef, registry);
    if (await exists(this.legacyHome)) return this.paths(LEGACY_CONTAINER_REF, { kind: "legacy" });

    const containerRef = this.newContainerRef();
    const now = Date.now();
    const created: ScopeRegistry = {
      version: 1,
      activeContainerRef: containerRef,
      containers: { [containerRef]: { owner: { kind: "guest" }, createdAtMillis: now, updatedAtMillis: now } },
      accounts: {}
    };
    await this.writeRegistry(created);
    return await this.ensureLaunch(containerRef, created);
  }

  async reconcile(identity: DshAccountIdentity): Promise<DshAccountScopeReconcileResult> {
    let result!: DshAccountScopeReconcileResult;
    const mutation = this.mutationTail.then(async () => { result = await this.reconcileSerial(identity); });
    this.mutationTail = mutation.catch(() => undefined);
    await mutation;
    return result;
  }

  async accountContainers(): Promise<DshAccountScopeChoice[]> {
    const current = await this.launch();
    if (current.owner.kind !== "account") return [];
    const accountRef = current.owner.accountRef;
    const registry = await this.requireRegistry();
    return Object.entries(registry.containers)
      .flatMap(([containerRef, container]) => container.owner.kind === "account"
        && container.owner.accountRef === accountRef
        ? [{ containerRef, active: containerRef === registry.activeContainerRef, createdAtMillis: container.createdAtMillis }]
        : [])
      .sort((left, right) => left.createdAtMillis - right.createdAtMillis || left.containerRef.localeCompare(right.containerRef));
  }

  async activate(containerRef: string): Promise<DshAccountScopeLaunch> {
    let result!: DshAccountScopeLaunch;
    const mutation = this.mutationTail.then(async () => {
      const current = await this.launch();
      const registry = await this.requireRegistry();
      const target = registry.containers[containerRef];
      if (current.owner.kind !== "account" || target?.owner.kind !== "account"
        || target.owner.accountRef !== current.owner.accountRef) {
        throw new Error("DSH account container does not belong to the active account");
      }
      registry.activeContainerRef = containerRef;
      registry.accounts[current.owner.accountRef] = containerRef;
      await this.writeRegistry(registry);
      result = await this.ensureLaunch(containerRef, registry);
    });
    this.mutationTail = mutation.catch(() => undefined);
    await mutation;
    return result;
  }

  private async reconcileSerial(identity: DshAccountIdentity): Promise<DshAccountScopeReconcileResult> {
    const current = await this.launch();
    const targetOwner = ownerFor(identity);
    if (current.owner.kind === "legacy") return await this.planLegacyMigration(targetOwner);

    const registry = await this.requireRegistry();
    if (sameOwner(current.owner, targetOwner)) return { status: "ready", launch: current };

    if (current.owner.kind === "guest" && targetOwner.kind === "account") {
      const preferred = registry.accounts[targetOwner.accountRef];
      if (identity.kind === "account" && identity.claimCurrentGuest === false
        && preferred !== undefined && registry.containers[preferred] !== undefined) {
        registry.activeContainerRef = preferred;
        await this.writeRegistry(registry);
        return { status: "relaunch", launch: await this.ensureLaunch(preferred, registry) };
      }
      const now = Date.now();
      registry.containers[current.containerRef] = {
        ...registry.containers[current.containerRef]!,
        owner: targetOwner,
        updatedAtMillis: now
      };
      registry.accounts[targetOwner.accountRef] = current.containerRef;
      await this.writeRegistry(registry);
      return { status: "ready", launch: await this.ensureLaunch(current.containerRef, registry) };
    }

    const targetRef = targetOwner.kind === "account"
      ? registry.accounts[targetOwner.accountRef]
      : Object.entries(registry.containers)
        .find(([, container]) => container.owner.kind === "guest")?.[0];
    const containerRef = targetRef !== undefined && registry.containers[targetRef] !== undefined
      ? targetRef
      : this.newContainerRef();
    if (registry.containers[containerRef] === undefined) {
      const now = Date.now();
      registry.containers[containerRef] = { owner: targetOwner, createdAtMillis: now, updatedAtMillis: now };
    }
    registry.activeContainerRef = containerRef;
    if (targetOwner.kind === "account") registry.accounts[targetOwner.accountRef] = containerRef;
    await this.writeRegistry(registry);
    return { status: "relaunch", launch: await this.ensureLaunch(containerRef, registry) };
  }

  private async planLegacyMigration(
    owner: Exclude<DshAccountScopeOwner, { kind: "legacy" }>
  ): Promise<DshAccountScopeReconcileResult> {
    const containerRef = this.newContainerRef();
    const now = Date.now();
    const registry: ScopeRegistry = {
      version: 1,
      activeContainerRef: containerRef,
      containers: { [containerRef]: { owner, createdAtMillis: now, updatedAtMillis: now } },
      accounts: owner.kind === "account" ? { [owner.accountRef]: containerRef } : {},
      pendingLegacy: { targetContainerRef: containerRef }
    };
    await this.writeRegistry(registry);
    return { status: "relaunch", launch: this.paths(containerRef, owner) };
  }

  private async recoverPendingLegacy(): Promise<void> {
    const registry = await this.readRegistry();
    const pending = registry?.pendingLegacy;
    if (registry === undefined || pending === undefined) return;
    const target = this.paths(pending.targetContainerRef, registry.containers[pending.targetContainerRef]!.owner).dshHome;
    const sourceExists = await exists(this.legacyHome);
    const targetExists = await exists(target);
    if (sourceExists && targetExists) throw new Error("Legacy DSH migration has both source and target directories");
    if (sourceExists) {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(this.legacyHome, target);
    } else if (!targetExists) {
      throw new Error("Legacy DSH migration lost both source and target directories");
    }
    delete registry.pendingLegacy;
    await this.writeRegistry(registry);
  }

  private async ensureLaunch(containerRef: string, registry: ScopeRegistry): Promise<DshAccountScopeLaunch> {
    const container = registry.containers[containerRef];
    if (container === undefined) throw new Error("Active DSH account container is missing");
    const launch = this.paths(containerRef, container.owner);
    await Promise.all([
      mkdir(launch.dshHome, { recursive: true }),
      mkdir(path.dirname(launch.logPath), { recursive: true })
    ]);
    return launch;
  }

  private paths(containerRef: string, owner: DshAccountScopeOwner): DshAccountScopeLaunch {
    if (containerRef === LEGACY_CONTAINER_REF) {
      return {
        containerRef,
        dshHome: this.legacyHome,
        settingsPath: path.join(this.userDataPath, "settings.json"),
        logPath: path.join(this.userDataPath, "logs", "harness.log"),
        runtimeScopeRef: "web:legacy",
        owner
      };
    }
    const root = path.join(this.userDataPath, CONTAINERS_DIRECTORY, containerRef);
    return {
      containerRef,
      dshHome: path.join(root, "dsh"),
      settingsPath: path.join(root, "settings.json"),
      logPath: path.join(root, "logs", "harness.log"),
      runtimeScopeRef: `web:${containerRef}`,
      owner
    };
  }

  private async requireRegistry(): Promise<ScopeRegistry> {
    const registry = await this.readRegistry();
    if (registry === undefined) throw new Error("DSH account scope registry is missing");
    return registry;
  }

  private async readRegistry(): Promise<ScopeRegistry | undefined> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.registryPath, "utf8")); }
    catch (error) {
      if (isMissing(error)) return undefined;
      throw new Error("DSH account scope registry is unreadable", { cause: error });
    }
    if (!validRegistry(parsed)) throw new Error("DSH account scope registry is invalid");
    return parsed;
  }

  private async writeRegistry(registry: ScopeRegistry): Promise<void> {
    await mkdir(this.userDataPath, { recursive: true });
    const temporaryPath = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.registryPath);
  }

  private newContainerRef(): string {
    const value = this.createContainerRef();
    if (!CONTAINER_REF_PATTERN.test(value)) throw new Error("DSH account container reference is invalid");
    return value;
  }

  private get registryPath(): string { return path.join(this.userDataPath, REGISTRY_FILE); }
  private get legacyHome(): string { return path.join(this.userDataPath, "dsh"); }
}

export async function arkmePluginSupportsDesktopAccountScope(pluginDirectory: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await readFile(path.join(pluginDirectory, "package.json"), "utf8"));
    if (!record(manifest) || !record(manifest.arkme) || !record(manifest.arkme.desktopAccountScope)) return false;
    return manifest.arkme.desktopAccountScope.version === 1;
  } catch { return false; }
}

function ownerFor(identity: DshAccountIdentity): Exclude<DshAccountScopeOwner, { kind: "legacy" }> {
  if (identity.kind === "guest") return { kind: "guest" };
  if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0) {
    throw new Error("DSH account identity is invalid");
  }
  return {
    kind: "account",
    accountRef: createHash("sha256").update(`arkme-dsh-account-scope-v1\n${String(identity.userId)}`).digest("hex")
  };
}

function sameOwner(left: DshAccountScopeOwner, right: DshAccountScopeOwner): boolean {
  return left.kind === right.kind
    && (left.kind !== "account" || right.kind === "account" && left.accountRef === right.accountRef);
}

function validRegistry(value: unknown): value is ScopeRegistry {
  if (!record(value) || value.version !== 1 || typeof value.activeContainerRef !== "string"
    || !CONTAINER_REF_PATTERN.test(value.activeContainerRef)
    || !record(value.containers) || !record(value.accounts)) return false;
  if (!exactKeys(value, value.pendingLegacy === undefined
    ? ["version", "activeContainerRef", "containers", "accounts"]
    : ["version", "activeContainerRef", "containers", "accounts", "pendingLegacy"])) return false;
  const activeContainerRef = value.activeContainerRef;
  const containerRecords = value.containers;
  const containers = Object.entries(containerRecords);
  if (containers.length === 0 || containers.some(([ref, raw]) => !CONTAINER_REF_PATTERN.test(ref) || !validContainer(raw))) return false;
  const validatedContainers = containerRecords as Record<string, ScopeContainer>;
  if (!(activeContainerRef in containerRecords)) return false;
  if (Object.entries(value.accounts).some(([accountRef, containerRef]) => {
    const container = typeof containerRef === "string" ? validatedContainers[containerRef] : undefined;
    return !ACCOUNT_REF_PATTERN.test(accountRef) || container?.owner.kind !== "account"
      || container.owner.accountRef !== accountRef;
  })) return false;
  const active = validatedContainers[activeContainerRef];
  if (active?.owner.kind === "account" && value.accounts[active.owner.accountRef] !== activeContainerRef) return false;
  if (value.pendingLegacy !== undefined && (!record(value.pendingLegacy)
    || Object.keys(value.pendingLegacy).length !== 1
    || typeof value.pendingLegacy.targetContainerRef !== "string"
    || !(value.pendingLegacy.targetContainerRef in containerRecords))) return false;
  return true;
}

function validContainer(value: unknown): value is ScopeContainer {
  if (!record(value) || !record(value.owner)
    || !Number.isSafeInteger(value.createdAtMillis) || Number(value.createdAtMillis) <= 0
    || !Number.isSafeInteger(value.updatedAtMillis) || Number(value.updatedAtMillis) <= 0) return false;
  if (!exactKeys(value, ["owner", "createdAtMillis", "updatedAtMillis"])) return false;
  if (!exactKeys(value.owner, value.owner.kind === "guest" ? ["kind"] : ["kind", "accountRef"])) return false;
  return value.owner.kind === "guest"
    || value.owner.kind === "account" && ACCOUNT_REF_PATTERN.test(String(value.owner.accountRef));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, error => {
    if (isMissing(error)) return false;
    throw error;
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
