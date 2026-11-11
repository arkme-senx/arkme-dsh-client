import {readFile,readdir,writeFile,stat,mkdir} from 'node:fs/promises';
import {createHash,sign,createPrivateKey} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import YAML from 'yaml';
import {api,prefix,required} from './api.mjs';
import {publishBatch} from './publication.mjs';
import {putImmutableObject} from './oss-upload.mjs';
const command=process.argv[2];const json=async p=>JSON.parse(await readFile(p,'utf8'));
const b=await json('reservation.json');
const digest=bytes=>createHash('sha512').update(bytes).digest('hex');
function kind(name){if(name.endsWith('.exe'))return 'nsis';if(name.endsWith('.pkg'))return 'pkg';if(name.endsWith('.zip'))return 'zip';if(name.endsWith('.blockmap'))return 'blockmap';if(['latest.yml','latest-mac.yml'].includes(name))return 'yaml';return null}
if(command==='collect'){
 const platform=process.argv[3];const files=[];for(const name of (await readdir('release-ci')).sort()){const type=kind(name);if(!type||(platform==='windows'&&(type==='zip'||name.endsWith('.zip.blockmap'))))continue;const bytes=await readFile(path.join('release-ci',name));files.push({platform,name,kind:type,size:bytes.length,sha512:digest(bytes),signing_status:['nsis','pkg','zip'].includes(type)?platform==='macos'?'signed-notarized':'signed':''})}
 for(const requiredKind of platform==='macos'?['pkg','zip','yaml']:['nsis','blockmap','yaml'])if(!files.some(f=>f.kind===requiredKind))throw new Error(`Missing ${requiredKind}`);
 const feed=YAML.parse(await readFile(`release-ci/${platform==='macos'?'latest-mac.yml':'latest.yml'}`,'utf8'));
 if(feed.version!==b.version||!feed.files?.length)throw new Error('Invalid update metadata');
 for(const ref of feed.files){const f=files.find(f=>f.name===ref.url);if(!f||f.size!==ref.size||Buffer.from(f.sha512,'hex').toString('base64')!==ref.sha512)throw new Error('Update file differs from final artifact')}
 const runtime=JSON.parse(execFileSync(process.platform==='win32'?'node_modules/electron/dist/electron.exe':'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',['-e','console.log(JSON.stringify({electron:process.versions.electron,modules:process.versions.modules}))'],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}).trim());
 await writeFile('release-ci/platform.json',JSON.stringify({batch_id:b.id,platform,run_attempt:Number(required('GITHUB_RUN_ATTEMPT')),electron_major:Number(runtime.electron.split('.')[0]),modules_abi:Number(runtime.modules),files,signing_evidence:await json('release-ci/signing-evidence.json')}));
}else if(command==='manifest'){
 const metas=await Promise.all(['macos','windows'].map(p=>json(`artifacts/${p}/platform.json`)));if(metas.some(m=>m.batch_id!==b.id)||metas[0].electron_major!==metas[1].electron_major||metas[0].modules_abi!==metas[1].modules_abi)throw new Error('Platform build mismatch');
 const writeback=await json('writeback.json');const payload=JSON.stringify({schema_version:1,batch_id:b.id,environment:b.environment,repository:b.repository,version:b.version,version_code:b.version_code,source_sha:b.source_sha,writeback_sha:writeback.sha,run_id:b.run_id,invocation_run_id:required('GITHUB_RUN_ID'),run_attempt:Math.max(...metas.map(m=>m.run_attempt)),electron_major:metas[0].electron_major,modules_abi:metas[0].modules_abi,signing_evidence:Object.fromEntries(metas.map(m=>[m.platform,m.signing_evidence])),notes:'即我 3.0 正式版',files:metas.flatMap(m=>m.files)});
 const key=createPrivateKey(required('ARKME_MANIFEST_PRIVATE_KEY'));if(key.asymmetricKeyType!=='ed25519')throw new Error('Ed25519 manifest key required');
 const envelope={batch_id:b.id,run_id:b.run_id,payload,signature:sign(null,Buffer.from(payload),key).toString('base64')};await mkdir('publication',{recursive:true});await writeFile('publication/manifest.json',JSON.stringify(envelope));
}else if(command==='upload'){
 const {default:OSS}=await import('ali-oss');const envelope=await json('publication/manifest.json');const m=JSON.parse(envelope.payload);if(m.batch_id!==b.id)throw new Error('Wrong batch');
 const all=[...m.files.map(f=>({...f,file:path.join('artifacts',f.platform,f.name)})),...['macos','windows'].map(platform=>({platform,name:'manifest.json',kind:'manifest',file:'publication/manifest.json'}))].sort((a,b)=>rank(a.kind)-rank(b.kind));
 function rank(k){return k==='manifest'?2:k==='yaml'?1:0}
 for(const f of all){const bytes=await readFile(f.file);const hash=digest(bytes);if(f.sha512&&(hash!==f.sha512||bytes.length!==f.size))throw new Error('Artifact changed after manifest');
  const g=await putImmutableObject({bytes,filename:`${f.platform}/${f.name}`,credentials:async()=>{const grant=await api('upload-credentials',{batch_id:b.id,run_id:b.run_id,platform:f.platform,file:f.name});if(grant.object_key!==prefix(b.environment,f.platform,b.version,b.version_code)+f.name)throw new Error('Invalid upload scope');return grant},createClient:(grant,options)=>new OSS({...options,endpoint:grant.endpoint,bucket:grant.bucket,accessKeyId:grant.credentials.access_key_id,accessKeySecret:grant.credentials.access_key_secret,stsToken:grant.credentials.security_token,secure:true})});
  const response=await fetch(g.url,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw new Error('CDN unavailable');const check=Buffer.from(await response.arrayBuffer());if(check.length!==bytes.length||digest(check)!==hash)throw new Error('Immutable object conflict or CDN mismatch');
 }
}else if(command==='publish'){
 const envelope=await json('publication/manifest.json');await publishBatch(api,envelope);
}else throw new Error('Unknown artifact operation');
