const path=require('node:path');const {readdir,writeFile}=require('node:fs/promises');const {withMacCiSigningEnvironment,runCommand,runLoggedCommand,createMacCiLogRedactor}=require('../macos-ci-signing.cjs');
const {verifyMacApp:verify}=require('./verify-macos.cjs');
withMacCiSigningEnvironment(process.env,async(env,temp)=>{
 await runLoggedCommand('pnpm',['exec','electron-builder','--config','electron-builder.ci-config.cjs','--mac','zip','--universal','--publish','never'],env);
 const config=require('../../electron-builder.ci-config.cjs');const name=config.productName+'.app';await verify(path.join('release-ci','mac-universal',name),env);
 const {buildCIMacPackage}=await import('./build-macos-pkg.mjs');
 const pkg=await buildCIMacPackage(path.join('release-ci','mac-universal',name),env,temp);
 const signature=runCommand('pkgutil',['--check-signature',pkg],env,true);
 if(!signature.includes('Developer ID Installer:')||!signature.includes(`(${env.APPLE_TEAM_ID})`))throw new Error('Unexpected PKG signing identity');
 runCommand('xcrun',['stapler','validate',pkg],env);runCommand('spctl',['--assess','--type','install',pkg],env);
 const {verifyMacReleasePair,verifyPairedMacUpdateMetadata}=await import('../macos-release-pair.mjs');
 const manifest=require('../../package.json');const report=await verifyMacReleasePair({appRoot:path.join('release-ci','mac-universal',name),releaseDirectory:'release-ci',version:manifest.version,versionCode:manifest.versionCode,test:env.ARKME_CI_ENV==='test'});
 const {readFile}=require('node:fs/promises');const YAML=require('yaml');verifyPairedMacUpdateMetadata(YAML.parse(await readFile('release-ci/latest-mac.yml','utf8')),report);
 const files=await readdir('release-ci');const zip=files.find(f=>f.endsWith('.zip'));if(!zip)throw new Error('Missing macOS ZIP');
 const unpack=path.join(temp,'zip-check');runCommand('ditto',['-x','-k',path.join('release-ci',zip),unpack],env);await verify(path.join(unpack,name),env);await writeFile('release-ci/signing-evidence.json',JSON.stringify({verified:true,notarized:true,team_id:env.APPLE_TEAM_ID}));
}).catch(e=>{console.error(createMacCiLogRedactor()(e.message));process.exitCode=1});
