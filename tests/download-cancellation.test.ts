import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { downloadRuntimeArtifact } from '../src/runtime/download.js';
const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

test.each(['http','range','overflow'] as const)('cancels its own %s failure before returning and retains original error',async scenario=>{
 const root=await mkdtemp(path.join(tmpdir(),'download-own-cancel-')); roots.push(root);
 const destination=path.join(root,'archive');
 if(scenario==='range') await writeFile(`${destination}.part`,'x');
 let cancelled=false; let signal:AbortSignal|undefined;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(11));},cancel(){cancelled=true; throw new DOMException('cleanup cancellation','AbortError');}});
 await expect(downloadRuntimeArtifact({destination,artifact:{url:'https://d.jiwo.cc/archive',sha256:'a'.repeat(64),size:10},retryDelaysMs:[0],fetcher:async(_url,init)=>{
  signal=init?.signal??undefined;
  return new Response(body,{status:scenario==='http'?403:scenario==='range'?206:200,headers:scenario==='range'?{'content-range':'bytes 2-9/10'}:{}});
 }})).rejects.toMatchObject(scenario==='overflow'?{name:'RuntimeArtifactValidationError',code:'ARTIFACT_SIZE_MISMATCH'}:{name:'RuntimeDownloadError',permanent:true});
 expect(cancelled).toBe(true);
 expect(signal?.aborted).toBe(true);
});

test('transport interruption has waiting presentation without relabeling server or filesystem errors', async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'download-network-presentation-'));roots.push(root);
 const artifact={url:'https://d.jiwo.cc/archive',sha256:'a'.repeat(64),size:10};
 await expect(downloadRuntimeArtifact({destination:path.join(root,'archive'),artifact,retryDelaysMs:[0],fetcher:async()=>{throw new TypeError('fetch failed');}})).rejects.toMatchObject({
  displayTitle:'需要联网完成运行环境升级',suggestion:'已下载进度和本地数据会保留。\n\n网络恢复后，请点击“重试”继续。',showWorkspaceAction:false
 });
 let server:unknown;
 try {await downloadRuntimeArtifact({destination:path.join(root,'server'),artifact,retryDelaysMs:[0],fetcher:async()=>new Response(null,{status:403})});}catch(error){server=error;}
 expect(server).toMatchObject({name:'RuntimeDownloadError',permanent:true});
 expect(server).not.toHaveProperty('displayTitle');
 await writeFile(path.join(root,'file'),'x');
 let disk:unknown;
 try {await downloadRuntimeArtifact({destination:path.join(root,'file','archive'),artifact,retryDelaysMs:[0],fetcher:async()=>new Response()});}catch(error){disk=error;}
 expect(disk).not.toHaveProperty('displayTitle');
 expect(disk).toHaveProperty('code');
});
