// LibreOfficeKit ships a headless engine plus resources in a stripped GUI app.
// Normalize that resource container without changing engine or SDK JavaScript.
import {readFile, writeFile, rename, readdir, stat, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const plist=file=>JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',file],{encoding:'utf8'}));
export async function normalizeOfficeResourceBundle(runtime, arch) {
 const root=path.join(runtime,'harness/node_modules/@deepseek-ai',`libreoffice-kit-darwin-${arch}`);
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 const manifestPath=path.join(root,'prebuilds.json');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 const oldPrefix='program/LibreOfficeDev.app',newPrefix='program/LibreOfficeResources.bundle';
 if(pkg.version!=='0.1.5'||manifest.engine?.programDirectory!==`${oldPrefix}/Contents/Resources`||manifest.engine?.executable!=='bin/libreoffice-kit')throw Error('Unknown LibreOfficeKit layout; review before normalizing');
 const source=path.join(root,oldPrefix), infoPath=path.join(source,'Contents/Info.plist');
 const info=plist(infoPath);
 if(info.CFBundleExecutable!=='soffice'||info.CFBundlePackageType!=='APPL')throw Error('Unexpected LibreOffice app metadata');
 try{await access(path.join(source,'Contents/MacOS'));throw Error('LibreOffice bundle contains executable directory; refusing resource conversion')}catch(e){if(e.code!=='ENOENT')throw e;}
 // Validate all original assets before changing their container and manifest paths.
 for(const [file,digest] of Object.entries(manifest.files))if(hash(await readFile(path.join(root,file)))!==digest)throw Error(`LibreOffice asset mismatch: ${file}`);
 await rename(source,path.join(root,newPrefix));
 const normalizedInfo=path.join(root,newPrefix,'Contents/Info.plist');
 await writeFile(normalizedInfo,JSON.stringify({CFBundleIdentifier:'com.senqisi.Jotmo.libreoffice-resources',CFBundleName:'LibreOfficeResources',CFBundlePackageType:'BNDL',CFBundleVersion:pkg.version,CFBundleShortVersionString:pkg.version}));
 execFileSync('/usr/bin/plutil',['-convert','xml1',normalizedInfo]);
 await writeFile(path.join(root,newPrefix,'Contents/PkgInfo'),'BNDL????');
 const files={};
 for(const [file,digest] of Object.entries(manifest.files)){
  const target=file.startsWith(oldPrefix+'/')?newPrefix+file.slice(oldPrefix.length):file;
  files[target]=/\/Contents\/(Info.plist|PkgInfo)$/.test(file)?hash(await readFile(path.join(root,target))):digest;
 }
 manifest.files=files;manifest.engine.programDirectory=`${newPrefix}/Contents/Resources`;
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 return {arch,packageVersion:pkg.version,from:oldPrefix,to:newPrefix,engineExecutableUnmodified:true,resourceFilesUnmodified:true,manifestSha256:hash(await readFile(manifestPath))};
}
export async function verifyNestedApplications(app) {
 const applications=[path.resolve(app)];
 for(const entry of await readdir(app,{recursive:true,withFileTypes:true}))if(entry.isDirectory()&&entry.name.endsWith('.app'))applications.push(path.join(entry.parentPath,entry.name));
 const checked=[];
 for(const bundle of applications){
  const info=plist(path.join(bundle,'Contents/Info.plist'));
  const executable=info.CFBundleExecutable;
  if(typeof executable!=='string'||!executable||path.basename(executable)!==executable)throw Error(`Bad CFBundleExecutable: ${bundle}`);
  const target=path.join(bundle,'Contents/MacOS',executable);
  let status;try{status=await stat(target)}catch{throw Error(`Bad CFBundleExecutable: missing ${target}`)}
  if(!status.isFile()||!(status.mode&0o111))throw Error(`Bad CFBundleExecutable: not executable ${target}`);
  checked.push(path.relative(app,bundle)||'.');
 }
 return checked;
}

export async function verifyOfficeResourceBundle(runtime, arch, normalization) {
 const root=path.join(runtime,'harness/node_modules/@deepseek-ai',`libreoffice-kit-darwin-${arch}`);
 const bytes=await readFile(path.join(root,'prebuilds.json'));
 if(!normalization||normalization.arch!==arch||normalization.manifestSha256!==hash(bytes))throw Error('LibreOffice resource normalization receipt mismatch');
 const manifest=JSON.parse(bytes);
 if(manifest.engine.programDirectory!=='program/LibreOfficeResources.bundle/Contents/Resources')throw Error('LibreOffice resource path mismatch');
 await access(path.join(root,manifest.engine.programDirectory));
 await access(path.join(root,manifest.engine.executable));
 // Native code gains a signing envelope; resource bytes must still match staging.
 for(const [file,digest] of Object.entries(manifest.files))if(file!==manifest.engine.executable&&hash(await readFile(path.join(root,file)))!==digest)throw Error(`LibreOffice resource changed: ${file}`);
 const info=plist(path.join(root,'program/LibreOfficeResources.bundle/Contents/Info.plist'));
 if(info.CFBundlePackageType!=='BNDL'||info.CFBundleExecutable)throw Error('LibreOffice resources incorrectly declare an application');
 if(info.CFBundleShortVersionString!==normalization.packageVersion||info.CFBundleVersion!==normalization.packageVersion)throw Error('LibreOffice resource bundle version mismatch');
 return {arch,resourceBundleVerified:true,manifestSha256:hash(bytes)};
}
