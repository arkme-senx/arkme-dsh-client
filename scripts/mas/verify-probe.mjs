import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const [application, output] = process.argv.slice(2);
if (!application || !output) throw new Error('Usage: verify-probe.mjs <app> <report.json>');
const app = path.resolve(application);
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const plist = file => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]));
const info = plist(path.join(app, 'Contents/Info.plist'));
if (info.CFBundleIdentifier !== 'com.senqisi.Jotmo') throw new Error('Incorrect MAS identity');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const entitlementResult = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], {encoding:'utf8',stdio:['pipe','pipe','pipe']});
const entitlements = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert','json','-o','-','-'], {input:entitlementResult,encoding:'utf8'}));
if (entitlements['com.apple.security.app-sandbox'] !== true) throw new Error('App Sandbox missing');
if (entitlements['com.apple.developer.team-identifier'] !== 'T6NSNA8LDZ') throw new Error('Wrong signature team');
const profileXML = run('/usr/bin/security', ['cms','-D','-i',path.join(app,'Contents/embedded.provisionprofile')]);
const profile = JSON.parse(execFileSync('python3',['-c',"import sys,plistlib,json; p=plistlib.loads(sys.stdin.buffer.read()); print(json.dumps({k:p.get(k) for k in ['Name','UUID','Platform','Entitlements','ExpirationDate']}, default=str))"],{input:profileXML,encoding:'utf8'}));
if (!profile.Platform.includes('OSX') || profile.Entitlements['com.apple.application-identifier'] !== 'T6NSNA8LDZ.com.senqisi.Jotmo') throw new Error('Wrong provisioning profile');
const architectures = run('/usr/bin/lipo', ['-archs', path.join(app,'Contents/MacOS',info.CFBundleExecutable)]).trim();
if (!architectures.includes('arm64') || !architectures.includes('x86_64')) throw new Error('Not Universal');
const resources=path.join(app,'Contents/Resources');
const frozen=JSON.parse(await readFile(path.join(resources,'frozen.json'),'utf8'));
const forbidden=(await readdir(resources)).filter(name=> /app-update|latest-mac|migration/i.test(name));
if(forbidden.length) throw new Error(`Website resources in MAS probe: ${forbidden}`);
await writeFile(output,JSON.stringify({purpose:'architecture-probe-only',application:app,version:info.CFBundleShortVersionString,
  versionCode:info.CFBundleVersion,architectures,signatureVerified:true,entitlements,
  profile:{name:profile.Name,uuid:profile.UUID,expiration:profile.ExpirationDate},
  combinationSha256:frozen.combinationSha256,sandboxRuntimeValidated:false},null,2));
console.log('MAS probe signature, sandbox entitlements, profile and Universal executable verified');
