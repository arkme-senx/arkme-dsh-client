import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface HarnessProcessReceipt { schemaVersion: 1; pid: number; generation: string; }
const mutations = new Map<string, Promise<void>>();
function serialized(file: string, operation: () => Promise<void>): Promise<void> {
  const result = (mutations.get(file) ?? Promise.resolve()).then(operation);
  const settled = result.catch(() => undefined);
  mutations.set(file, settled);
  void settled.then(() => { if (mutations.get(file) === settled) mutations.delete(file); });
  return result;
}
async function readReceipt(file: string): Promise<HarnessProcessReceipt | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const receipt = value as Partial<HarnessProcessReceipt> | null;
  if (receipt?.schemaVersion !== 1 || !Number.isSafeInteger(receipt.pid) || receipt.pid! <= 0
    || typeof receipt.generation !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(receipt.generation)) {
    throw new Error('Invalid Harness process receipt; recovery is blocked');
  }
  return receipt as HarnessProcessReceipt;
}
export function writeHarnessProcessReceipt(file: string, receipt: HarnessProcessReceipt): Promise<void> {
  return serialized(file, async () => {
    await mkdir(path.dirname(file), {recursive:true,mode:0o700});
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary,'wx',0o600);
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary,file);
    } finally { await rm(temporary,{force:true}).catch(() => undefined); }
  });
}
/** Never signal a recorded PID: it may have been reused by an unrelated process. */
export function assertPreviousHarnessExited(file: string): Promise<void> {
  return serialized(file, async () => {
    const receipt = await readReceipt(file);
    if (receipt === undefined) return;
    assertReceiptExited(receipt);
    await rm(file,{force:true});
  });
}

export function clearExitedHarnessProcessReceipt(file: string, generation: string): Promise<void> {
  return serialized(file, async () => {
    const receipt = await readReceipt(file);
    if (receipt === undefined || receipt.generation !== generation) return;
    assertReceiptExited(receipt);
    await rm(file,{force:true});
  });
}

function assertReceiptExited(receipt: HarnessProcessReceipt): void {
  for (const pid of process.platform === 'win32' ? [receipt.pid] : [receipt.pid,-receipt.pid]) {
    try { process.kill(pid,0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw new Error('Cannot verify previous Harness exit; recovery is blocked');
    }
    throw new Error('Previous Harness is still running; retry after it exits before recovering data');
  }
}

function terminateOrphanGroup(): void {
  if (process.platform === 'win32') {
    // taskkill owns the full tree even if this process exits first.
    const killer = spawn('taskkill.exe',['/PID',String(process.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,detached:true});
    killer.on('error',() => process.exit(1));
    killer.unref();
    setTimeout(() => process.exit(1),1000);
  } else {
    // A separate process group survives our graceful exit and kills descendants
    // that ignore SIGTERM. Only the group created for this Harness is targeted.
    const code = `try{process.kill(-${process.pid},'SIGTERM')}catch{};setTimeout(()=>{try{process.kill(-${process.pid},'SIGKILL')}catch{}},500);`;
    const killer = spawn(process.execPath,['--eval',code],{stdio:'ignore',detached:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
    killer.on('error',() => { try {process.kill(-process.pid,'SIGKILL');} catch {process.exit(1);} });
    killer.unref();
    setTimeout(() => { try {process.kill(-process.pid,'SIGKILL');} catch {process.exit(1);} },1500);
  }
  // Keep the process alive until the cleanup helper has captured its tree/group.

}

const generation = process.env.ARKME_PROCESS_GUARD_GENERATION;
if (generation !== undefined && typeof process.send === 'function') {
  // Installed by --import: the application entry point cannot execute until the
  // parent has durably registered this PID and explicitly grants startup.
  let terminating = false;
  const disconnected = () => { if (terminating) return; terminating = true; terminateOrphanGroup(); };
  process.once('disconnect',disconnected);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(disconnected,30_000);
    process.on('message',message => {
      const value = message as {type?:unknown;generation?:unknown} | null;
      if (terminating || value?.type !== 'arkme-harness-start' || value.generation !== generation) return;
      clearTimeout(timer);
      resolve();
    });
    if (!process.connected) disconnected();
  });
}
