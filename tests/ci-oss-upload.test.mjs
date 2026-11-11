import {test, expect} from 'vitest';
import {putImmutableObject} from '../scripts/ci/oss-upload.mjs';

test('lost response retries with renewed scoped credentials and accepts existing object for subsequent digest verification', async () => {
  let grants = 0;
  const bytes = Buffer.from('immutable');
  const result = await putImmutableObject({bytes, credentials: async () => ({object_key: 'fixed', generation: ++grants}), wait: async () => {},
    createClient: (grant, options) => {
      expect(options.timeout).toBe(300000);
      return {put: async (key, value, args) => {
        expect(key).toBe('fixed'); expect(value).toBe(bytes); expect(args.headers['x-oss-forbid-overwrite']).toBe('true');
        if (grant.generation === 1) throw {name: 'ResponseTimeoutError', message: 'secret request'};
        throw {code: 'FileAlreadyExists', status: 409};
      }};
    }});
  expect(grants).toBe(2); expect(result.generation).toBe(2);
});

test('permanent errors stop immediately and redact sensitive SDK diagnostics', async () => {
  let attempts = 0;
  await expect(putImmutableObject({bytes: Buffer.from('x'), credentials: async () => ({}), createClient: () => ({put: async () => {
    attempts++; throw {code: 'AccessDenied', status: 403, message: 'secret token', request: {authorization: 'secret'}};
  }})})).rejects.toThrow('OSS upload failed (AccessDenied; status=403; attempts=1)');
  expect(attempts).toBe(1);
});

test('transient retries are bounded', async () => {
  let attempts = 0;
  await expect(putImmutableObject({bytes: Buffer.from('x'), credentials: async () => ({}), wait: async () => {}, createClient: () => ({put: async () => {
    attempts++; throw {code: 'ETIMEDOUT'};
  }})})).rejects.toThrow('attempts=3');
  expect(attempts).toBe(3);
});

test('large files resume multipart with renewed credentials and safe progress logs', async () => {
 const bytes=Buffer.alloc(9*1024*1024), events=[];
 const checkpoint={uploadId:'private-upload-id',doneParts:[{number:1,etag:'etag'}]};
 let grants=0,clock=0;
 await putImmutableObject({bytes,filename:'app.exe',log:e=>events.push(e),now:()=>clock,wait:async()=>{},
 credentials:async()=>({object_key:'fixed',generation:++grants}),
 createClient:grant=>({multipartUpload:async(key,value,options)=>{
  expect(key).toBe('fixed');expect(value).toBe(bytes);
  expect(options.partSize).toBe(8*1024*1024);expect(options.parallel).toBe(2);
  expect(options.headers['x-oss-forbid-overwrite']).toBe('true');
  clock+=1000;
  if(grant.generation===1){await options.progress(.5,checkpoint);throw {name:'ResponseTimeoutError',message:'secret'};}
  expect(options.checkpoint).toBe(checkpoint);
 }})});
 expect(grants).toBe(2);
 expect(events.at(-1)).toMatchObject({event:'oss_upload_complete',file:'app.exe',size_bytes:bytes.length,elapsed_ms:2000});
 expect(JSON.stringify(events)).not.toMatch(/private-upload-id|secret/);
});

test('multipart credential expiry retries but unrelated 409 is not mistaken for existing object', async()=>{
 let calls=0;
 await expect(putImmutableObject({bytes:Buffer.alloc(9*1024*1024),log:()=>{},wait:async()=>{},credentials:async()=>({object_key:'fixed'}),createClient:()=>({multipartUpload:async()=>{
  if(++calls===1)throw {code:'SecurityTokenExpired',status:403};
  throw {code:'InvalidPart',status:409};
 }})})).rejects.toThrow('InvalidPart');
 expect(calls).toBe(2);
});

test('completed upload with lost response can recover an expired upload ID without overwriting', async()=>{
 let calls=0;
 await putImmutableObject({bytes:Buffer.alloc(9*1024*1024),log:()=>{},wait:async()=>{},credentials:async()=>({object_key:'fixed'}),createClient:()=>({multipartUpload:async(key,bytes,options)=>{
  calls++;
  if(calls===1){await options.progress(.9,{uploadId:'completed'});throw {name:'ResponseTimeoutError'};}
  if(calls===2){expect(options.checkpoint.uploadId).toBe('completed');throw {code:'NoSuchUpload',status:404};}
  expect(options.checkpoint).toBeUndefined();throw {code:'FileAlreadyExists',status:409};
 }})});
 expect(calls).toBe(3);
});
