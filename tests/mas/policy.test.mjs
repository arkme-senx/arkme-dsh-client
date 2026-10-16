import {it,expect} from 'vitest';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pluginCodeDigests} from '../../scripts/mas/stage-runtime.mjs';
it('records plugin code integrity without requiring additional compatibility metadata',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mas-policy-'));
 try{
  await mkdir(path.join(dir,'lib'));await writeFile(path.join(dir,'lib/index.js'),'export const code = "unchanged";');
  await writeFile(path.join(dir,'package.json'),'{}');const before=await pluginCodeDigests(dir);
  expect(await pluginCodeDigests(dir)).toEqual(before);
  expect(await readFile(path.join(dir,'lib/index.js'),'utf8')).toBe('export const code = "unchanged";');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('keeps website build commands independent',async()=>{
 const p=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
 expect(p.scripts.dist).toBe('node scripts/build-macos-artifacts.mjs');expect(p.scripts['dist:win']).not.toContain('mas');
});
