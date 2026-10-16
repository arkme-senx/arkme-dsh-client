import { describe,it,expect } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMasChannel } from '../../src/mas/runtime.js';
describe('signed channel separation',()=>{
 it('fails closed without marker in MAS but leaves website unchanged',()=>{
  const p=mkdtempSync(path.join(tmpdir(),'jiwo-mas-'));
  try {expect(isMasChannel(p,true,false)).toBe(false);expect(()=>isMasChannel(p,true,true)).toThrow('MAS_CHANNEL_MISSING');
   writeFileSync(path.join(p,'jiwo-mas.json'),JSON.stringify({schemaVersion:1,distribution:'mas',environment:'prod',policyRevision:2,appId:'com.senqisi.Jotmo'}));
   expect(isMasChannel(p,true,true)).toBe(true);expect(()=>isMasChannel(p,true,false)).toThrow('MAS_CHANNEL_INVALID');
  }finally{rmSync(p,{recursive:true,force:true});}
 });
});
