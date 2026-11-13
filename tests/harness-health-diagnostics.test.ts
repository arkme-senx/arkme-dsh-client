import {afterEach, expect, test, vi} from 'vitest';
import {checkHarnessHealth} from '../src/harness-supervisor.js';
const session = {url:'http://127.0.0.1:41234/',cookie:{name:'dsh-auth-test',value:'secret',path:'/' as const,httpOnly:true as const,sameSite:'strict' as const},signal:new AbortController().signal};
afterEach(()=>vi.unstubAllGlobals());
test.each([200,302,401,503])('classifies HTTP %s without reading response bodies',async status=>{
 const cancel=vi.fn(async()=>{});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:status===200,status,body:{cancel}})));
 expect(await checkHarnessHealth(session.url,session)).toEqual({ok:status===200,reason:status===200?'ready':'http-status',status});
 expect(cancel).toHaveBeenCalledOnce();
});
test.each(['ECONNREFUSED','ECONNRESET','PRIVATE_SECRET'])('keeps only allowlisted cause codes (%s)',async code=>{
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('token=private', {cause:{code,message:'private endpoint'}});}));
 const result=await checkHarnessHealth(session.url,session);
 expect(result).toEqual({ok:false,reason:'network-error',...(code==='PRIVATE_SECRET'?{}:{errorCode:code})});
 expect(JSON.stringify(result)).not.toContain('private');
});
test('classifies timeout separately from generic network failure',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('private','TimeoutError');}));
 expect(await checkHarnessHealth(session.url,session)).toEqual({ok:false,reason:'request-timeout'});
});
