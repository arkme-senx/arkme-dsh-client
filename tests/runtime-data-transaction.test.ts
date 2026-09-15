import { access, chmod, cp, mkdir, mkdtemp, readFile, readlink, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeDataTransactionStore } from '../src/runtime-data-transaction.js'

async function fixture(environment = 'test') {
  const root = await mkdtemp(join(tmpdir(), 'arkme-data-txn-'))
  const userDataPath = join(root, 'user-data')
  const dshHome = join(userDataPath, 'dsh-containers', 'account-1', 'dsh')
  await mkdir(join(dshHome, 'sessions'), { recursive: true })
  await writeFile(join(dshHome, 'sessions', 'older.jsonl'), 'old-session')
  return { root, userDataPath, dshHome, store: new RuntimeDataTransactionStore({ userDataPath, environment }) }
}

describe('runtime data transactions', () => {
  it('restores older sessions and preserves the failed trial directory', async () => {
    const { dshHome, userDataPath, store } = await fixture()
    const registryPath = join(userDataPath, 'dsh-account-scopes.json')
    await writeFile(registryPath, 'original-registry')
    const transaction = await store.begin({ dshHome, releaseId: 'release-2', harnessIdentity: 'harness-2' })
    expect(transaction).toBeDefined()
    await writeFile(join(dshHome, 'sessions', 'older.jsonl'), 'trial-write')
    await writeFile(join(dshHome, 'sessions', 'new.jsonl'), 'new-session')
    await writeFile(registryPath, 'trial-registry')

    await transaction!.restorePrecommitFailure()

    expect(await readFile(join(dshHome, 'sessions', 'older.jsonl'), 'utf8')).toBe('old-session')
    await expect(readFile(join(dshHome, 'sessions', 'new.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(transaction!.record.failurePreservationPath!, 'sessions', 'new.jsonl'), 'utf8'))
      .toBe('new-session')
    expect(await readFile(registryPath, 'utf8')).toBe('original-registry')
  })

  it('copies symlinks without following or changing their external targets', async () => {
    const { root, dshHome, store } = await fixture()
    const external = join(root, 'external-project')
    await mkdir(external)
    await writeFile(join(external, 'keep.txt'), 'untouched')
    await symlink(external, join(dshHome, 'external-link'))
    await symlink('../../../../external-project', join(dshHome, 'relative-link'))

    const transaction = await store.begin({ dshHome, releaseId: 'release-2', harnessIdentity: 'harness-2' })

    expect(await readlink(join(transaction!.record.snapshotPath, 'external-link'))).toBe(external)
    expect(await readlink(join(transaction!.record.snapshotPath, 'relative-link'))).toBe('../../../../external-project')
    await transaction!.restorePrecommitFailure()
    expect(await readlink(join(dshHome, 'relative-link'))).toBe('../../../../external-project')
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('untouched')
  })

  it('retains executable modes when restored', async () => {
    const { dshHome, store } = await fixture()
    const binary = join(dshHome, 'tool')
    await writeFile(binary, '#!/bin/sh\n')
    await chmod(binary, 0o755)
    const transaction = await store.begin({ dshHome, releaseId: 'r2', harnessIdentity: 'h2' })
    await transaction!.restorePrecommitFailure()
    expect((await stat(join(dshHome, 'tool'))).mode & 0o777).toBe(0o755)
  })

  it('never restores after the durable commit decision and reports roll-forward on recovery', async () => {
    const { dshHome, userDataPath, store } = await fixture()
    const transaction = await store.begin({ dshHome, releaseId: 'release-2', harnessIdentity: 'harness-2' })
    await transaction!.markCommitDecided()
    await writeFile(join(dshHome, 'sessions', 'older.jsonl'), 'committed-write')

    await expect(transaction!.restorePrecommitFailure()).rejects.toThrow(/commit decision/i)
    const recovered = await new RuntimeDataTransactionStore({ userDataPath, environment: 'test' }).recover()
    expect(recovered).toEqual([expect.objectContaining({
      kind: 'roll-forward-required',
      target: { releaseId: 'release-2', harnessIdentity: 'harness-2' },
    })])
    expect(await readFile(join(dshHome, 'sessions', 'older.jsonl'), 'utf8')).toBe('committed-write')
  })

  it('tracks committed harness identity independently for each account container', async () => {
    const { userDataPath, dshHome, store } = await fixture()
    const second = join(userDataPath, 'dsh-containers', 'account-2', 'dsh')
    await mkdir(second, { recursive: true })
    await writeFile(join(second, 'session'), 'two')
    const first = await store.begin({ dshHome, releaseId: 'release-2', harnessIdentity: 'harness-2' })
    await first!.markCommitDecided()
    await first!.complete()

    expect(await store.begin({ dshHome, releaseId: 'release-2', harnessIdentity: 'harness-2' })).toBeUndefined()
    await expect(store.recover()).resolves.toEqual([])
    expect(await store.begin({ dshHome: second, releaseId: 'release-2', harnessIdentity: 'harness-2' })).toBeDefined()
  })

  it('durably transfers committed identity before a legacy directory rename', async () => {
    const { userDataPath, dshHome: source, store } = await fixture()
    const committed = await store.begin({ dshHome: source, releaseId: 'release-new', harnessIdentity: 'harness-new' })
    await committed!.markCommitDecided()
    await committed!.complete()
    const target = join(userDataPath, 'dsh-containers', 'migrated', 'dsh')

    await store.transferCommittedIdentity(source, target)
    await store.transferCommittedIdentity(source, target)
    await mkdir(join(target, '..'), { recursive: true })
    await rename(source, target)

    const restarted = new RuntimeDataTransactionStore({ userDataPath, environment: 'test' })
    await expect(restarted.begin({
      dshHome: target, releaseId: 'release-old', harnessIdentity: 'harness-old',
    })).rejects.toThrow(/explicit harness transition/i)
  })

  it('does not create a target marker without a source marker or overwrite a conflicting target', async () => {
    const { userDataPath, dshHome: source, store } = await fixture()
    const uncommittedTarget = join(userDataPath, 'dsh-containers', 'uncommitted', 'dsh')
    await store.transferCommittedIdentity(source, uncommittedTarget)
    await mkdir(uncommittedTarget, { recursive: true })
    await expect(store.begin({ dshHome: uncommittedTarget, releaseId: 'r', harnessIdentity: 'h' }))
      .resolves.toBeDefined()

    const sourceTxn = await store.begin({ dshHome: source, releaseId: 'source-r', harnessIdentity: 'source-h' })
    await sourceTxn!.markCommitDecided(); await sourceTxn!.complete()
    const target = join(userDataPath, 'dsh-containers', 'conflict', 'dsh')
    await mkdir(target, { recursive: true })
    const targetTxn = await store.begin({ dshHome: target, releaseId: 'target-r', harnessIdentity: 'target-h' })
    await targetTxn!.markCommitDecided(); await targetTxn!.complete()

    await expect(store.transferCommittedIdentity(source, target)).rejects.toThrow(/conflicting committed identity/i)
    await expect(store.begin({ dshHome: target, releaseId: 'target-r', harnessIdentity: 'target-h' }))
      .resolves.toBeUndefined()
  })

  it('rejects malformed committed identity registries before transferring data ownership', async () => {
    const { root, dshHome, userDataPath, store } = await fixture()
    await mkdir(store.transactionsPath, { recursive: true })
    await writeFile(join(store.transactionsPath, 'committed-containers.json'), JSON.stringify({
      version: 1,
      containers: { [join(root, 'outside')]: { releaseId: 'r', harnessIdentity: 'h' } },
    }))
    await expect(store.transferCommittedIdentity(
      dshHome, join(userDataPath, 'dsh-containers', 'target', 'dsh'),
    )).rejects.toThrow(/registry|user data/i)
  })

  it('rejects transaction-shaped symlink directories while ignoring transaction metadata files', async () => {
    const { root, userDataPath, store } = await fixture()
    const metadataRoot = join(userDataPath, 'runtime-data-transactions', 'test')
    await mkdir(metadataRoot, { recursive: true })
    await writeFile(join(metadataRoot, 'temporary.json.tmp'), 'ignored')
    await symlink(root, join(metadataRoot, '123-11111111-1111-4111-8111-111111111111'))
    await expect(store.recover()).rejects.toThrow(/symbolic link/i)
  })

  it('makes recovery idempotent after a crash during restore staging', async () => {
    const { dshHome, userDataPath, store } = await fixture()
    const transaction = await store.begin({ dshHome, releaseId: 'release-2', harnessIdentity: 'harness-2' })
    await writeFile(join(dshHome, 'sessions', 'older.jsonl'), 'failed-write')
    const failurePath = join(transaction!.record.journalPath, '..', 'failed-current')
    await rename(dshHome, failurePath)
    await writeFile(transaction!.record.journalPath, `${JSON.stringify({
      ...transaction!.record,
      failurePreservationPath: failurePath,
      restoreState: 'copying-snapshot',
    })}\n`)
    await cp(transaction!.record.snapshotPath, dshHome, { recursive: true, verbatimSymlinks: true })

    const first = await new RuntimeDataTransactionStore({ userDataPath, environment: 'test' }).recover()
    const second = await new RuntimeDataTransactionStore({ userDataPath, environment: 'test' }).recover()
    expect(first).toEqual(second)
    expect(await readFile(join(dshHome, 'sessions', 'older.jsonl'), 'utf8')).toBe('old-session')
  })

  it('removes a registry created by the failed trial when it did not exist at prepare', async () => {
    const { dshHome, userDataPath, store } = await fixture()
    const registryPath = join(userDataPath, 'dsh-account-scopes.json')
    const transaction = await store.begin({ dshHome, releaseId: 'r2', harnessIdentity: 'h2' })
    await writeFile(registryPath, 'trial-only')
    await transaction!.restorePrecommitFailure()
    await expect(access(registryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(transaction!.record.failurePreservationPath!, 'protected', '0-dsh-account-scopes.json'), 'utf8'))
      .toBe('trial-only')
  })

  it('rejects journal-controlled paths outside the transaction and can resume a decided commit', async () => {
    const { root, dshHome, userDataPath, store } = await fixture()
    const transaction = await store.begin({ dshHome, releaseId: 'r2', harnessIdentity: 'h2' })
    await transaction!.markCommitDecided()
    const resumed = await store.resume(transaction!.record.transactionId)
    expect(resumed.record.phase).toBe('commit-decided')
    await resumed.complete()

    const malicious = JSON.parse(await readFile(transaction!.record.journalPath, 'utf8'))
    malicious.phase = 'prepared'
    malicious.snapshotPath = join(root, 'outside')
    await writeFile(transaction!.record.journalPath, JSON.stringify(malicious))
    await expect(store.resume(transaction!.record.transactionId)).rejects.toThrow(/journal|snapshot/i)

    const external = join(root, 'external-journal-target')
    await mkdir(external)
    const transactionRoot = join(transaction!.record.journalPath, '..')
    await symlink(external, join(transactionRoot, 'escape'))
    malicious.snapshotPath = transaction!.record.snapshotPath
    malicious.failurePreservationPath = join(transactionRoot, 'escape', 'failed')
    await writeFile(transaction!.record.journalPath, JSON.stringify(malicious))
    await expect(store.resume(transaction!.record.transactionId)).rejects.toThrow(/failure path/i)
  })

  it('rejects data roots outside userData and protects journal permissions', async () => {
    const { root, userDataPath, store } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await expect(store.begin({ dshHome: outside, releaseId: 'r', harnessIdentity: 'h' })).rejects.toThrow(/user data/i)
    for (const managed of ['runtime-manager', 'runtime-data-transactions']) {
      const managedHome = join(userDataPath, managed, 'candidate')
      await mkdir(managedHome, { recursive: true })
      await expect(store.begin({ dshHome: managedHome, releaseId: 'r', harnessIdentity: 'h' }))
        .rejects.toThrow(/runtime manager|transaction/i)
    }

    const dshHome = join(userDataPath, 'dsh')
    await mkdir(dshHome)
    const transaction = await store.begin({ dshHome, releaseId: 'r', harnessIdentity: 'h' })
    expect((await stat(transaction!.record.snapshotPath)).mode & 0o777).toBe(0o700)
    expect((await stat(transaction!.record.journalPath)).mode & 0o777).toBe(0o600)
  })
})
