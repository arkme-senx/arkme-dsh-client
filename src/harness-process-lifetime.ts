import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { getEnvironmentData, setEnvironmentData, isMainThread, type WorkerOptions } from 'node:worker_threads';

const builtinCompatibilityKey = '@arkme/mas-electron-builtin-compatibility';

/** Preserve explicit Worker isolation while carrying the host's verified internal-module adapter. */
export function harnessWorkerExecArgv(requested: string[] | undefined, inherited: string[], preload: string): string[] {
  const result = [...(requested ?? inherited)];
  if (!result.includes('--expose-internals')) result.push('--expose-internals');
  if (!result.some((value, index) => value === `--import=${preload}` || value === '--import' && result[index + 1] === preload)) {
    result.push('--import', preload);
  }
  return result;
}

function installHarnessBuiltinCompatibility(): void {
  // Electron's Worker process.versions may omit electron; inherit the verified host version.
  const inherited = getEnvironmentData(builtinCompatibilityKey) as {electronVersion?: string} | undefined;
  if ((process.versions.electron ?? inherited?.electronVersion) !== '43.2.0' || !process.execArgv.includes('--expose-internals')) return;
  const policy = JSON.parse(process.env.ARKME_HOST_POLICY ?? '{}') as {schemaVersion?: number; distribution?: string};
  const mas = policy.distribution === 'mas' && process.env.NARB_DISABLE_NATIVE_CACHE === '1';
  const development = policy.distribution === 'website' && process.env.ARKME_DEVELOPMENT_HOST === '1';
  if (policy.schemaVersion !== 1 || (!mas && !development)) return;
  const entry = process.env.DSH_INSTALLED_MODULE_BASE_PATH;
  if (entry === undefined) throw new Error('Harness builtin compatibility requires the selected Harness entry');
  setEnvironmentData(builtinCompatibilityKey, {electronVersion: '43.2.0'});
  const hostRequire = createRequire(import.meta.url);
  // Match the existing Electron 43.2.0 adapter in dsh-app-boot's main thread.
  // Keep the signed native module's other exports and its fallback for unknown IDs.
  const addon = createRequire(entry)('node-addon-require-builtin') as {requireBuiltin(id: string): unknown; default?: {requireBuiltin(id: string): unknown}};
  const fallback = addon.requireBuiltin.bind(addon);
  const requireBuiltin = (id: string): unknown => {
    try { return hostRequire(id); }
    catch { return fallback(id); }
  };
  addon.requireBuiltin = requireBuiltin;
  if (addon.default !== undefined) addon.default.requireBuiltin = requireBuiltin;
  const threads = hostRequire('node:worker_threads') as typeof import('node:worker_threads');
  const NativeWorker = threads.Worker;
  threads.Worker = class HarnessWorker extends NativeWorker {
    constructor(filename: string | URL, options: WorkerOptions = {}) {
      super(filename, {...options, execArgv: harnessWorkerExecArgv(options.execArgv, process.execArgv, import.meta.url)});
    }
  };
  syncBuiltinESMExports();
}

installHarnessBuiltinCompatibility();

export interface HarnessProcessReceipt {
  schemaVersion: 1; pid: number; generation: string;
  /** Windows FILETIME, stored as a string to preserve precision across PID reuse. */
  windowsCreationTime?: string;
}
interface WindowsProcessIdentity { creationTime: string; commandLine: string | null; }
const identityUnverified = 'Cannot verify previous Harness exit; recovery is blocked';
function validCreationTime(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{16,19}$/.test(value);
}

async function readWindowsProcessIdentity(pid: number): Promise<WindowsProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(identityUnverified);
  // Query only this PID. Never persist or report its command line (it may contain secrets).
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; `
    + `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; `
    + `if ($null -eq $p) { 'null' } else { `
    + `@{creationTime=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture); `
    + `commandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        {windowsHide:true, timeout:5000, maxBuffer:256 * 1024, encoding:'utf8'},
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const value: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
    if (value === null) return null;
    const identity = value as Partial<WindowsProcessIdentity>;
    if (!validCreationTime(identity.creationTime)
      || (identity.commandLine !== null && typeof identity.commandLine !== 'string')) throw new Error(identityUnverified);
    return identity as WindowsProcessIdentity;
  } catch {
    // Do not expose PowerShell output, command lines or an unverified process identity.
    throw new Error(identityUnverified);
  }
}
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
    || (receipt.windowsCreationTime !== undefined && !validCreationTime(receipt.windowsCreationTime))
    || typeof receipt.generation !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(receipt.generation)) {
    throw new Error('Invalid Harness process receipt; recovery is blocked');
  }
  return receipt as HarnessProcessReceipt;
}
export function writeHarnessProcessReceipt(file: string, receipt: HarnessProcessReceipt): Promise<void> {
  return serialized(file, async () => {
    let recorded = receipt;
    if (process.platform === 'win32') {
      const identity = await readWindowsProcessIdentity(receipt.pid);
      if (identity === null) throw new Error(identityUnverified);
      recorded = {...receipt, windowsCreationTime:identity.creationTime};
    }
    await mkdir(path.dirname(file), {recursive:true,mode:0o700});
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary,'wx',0o600);
      try { await handle.writeFile(JSON.stringify(recorded)); await handle.sync(); }
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
    await assertReceiptExited(receipt);
    await rm(file,{force:true});
  });
}

export function clearExitedHarnessProcessReceipt(file: string, generation: string): Promise<void> {
  return serialized(file, async () => {
    const receipt = await readReceipt(file);
    if (receipt === undefined || receipt.generation !== generation) return;
    await assertReceiptExited(receipt);
    await rm(file,{force:true});
  });
}

async function assertReceiptExited(receipt: HarnessProcessReceipt): Promise<void> {
  if (process.platform === 'win32') {
    try { process.kill(receipt.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw new Error(identityUnverified);
    }
    const identity = await readWindowsProcessIdentity(receipt.pid);
    if (identity === null) {
      // Exit during the query is fine; a still-live PID with no identity is not.
      try { process.kill(receipt.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
      throw new Error(identityUnverified);
    }
    if (receipt.windowsCreationTime !== undefined) {
      if (identity.creationTime !== receipt.windowsCreationTime) return;
    } else {
      // Legacy receipts have no creation time. Every receipt-managed Harness was
      // started with --import for this guard. Only an observable command line
      // without ANY import option proves this is not that managed process.
      // Ambiguous/import-bearing processes stay protected, regardless of name.
      if (!identity.commandLine?.trim()) throw new Error(identityUnverified);
      if (!identity.commandLine.includes('--import')) return;
    }
    throw new Error('Previous Harness is still running; retry after it exits before recovering data');
  }
  for (const pid of [receipt.pid, -receipt.pid]) {
    try { process.kill(pid,0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw new Error(identityUnverified);
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
if (isMainThread && generation !== undefined && typeof process.send === 'function') {
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
