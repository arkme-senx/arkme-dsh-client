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
 answer({creationTime:'133000000000000000',commandLine});await expect(assertPreviousHarnessExited(file)).rejects.toThrow('Cannot verify');await access(file);
});
test('process inspection failure preserves receipt',async()=>{
 answer(null,new Error('access denied'));await expect(assertPreviousHarnessExited(file)).rejects.toThrow('Cannot verify');await access(file);
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
