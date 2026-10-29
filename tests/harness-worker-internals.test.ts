import {expect,it} from 'vitest';
import {harnessWorkerExecArgv} from '../src/harness-process-lifetime.js';

const preload='file:///signed/app.asar.unpacked/dist/harness-process-lifetime.js';
it('adds the host adapter to Workers that explicitly clear inherited CLI arguments',()=>{
 expect(harnessWorkerExecArgv([],['--inspect=127.0.0.1:9229'],preload))
  .toEqual(['--expose-internals','--import',preload]);
});
it('preserves requested Worker arguments without duplicating the host adapter',()=>{
 const args=['--trace-warnings','--expose-internals','--import',preload];
 expect(harnessWorkerExecArgv(undefined,args,preload)).toEqual(args);
 expect(harnessWorkerExecArgv(harnessWorkerExecArgv([],[],preload),[],preload))
  .toEqual(['--expose-internals','--import',preload]);
});
it('recognizes the inline import spelling and leaves the caller array untouched',()=>{
 const requested=[`--import=${preload}`];
 expect(harnessWorkerExecArgv(requested,[],preload)).toEqual([`--import=${preload}`,'--expose-internals']);
 expect(requested).toEqual([`--import=${preload}`]);
});
