import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {stageDependencies} from '../../scripts/mas/stage-dependencies.mjs';
it('materializes transitive dependencies without a path back to the workspace',async()=>{
 const tmp=await mkdtemp(path.join(tmpdir(),'mas-deps-')),source=path.join(tmp,'source'),dest=path.join(tmp,'stage/node_modules');
 try{
  await mkdir(path.join(source,'node_modules/a/node_modules'),{recursive:true});
  await mkdir(path.join(source,'store/b'),{recursive:true});
  await writeFile(path.join(source,'package.json'),'{}');
  await writeFile(path.join(source,'node_modules/a/package.json'),JSON.stringify({name:'a',main:'index.js',dependencies:{b:'1.0.0'}}));
  await writeFile(path.join(source,'node_modules/a/index.js'),"module.exports=require('b');");
  await writeFile(path.join(source,'store/b/package.json'),JSON.stringify({name:'b',version:'1.0.0',main:'index.js'}));
  await writeFile(path.join(source,'store/b/index.js'),"module.exports='frozen';");
  await symlink(path.join(source,'store/b'),path.join(source,'node_modules/a/node_modules/b'));
  await stageDependencies(source,dest,['a']);
  const actual=await realpath(path.join(dest,'a/node_modules/b'));
  expect(actual.startsWith(await realpath(dest)+path.sep)).toBe(true);
  expect(createRequire(path.join(tmp,'stage/package.json'))('a')).toBe('frozen');
 }finally{await rm(tmp,{recursive:true,force:true});}
});
