import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRuntimeServiceOrigin } from './runtime/service-config.js';

type Stage = 'runtime-prepare' | 'harness-start' | 'plugin-load';
interface Metadata { version: string; build: number; platform: string; osVersion: string; architecture: string; harnessVersion?: string; pluginVersion?: string }
interface Report {
  schema: number; event_id: string; platform: string; os_version: string; architecture: string;
  version: string; build: number; stage: Stage; result: string; error_code: string; recovery: string;
  scope: string; elapsed_ms: number; details: string; log: string; harness_version: string; plugin_version: string;
}
const day = 86400000;
const filenamePattern = /^[a-f0-9]{32}\.json$/;
const componentVersion = (value: string | undefined) => value && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : '';
function bounded(value: string, bytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.length <= bytes) return value;
  return encoded.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '');
}

/** Same path/credential rules as installer diagnostics, applied BEFORE persistence. */
export function scrubStartupDiagnostic(input: string, limit = 4096): string {
  let value = input
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/(?:https?|file):\/\/[^\s<>"']+/gi, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .replace(/^([ \t]*(?:用户名|计算机|username|hostname|computer|machine|authorization|cookie|set-cookie|RunAs 用户|RunAs User)[ \t]*[:=][ \t]*)[^\r\n]*/gim, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|password|passwd|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|secret|api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?secret|用户名|计算机|username|hostname|computer|RunAs 用户|RunAs User)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;\r\n]+)/gi, '$1[REDACTED]')
    .replace(/((?:[a-z]:)?[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\r\n"<>]+/gi, '$1<user>')
    .replace(/(\/(?:Users|home)\/)[^/\r\n"<>]+/gi, '$1<user>')
    .replace(/(\/(?:mnt|media|Volumes)\/)[^/\r\n"<>]+/gi, '$1<volume>')
    .replace(/(\/var\/folders\/)[^/\s]+\/[^/\s]+/g, '$1<bucket>/<temp-id>')
    .replace(/\\\\[^\\\s]+\\[^\\\r\n"<>]+/g, '\\\\<server>\\<share>')
    .replace(/(^|[ \t=(])[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+($|[ \t\r\n])/gm, '$1<account>$2')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return bounded(value, limit);
}

// Never upload renderer console/business output. Select fixed lifecycle events and numeric fields only.
export async function startupLifecycleTail(file: string, since = 0): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.mtimeMs < since) return "";
    const size = info.size;
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
    let lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    let latest = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.startsWith('[supervisor] spawned ')) { latest = i; break; }
    if (latest < 0) return ''; // Do not reuse unrelated/historical logs.
    lines = lines.slice(latest);
    const selected: string[] = [];
    for (const line of lines) {
      const match = /^\[supervisor\] (spawned|health-waiting|health-ready|startup-timeout|process-exit|process-stop-requested|process-force-stop-requested) (\{.*\})$/.exec(line);
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[2]!) as Record<string, unknown>;
        const safe: Record<string, number | boolean> = {};
        for (const key of ['timeoutMs','healthChecks','code','expected']) {
          const v = parsed[key];
          if (typeof v === 'number' || typeof v === 'boolean') safe[key] = v;
        }
        selected.push(`[supervisor] ${match[1]} ${JSON.stringify(safe)}`);
      } catch { /* Incomplete log lines are not sent. */ }
    }
    return selected.slice(-40).join('\n');
  } finally { await handle.close(); }
}

export class StartupDiagnostics {
  private attempt: {id: string; started: number; stage: Stage; reported: boolean} | undefined;
  private stopped = false;
  private sending: AbortController | undefined;
  private work = Promise.resolve();
  private pending = 0;
  private readonly endpoint: string;
  constructor(private readonly options: {
    directory: string; serviceOrigin: string; metadata: () => Metadata;
    fetcher?: typeof fetch; now?: () => number; enabled?: boolean;
  }) { this.endpoint = resolveRuntimeServiceOrigin(options.serviceOrigin) + '/api/public/v1/arkme/installer-reports'; }
  private now() { return this.options.now?.() ?? Date.now(); }
  begin(stage: Stage = 'runtime-prepare'): void {
    if (this.stopped) return;
    this.attempt = {id: randomUUID().replaceAll('-', ''), started: this.now(), stage, reported:false};
    this.schedule(() => this.flush());
  }
  starting(): void {
    if (!this.attempt || this.attempt.reported) this.begin('harness-start');
    else this.attempt.stage = 'harness-start';
  }
  cancel(): void { this.attempt = undefined; }
  shutdown(): void { this.stopped = true; this.cancel(); this.sending?.abort(); }
  fail(message: string, logFile?: string): void {
    try { this.captureFailure(message, logFile); } catch { /* Telemetry must never affect startup. */ }
  }
  private captureFailure(message: string, logFile?: string): void {
    const attempt = this.attempt;
    if (!attempt || attempt.reported || this.stopped || this.options.enabled === false || this.pending >= 20) return;
    attempt.reported = true; // Synchronous: duplicate supervisor/renderFailure notifications share one event.
    const meta = this.options.metadata();
    if (!['windows','macos'].includes(meta.platform) || !['x64','arm64'].includes(meta.architecture) || !Number.isInteger(meta.build) || meta.build < 1) return;
    const report: Report = {
      schema:1, event_id:attempt.id, platform:meta.platform, architecture:meta.architecture,
      os_version:meta.osVersion, version:meta.version, build:meta.build,
      stage:message.includes('plugin tree failed to load') ? 'plugin-load' : attempt.stage,
      result:'failure',error_code:'STARTUP_FAILED',recovery:'unknown',scope:'current',
      elapsed_ms:Math.max(0,Math.min(604800000,this.now()-attempt.started)),
      details:scrubStartupDiagnostic(message),log:scrubStartupDiagnostic(message,10000),
      harness_version:componentVersion(meta.harnessVersion),plugin_version:componentVersion(meta.pluginVersion)
    };
    const tail = logFile && attempt.stage !== 'runtime-prepare'
      ? startupLifecycleTail(logFile, attempt.started).then(text => this.attempt?.id === attempt.id ? text : '').catch(() => '')
      : Promise.resolve('');
    this.schedule(async () => {
      report.log = scrubStartupDiagnostic(report.log + "\n" + scrubStartupDiagnostic(await tail, 1800), 12000);
      await mkdir(this.options.directory,{recursive:true,mode:0o700});
      // Reserve a slot BEFORE writing; this also bounds repeated offline failures.
      await this.prune(19);
      const body = JSON.stringify(report);
      if (Buffer.byteLength(body) >= 32768) return;
      await writeFile(path.join(this.options.directory,report.event_id+'.json'),body,{flag:'wx',mode:0o600});
      await this.flush();
    });
  }
  private schedule(task: () => Promise<void>): void {
    if (this.stopped || this.options.enabled === false || this.pending >= 20) return;
    this.pending++;
    this.work = this.work.then(() => new Promise<void>(resolve => setImmediate(resolve)))
      .then(task).catch(() => undefined).finally(() => {this.pending--;});
  }
  /** Tests/support may await completion; startup, retry and shutdown must never await this. */
  settled(): Promise<void> { return this.work; }
  private async prune(limit = 20): Promise<string[]> {
    const entries = await readdir(this.options.directory).catch(() => [] as string[]);
    const files: {file:string;time:number}[] = [];
    for (const name of entries.filter(name => filenamePattern.test(name))) {
      const file = path.join(this.options.directory,name);
      const info = await lstat(file);
      if (!info.isFile()) continue;
      if (this.now()-info.mtimeMs > 7*day) await rm(file,{force:true});
      else files.push({file,time:info.mtimeMs});
    }
    files.sort((a,b)=>b.time-a.time);
    for (const entry of files.slice(limit)) await rm(entry.file,{force:true});
    return files.slice(0,limit).map(entry=>entry.file);
  }
  private async flush(): Promise<void> {
    const files = await this.prune();
    for (const file of files.slice(0,2)) {
      if (this.stopped) return;
      const info = await lstat(file);
      if (!info.isFile()) continue;
      if (info.size > 32768) { await rm(file,{force:true}); continue; }
      let r: Report;
      try { r = JSON.parse(await readFile(file,'utf8')) as Report; } catch { await rm(file,{force:true}); continue; }
      if (!validQueuedReport(r)) { await rm(file,{force:true}); continue; }
      // Queue is never a source of arbitrary request fields or destinations.
      if (path.basename(file)!==r.event_id+'.json') { await rm(file,{force:true}); continue; }
      const body = JSON.stringify({schema:1,event_id:r.event_id,platform:r.platform,os_version:r.os_version,architecture:r.architecture,version:r.version,build:r.build,stage:r.stage,result:'failure',error_code:'STARTUP_FAILED',recovery:'unknown',scope:'current',elapsed_ms:r.elapsed_ms,details:scrubStartupDiagnostic(r.details),log:scrubStartupDiagnostic(r.log,12000),harness_version:componentVersion(r.harness_version),plugin_version:componentVersion(r.plugin_version)});
      const abort = new AbortController();
      this.sending = abort;
      const timeout = setTimeout(()=>abort.abort(),1500); timeout.unref();
      try {
        const response = await (this.options.fetcher ?? fetch)(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body,redirect:'error',credentials:'omit',signal:abort.signal});
        void response.body?.cancel().catch(()=>undefined);
        if (response.status===202) await rm(file,{force:true});
      } catch { /* Keep the sanitized report for the next startup/retry; no recursive logging. */ }
      finally {clearTimeout(timeout); this.sending = undefined;}
    }
  }
}

function validQueuedReport(r: Report): boolean {
  return r !== null && typeof r === 'object'
    && typeof r.event_id === 'string' && /^[a-f0-9]{32}$/.test(r.event_id)
    && r.schema === 1 && ['windows','macos'].includes(r.platform)
    && ['x64','arm64'].includes(r.architecture)
    && typeof r.os_version === 'string' && /^\d{1,5}(?:\.\d{1,8}){1,3}$/.test(r.os_version)
    && typeof r.version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(r.version)
    && Number.isInteger(r.build) && r.build > 0 && r.build <= 2147483647
    && Number.isInteger(r.elapsed_ms) && r.elapsed_ms >= 0 && r.elapsed_ms <= 604800000
    && ['runtime-prepare','harness-start','plugin-load'].includes(r.stage)
    && r.error_code === 'STARTUP_FAILED' && r.result === 'failure'
    && typeof r.details === 'string' && typeof r.log === 'string'
    && typeof r.harness_version === 'string' && typeof r.plugin_version === 'string';
}
