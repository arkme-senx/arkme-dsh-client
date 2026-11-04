import {readFile,appendFile,mkdir} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
import {api,required} from './api.mjs';
import {canStartFirstBuild} from './restore-history.mjs';
import {restoreOSS} from './restore-oss.mjs';
const platform=process.argv[2];const b=JSON.parse(await readFile('reservation.json','utf8'));const name=`arkme-${b.id}-${platform}`;
const args=['api',`repos/${b.repository}/actions/artifacts?name=${name}&per_page=100`];const data=JSON.parse(execFileSync('gh',args,{encoding:'utf8'}));const artifacts=data.artifacts.filter(x=>x.name===name&&!x.expired);
if(artifacts.length>1)throw new Error('Ambiguous saved artifacts');
const destination=platform==='publication'?'publication':'release-ci';
if(artifacts.length){await mkdir(destination,{recursive:true});execFileSync('gh',['run','download',String(artifacts[0].workflow_run.id),'--repo',b.repository,'--name',name,'--dir',destination],{stdio:'inherit'})}
let reused=artifacts.length===1;
if(!reused){const current=await api('releases/status',{batch_id:b.id,run_id:b.run_id});reused=await restoreOSS(required('ARKME_CDN_BASE'),current,platform,destination);if(!reused){
 const safe=await canStartFirstBuild({batch:current,runID:process.env.GITHUB_RUN_ID,attempt:Number(process.env.GITHUB_RUN_ATTEMPT),artifacts:data.artifacts,platform,loadJobs:async attempt=>{
  const pages=JSON.parse(execFileSync('gh',['api',`repos/${b.repository}/actions/runs/${b.run_id}/attempts/${attempt}/jobs?per_page=100`,'--paginate','--slurp'],{encoding:'utf8'}));
  return pages.flatMap(page=>page.jobs);
 }});
 if(!safe)throw new Error('Original artifacts unavailable or prior build history uncertain; use a new source commit/version instead of rebuilding this reservation');
}}
await appendFile(process.env.GITHUB_OUTPUT,`reused=${reused}\nartifact_run=${artifacts[0]?.workflow_run.id??process.env.GITHUB_RUN_ID}\n`);
