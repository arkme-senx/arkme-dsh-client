import { createPackageWithOptions } from '@electron/asar';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
export async function packClient(resources) {
 const source=path.join(resources,'app');
 await access(path.join(source,'package.json'));
 await rm(path.join(resources,'app.asar'),{force:true});
 await rm(path.join(resources,'app.asar.unpacked'),{recursive:true,force:true});
 await createPackageWithOptions(source,path.join(resources,'app.asar'),{
  unpack:'**/{preload.cjs,harness-process-lifetime.js,*.node,*.dylib}'
 });
 for(const file of ['dist/preload.cjs','dist/harness-process-lifetime.js']) await access(path.join(resources,'app.asar.unpacked',file));
 await rm(source,{recursive:true});
}
