import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {normalizeOfficeResourceBundle,verifyNestedApplications,verifyOfficeResourceBundle} from '../../scripts/mas/resource-bundles.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
it('rejects the stripped nested app and preserves resources while updating engine metadata',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mas-office-'));
 try{
  await mkdir(path.join(dir,'Contents/MacOS'),{recursive:true});
  await writeFile(path.join(dir,'Contents/Info.plist'),JSON.stringify({CFBundleExecutable:'host'}));
  await writeFile(path.join(dir,'Contents/MacOS/host'),'host',{mode:0o755});
  const root=path.join(dir,'harness/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64');
  const prefix='program/LibreOfficeDev.app/Contents';
  await mkdir(path.join(root,prefix,'Resources'),{recursive:true});await mkdir(path.join(root,'bin'));
  const assets={[`${prefix}/Info.plist`]:JSON.stringify({CFBundleExecutable:'soffice',CFBundlePackageType:'APPL',CFBundleVersion:'26.8.0.3',CFBundleShortVersionString:'26.8.0.3'}),[`${prefix}/PkgInfo`]:'APPL????',[`${prefix}/Resources/bootstraprc`]:'original resource bytes','bin/libreoffice-kit':'original engine bytes'};
  for(const [file,bytes] of Object.entries(assets))await writeFile(path.join(root,file),bytes);
  await writeFile(path.join(root,'package.json'),JSON.stringify({version:'0.1.5'}));
  await writeFile(path.join(root,'prebuilds.json'),JSON.stringify({engine:{executable:'bin/libreoffice-kit',programDirectory:`${prefix}/Resources`},files:Object.fromEntries(Object.entries(assets).map(([f,b])=>[f,hash(b)]))}));
  await expect(verifyNestedApplications(dir)).rejects.toThrow('Bad CFBundleExecutable');
  await writeFile(path.join(root,'bin/libreoffice-kit'),'unexpected modified engine');
  await expect(normalizeOfficeResourceBundle(dir,'arm64')).rejects.toThrow('asset mismatch');
  await access(path.join(root,'program/LibreOfficeDev.app'));
  await writeFile(path.join(root,'bin/libreoffice-kit'),'original engine bytes');
  const normalization=await normalizeOfficeResourceBundle(dir,'arm64');
  expect((await verifyOfficeResourceBundle(dir,'arm64',normalization)).resourceBundleVerified).toBe(true);
  await expect(access(path.join(root,'program/LibreOfficeDev.app'))).rejects.toThrow();
  expect(await readFile(path.join(root,'program/LibreOfficeResources.bundle/Contents/Resources/bootstraprc'),'utf8')).toBe('original resource bytes');
  const manifest=JSON.parse(await readFile(path.join(root,'prebuilds.json'),'utf8'));
  expect(manifest.engine.programDirectory).toContain('LibreOfficeResources.bundle');
  for(const [file,digest] of Object.entries(manifest.files))expect(hash(await readFile(path.join(root,file)))).toBe(digest);
  expect(await readFile(path.join(root,'bin/libreoffice-kit'),'utf8')).toBe('original engine bytes');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('rejects application declarations with a missing or non-executable entry point',async()=>{
 const app=await mkdtemp(path.join(tmpdir(),'mas-app-'));
 try{
  await mkdir(path.join(app,'Contents/MacOS'),{recursive:true});
  await writeFile(path.join(app,'Contents/Info.plist'),JSON.stringify({CFBundleExecutable:'missing'}));
  await expect(verifyNestedApplications(app)).rejects.toThrow('missing');
  await writeFile(path.join(app,'Contents/MacOS/missing'),'x',{mode:0o644});
  await expect(verifyNestedApplications(app)).rejects.toThrow('not executable');
 }finally{await rm(app,{recursive:true,force:true});}
});
