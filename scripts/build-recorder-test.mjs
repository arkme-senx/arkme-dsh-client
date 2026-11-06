import {spawn,execFileSync} from 'node:child_process';
import {access,mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const clientMetadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const clientCommit=process.env.GITHUB_SHA || execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const plugin=path.resolve(process.env.ARKME_RUNTIME_LOCAL_PLUGIN_DIR || '../plugin');
const arch=process.env.ARKME_RUNTIME_ARCH || process.arch;
if(!['darwin','win32'].includes(process.platform) || arch!==process.arch)throw new Error('Build each recorder test package on its matching native OS/architecture');
const metadata=JSON.parse(await readFile(path.join(plugin,'package.json'),'utf8'));
if(metadata.name!=='@senguoyun/dsh-arkme')throw new Error('Wrong recorder plugin');
await access(path.join(plugin,'lib','index.js'));await access(path.join(plugin,'lib','client.js'));
const env={...process.env,GITHUB_SHA:clientCommit,ARKME_RUNTIME_LOCAL_PLUGIN_DIR:plugin,ARKME_RUNTIME_ARCH:arch,ARKME_SKIP_PREPARE_BUILD:'true',
  CSC_IDENTITY_AUTO_DISCOVERY:'false',ARKME_RUNTIME_SERVICE_BASE_URL:'https://api.jotmo.cc'};
for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','CSC_NAME','CSC_INSTALLER_LINK','CSC_INSTALLER_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID'])delete env[key];
await run('pnpm',['run','build']);
await run(process.execPath,['scripts/prepare-runtime.mjs']);
const runtime=path.join(root,'.runtime',`dsh-${arch}`,'node_modules');
await run(require('electron'),['--input-type=module','--eval',`const {SerialPort}=await import(${JSON.stringify(pathToFileURL(path.join(runtime,'serialport','dist','index.js')).href)});console.log(JSON.stringify({electron:process.versions.electron,serialPortLoaded:true,portCount:(await SerialPort.list()).length}))`],{ELECTRON_RUN_AS_NODE:'1'});
const builder=require.resolve('electron-builder/cli.js');
await run(process.execPath,[builder,'--config','electron-builder.recorder-test.cjs',process.platform==='darwin'?'--mac':'--win',`--${arch}`,'--publish','never']);
const out=path.join(root,'release-recorder-test');
if(process.platform==='darwin'){
  const app=path.join(out,`mac${arch==='arm64'?'-arm64':''}`,'arkme Local Test.app');
  await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
}
const files=[];
for(const name of await readdir(out)){
 const file=path.join(out,name);if(!(await stat(file)).isFile() || !/\.(dmg|zip|exe)$/.test(name))continue;
 files.push({file:name,size:(await stat(file)).size,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
}
await writeFile(path.join(out,`recorder-test-${process.platform}-${arch}.json`),JSON.stringify({schemaVersion:1,
  app:'arkme Local Test',environment:'prod',dataDirectory:'Arkme Recorder Test',independentLogin:true,
  clientVersion:clientMetadata.version,clientVersionCode:clientMetadata.versionCode,clientCommit,
  pluginVersion:metadata.version,pluginCommit:process.env.ARKME_RECORDER_PLUGIN_COMMIT,platform:process.platform,arch,files},null,2)+'\n');
console.log(JSON.stringify({output:out,files}));

async function run(command,args,extraEnv={}){
 const isPnpm=command==='pnpm';
 const actual=isPnpm&&process.platform==='win32'?'pnpm.cmd':command;
 await new Promise((resolve,reject)=>{
  const child=spawn(actual,args,{cwd:root,env:{...env,...extraEnv},stdio:'inherit',shell:isPnpm&&process.platform==='win32'});
  child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} failed: ${signal??code}`)));
 });
}
