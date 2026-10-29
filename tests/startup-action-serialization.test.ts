import { readFile, writeFile, mkdir, mkdtemp, rm, readlink, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RuntimeDataTransactionStore } from '../src/runtime-data-transaction.js'
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'

// Exercise the actual main-process startup/queue wiring without loading Electron.
test('an immediate reset waits for initial bootstrap rollback and error rendering', async () => {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  const startup = source.slice(source.indexOf('const hasSingleInstanceLock ='), source.indexOf('\nfunction registerApplicationLifecycle'))
  const queue = source.slice(source.indexOf('function enqueueAction('), source.indexOf('\nasync function handleAppAction'))
    .replace('action: () => Promise<void>', 'action').replace('): void', ')')
  const events: string[] = []
  let releaseRollback!: () => void
  let started!: () => void
  const rollback = new Promise<void>(resolve => { releaseRollback = resolve })
  const starting = new Promise<void>(resolve => { started = resolve })
  const context = {
    actionQueue: Promise.resolve(),
    app: { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve() },
    registerApplicationLifecycle: () => undefined,
    bootstrap: async () => { events.push('failure-page'); started(); await rollback; events.push('rollback-complete'); throw new Error('startup failed') },
    showFatalBootstrapError: async () => { events.push('fatal-rendered') },
    showActionError: async () => { events.push('unexpected-action-error') },
    enqueueAction: undefined as unknown as (action: () => Promise<void>) => void,
  }
  runInNewContext(startup + '\n' + queue, context)
  await starting
  context.enqueueAction(async () => { events.push('reset') })
  await new Promise(resolve => setImmediate(resolve))
  const beforeRollback = [...events]
  releaseRollback()
  await context.actionQueue
  expect(beforeRollback).toEqual(['failure-page'])
  expect(events).toEqual(['failure-page', 'rollback-complete', 'fatal-rendered', 'reset'])
})


test('queued reset cannot delete a live restore staging tree; real historical data and links survive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arkme-restore-queue-'))
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  const startup = source.slice(source.indexOf('const hasSingleInstanceLock ='), source.indexOf('\nfunction registerApplicationLifecycle'))
  const queue = source.slice(source.indexOf('function enqueueAction('), source.indexOf('\nasync function handleAppAction'))
    .replace('action: () => Promise<void>', 'action').replace('): void', ')')
  const home = join(root, 'dsh-containers', 'legacy', 'dsh')
  const sdk = join(home, 'profiles', 'node_modules', 'sdk')
  await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true })
  const oldTarget = join(root, 'removed-release', 'sdk')
  await mkdir(oldTarget, { recursive: true })
  await symlink(oldTarget, sdk, process.platform === 'win32' ? 'junction' : 'dir')
  const linkBefore = await readlink(sdk)
  await rm(join(root, 'removed-release'), { recursive: true })
  const files = [join(home, 'conversation.jsonl'), join(home, 'attachment.bin'), join(root, 'settings.json')]
  const contents = [Buffer.from('historical conversations'), Buffer.from([0, 255, 128, 10, 1]), Buffer.from('{"theme":"dark"}')]
  for (const [index, file] of files.entries()) await writeFile(file, contents[index]!)
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const before = contents.map(hash)
  const store = new RuntimeDataTransactionStore({userDataPath:root, environment:'prod'})
  const tx = (await store.begin({dshHome:home, releaseId:'new-release', harnessIdentity:'harness', registry:[files[2]!]}))!
  await writeFile(files[0]!, 'uncommitted trial')
  await writeFile(files[2]!, '{"theme":"trial"}')
  let releaseCopy!: () => void
  let reachedCopy!: () => void
  const copyGate = new Promise<void>(resolve => { releaseCopy = resolve })
  const copyStarted = new Promise<void>(resolve => { reachedCopy = resolve })
  const update = store.update.bind(store)
  store.update = async (record, patch) => {
    const next = await update(record, patch)
    if (patch.restoreState === 'copying-snapshot') { reachedCopy(); await copyGate }
    return next
  }
  const events: string[] = []
  const context = {
    actionQueue: Promise.resolve(),
    app: {requestSingleInstanceLock:()=>true, whenReady:()=>Promise.resolve()},
    registerApplicationLifecycle:()=>undefined,
    bootstrap:async()=>{await tx.restorePrecommitFailure(); events.push('rollback'); throw new Error('startup failed')},
    showFatalBootstrapError:async()=>{events.push('error-rendered')},
    showActionError:async(error:unknown)=>{throw error},
    enqueueAction:undefined as unknown as (action:()=>Promise<void>)=>void,
  }
  try {
    runInNewContext(startup+'\n'+queue, context)
    await copyStarted
    context.enqueueAction(async()=>{events.push('reset'); await store.recover()})
    context.enqueueAction(async()=>{events.push('retry'); await store.recover()})
    await new Promise(resolve=>setImmediate(resolve))
    const earlyEvents = [...events]
    releaseCopy()
    await context.actionQueue
    expect(earlyEvents).toEqual([])
    expect(events).toEqual(['rollback','error-rendered','reset','retry'])
    for (const [index,file] of files.entries()) expect(hash(await readFile(file))).toBe(before[index])
    expect(await readlink(sdk)).toBe(linkBefore)
    expect(await readFile(join(tx.record.failurePreservationPath!, 'conversation.jsonl'), 'utf8')).toBe('uncommitted trial')
    await expect(access(join(root,'removed-release'))).rejects.toMatchObject({code:'ENOENT'})
    await expect(access(join(store.transactionsPath,tx.record.transactionId,'restore-staging-dsh'))).rejects.toMatchObject({code:'ENOENT'})
  } finally {
    releaseCopy()
    await rm(root,{recursive:true,force:true})
  }
})
