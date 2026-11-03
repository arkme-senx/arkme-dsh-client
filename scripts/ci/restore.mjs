import {readFile,appendFile,mkdir} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
const platform=process.argv[2];const b=JSON.parse(await readFile('reservation.json','utf8'));const name=`arkme-${b.id}-${platform}`;
const args=['api',`repos/${b.repository}/actions/artifacts?name=${name}&per_page=100`];const data=JSON.parse(execFileSync('gh',args,{encoding:'utf8'}));if(data.artifacts.some(x=>x.name===name&&x.expired))throw new Error('Original artifact expired; do not rebuild this reserved version');const artifacts=data.artifacts.filter(x=>x.name===name&&!x.expired);
if(artifacts.length>1)throw new Error('Ambiguous saved artifacts');
const destination=platform==='publication'?'publication':'release-ci';
if(artifacts.length){await mkdir(destination,{recursive:true});execFileSync('gh',['run','download',String(artifacts[0].workflow_run.id),'--repo',b.repository,'--name',name,'--dir',destination],{stdio:'inherit'})}
await appendFile(process.env.GITHUB_OUTPUT,`reused=${artifacts.length===1}\nartifact_run=${artifacts[0]?.workflow_run.id??process.env.GITHUB_RUN_ID}\n`);
