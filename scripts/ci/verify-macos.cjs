const path=require('node:path');
const {runCommand,validateMacNotarizationTicket}=require('../macos-ci-signing.cjs');
function verifyMacApp(app,env){
 runCommand('codesign',['--verify','--deep','--strict',app],env);
 validateMacNotarizationTicket(app,env);
 runCommand('spctl',['--assess','--type','exec',app],env);
 const details=runCommand('codesign',['-d','--verbose=4',app],env,'combined');
 if(!env.APPLE_TEAM_ID||!details.split(/\r?\n/).includes(`TeamIdentifier=${env.APPLE_TEAM_ID}`))throw new Error('Unexpected signing team');
 if(!/^Authority=Developer ID Application:/m.test(details)||!/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(details))throw new Error('Distribution signature or Hardened Runtime missing');
 const executable=runCommand('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',path.join(app,'Contents/Info.plist')],env,true).trim();
 for(const file of [path.join(app,'Contents/MacOS',executable),path.join(app,'Contents/Frameworks/Electron Framework.framework/Electron Framework'),path.join(app,'Contents/Resources/app.asar.unpacked/node_modules/@arkme/macos-notification-permission/build/Release/arkme_notification_permission.node')]){
  const archs=runCommand('lipo',['-archs',file],env,true).trim().split(/\s+/).sort();
  if(archs.join(' ')!=='arm64 x86_64')throw new Error('Final macOS executable/framework/native module is not Universal');
 }
}
module.exports={verifyMacApp};
if(require.main===module){verifyMacApp(path.resolve(process.argv[2]),process.env);console.log('Final signed Universal app verified')}
