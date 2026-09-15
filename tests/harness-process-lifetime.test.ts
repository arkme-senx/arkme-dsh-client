import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';
import * as lifetime from '../src/harness-process-lifetime.js';

test('a live recorded process blocks recovery and stale cleanup cannot erase the replacement receipt',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'harness-pid-receipt-')); const receipt=path.join(root,'runtime-process.json');
 try{
  await lifetime.writeHarnessProcessReceipt(receipt,{schemaVersion:1,pid:process.pid,generation:'first'});
  await expect(lifetime.assertPreviousHarnessExited(receipt)).rejects.toThrow('still running');
  await expect(lifetime.clearExitedHarnessProcessReceipt(receipt,'first')).rejects.toThrow('still running');
  expect(JSON.parse(await readFile(receipt,'utf8')).generation).toBe('first');
  await lifetime.writeHarnessProcessReceipt(receipt,{schemaVersion:1,pid:process.pid,generation:'second'});
  await lifetime.clearExitedHarnessProcessReceipt(receipt,'first');
  expect(JSON.parse(await readFile(receipt,'utf8')).generation).toBe('second');
  await expect(lifetime.clearExitedHarnessProcessReceipt(receipt,'second')).rejects.toThrow('still running');
  await rm(receipt);
  await expect(lifetime.assertPreviousHarnessExited(receipt)).resolves.toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});

test.skipIf(process.platform==='win32')('guard waits for receipt-before-start IPC and exits when its parent is killed',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'harness-orphan-guard-'));
 const guard=path.join(root,'guard.mjs'); const marker=path.join(root,'started'); const childPidFile=path.join(root,'child.pid'); const parentPath=path.join(root,'parent.mjs');
 const code=ts.transpileModule(await readFile('src/harness-process-lifetime.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 await writeFile(guard,code);
 await writeFile(parentPath,`import {spawn} from 'node:child_process';import{writeFile}from'node:fs/promises';import{writeHarnessProcessReceipt}from ${JSON.stringify(new URL('file://'+guard).href)};
 const child=spawn(process.execPath,['--import',${JSON.stringify(guard)},'-e',${JSON.stringify("require('node:fs').writeFileSync("+JSON.stringify(marker)+",'started');setInterval(()=>{},1000)")}],{detached:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,ARKME_PROCESS_GUARD_GENERATION:'test-generation'}});
 child.stdout.resume();child.stderr.resume();await writeFile(${JSON.stringify(childPidFile)},String(child.pid));
 setTimeout(async()=>{await writeHarnessProcessReceipt(${JSON.stringify(path.join(root,'runtime-process.json'))},{schemaVersion:1,pid:child.pid,generation:'test-generation'});child.send({type:'arkme-harness-start',generation:'test-generation'});},300);setInterval(()=>{},1000);`);
 const parent=spawn(process.execPath,[parentPath],{stdio:'ignore'});let childPid:number|undefined;
 try{
  const deadline=Date.now()+3500;
  while(Date.now()<deadline){try{childPid=Number(await readFile(childPidFile,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,10));}}
  expect(childPid).toBeGreaterThan(0);
  await new Promise(resolve=>setTimeout(resolve,150));
  await expect(access(marker)).rejects.toMatchObject({code:'ENOENT'});
  while(Date.now()<deadline){try{await access(marker);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  expect(await readFile(marker,'utf8')).toBe('started');
  const exited=once(parent,'exit');parent.kill('SIGKILL');await exited;
  while(Date.now()<deadline){try{process.kill(childPid!,0);}catch{break;}await new Promise(r=>setTimeout(r,25));}
  expect(()=>process.kill(childPid!,0)).toThrow();
  await lifetime.assertPreviousHarnessExited(path.join(root,'runtime-process.json'));
 }finally{try{parent.kill('SIGKILL');}catch{} if(childPid!==undefined){try{process.kill(-childPid,'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});}
});
