// Execute only the production pure scope selector: no registry writes, UAC or installation.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const compiler=process.env.ARKME_TEST_MAKENSIS;
if (!compiler || process.platform !== 'win32') throw new Error('Windows NSIS toolset required');
const root=mkdtempSync(path.join(tmpdir(),'jiwo-scope-test-'));
try {
 const source=readFileSync('build/windows-migration.nsh','utf8');
 const macro=source.match(/!macro windowsMigrationChooseScope[^]*?!macroend/)[0];
 const cases=[
  ['new user','','','','',''],
  ['Flutter all only','','','','D:/jotmo','all'],
  ['Flutter user only','','','C:/Users/test/jotmo','','current'],
  ['Arkme user only','C:/Users/test/arkme','','','','current'],
  ['Arkme all only','','D:/arkme','','','all'],
  ['Arkme user Flutter all','C:/Users/test/arkme','','','D:/jotmo','current'],
  ['Arkme all Flutter user','','D:/arkme','C:/Users/test/jotmo','','all'],
  ['both user','C:/Users/test/arkme','','C:/Users/test/jotmo','','current'],
  ['both all','','D:/arkme','','D:/jotmo','all'],
 ];
 const checks=cases.map(([name,user,machine,flutterUser,flutterAll,expected],i)=>`!insertmacro windowsMigrationChooseScope "${user}" "${machine}" "${flutterUser}" "${flutterAll}" $R7\nStrCmp $R7 "${expected}" +3\nSetErrorLevel ${i+1}\nQuit`).join('\n');
 const exe=path.join(root,'scope.exe'),nsi=path.join(root,'scope.nsi');
 writeFileSync(nsi,`Unicode true\nName "Scope logic test"\nOutFile "${exe}"\nRequestExecutionLevel user\nSilentInstall silent\n!include LogicLib.nsh\n${macro}\nSection\n${checks}\nSetErrorLevel 0\nSectionEnd\n`);
 execFileSync(compiler,['-V2',nsi],{encoding:'utf8'});
 execFileSync(exe,[],{timeout:15000});
 console.log(`Scope matrix passed: ${cases.length} scenarios`);
} finally {rmSync(root,{recursive:true,force:true});}
