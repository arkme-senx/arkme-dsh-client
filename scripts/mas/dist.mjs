// Promote an already verified MAS development sample without resolving a new release-set.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareReceiptPermissions,verifyBundlePermissions} from './permissions.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [id,profileArg]=process.argv.slice(2);
if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id??'')||!profileArg)throw Error('Usage: dist:mas <verified-build-id> <store-profile>');
const appIdentity=process.env.MAS_APP_IDENTITY,installerIdentity=process.env.MAS_INSTALLER_IDENTITY;
if(!/^[A-Fa-f0-9]{40}$/.test(appIdentity??'')||!/^[A-Fa-f0-9]{40}$/.test(installerIdentity??''))throw Error('Set MAS_APP_IDENTITY and MAS_INSTALLER_IDENTITY to certificate SHA-1 fingerprints');
const profile=path.resolve(profileArg),out=path.join(root,'release-mas',id,'testflight');
const source=path.join(root,'release-mas',id,'client/mas-dev-universal/即我.app');
const work=path.join(root,'.mas-build',id,'testflight');
const run=(bin,args)=>execFileSync(bin,args,{encoding:'utf8',maxBuffer:16*1024*1024});
const plist=file=>JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',file]));
const verified=JSON.parse(await readFile(path.join(root,'release-mas',id,'verification.json'),'utf8'));
if(!verified.signatureVerified||!verified.sandboxRuntimeValidated)throw Error('A signed sandbox-validated development sample is required');
const profileXml=run('/usr/bin/security',['cms','-D','-i',profile]);
const pp=JSON.parse(execFileSync('/usr/bin/python3',['-c',`import sys,plistlib,json,hashlib
p=plistlib.loads(sys.stdin.buffer.read())
p['DeveloperCertificates']=[hashlib.sha1(c).hexdigest().upper() for c in p['DeveloperCertificates']]
print(json.dumps(p,default=str))`],{input:profileXml,encoding:'utf8'}));
if(!pp.Platform?.includes('OSX')||pp.ProvisionedDevices||pp.ProvisionsAllDevices||pp.Entitlements?.['com.apple.application-identifier']!=='T6NSNA8LDZ.com.senqisi.Jotmo'||!pp.DeveloperCertificates.includes(appIdentity.toUpperCase())||Date.parse(pp.ExpirationDate)<Date.now())throw Error('Store profile does not match this signing identity/application');
const identities=run('/usr/bin/security',['find-identity','-v','-p','basic']);
for(const identity of [appIdentity,installerIdentity])if(!identities.includes(identity.toUpperCase()))throw Error('Signing identity unavailable: '+identity);
run('/usr/bin/codesign',['--verify','--deep','--strict',source]);
const frozen=JSON.parse(await readFile(path.join(source,'Contents/Resources/frozen.json'),'utf8'));
if(frozen.combinationSha256!==verified.combinationSha256)throw Error('Verified combination mismatch');
const info=plist(path.join(source,'Contents/Info.plist'));
await mkdir(work,{recursive:true});await mkdir(out,{recursive:true});
const app=path.join(out,'即我.app');
try{await access(app);throw Error('TestFlight output already exists; use a clean reviewed output directory')}catch(e){if(e.code!=='ENOENT')throw e;}
console.log('Copying verified MAS sample');run('/usr/bin/ditto',[source,app]);
await prepareReceiptPermissions(path.join(app,'Contents/Resources/embedded'));
await verifyBundlePermissions(app);
// Remove the development profile before osx-sign embeds the store profile.
const {rm}=await import('node:fs/promises');await rm(path.join(app,'Contents/embedded.provisionprofile'));
const req=createRequire(path.join(root,'package.json')),br=createRequire(req.resolve('electron-builder')),lr=createRequire(br.resolve('app-builder-lib'));
const {signAsync}=lr('@electron/osx-sign');
console.log('Signing MAS distribution application');
await signAsync({app,platform:'mas',type:'distribution',identity:appIdentity,identityValidation:false,provisioningProfile:profile,version:frozen.channel.electronVersion,
 optionsForFile:file=>({entitlements:path.join(root,'build/mas',path.resolve(file)===app?'entitlements.dev.plist':'entitlements.inherit.plist'),hardenedRuntime:false})});
const verification=path.join(out,'verification.json');
console.log(run(process.execPath,[path.join(root,'scripts/mas/verify-dev.mjs'),app,verification]));
const ent=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:execFileSync('/usr/bin/codesign',['-d','--entitlements',':-',app],{encoding:'utf8',stdio:['pipe','pipe','pipe']}),encoding:'utf8'}));
if(ent['get-task-allow']||ent['com.apple.security.get-task-allow'])throw Error('Debug entitlement in store application');
const embedded=await readFile(path.join(app,'Contents/embedded.provisionprofile'));
if(!embedded.equals(await readFile(profile)))throw Error('Embedded profile mismatch');
const appAsar=await readFile(path.join(app,'Contents/Resources/app.asar'));
if(!appAsar.equals(await readFile(path.join(source,'Contents/Resources/app.asar'))))throw Error('Client code changed during promotion');
const pkg=path.join(out,`即我-MAS-TestFlight-${info.CFBundleShortVersionString}-vc${info.CFBundleVersion}-universal.pkg`);
console.log('Signing TestFlight installer');run('/usr/bin/productbuild',['--component',app,'/Applications','--sign',installerIdentity,pkg]);
const pkgSignature=run('/usr/sbin/pkgutil',['--check-signature',pkg]);
if(!pkgSignature.includes('T6NSNA8LDZ')||!pkgSignature.includes('3rd Party Mac Developer Installer'))throw Error('Wrong installer signature');
const bytes=await readFile(pkg);const report={...JSON.parse(await readFile(verification,'utf8')),purpose:'testflight-distribution',sandboxRuntimeValidated:false,developmentSampleRuntimeValidated:true,profile:{name:pp.Name,uuid:pp.UUID,expiration:pp.ExpirationDate},applicationIdentity:appIdentity,installerIdentity,clientCodeUnmodified:true,pkg,pkgSize:bytes.length,pkgSha256:createHash('sha256').update(bytes).digest('hex'),pkgSignature,uploaded:false,appStoreConnectBuildNumberChecked:false};
await writeFile(verification,JSON.stringify(report,null,2));console.log(JSON.stringify({pkg,sha256:report.pkgSha256,size:bytes.length}));
