import { readFile, writeFile, access, readdir, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {pluginCodeDigests} from './stage-runtime.mjs';
import {statFile} from '@electron/asar';
import {verifyBundlePermissions} from './permissions.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [app,output]=process.argv.slice(2);
if(!app||!output)throw new Error('Usage: verify:mas <app> <report.json>');
await verifyBundlePermissions(app);
execFileSync(process.execPath,[path.join(root,'scripts/mas/verify-probe.mjs'),app,output],{stdio:'inherit'});
const resources=path.resolve(app,'Contents/Resources');
await access(path.join(resources,'app.asar'));
for(const file of ['preload.cjs','harness-process-lifetime.js']) await access(path.join(resources,'app.asar.unpacked/dist',file));
for(const entry of await readdir(path.resolve(app),{recursive:true,withFileTypes:true})){
 if(entry.isSymbolicLink()){const target=await realpath(path.join(entry.parentPath,entry.name));if(!target.startsWith(path.resolve(app)+path.sep))throw new Error(`External bundle symlink: ${target}`);}
}
for(const name of ['semver','electron-updater','ali-oss','koffi']) if(statFile(path.join(resources,'app.asar'),'node_modules/'+name,false).link) throw new Error(`MAS dependency must be materialized: ${name}`);
const marker=JSON.parse(await readFile(path.join(resources,'jiwo-mas.json'),'utf8'));
if(marker.distribution!=='mas'||marker.policyRevision!==2)throw new Error('MAS policy marker missing');
const report=JSON.parse(await readFile(output,'utf8'));
const frozen=JSON.parse(await readFile(path.join(resources,'frozen.json'),'utf8'));
if(frozen.channel.version!==report.version||String(frozen.channel.versionCode)!==String(report.versionCode))throw new Error('MAS version mismatch');
report.purpose='full-client-development-sample';report.layout='asar';report.restrictions=[];
const unpacked=path.join(resources,'app.asar.unpacked');
const addon=(await readdir(unpacked,{recursive:true})).find(p=>p.endsWith('/arkme_notification_permission.node'));
if(!addon)throw new Error('Notification native dependency missing');
const nativeArch=execFileSync('/usr/bin/lipo',['-archs',path.join(unpacked,addon)],{encoding:'utf8'}).trim();
if(!nativeArch.includes('arm64')||!nativeArch.includes('x86_64'))throw new Error('Notification dependency is not Universal');
report.notificationNativeArchitectures=nativeArch;
for(const arch of ['arm64','x64']){
 const dir=path.join(resources,'embedded',arch);
 const policy=JSON.parse(await readFile(path.join(dir,'mas-policy.json'),'utf8'));
 if(policy.credentialServicePrefix!=='com.senqisi.dsh-arkme.mas')throw new Error('MAS credentials must be isolated');
 if(policy.revision!==2||policy.pluginCodeUnmodified!==true)throw new Error('MAS host policy metadata invalid');
 const pluginRoot=path.join(dir,frozen.manifests[arch].artifacts.requiredPlugin.target);
 if(JSON.stringify(await pluginCodeDigests(pluginRoot))!==JSON.stringify(policy.files))throw new Error('MAS plugin code hashes changed');
 report.restrictions.push({arch,pluginCodeHashesVerified:true,pluginCodeUnmodified:true});
}
report.websiteBuildModified=false;
await writeFile(output,JSON.stringify(report,null,2));
console.log('MAS full client signature and embedded host policy contract verified');
