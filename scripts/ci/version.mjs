import {nextPackageVersion, assertReservedVersion} from './package-version.mjs';
import {readFile,writeFile,appendFile} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import {api,environment,required} from './api.mjs';
const command=process.argv[2];const read=async p=>JSON.parse(await readFile(p,'utf8'));const pkg=await read('package.json');
if(command==='reserve'){
 const headMessage=execFileSync('git',['log','-1','--format=%B'],{encoding:'utf8'});
 if(headMessage.includes('Arkme-CI-Batch:'))throw new Error('This is a CI version writeback commit; rerun the original release run to reuse its batch and artifacts');
 const target=nextPackageVersion(pkg);const env=environment(required('GITHUB_REF'));const b=await api('versions/reserve',{repository:required('GITHUB_REPOSITORY'),source_sha:required('GITHUB_SHA'),version:pkg.version,version_code:pkg.versionCode,target_version:target,run_id:required('GITHUB_RUN_ID')});assertReservedVersion(b,target);if(b.environment!==env)throw new Error('Backend environment mismatch');await writeFile('reservation.json',JSON.stringify(b));if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`environment=${env}\npublished=${b.status==='published'}\n`);
}else{
 const b=await read('reservation.json');pkg.version=b.version;pkg.versionCode=b.version_code;if(pkg.build?.mac)pkg.build.mac.bundleVersion=String(b.version_code);await writeFile('package.json',JSON.stringify(pkg,null,2)+'\n');
 if(command==='writeback'){
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();const branch=required('GITHUB_REF').replace('refs/heads/','');environment(required('GITHUB_REF'));
  git('add','package.json');const tree=git('write-tree');git('fetch','origin',branch);const remote=git('rev-parse','FETCH_HEAD');let commit;
  if(remote===b.source_sha){const date=new Date(b.created_at*1000).toISOString();commit=execFileSync('git',['commit-tree',tree,'-p',b.source_sha],{input:`chore(release): ${b.version} vc${b.version_code}\n\n功能点: CI 回写客户端版本\nArkme-CI-Batch: ${b.id}\n`,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'github-actions[bot]',GIT_AUTHOR_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com',GIT_COMMITTER_NAME:'github-actions[bot]',GIT_COMMITTER_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com',GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}}).trim();git('push','origin',`${commit}:refs/heads/${branch}`)}
  else if(git('rev-parse',`${remote}^`)===b.source_sha&&git('rev-parse',`${remote}^{tree}`)===tree&&git('log','-1','--format=%B',remote).includes(`Arkme-CI-Batch: ${b.id}`)){commit=remote}else throw new Error('Branch advanced; refusing stale publication');
  await writeFile('writeback.json',JSON.stringify({sha:commit}));
 }
}
