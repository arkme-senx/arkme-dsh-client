import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,symlink,rm,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const hook=require('../scripts/recorder-test-signing.cjs');

describe('recorder test signing discovery',()=>{
 it('finds binaries and nested bundles while excluding text and symlink cycles',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'recorder-signing-'));
  try{
   const bundle=path.join(root,'Helper.app'),framework=path.join(bundle,'Library.framework');
   await mkdir(framework,{recursive:true});
   const binary=path.join(framework,'native.node');
   await writeFile(binary,Buffer.from([0xcf,0xfa,0xed,0xfe,0,0,0,0]));
   await writeFile(path.join(root,'types.d.ts'),'export declare const value: string;');
   const temporary=path.join(root,'old.cstemp');await writeFile(temporary,'old');
   await symlink(root,path.join(framework,'cycle'),process.platform==='win32'?'junction':'dir');
   expect((await hook.boundedSigningWalk(root)).sort()).toEqual([bundle,framework,binary].sort());
   await expect(access(temporary)).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.skipIf(process.platform==='win32')('scans a large real directory under a 64-file descriptor limit',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'recorder-signing-limit-'));
  try{
   for(let i=0;i<512;i++)await writeFile(path.join(root,`entry-${i}.d.ts`),'export declare const value: string;');
   await writeFile(path.join(root,'native.node'),Buffer.from([0xcf,0xfa,0xed,0xfe,0,0,0,0]));
   const builderRequire=createRequire(require.resolve('electron-builder'));
   const signing=createRequire(builderRequire.resolve('app-builder-lib')).resolve('@electron/osx-sign');
   const code=`require(${JSON.stringify(require.resolve('../scripts/recorder-test-signing.cjs'))}).installBoundedSigningWalk();require(${JSON.stringify(signing)}).walkAsync(${JSON.stringify(root)}).then(x=>console.log(JSON.stringify(x)))`;
   const output=execFileSync('/bin/sh',['-c','ulimit -n 64; exec "$@"','recorder-signing-check',process.execPath,'-e',code],{encoding:'utf8'});
   expect(JSON.parse(output)).toEqual([path.join(root,'native.node')]);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
