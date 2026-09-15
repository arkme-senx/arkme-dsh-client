import {
  chmod, cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, statfs, writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type RuntimeDataTransactionPhase = 'prepared' | 'commit-decided' | 'completed'

export interface RuntimeDataIdentity {
  releaseId: string
  harnessIdentity: string
}

interface ProtectedSnapshot {
  sourcePath: string
  snapshotPath: string
  existed: boolean
}

export interface RuntimeDataTransactionRecord {
  version: 1
  transactionId: string
  environment: string
  source: { dshHome: string; identity?: RuntimeDataIdentity }
  target: RuntimeDataIdentity
  phase: RuntimeDataTransactionPhase
  snapshotPath: string
  journalPath: string
  protectedSnapshots: ProtectedSnapshot[]
  failurePreservationPath?: string
  restoreState?: 'preserving-current' | 'copying-snapshot' | 'restored'
  createdAt: string
  updatedAt: string
}

export type RuntimeDataRecovery =
  | { kind: 'restored'; transactionId: string; target: RuntimeDataIdentity }
  | { kind: 'roll-forward-required'; transactionId: string; target: RuntimeDataIdentity }

export interface RuntimeDataTransactionBeginOptions extends RuntimeDataIdentity {
  dshHome: string
  registry?: readonly string[]
  allowHarnessTransition?: boolean
}

export interface RuntimeDataTransactionStoreOptions {
  userDataPath: string
  environment: string
}

interface CommittedRegistry {
  version: 1
  containers: Record<string, RuntimeDataIdentity>
}

const TRANSACTION_ID_PATTERN = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function dataSize(path: string): Promise<number> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return info.size
  if (!info.isDirectory()) return info.size
  let total = info.size
  for (const entry of await readdir(path)) total += await dataSize(join(path, entry))
  return total
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}

export class RuntimeDataTransaction {
  constructor(private readonly store: RuntimeDataTransactionStore, private current: RuntimeDataTransactionRecord) {}
  get record(): Readonly<RuntimeDataTransactionRecord> { return this.current }

  async markCommitDecided(): Promise<void> {
    if (this.current.phase === 'completed') throw new Error('runtime data transaction is already completed')
    if (this.current.phase === 'commit-decided') return
    this.current = await this.store.update(this.current, { phase: 'commit-decided' })
  }

  async complete(): Promise<void> {
    if (this.current.phase !== 'commit-decided') throw new Error('runtime data commit decision is required before completion')
    await this.store.recordCommitted(this.current.source.dshHome, this.current.target)
    this.current = await this.store.update(this.current, { phase: 'completed' })
  }

  async restorePrecommitFailure(): Promise<void> {
    if (this.current.phase !== 'prepared') throw new Error('cannot restore after the runtime data commit decision')
    this.current = await this.store.restore(this.current)
  }
}

export class RuntimeDataTransactionStore {
  readonly userDataPath: string
  readonly environment: string
  readonly transactionsPath: string
  private readonly committedPath: string

  constructor(options: RuntimeDataTransactionStoreOptions) {
    if (!/^[a-zA-Z0-9._-]+$/.test(options.environment)) throw new Error('invalid runtime data environment')
    this.userDataPath = resolve(options.userDataPath)
    this.environment = options.environment
    this.transactionsPath = join(this.userDataPath, 'runtime-data-transactions', this.environment)
    this.committedPath = join(this.transactionsPath, 'committed-containers.json')
  }

  async begin(options: RuntimeDataTransactionBeginOptions): Promise<RuntimeDataTransaction | undefined> {
    const dshHome = await this.validateDataPath(options.dshHome, true)
    const target = { releaseId: options.releaseId, harnessIdentity: options.harnessIdentity }
    const committed = await this.readCommitted()
    const previous = committed.containers[dshHome]
    if (previous?.releaseId === target.releaseId && previous.harnessIdentity === target.harnessIdentity) return undefined
    if (previous !== undefined && previous.harnessIdentity !== target.harnessIdentity && options.allowHarnessTransition !== true) {
      throw new Error(`container is committed to harness ${previous.harnessIdentity}; an explicit harness transition is required`)
    }

    const transactionId = `${Date.now()}-${randomUUID()}`
    const root = join(this.transactionsPath, transactionId)
    const snapshotPath = join(root, 'snapshot', 'dsh-home')
    const journalPath = join(root, 'transaction.json')
    const requestedRegistry = options.registry ?? [join(this.userDataPath, 'dsh-account-scopes.json')]
    const registry = [...new Set(requestedRegistry.map(path => resolve(path)))]
    for (const path of registry) await this.validateDataPath(path, false)
    const existingRegistry = [] as string[]
    for (const path of registry) if (await pathExists(path)) existingRegistry.push(path)

    let requiredBytes = await dataSize(dshHome)
    for (const path of existingRegistry) requiredBytes += await dataSize(path)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const disk = await statfs(root)
    const available = disk.bavail * disk.bsize
    if (available < requiredBytes + 1024 * 1024) throw new Error('insufficient disk capacity for runtime data snapshot')

    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await cp(dshHome, snapshotPath, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
    await chmod(snapshotPath, 0o700)
    const protectedSnapshots: ProtectedSnapshot[] = []
    for (const [index, sourcePath] of registry.entries()) {
      const protectedPath = join(root, 'snapshot', 'registry', `${index}-${basename(sourcePath)}`)
      const existed = existingRegistry.includes(sourcePath)
      if (existed) {
        await mkdir(dirname(protectedPath), { recursive: true, mode: 0o700 })
        await cp(sourcePath, protectedPath, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
      }
      protectedSnapshots.push({ sourcePath, snapshotPath: protectedPath, existed })
    }
    const now = new Date().toISOString()
    const record: RuntimeDataTransactionRecord = {
      version: 1, transactionId, environment: this.environment,
      source: { dshHome, ...(previous === undefined ? {} : { identity: previous }) },
      target, phase: 'prepared', snapshotPath, journalPath,
      protectedSnapshots, createdAt: now, updatedAt: now,
    }
    await atomicJson(journalPath, record)
    return new RuntimeDataTransaction(this, record)
  }

  async recover(): Promise<RuntimeDataRecovery[]> {
    if (!(await pathExists(this.transactionsPath))) return []
    const recoveries: RuntimeDataRecovery[] = []
    const entries = await readdir(this.transactionsPath, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!TRANSACTION_ID_PATTERN.test(entry.name)) continue
      if (entry.isSymbolicLink()) throw new Error(`runtime data transaction directory cannot be a symbolic link: ${entry.name}`)
      if (!entry.isDirectory()) continue
      const journalPath = join(this.transactionsPath, entry.name, 'transaction.json')
      if (!(await pathExists(journalPath))) continue
      const transaction = await this.resume(entry.name)
      let record = transaction.record as RuntimeDataTransactionRecord
      if (record.phase === 'prepared') {
        record = await this.restore(record)
        recoveries.push({ kind: 'restored', transactionId: record.transactionId, target: record.target })
      } else if (record.phase === 'commit-decided') {
        recoveries.push({ kind: 'roll-forward-required', transactionId: record.transactionId, target: record.target })
      }
    }
    return recoveries
  }

  async resume(transactionId: string): Promise<RuntimeDataTransaction> {
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) throw new Error('invalid runtime data transaction id')
    const root = join(this.transactionsPath, transactionId)
    const journalPath = join(root, 'transaction.json')
    const record = JSON.parse(await readFile(journalPath, 'utf8')) as RuntimeDataTransactionRecord
    await this.validateRecord(record, transactionId, root, journalPath)
    return new RuntimeDataTransaction(this, record)
  }

  async transferCommittedIdentity(sourceDshHome: string, targetDshHome: string): Promise<void> {
    const source = await this.validateDataPath(sourceDshHome, false)
    const target = await this.validateDataPath(targetDshHome, false)
    const registry = await this.readCommitted()
    const sourceIdentity = registry.containers[source]
    if (sourceIdentity === undefined) return
    const targetIdentity = registry.containers[target]
    if (targetIdentity !== undefined) {
      if (targetIdentity.releaseId === sourceIdentity.releaseId
        && targetIdentity.harnessIdentity === sourceIdentity.harnessIdentity) return
      throw new Error('target container has a conflicting committed identity')
    }
    registry.containers[target] = { ...sourceIdentity }
    await atomicJson(this.committedPath, registry)
  }

  async update(record: RuntimeDataTransactionRecord, patch: Partial<RuntimeDataTransactionRecord>): Promise<RuntimeDataTransactionRecord> {
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() }
    await atomicJson(record.journalPath, next)
    return next
  }

  async restore(record: RuntimeDataTransactionRecord): Promise<RuntimeDataTransactionRecord> {
    if (record.restoreState === 'restored') return record
    const failurePath = record.failurePreservationPath ?? join(dirname(record.journalPath), 'failed-current')
    let next = record
    if (next.restoreState === undefined) {
      next = await this.update(next, { failurePreservationPath: failurePath, restoreState: 'preserving-current' })
    }
    const dshHome = record.source.dshHome
    if (next.restoreState === 'preserving-current' && await pathExists(dshHome)) {
      if (!(await pathExists(failurePath))) await rename(dshHome, failurePath)
      else throw new Error('runtime data failure preservation path already exists')
    }
    if (next.restoreState === 'preserving-current') next = await this.update(next, { restoreState: 'copying-snapshot' })
    await this.restoreSnapshot(record.snapshotPath, dshHome, join(dirname(record.journalPath), 'restore-staging-dsh'))
    for (const [index, item] of record.protectedSnapshots.entries()) {
      const failedRegistry = join(failurePath, 'protected', `${index}-${basename(item.sourcePath)}`)
      if (await pathExists(item.sourcePath)) {
        await mkdir(dirname(failedRegistry), { recursive: true, mode: 0o700 })
        if (!(await pathExists(failedRegistry))) await rename(item.sourcePath, failedRegistry)
      }
      if (item.existed) {
        await this.restoreSnapshot(item.snapshotPath, item.sourcePath, join(dirname(record.journalPath), `restore-staging-registry-${index}`))
      }
    }
    return this.update(next, { restoreState: 'restored' })
  }

  private async restoreSnapshot(snapshot: string, target: string, staging: string): Promise<void> {
    if (await pathExists(target) && !(await pathExists(staging))) return
    if (await pathExists(staging)) await rm(staging, { recursive: true, force: true })
    await mkdir(dirname(staging), { recursive: true, mode: 0o700 })
    await cp(snapshot, staging, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(staging, target)
  }

  async recordCommitted(dshHome: string, target: RuntimeDataIdentity): Promise<void> {
    const canonicalHome = await this.validateDataPath(dshHome, false)
    if (!this.validIdentity(target)) throw new Error('invalid committed runtime data identity')
    const registry = await this.readCommitted()
    registry.containers[canonicalHome] = target
    await atomicJson(this.committedPath, registry)
  }

  private async readCommitted(): Promise<CommittedRegistry> {
    if (!(await pathExists(this.committedPath))) return { version: 1, containers: {} }
    const parsed = JSON.parse(await readFile(this.committedPath, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null
      || (parsed as { version?: unknown }).version !== 1
      || typeof (parsed as { containers?: unknown }).containers !== 'object'
      || (parsed as { containers?: unknown }).containers === null
      || Array.isArray((parsed as { containers?: unknown }).containers)) {
      throw new Error('invalid committed runtime data registry')
    }
    const containers = (parsed as { containers: Record<string, unknown> }).containers
    const validated: Record<string, RuntimeDataIdentity> = {}
    for (const [rawPath, identity] of Object.entries(containers)) {
      const canonicalPath = await this.validateDataPath(rawPath, false)
      if (canonicalPath !== rawPath || !this.validIdentity(identity as RuntimeDataIdentity)) {
        throw new Error('invalid committed runtime data registry entry')
      }
      validated[canonicalPath] = identity as RuntimeDataIdentity
    }
    return { version: 1, containers: validated }
  }

  private async validateDataPath(input: string, mustExist: boolean): Promise<string> {
    const candidate = resolve(input)
    if (!isWithin(this.userDataPath, candidate) || candidate === this.userDataPath) {
      throw new Error('runtime data path must stay inside user data')
    }
    if (isWithin(join(this.userDataPath, 'runtime-data-transactions'), candidate)
      || isWithin(join(this.userDataPath, 'runtime-manager'), candidate)) {
      throw new Error('runtime data source cannot be inside transaction or runtime manager storage')
    }
    if (!(await pathExists(candidate))) {
      if (mustExist) throw new Error(`runtime data path does not exist: ${candidate}`)
      let ancestor = dirname(candidate)
      while (!(await pathExists(ancestor)) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor)
      const rootReal = await realpath(this.userDataPath)
      if (!isWithin(rootReal, await realpath(ancestor))) throw new Error('runtime data parent resolves outside user data')
      return candidate
    }
    const rootReal = await realpath(this.userDataPath)
    const candidateReal = await realpath(candidate)
    if (!isWithin(rootReal, candidateReal)) throw new Error('runtime data path resolves outside user data')
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error('runtime data root cannot be a symbolic link')
    return candidate
  }

  private async validateRecord(record: RuntimeDataTransactionRecord, id: string, root: string, journal: string): Promise<void> {
    const validPhase = record?.phase === 'prepared' || record?.phase === 'commit-decided' || record?.phase === 'completed'
    if (record?.version !== 1 || record.transactionId !== id || record.environment !== this.environment
      || record.journalPath !== journal || !validPhase || !this.validIdentity(record.target)) {
      throw new Error('invalid runtime data transaction journal schema')
    }
    if (record.source.identity !== undefined && !this.validIdentity(record.source.identity)) {
      throw new Error('invalid runtime data transaction source identity')
    }
    await this.validateDataPath(record.source.dshHome, false)
    const snapshotRoot = join(root, 'snapshot')
    if (!await this.validControlledPath(record.snapshotPath, snapshotRoot, true)) {
      throw new Error('invalid runtime data transaction snapshot path')
    }
    if (record.failurePreservationPath !== undefined
      && !await this.validControlledPath(record.failurePreservationPath, root, false)) {
      throw new Error('invalid runtime data transaction failure path')
    }
    if (!Array.isArray(record.protectedSnapshots)) throw new Error('invalid runtime data transaction protected snapshots')
    for (const item of record.protectedSnapshots) {
      await this.validateDataPath(item.sourcePath, false)
      if (typeof item.existed !== 'boolean'
        || !await this.validControlledPath(item.snapshotPath, snapshotRoot, item.existed)) {
        throw new Error('invalid runtime data transaction protected snapshot path')
      }
    }
  }

  private validIdentity(value: RuntimeDataIdentity): boolean {
    return typeof value?.releaseId === 'string' && value.releaseId.length > 0
      && typeof value.harnessIdentity === 'string' && value.harnessIdentity.length > 0
  }

  private async validControlledPath(input: string, root: string, mustExist: boolean): Promise<boolean> {
    const candidate = resolve(input)
    if (!isWithin(root, candidate) || candidate === root) return false
    if (await pathExists(candidate)) {
      if ((await lstat(candidate)).isSymbolicLink()) return false
      return isWithin(await realpath(root), await realpath(candidate))
    }
    if (mustExist) return false
    let ancestor = dirname(candidate)
    while (!(await pathExists(ancestor)) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor)
    return isWithin(await realpath(root), await realpath(ancestor))
  }
}
