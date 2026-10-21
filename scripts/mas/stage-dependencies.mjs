import { readFile, realpath, mkdir, cp, symlink, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
export async function stageDependencies(root, destination, names) {
 await rm(destination,{recursive:true,force:true}); await mkdir(destination,{recursive:true});
 const seen=new Map();
 async function locate(name, parent) {
  const req=createRequire(path.join(parent,'package.json'));
  for(const base of req.resolve.paths('__mas_dependency_lookup__')??[]) {
   try {const dir=await realpath(path.join(base,name));await readFile(path.join(dir,'package.json'));return dir;}catch{}
  }
  throw new Error(`Missing production dependency ${name} from ${parent}`);
 }
 async function add(name,parent,links,optional=false) {
  let original;try{original=await locate(name,parent);}catch(e){if(optional)return;throw e;}
  let dest=seen.get(original);
  if(!dest){
   dest=path.join(destination,'.mas-store',createHash('sha256').update(original).digest('hex').slice(0,16),name);
   seen.set(original,dest);await mkdir(path.dirname(dest),{recursive:true});
   await cp(original,dest,{recursive:true,filter:source=>source===original||!path.relative(original,source).split(path.sep).includes('node_modules')});
   const p=JSON.parse(await readFile(path.join(original,'package.json'),'utf8'));
   for(const dependency of Object.keys({...p.dependencies,...p.optionalDependencies})) await add(dependency,original,path.join(dest,'node_modules'),dependency in (p.optionalDependencies??{}));
  }
  const link=path.join(links,name);await mkdir(path.dirname(link),{recursive:true});
  await symlink(path.relative(path.dirname(link),dest),link);
 }
 for(const name of names) await add(name,root,destination);
 // ASAR's ESM resolver must not depend on pnpm-like directory symlinks.
 const flat=destination+'.flat';await rm(flat,{recursive:true,force:true});await mkdir(flat,{recursive:true});
 for(const name of names){const target=path.join(flat,name);await mkdir(path.dirname(target),{recursive:true});await cp(path.join(destination,name),target,{recursive:true,dereference:true});}
 await rm(destination,{recursive:true});await rename(flat,destination);
 return seen.size;
}
