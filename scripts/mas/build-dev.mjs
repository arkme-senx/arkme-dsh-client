import { stageDependencies } from './stage-dependencies.mjs';
import { mkdir, readFile, writeFile, cp, access, symlink, rm, realpath, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [id,profile]=process.argv.slice(2);
if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id??'') || !profile) throw new Error('Usage: pack:mas:dev <frozen-build-id> <development-profile>');
const work=path.join(root,'.mas-build',id), stage=path.join(work,'client');
function run(bin,args,cwd=root){const r=spawnSync(bin,args,{cwd,stdio:'inherit'});if(r.status!==0)throw new Error(`${bin} failed: ${r.status}`);}
run(process.execPath,[path.join(root,'scripts/mas/prepare.mjs'),'--build-id',id]);
run(process.execPath,[path.join(root,'scripts/mas/stage-runtime.mjs'),id]);
const frozen=JSON.parse(await readFile(path.join(work,'frozen.json'),'utf8'));
await access(profile);
for(const arch of ['arm64','x64']) {
 const policy=JSON.parse(await readFile(path.join(work,'processed',arch,'mas-policy.json'),'utf8'));
 if(policy.revision!==2||policy.combinationSha256!==frozen.combinationSha256) throw new Error('MAS runtime policy staging invalid');
}
await mkdir(stage,{recursive:true});
run(path.join(root,'node_modules/.bin/tsc'),['-p','tsconfig.build.json','--outDir',path.join(stage,'dist')]);
await cp(path.join(root,'src/ui'),path.join(stage,'dist/ui'),{recursive:true});
await writeFile(path.join(stage,'dist/runtime-service-config.json'),JSON.stringify({environment:'prod',serviceBaseUrl:frozen.channel.serviceBaseUrl}));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
await writeFile(path.join(stage,'package.json'),JSON.stringify({name:pkg.name,version:frozen.channel.version,versionCode:frozen.channel.versionCode,type:'module',main:'mas-bootstrap.cjs',description:'即我',author:pkg.author,dependencies:{}},null,2));
await cp(path.join(root,'build/mas/bootstrap.cjs'),path.join(stage,'mas-bootstrap.cjs'));
await rm(path.join(stage,'node_modules'),{force:true,recursive:true});
await stageDependencies(root,path.join(work,'client-dependencies'),Object.keys({...pkg.dependencies,...pkg.optionalDependencies}));
const headers=path.join(process.env.HOME,'.electron-gyp',frozen.channel.electronVersion,'include/node');
await access(path.join(headers,'node_api.h'));
const native=await realpath(path.join(work,'client-dependencies/@arkme/macos-notification-permission'));
run('/usr/bin/clang++',['-arch','arm64','-arch','x86_64','-mmacosx-version-min=12.0','-std=c++20','-fobjc-arc','-DNAPI_VERSION=4','-bundle','-undefined','dynamic_lookup','-I',headers,'-framework','Foundation','-framework','UserNotifications',path.join(root,'native/macos-notification-permission/src/notification_permission.mm'),'-o',path.join(native,'build/Release/arkme_notification_permission.node')]);

const output=path.join(root,'release-mas',id,'client'),finalOutput=path.join(output,'mas-dev-universal');
const hook=path.join(work,'client-after-pack.cjs');
await writeFile(hook,`const fs=require('node:fs/promises'),path=require('node:path');module.exports=async ctx=>{
if(path.resolve(ctx.appOutDir)!==${JSON.stringify(finalOutput)})return;
const r=path.join(ctx.appOutDir,'arkme.app','Contents/Resources');
await fs.cp(${JSON.stringify(path.join(work,'client-dependencies'))},path.join(r,'app','node_modules'),{recursive:true,verbatimSymlinks:true});
await fs.cp(${JSON.stringify(path.join(work,'processed'))},path.join(r,'embedded'),{recursive:true});
await fs.copyFile(${JSON.stringify(path.join(work,'frozen.json'))},path.join(r,'frozen.json'));
await fs.writeFile(path.join(r,'jiwo-mas.json'),${JSON.stringify(JSON.stringify({...frozen.channel,policyRevision:2}))});
await (await import(${JSON.stringify('file://' + path.join(root,'scripts/mas/pack-client.mjs'))})).packClient(r);
};`);
const req=createRequire(path.join(root,'package.json')), br=createRequire(req.resolve('electron-builder')), lr=createRequire(br.resolve('app-builder-lib'));
const signHook=path.join(work,'client-sign.cjs');
await writeFile(signHook,`const {signAsync}=require(${JSON.stringify(lr.resolve('@electron/osx-sign'))});module.exports=options=>signAsync({...options,identity:'73ED76D4647DC9A567C382CE60156F085C71F51B',identityValidation:false});`);
const config={extends:null,appId:frozen.channel.appId,productName:'即我',executableName:'arkme',electronVersion:frozen.channel.electronVersion,npmRebuild:false,asar:false,asarUnpack:['dist/preload.cjs','dist/harness-process-lifetime.js','**/*.node','**/*.dylib'],directories:{app:stage,output},files:['dist/**/*','package.json','mas-bootstrap.cjs'],publish:null,afterPack:hook,electronLanguages:['en-US','zh-CN'],
 mac:{minimumSystemVersion:'12.0',bundleVersion:String(frozen.channel.versionCode),icon:path.join(root,'build/icon.icns'),category:'public.app-category.productivity',mergeASARs:true,x64ArchFiles:'**/{*darwin-arm64*,*darwin-x64*}/**/*',extendInfo:{NSMicrophoneUsageDescription:'即我需要麦克风权限进行录音。',NSLocationUsageDescription:'即我在你开启位置记录后使用当前位置。'}},
 masDev:{sign:signHook,identity:'Apple Development: richard chou (6Q3VB9R2RR)',provisioningProfile:path.resolve(profile),type:'development',hardenedRuntime:false,entitlements:path.join(root,'build/mas/entitlements.dev.plist'),entitlementsInherit:path.join(root,'build/mas/entitlements.inherit.plist')}};
const cfg=path.join(work,'client-builder.json');await writeFile(cfg,JSON.stringify(config,null,2));
run(path.join(root,'node_modules/.bin/electron-builder'),['--projectDir',stage,'--config',cfg,'--mac','mas-dev','--universal','--publish','never'],stage);
const finalApp=path.join(finalOutput,'即我.app');
await rm(finalApp,{recursive:true,force:true});
await rename(path.join(finalOutput,'arkme.app'),finalApp);
console.log('MAS development app:',finalApp);
