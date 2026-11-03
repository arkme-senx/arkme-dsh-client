import {test,expect} from 'vitest';
import {createRequire} from 'node:module';
const {runCommand}=createRequire(import.meta.url)('../scripts/macos-ci-signing.cjs');
test('signature detail verification captures codesign stderr without changing stdout-only callers',()=>{
 const args=['-e','process.stdout.write("metadata\\n");process.stderr.write("TeamIdentifier=TESTTEAM01\\n")'];
 expect(runCommand(process.execPath,args,process.env,'combined')).toContain('TeamIdentifier=TESTTEAM01');
 expect(runCommand(process.execPath,args,process.env,true)).not.toContain('TeamIdentifier');
});
