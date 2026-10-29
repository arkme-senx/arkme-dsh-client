import {cp, readFile, writeFile, mkdir, readdir, rm, chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeOfficeResourceBundle} from './resource-bundles.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function pluginCodeDigests(pluginRoot) {
  const files=[];
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())await walk(file);
    else if(entry.isFile()&&/\.(?:[cm]?js|json)$/.test(entry.name))files.push({path:path.relative(pluginRoot,file),sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
  }}
  await walk(path.join(pluginRoot,'lib'));
  files.push({path:'package.json',sha256:createHash('sha256').update(await readFile(path.join(pluginRoot,'package.json'))).digest('hex')});
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function stageRuntime(id) {
  if(!/^[\w.-]+$/.test(id))throw new Error('Invalid build ID');
  const work=path.join(root,'.mas-build',id);
  const frozen=JSON.parse(await readFile(path.join(work,'frozen.json'),'utf8'));
  // Combination compatibility is owned by the existing release-set preparation.
  const reports=[];
  for(const arch of ['arm64','x64']){
    const relative=frozen.manifests[arch].artifacts.requiredPlugin.target;
    const source=path.join(work,'embedded',arch), dest=path.join(work,'processed',arch);
    const files=await pluginCodeDigests(path.join(source,relative));
    await rm(dest,{recursive:true,force:true});await mkdir(dest,{recursive:true});
    await cp(source,dest,{recursive:true});
    await chmod(path.join(dest,'install-receipt.json'),0o644);
    const resourceBundleNormalization=await normalizeOfficeResourceBundle(dest,arch);
    if(JSON.stringify(files)!==JSON.stringify(await pluginCodeDigests(path.join(dest,relative))))throw new Error('MAS_PLUGIN_COPY_MISMATCH');
    const report={revision:2,credentialServicePrefix:'com.senqisi.dsh-arkme.mas',releaseId:frozen.manifests[arch].releaseId,combinationSha256:frozen.combinationSha256,arch,pluginTarget:relative,pluginCodeUnmodified:true,resourceBundleNormalization,files};
    await writeFile(path.join(dest,'mas-policy.json'),JSON.stringify(report,null,2));reports.push(report);
  }
  await writeFile(path.join(work,'staging-report.json'),JSON.stringify(reports,null,2));
  return reports;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await stageRuntime(process.argv[2]);
