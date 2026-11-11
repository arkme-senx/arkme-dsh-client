// Run on Windows: node <fixture> <baseline-module> <fixed-module>.
// Only owned child processes and a fresh temporary directory are used.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile, access, rm} from 'node:fs/promises';
import {tmpdir, hostname} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
assert.equal(process.platform,'win32');
const baseline=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const fixedPath=path.resolve(process.argv[3]);
const fixed=await import(pathToFileURL(fixedPath).href);
const root=await mkdtemp(path.join(tmpdir(),'arkme-owned-identity-fix-'));
const receipt=path.join(root,'runtime-process.json');
const children=[];const results=[];
const spawnOwned=(args,options={})=>{const child=spawn(process.execPath,args,{stdio:'ignore',windowsHide:true,...options});children.push(child);return child;};
const stop=async child=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill();await exited;};
const legacy=pid=>({schemaVersion:1,pid,generation:'legacy'});
const present=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
try {
 const unrelated=spawnOwned(['-e','setInterval(()=>{},1000)']);await once(unrelated,'spawn');
 for(let attempt=1;attempt<=3;attempt++){
  await writeFile(receipt,JSON.stringify(legacy(unrelated.pid)));
  await assert.rejects(baseline.assertPreviousHarnessExited(receipt),/Previous Harness is still running/);
  await fixed.assertPreviousHarnessExited(receipt);await assert.rejects(access(receipt),{code:'ENOENT'});
  assert(present(unrelated.pid));results.push({case:'legacy unrelated live PID: baseline blocked, fixed allowed without killing',attempt,pass:true});
 }
 await fixed.writeHarnessProcessReceipt(receipt,legacy(unrelated.pid));
 const recorded=JSON.parse(await readFile(receipt,'utf8'));assert.match(recorded.windowsCreationTime,/^\d+$/);
 await assert.rejects(fixed.assertPreviousHarnessExited(receipt),/Previous Harness is still running/);
 results.push({case:'new receipt captures identity and protects same live process',pass:true});
 await writeFile(receipt,JSON.stringify({...recorded,windowsCreationTime:(BigInt(recorded.windowsCreationTime)-10000000n).toString()}));
 await fixed.assertPreviousHarnessExited(receipt);assert(present(unrelated.pid));
 results.push({case:'different recorded creation time: reused-PID state allowed without killing',pass:true});
 await fixed.writeHarnessProcessReceipt(receipt,legacy(unrelated.pid));await stop(unrelated);
 await fixed.assertPreviousHarnessExited(receipt);await assert.rejects(access(receipt),{code:'ENOENT'});
 results.push({case:'actual process exit allows recovery and cleans receipt',pass:true});
 const marker=path.join(root,'started');
 const guarded=spawnOwned(['--import',pathToFileURL(fixedPath).href,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`],{
  stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,ARKME_PROCESS_GUARD_GENERATION:'guarded'}
 });await once(guarded,'spawn');
 await new Promise(r=>setTimeout(r,300));await assert.rejects(access(marker),{code:'ENOENT'});
 await fixed.writeHarnessProcessReceipt(receipt,{schemaVersion:1,pid:guarded.pid,generation:'guarded'});
 guarded.send({type:'arkme-harness-start',generation:'guarded'});
 for(let i=0;i<100;i++){try{await access(marker);break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.equal(await readFile(marker,'utf8'),'ready');
 await assert.rejects(fixed.assertPreviousHarnessExited(receipt),/Previous Harness is still running/);
 await fixed.clearExitedHarnessProcessReceipt(receipt,'wrong-generation');await access(receipt);
 results.push({case:'guarded startup waits for durable identity and IPC; live process and generation stay protected',pass:true});
 await writeFile(receipt,JSON.stringify(legacy(guarded.pid)));
 await assert.rejects(fixed.assertPreviousHarnessExited(receipt),/Previous Harness is still running/);
 results.push({case:'legacy actual import-guarded process remains protected',pass:true});
 await stop(guarded);await fixed.assertPreviousHarnessExited(receipt);
 results.push({case:'guarded process exit permits recovery',pass:true});
 // Parent crash: exercise the real Windows taskkill orphan-cleanup path.
 const parentFile=path.join(root,'parent.mjs');const orphanPidFile=path.join(root,'orphan.pid');const orphanReady=path.join(root,'orphan.ready');
 await writeFile(parentFile,`import{spawn}from'node:child_process';import{writeFile}from'node:fs/promises';import{writeHarnessProcessReceipt}from ${JSON.stringify(pathToFileURL(fixedPath).href)};
 const c=spawn(process.execPath,['--import',${JSON.stringify(pathToFileURL(fixedPath).href)},'-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(orphanReady)},'ready');setInterval(()=>{},1000)`)}],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,env:{...process.env,ARKME_PROCESS_GUARD_GENERATION:'orphan'}});
 await writeFile(${JSON.stringify(orphanPidFile)},String(c.pid));await writeHarnessProcessReceipt(${JSON.stringify(receipt)},{schemaVersion:1,pid:c.pid,generation:'orphan'});c.send({type:'arkme-harness-start',generation:'orphan'});setInterval(()=>{},1000);`);
 const parent=spawnOwned([parentFile]);await once(parent,'spawn');
 for(let i=0;i<200;i++){try{await access(orphanReady);break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.equal(await readFile(orphanReady,'utf8'),'ready');
 const orphanPid=Number(await readFile(orphanPidFile,'utf8'));assert(present(orphanPid));
 await stop(parent);
 for(let i=0;i<200&&present(orphanPid);i++)await new Promise(r=>setTimeout(r,50));
 assert.equal(present(orphanPid),false);await fixed.assertPreviousHarnessExited(receipt);
 results.push({case:'parent crash: Windows orphan guard terminates owned Harness and recovery proceeds',pass:true});
 console.log(JSON.stringify({host:hostname(),platform:process.platform,node:process.version,time:new Date().toISOString(),results},null,2));
} finally {for(const child of children)await stop(child);await rm(root,{recursive:true,force:true});}
