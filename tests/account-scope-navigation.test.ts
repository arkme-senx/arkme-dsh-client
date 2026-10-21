import {it, expect, vi} from 'vitest';
import {revealAfterAccountAcknowledgement} from '../src/account-scope-navigation.js';
it('acknowledges without awaiting slow navigation for every channel',async()=>{
 vi.useFakeTimers();
 try{
  let finish!:()=>void;
  const pending=new Promise<void>(r=>{finish=r;});
  const reveal=vi.fn(()=>pending);
  await revealAfterAccountAcknowledgement(reveal,()=>{});
  expect(reveal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(reveal).toHaveBeenCalledOnce();finish();
 }finally{vi.useRealTimers();}
});
it('reports deferred navigation failures without rejecting the committed acknowledgement',async()=>{
 vi.useFakeTimers();
 try{
  const error=new Error('navigation failed'),report=vi.fn();
  await revealAfterAccountAcknowledgement(async()=>{throw error;},report);
  await vi.runAllTimersAsync();expect(report).toHaveBeenCalledWith(error);
 }finally{vi.useRealTimers();}
});
