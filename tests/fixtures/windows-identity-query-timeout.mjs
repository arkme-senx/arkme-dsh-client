// Windows-only owned-process regression. Arguments: baseline.mjs fixed.mjs delayed-SystemRoot.
// Setup in a fresh owned directory: run windows-identity-query-timeout-shim.ps1 there.
// Set ARKME_TEST_REAL_SYSTEMROOT to the original $env:SystemRoot and
// ARKME_TEST_REAL_POWERSHELL to its System32/WindowsPowerShell/v1.0/powershell.exe.
// Pass the generated delayed-system directory as the third argument.
// The shim forwards to the real PowerShell after ARKME_TEST_QUERY_DELAY_MS.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const exec=promisify(execFile);
assert.equal(process.platform,'win32');
const [baselinePath,fixedPath,shimRoot,mode,operation='register-new']=process.argv.slice(2);
const here=fileURLToPath(import.meta.url);
async function guardCase(modulePath,expectReady,grantDelay){
 const root=await mkdtemp(path.join(os.tmpdir(),'arkme-owned-grant-'));
 const marker=path.join(root,'ready');
 const child=spawn(process.execPath,['--import',pathToFileURL(path.resolve(modulePath)).href,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,env:{...process.env,ARKME_PROCESS_GUARD_GENERATION:'owned-test'}});
 const exited=once(child,'exit');
 try{
  await once(child,'spawn');
  await new Promise(r=>setTimeout(r,grantDelay));
  if(expectReady){assert.equal(child.exitCode,null);await assert.rejects(access(marker),{code:'ENOENT'});await new Promise((r,j)=>child.send({type:'arkme-harness-start',generation:'owned-test'},e=>e?j(e):r()));for(let i=0;i<100;i++){try{await access(marker);break}catch{await new Promise(r=>setTimeout(r,50))}}assert.equal(await readFile(marker,'utf8'),'ready');}
  else {assert.notEqual(child.exitCode,null);await assert.rejects(access(marker),{code:'ENOENT'});}
  return {case:`grant ${expectReady?'accepted':'expired'} after ${grantDelay}ms`,pass:true};
 }finally{if(child.exitCode===null){child.kill();await exited}await rm(root,{recursive:true,force:true})}
}
if(mode){
 const api=await import(pathToFileURL(path.resolve(mode==='baseline-slow'?baselinePath:fixedPath)).href);
 const root=await mkdtemp(path.join(os.tmpdir(),'arkme-owned-query-'));const receipt=path.join(root,'receipt.json');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});const exited=once(child,'exit');await once(child,'spawn');
 const original={schemaVersion:1,pid:child.pid,generation:'owned-test'};
 const savedSystemRoot=process.env.SystemRoot;
 try{
  await writeFile(receipt,JSON.stringify(original));
  if(mode!=='normal'){process.env.SystemRoot=shimRoot;process.env.ARKME_TEST_QUERY_DELAY_MS=mode==='timeout'?'35000':'6000';}
  const start=Date.now();let error;
  try{await(operation==='register-new'?api.writeHarnessProcessReceipt(receipt,original):operation==='verify-previous'?api.assertPreviousHarnessExited(receipt):api.clearExitedHarnessProcessReceipt(receipt,'owned-test'));}catch(e){error=e}
  const elapsedMs=Date.now()-start;
  if(mode==='baseline-slow'||mode==='timeout'){
   assert(error);assert.equal(api.harnessFailureDiagnostic(error).diagnosticReason,'query-timeout');
   assert.equal(api.harnessFailureDiagnostic(error).operation,operation);
   assert.deepEqual(JSON.parse(await readFile(receipt,'utf8')),original);
   if(mode==='timeout'){assert(elapsedMs>=29000&&elapsedMs<34000);assert.match(error.message,operation==='register-new'?/新启动/:operation==='verify-previous'?/上一次运行/:/清理/);assert.match(error.message,/30 秒/);}
   else assert(elapsedMs>=4900&&elapsedMs<6500);
  }else{
   assert.equal(error,undefined);
   if(mode==='slow')assert(elapsedMs>=6000&&elapsedMs<30000);
   if(operation==='register-new'){
    const value=JSON.parse(await readFile(receipt,'utf8'));assert.match(value.windowsCreationTime,/^\d{17,19}$/);
    process.env.SystemRoot=savedSystemRoot;
    await assert.rejects(api.assertPreviousHarnessExited(receipt),/still running/);
    await api.clearExitedHarnessProcessReceipt(receipt,'wrong-generation');await access(receipt);
   }else await assert.rejects(access(receipt),{code:'ENOENT'});
  }
  assert.equal(process.kill(child.pid,0),true);
  console.log(JSON.stringify({mode,operation,elapsedMs,pass:true,...(error?{message:error.message,diagnostic:api.harnessFailureDiagnostic(error)}:{})}));
 }finally{process.env.SystemRoot=savedSystemRoot;if(child.exitCode===null){child.kill();await exited}await rm(root,{recursive:true,force:true})}
}else{
 const run=async(mode,operation)=>{const r=await exec(process.execPath,[here,baselinePath,fixedPath,shimRoot,mode,operation],{timeout:45000,maxBuffer:1024*1024,windowsHide:true});return JSON.parse(r.stdout)};
 const results=[];
 results.push(await run('normal','register-new'));
 results.push(await run('baseline-slow','register-new'));
 results.push(await run('slow','register-new'));
 results.push(await run('slow','verify-previous'));
 results.push(...await Promise.all([
  ...['register-new','verify-previous','clear-exited'].map(operation=>run('timeout',operation)),
  guardCase(baselinePath,false,32000),guardCase(fixedPath,true,32000),guardCase(fixedPath,false,47000),
 ]));
 console.log(JSON.stringify({host:os.hostname(),os:os.release(),node:process.version,results},null,2));
}
