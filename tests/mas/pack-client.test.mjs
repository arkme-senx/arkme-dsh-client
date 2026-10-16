import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {extractFile,statFile} from '@electron/asar';
import {packClient} from '../../scripts/mas/pack-client.mjs';
it('creates website-compatible ASAR paths and replaces stale unpacked output',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mas-asar-'));
 try{
  await mkdir(path.join(root,'app/dist'),{recursive:true});
  await mkdir(path.join(root,'app/node_modules/example'),{recursive:true});
  await mkdir(path.join(root,'app.asar.unpacked/dist'),{recursive:true});
  await writeFile(path.join(root,'app.asar.unpacked/dist/preload.cjs'),'stale');
  await writeFile(path.join(root,'app/package.json'),'{}');
  await writeFile(path.join(root,'app/dist/preload.cjs'),'module.exports = {};');
  await writeFile(path.join(root,'app/dist/harness-process-lifetime.js'),'export {};');
  await writeFile(path.join(root,'app/node_modules/example/index.js'),'module.exports=1;');
  await packClient(root);
  expect(await readFile(path.join(root,'app.asar.unpacked/dist/preload.cjs'),'utf8')).toBe('module.exports = {};');
  expect(extractFile(path.join(root,'app.asar'),'node_modules/example/index.js').toString()).toBe('module.exports=1;');
  expect(statFile(path.join(root,'app.asar'),'node_modules/example',false).link).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
