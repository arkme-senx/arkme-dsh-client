import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {test,expect} from 'vitest';
test.skipIf(process.platform!=='darwin')('macOS diagnostics redact before disk/network and retry without changing installation',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'jiwo-diagnostics-'));
 try {
  const binary=path.join(root,'diagnostics');
  execFileSync('/usr/bin/xcrun',['swiftc','-module-cache-path',path.join(root,'modules'),'build/macos-migration/Diagnostics.swift','tests/fixtures/installer-diagnostics/main.swift','-o',binary],{timeout:120000});
  expect(execFileSync(binary,[root],{encoding:'utf8',timeout:10000})).toContain('privacy and retry fixtures passed');
 } finally {rmSync(root,{recursive:true,force:true})}
},150000);
test('reporting runs after Windows recovery and macOS records no login identity',()=>{
 const win=readFileSync('build/windows-migration.ps1','utf8');
 expect(win.lastIndexOf('Complete-InstallerDiagnostic $diagnosticResult')).toBeGreaterThan(win.indexOf("$diagnosticRecovery='completed'"));
 expect(win).toContain('$request.Wait(1500)');
 expect(win).toContain('$handler.AllowAutoRedirect=$false');
 const nsis=readFileSync('build/windows-migration.nsh','utf8');
 const nativeFailure=nsis.split('Function .onInstFailed')[1]?.split('${EndIf}\n  ${If} $JiwoMigrationDestination !=')[0];
 expect(nativeFailure).toBeDefined();
 expect(nativeFailure).toContain('-Action Report -FailureContext NSIS');
 expect(nativeFailure).not.toContain('-Action Rollback');
 const mac=readFileSync('build/macos-migration/Diagnostics.swift','utf8');
 expect(mac).toContain('try? deliver(report');
 expect(mac).toContain('completionHandler(nil)');
});
