import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {prefix} from './api.mjs';
// The authenticated backend fingerprint anchors the already-verified signed payload.
export function verifyRecoveryManifest(envelope,b){
 if(!b.payload_digest||createHash('sha256').update(envelope.payload).digest('hex')!==b.payload_digest)throw new Error('Recovery manifest fingerprint mismatch');
 const m=JSON.parse(envelope.payload);
 if(envelope.batch_id!==b.id||envelope.run_id!==b.run_id||m.batch_id!==b.id||m.source_sha!==b.source_sha||m.version!==b.version||m.version_code!==b.version_code||m.environment!==b.environment)throw new Error('Recovery manifest identity mismatch');
 for(const f of m.files){if(!['macos','windows'].includes(f.platform)||typeof f.name!=='string'||/[\\/\x00-\x1f?#%]/.test(f.name)||['.','..'].includes(f.name)||!Number.isSafeInteger(f.size)||f.size<=0||!/^[a-f0-9]{128}$/i.test(f.sha512))throw new Error('Invalid recovery artifact')}
 return m;
}
export async function restoreOSS(api,b,platform,destination,fetcher=fetch){
 if(!b.payload_digest)return false;
 const manifestPlatform=platform==='publication'?'macos':platform;
 const grant=await api('upload-credentials',{batch_id:b.id,run_id:b.run_id,platform:manifestPlatform,file:'manifest.json'});
 const expected=prefix(b.environment,manifestPlatform,b.version,b.version_code)+'manifest.json';
 if(grant.object_key!==expected||new URL(grant.url).protocol!=='https:')throw new Error('Invalid recovery scope');
 const response=await fetcher(grant.url,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok)throw new Error('Original manifest unavailable; do not rebuild this version');
 const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>256*1024)throw new Error('Recovery manifest too large');
 const envelope=JSON.parse(bytes);const m=verifyRecoveryManifest(envelope,b);await mkdir(destination,{recursive:true});
 if(platform==='publication'){await writeFile(path.join(destination,'manifest.json'),bytes);return true}
 const files=m.files.filter(f=>f.platform===platform);if(!files.length)throw new Error('Recovery platform missing');
 for(const f of files){const url=new URL(encodeURIComponent(f.name),grant.url);const r=await fetcher(url,{signal:AbortSignal.timeout(300000),redirect:'error'});if(!r.ok)throw new Error('Original artifact unavailable');const data=Buffer.from(await r.arrayBuffer());if(data.length!==f.size||createHash('sha512').update(data).digest('hex')!==f.sha512.toLowerCase())throw new Error('Original artifact digest mismatch');await writeFile(path.join(destination,f.name),data)}
 await writeFile(path.join(destination,'platform.json'),JSON.stringify({batch_id:b.id,platform,run_attempt:m.run_attempt,electron_major:m.electron_major,modules_abi:m.modules_abi,files,signing_evidence:m.signing_evidence[platform]}));return true;
}
