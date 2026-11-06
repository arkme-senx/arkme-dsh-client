import { test } from 'vitest';
import assert from 'node:assert/strict';
import {canStartFirstBuild,neverProduced} from '../scripts/ci/restore-history.mjs';
const skipped=[{name:'build',status:'completed',conclusion:'skipped',steps:[]}];
const blocked=[{name:'build (macos, macos-14)',status:'completed',conclusion:'failure',steps:[{name:'Run node scripts/ci/restore.mjs macos',conclusion:'failure'},{name:'Run node scripts/ci/build-macos.cjs',conclusion:'skipped'},{name:'通知平台构建失败或取消',conclusion:'success'}]}];
const input={batch:{run_id:'1',status:'reserved'},runID:'1',attempt:3,artifacts:[],platform:'macos',loadJobs:async n=>n===1?skipped:blocked};
test('reserve failure followed by restore rejection can start first build',async()=>assert.equal(await canStartFirstBuild(input),true));
test('prior output creation and ambiguous or incomplete history prevent rebuild',async()=>{
 for(const jobs of [[],[...blocked,...blocked], [{...blocked[0],status:'in_progress'}], [{...blocked[0],steps:blocked[0].steps.map((s,i)=>i===0?{...s,conclusion:'success'}:s)}], [{...blocked[0],steps:blocked[0].steps.map((s,i)=>i===1?{...s,conclusion:'failure'}:s)}]]) assert.equal(await canStartFirstBuild({...input,loadJobs:async()=>jobs}),false);
});
test('expired artifacts, submitted manifest and different workflow identity never rebuild',async()=>{
 for(const change of [{artifacts:[{expired:true}]},{batch:{...input.batch,payload_digest:'digest'}},{batch:{...input.batch,status:'published'}},{runID:'2'},{attempt:NaN}]) assert.equal(await canStartFirstBuild({...input,...change}),false);
});
test('platform-specific history and publication boundary remain independent',()=>{
 assert.equal(neverProduced(blocked,'windows'),false);
 assert.equal(neverProduced([{name:'publish',status:'completed',conclusion:'skipped',steps:[]}],'publication'),true);
});
test('history API errors propagate rather than authorize rebuilding',async()=>{
 await assert.rejects(canStartFirstBuild({...input,loadJobs:async()=>{throw Error('unavailable')}}));
});
