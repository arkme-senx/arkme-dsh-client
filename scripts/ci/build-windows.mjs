// Preserve production migration hooks; test identity must never run production migration.
if(process.env.ARKME_CI_ENV==='prod')await import('../build-windows-artifacts.mjs');
else if(process.env.ARKME_CI_ENV==='test'){
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);const {build,Platform,Arch}=require('electron-builder');const path=await import('node:path');const config=require('../../electron-builder.ci-config.cjs');config.extends=path.resolve('electron-builder.cjs');
 await build({targets:Platform.WINDOWS.createTarget(['nsis','zip'],Arch.x64),config,publish:'never'});
}else throw new Error('Unknown CI environment');
