import {describe,it,expect} from 'vitest';
// @ts-expect-error CI JavaScript has no runtime TypeScript dependency.
import {publishBatch} from '../scripts/ci/publication.mjs';
const envelope={batch_id:'batch',run_id:'run',payload:'signed',signature:'signature'};
describe('durable CI publication',()=>{
 it('waits for publication after acceptance and a transient status disconnect',async()=>{
  const responses:any[]=[{status:'validating'},new Error('network'),{status:'validating'},{status:'published'}];const calls:any[]=[];const waits:number[]=[];
  const result=await publishBatch(async(route:string,body:any)=>{calls.push([route,body]);const r=responses.shift();if(r instanceof Error)throw r;return r},{...envelope},{wait:async(ms:number)=>{waits.push(ms)}});
  expect(result.status).toBe('published');expect(calls[0][1]).toEqual({...envelope,async:true});expect(waits).toEqual([2000,4000,2000]);
 });
 it('recovers an accepted submit whose HTTP response was lost',async()=>{
  const responses:any[]=[new Error('504'),{status:'validating'},{status:'published'}];
  expect((await publishBatch(async()=>{const r=responses.shift();if(r instanceof Error)throw r;return r},envelope,{wait:async()=>{}})).status).toBe('published');
 });
 it('does not turn failed validation into success',async()=>{
  await expect(publishBatch(async()=>({status:'failed'}),envelope)).rejects.toThrow(/validation failed/);
 });
 it('leaves a pending batch recoverable when polling expires',async()=>{
  let now=0;await expect(publishBatch(async()=>({status:'validating'}),envelope,{timeout:1,now:()=>now,wait:async()=>{now=2}})).rejects.toThrow(/resume this batch/);
 });
});
