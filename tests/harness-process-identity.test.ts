import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const probe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({...await importOriginal<typeof import('node:child_process')>(), execFile: probe}));
import { assertPreviousHarnessExited, writeHarnessProcessReceipt } from '../src/harness-process-lifetime.js';
const platform = process.platform;
let root: string, file: string;
const oldReceipt = {schemaVersion:1, pid:4321, generation:'old'} as const;
function answer(value: unknown, error: Error | null = null) {
 probe.mockImplementation((_exe, _args, _options, callback) => {callback(error, JSON.stringify(value), '');return {};});
}
beforeEach(async () => {
 root = await mkdtemp(path.join(tmpdir(),'harness-identity-'));file=path.join(root,'runtime-process.json');
 Object.defineProperty(process,'platform',{value:'win32'});
 vi.spyOn(process,'kill').mockImplementation(() => true);
 await writeFile(file,JSON.stringify(oldReceipt));
 answer({creationTime:'133000000000000000',commandLine:'node.exe -e setInterval(()=>{},1000)'});
});
afterEach(async () => {Object.defineProperty(process,'platform',{value:platform});vi.restoreAllMocks();probe.mockReset();await rm(root,{recursive:true,force:true});});
test('legacy receipt referencing a provably unrelated process no longer blocks recovery',async()=>{
 await expect(assertPreviousHarnessExited(file)).resolves.toBeUndefined();await expect(access(file)).rejects.toMatchObject({code:'ENOENT'});
});
test('legacy guarded process stays protected',async()=>{
 answer({creationTime:'133000000000000000',commandLine:'arkme.exe --import file:///app/harness-process-lifetime.js entry.js'});
 await expect(assertPreviousHarnessExited(file)).rejects.toThrow('still running');await access(file);
});
test.each([null,''])('legacy inaccessible command line %s fails closed',async commandLine=>{
 answer({creationTime:'133000000000000000',commandLine});await expect(assertPreviousHarnessExited(file)).rejects.toThrow('无法确认上一次运行的 Harness 进程是否已退出');await access(file);
});
test('process inspection failure preserves receipt',async()=>{
 answer(null,new Error('access denied'));await expect(assertPreviousHarnessExited(file)).rejects.toThrow('无法确认上一次运行的 Harness 进程是否已退出');await access(file);
});
test('new receipt records process creation time before allowing startup',async()=>{
 await writeHarnessProcessReceipt(file,oldReceipt);
 expect(JSON.parse(await readFile(file,'utf8')).windowsCreationTime).toBe('133000000000000000');
});
test('same process creation time stays protected even without readable command line',async()=>{
 await writeFile(file,JSON.stringify({...oldReceipt,windowsCreationTime:'133000000000000000'}));
 answer({creationTime:'133000000000000000',commandLine:null});await expect(assertPreviousHarnessExited(file)).rejects.toThrow('still running');
});
test('reused PID with different creation time allows recovery even if it is another Harness',async()=>{
 await writeFile(file,JSON.stringify({...oldReceipt,windowsCreationTime:'132000000000000000'}));
 answer({creationTime:'133000000000000000',commandLine:'arkme.exe --import guard.js entry.js'});
 await expect(assertPreviousHarnessExited(file)).resolves.toBeUndefined();await expect(access(file)).rejects.toMatchObject({code:'ENOENT'});
});
test('malformed recorded identity fails closed rather than using legacy rules',async()=>{
 await writeFile(file,JSON.stringify({...oldReceipt,windowsCreationTime:123}));await expect(assertPreviousHarnessExited(file)).rejects.toThrow('Invalid Harness');
});
test('cannot replace receipt when creation identity cannot be read',async()=>{
 answer(null,new Error('probe timeout'));await expect(writeHarnessProcessReceipt(file,{...oldReceipt,generation:'new'})).rejects.toThrow();
 expect(JSON.parse(await readFile(file,'utf8'))).toEqual(oldReceipt);
});

test('new-process query timeout is distinguished from old receipt verification and sanitized',async()=>{
 const {harnessFailureDiagnostic}=await import('../src/harness-process-lifetime.js');
 answer(null,Object.assign(new Error('private command line'),{killed:true,signal:'SIGTERM'}));
 try {await writeHarnessProcessReceipt(file,{...oldReceipt,generation:'new'});throw new Error('expected failure');}
 catch(error){expect(harnessFailureDiagnostic(error)).toMatchObject({operation:'register-new',diagnosticReason:'query-timeout'});expect(JSON.stringify(harnessFailureDiagnostic(error))).not.toContain('private');}
});

test.each(['verify-previous','clear-exited'] as const)('query failures label %s and retain receipt',async operation=>{
 const {harnessFailureDiagnostic,clearExitedHarnessProcessReceipt}=await import('../src/harness-process-lifetime.js');
 answer(null,new Error('private command'));
 try {await (operation==='verify-previous'?assertPreviousHarnessExited(file):clearExitedHarnessProcessReceipt(file,'old'));throw new Error('expected failure');}
 catch(error){expect(harnessFailureDiagnostic(error)).toMatchObject({operation,diagnosticReason:'query-failed'});}
 expect(JSON.parse(await readFile(file,'utf8'))).toEqual(oldReceipt);
});

test('CIM failure keeps only numeric HRESULT, not private provider output',async()=>{
 const {harnessFailureDiagnostic}=await import('../src/harness-process-lifetime.js');
 answer({failure:'cim-query',hresult:-2147024891,private:'secret command'});
 try{await writeHarnessProcessReceipt(file,oldReceipt);throw new Error('expected failure');}
 catch(error){expect(harnessFailureDiagnostic(error)).toMatchObject({operation:'register-new',diagnosticReason:'query-failed',nativeHresult:-2147024891});expect(JSON.stringify(harnessFailureDiagnostic(error))).not.toContain('secret');}
});

test.each(['register-new','verify-previous'] as const)('%s permits a successful identity query taking more than five seconds', async operation => {
 vi.useFakeTimers();
 try {
  probe.mockImplementation((_exe, _args, options, callback) => {
   const timeout = setTimeout(() => callback(Object.assign(new Error('private'), {killed:true}), '', ''), options.timeout);
   setTimeout(() => { clearTimeout(timeout); callback(null, JSON.stringify({creationTime:'133000000000000000', commandLine:'node.exe'}), ''); }, 6000);
   return {};
  });
  const result = (operation === 'register-new' ? writeHarnessProcessReceipt(file,oldReceipt) : assertPreviousHarnessExited(file)).then(()=>'ok', e=>e.message);
  // Let the receipt read finish before advancing the external process timers.
  await vi.waitFor(() => expect(probe).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(6000);
  expect(await result).toBe('ok');
  expect(probe.mock.calls.at(-1)?.[2].timeout).toBe(30000);
 } finally { vi.useRealTimers(); }
});

test.each([
 ['register-new','查询新启动的 Harness 进程身份超时（30 秒），本次启动已中止。'],
 ['verify-previous','检查上一次运行的 Harness 进程超时（30 秒），暂时无法确认其是否已退出。'],
 ['clear-exited','清理 Harness 进程记录时查询超时（30 秒），暂时无法确认进程是否已退出。'],
] as const)('%s reports its own timeout and preserves the receipt',async (operation,message)=>{
 const {harnessFailureDiagnostic,clearExitedHarnessProcessReceipt}=await import('../src/harness-process-lifetime.js');
 answer(null,Object.assign(new Error('private command'),{killed:true}));
 const run=()=>operation==='register-new'?writeHarnessProcessReceipt(file,{...oldReceipt,generation:'new'}):operation==='verify-previous'?assertPreviousHarnessExited(file):clearExitedHarnessProcessReceipt(file,'old');
 await expect(run()).rejects.toThrow(message);
 await run().catch(error=>expect(harnessFailureDiagnostic(error)).toMatchObject({operation,diagnosticReason:'query-timeout'}));
 expect(probe.mock.calls.at(-1)?.[2].timeout).toBe(30000);
 expect(JSON.parse(await readFile(file,'utf8'))).toEqual(oldReceipt);
});

test.each([
 ['register-new','无法确认新启动的 Harness 进程身份，本次启动已中止。'],
 ['verify-previous','无法确认上一次运行的 Harness 进程是否已退出，暂时无法继续启动。'],
 ['clear-exited','无法确认待清理的 Harness 进程是否已退出，已保留进程记录。'],
] as const)('%s reports its own non-timeout failure without private output',async(operation,message)=>{
 const {clearExitedHarnessProcessReceipt}=await import('../src/harness-process-lifetime.js');
 answer(null,new Error('private command stderr'));
 const result=operation==='register-new'?writeHarnessProcessReceipt(file,oldReceipt):operation==='verify-previous'?assertPreviousHarnessExited(file):clearExitedHarnessProcessReceipt(file,'old');
 await expect(result).rejects.toThrow(message);
 expect(JSON.parse(await readFile(file,'utf8'))).toEqual(oldReceipt);
});
