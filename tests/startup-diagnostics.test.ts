import {afterEach,expect,test,vi} from 'vitest';
import {mkdtemp,readFile,readdir,rm,writeFile,utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StartupDiagnostics,scrubStartupDiagnostic,startupLifecycleTail} from '../src/startup-diagnostics.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(fetcher: typeof fetch = vi.fn(async()=>new Response(null,{status:503})) as typeof fetch) {
 const directory=await mkdtemp(path.join(os.tmpdir(),'startup-report-'));roots.push(directory);
 const reporter=new StartupDiagnostics({directory,serviceOrigin:'https://jotmo.senguo.me',fetcher,metadata:()=>({version:'3.0.13',build:291,platform:'windows',architecture:'x64',osVersion:'10.0.22631',harnessVersion:'0.1.5-rc.2',pluginVersion:'3.0.11'})});
 return {directory,reporter,fetcher};
}
test('matches shared installer redaction fixtures before truncation and protects extended credentials',async()=>{
 const f=JSON.parse(await readFile('tests/fixtures/installer-diagnostics/path-redaction.json','utf8'));
 const text=scrubStartupDiagnostic(f.input,16000);
 for(const keep of f.keep)expect(text).toContain(keep);
 for(const hide of f.hide)expect(text).not.toContain(hide);
 const extended=scrubStartupDiagnostic('accessToken="super-private" refresh_token=secret-refresh\n-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----');
 for(const secret of ['super-private','secret-refresh','secret-key'])expect(extended).not.toContain(secret);
 expect(Buffer.byteLength(scrubStartupDiagnostic('中'.repeat(5000)))).toBeLessThanOrEqual(4096);
});
test('deduplicates supervisor and failure-page events and persists only scrubbed reports',async()=>{
 const {reporter,directory}=await fixture();
 reporter.begin();reporter.starting();
 reporter.fail('plugin tree failed to load: C:\\Users\\alice\\app.js token=private');
 reporter.fail('same failure');await reporter.settled();
 const files=await readdir(directory);expect(files).toHaveLength(1);
 const text=await readFile(path.join(directory,files[0]!),'utf8');expect(text).not.toContain('alice');expect(text).not.toContain('private');
 expect(JSON.parse(text)).toMatchObject({stage:'plugin-load',harness_version:'0.1.5-rc.2',plugin_version:'3.0.11',error_code:'STARTUP_FAILED'});
});
test('startup and retry return immediately while network is pending; normal cancellation never reports',async()=>{
 let finish!:()=>void;
 const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=()=>resolve(new Response(null,{status:202}));})) as unknown as typeof fetch;
 const {reporter}=await fixture(fetcher);
 reporter.begin();reporter.starting();reporter.cancel();reporter.fail('This operation was aborted');
 await reporter.settled();expect(fetcher).not.toHaveBeenCalled();
 reporter.starting();expect(reporter.fail('real failure')).toBeUndefined();
 await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
 expect(reporter.begin()).toBeUndefined(); // no network wait on retry
 finish();await reporter.settled();
});
test('does not suppress real aborted errors without explicit cancellation',async()=>{
 const {reporter,directory}=await fixture();reporter.begin();reporter.fail('This operation was aborted');await reporter.settled();
 expect(await readdir(directory)).toHaveLength(1);
});
test('retries across reporter instances using same event id and removes only acknowledged reports',async()=>{
 const f=await fixture();f.reporter.begin();f.reporter.fail('error');await f.reporter.settled();
 const filename=(await readdir(f.directory))[0]!;
 const send=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  expect(JSON.parse(init!.body as string).event_id+'.json').toBe(filename);
  expect(init).toMatchObject({redirect:'error',credentials:'omit'});return new Response(null,{status:202});
 });
 const next=new StartupDiagnostics({directory:f.directory,serviceOrigin:'https://jotmo.senguo.me',fetcher:send as typeof fetch,metadata:()=>{throw Error('not needed');}});
 next.begin();await next.settled();expect(send).toHaveBeenCalledOnce();expect(await readdir(f.directory)).toEqual([]);
});
test('bounds offline queue, expires old entries, and ignores unrelated files',async()=>{
 const {reporter,directory}=await fixture();
 await writeFile(path.join(directory,'unrelated.txt'),'keep');
 for(let i=0;i<23;i++){reporter.begin();reporter.fail('error');await reporter.settled();}
 let files=(await readdir(directory)).filter(n=>n.endsWith('.json'));expect(files).toHaveLength(20);
 const old=path.join(directory,files[0]!);await utimes(old,0,0);
 reporter.begin();await reporter.settled();files=(await readdir(directory)).filter(n=>n.endsWith('.json'));expect(files).toHaveLength(19);
 expect(await readFile(path.join(directory,'unrelated.txt'),'utf8')).toBe('keep');
});
test('uploads only allowed supervisor lifecycle fields, never business or historical lines',async()=>{
 const {directory}=await fixture();const log=path.join(directory,'harness.log');
 await writeFile(log,'[supervisor] spawned {"timeoutMs":1}\n[supervisor] startup-timeout {"timeoutMs":1}\n[supervisor] spawned {"timeoutMs":90000,"workspacePath":"/Users/alice/private"}\nchat: private conversation\n[supervisor] health-waiting {"url":"http://private"}\n[supervisor] process-exit {"code":1,"cookie":"private"}\n');
 const text=await startupLifecycleTail(log);expect(text).toContain('90000');expect(text).toContain('"code":1');expect(text).not.toContain('private');expect(text).not.toContain('alice');expect(text).not.toContain('startup-timeout');
 expect(await startupLifecycleTail(log,Date.now()+10000)).toBe('');
});
test('disabled development channel and shutdown do not send or block',async()=>{
 const {directory}=await fixture();const fetcher=vi.fn();
 const reporter=new StartupDiagnostics({directory,serviceOrigin:'https://jotmo.senguo.me',enabled:false,fetcher,metadata:()=>{throw Error('must not read');}});
 reporter.begin();reporter.fail('error');await reporter.settled();expect(fetcher).not.toHaveBeenCalled();
 reporter.shutdown();reporter.begin();expect(reporter.fail('error')).toBeUndefined();
});
test('disk errors and metadata errors never escape into application startup',async()=>{
 const {reporter,directory}=await fixture();await rm(directory,{recursive:true});await writeFile(directory,'not a directory');
 reporter.begin();expect(reporter.fail('error')).toBeUndefined();await expect(reporter.settled()).resolves.toBeUndefined();
 const broken=new StartupDiagnostics({directory,serviceOrigin:'https://jotmo.senguo.me',metadata:()=>{throw Error('metadata unavailable');}});
 broken.begin();expect(()=>broken.fail('error')).not.toThrow();await broken.settled();
});

test('request timeout aborts delivery without deleting pending report',async()=>{
 let aborted=false;
 const send=vi.fn(async(_url:unknown,init?:RequestInit)=>await new Promise<Response>((_resolve,reject)=>{
  init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});
 }));
 const {reporter,directory}=await fixture(send as typeof fetch);
 reporter.begin();reporter.fail('failure');
 await reporter.settled();expect(aborted).toBe(true);expect(await readdir(directory)).toHaveLength(1);
},5000);

test('shutdown aborts in-flight delivery, retains report and rejects subsequent attempts',async()=>{
 const send=vi.fn(async(_url:unknown,init?:RequestInit)=>await new Promise<Response>((_resolve,reject)=>{
  init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
 }));
 const {reporter,directory}=await fixture(send as typeof fetch);
 reporter.begin();reporter.fail('failure');await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce());
 expect(reporter.shutdown()).toBeUndefined();await reporter.settled();
 reporter.begin();reporter.fail('should not send');await reporter.settled();
 expect(send).toHaveBeenCalledOnce();expect(await readdir(directory)).toHaveLength(1);
});

test('discard corrupt queue records without blocking a subsequent valid failure',async()=>{
 const {reporter,directory}=await fixture();
 await writeFile(path.join(directory,'a'.repeat(32)+'.json'),'null');
 await writeFile(path.join(directory,'b'.repeat(32)+'.json'),'{broken');
 reporter.begin();reporter.fail('valid');await reporter.settled();expect(await readdir(directory)).toHaveLength(1);
});


test('keeps the error stack beyond the short summary in the bounded log field',async()=>{
 const {reporter,directory}=await fixture();
 reporter.begin();reporter.fail('Error: '+ 'stack-frame\n'.repeat(400)+'Caused by: original failure');await reporter.settled();
 const report=JSON.parse(await readFile(path.join(directory,(await readdir(directory))[0]!), 'utf8'));
 expect(report.details).not.toContain('Caused by: original failure');
 expect(report.log).toContain('Caused by: original failure');
 expect(Buffer.byteLength(report.log)).toBeLessThanOrEqual(12000);
});
