# Run on an interactive Windows desktop; never installs or exits a real app.
param([Parameter(Mandatory=$true)][string]$Makensis)
$ErrorActionPreference='Stop'
$directory=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-dialog-regression-'+[Guid]::NewGuid())
$null=New-Item -ItemType Directory $directory
$helper=(Resolve-Path "$PSScriptRoot\..\..\build\windows-migration.ps1").Path
$worker=Join-Path $directory 'worker.ps1'
$pidFile=Join-Path $directory 'worker-pid.txt'
$answer=Join-Path $directory 'answer.txt'
$exe=Join-Path $directory 'probe.exe'
$source=Join-Path $directory 'probe.nsi'
$quote={param($s) $s.Replace("'","''")}
@"
`$ErrorActionPreference='Stop'
. '$(& $quote $helper)' -Action Library
Initialize-MigrationExitNative
`$PID | Set-Content '$(& $quote $pidFile)'
[JiwoMigrationExit]::Confirm('Arkme',`$false) | Set-Content '$(& $quote $answer)'
"@ | Set-Content -Encoding UTF8 $worker
$escape={param($s) $s.Replace('$','$$').Replace('"','$\"')}
@"
Unicode true
Name "Jiwo exit visibility regression"
OutFile "$(& $escape $exe)"
RequestExecutionLevel user
SilentInstall silent
Section
 nsExec::ExecToLog '"`$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(& $escape $worker)"'
 Pop `$0
 SetErrorLevel `$0
SectionEnd
"@ | Set-Content -Encoding UTF8 $source
$env:NSISDIR=Split-Path $Makensis -Parent
& $Makensis -V2 $source
if($LASTEXITCODE -ne 0){throw 'NSIS probe compile failed'}
 Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class VisibleTest {
 delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback f,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Callback f,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 static string Text(IntPtr h){var b=new StringBuilder(200);GetWindowText(h,b,b.Capacity);return b.ToString();}
 public static int Check(int pid){int result=-1;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==pid&&Text(h)=="安装即我"){result=IsWindowVisible(h)?1:0;EnumChildWindows(h,(c,q)=>{if(Text(c)=="取消安装")PostMessage(c,0xf5,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero);}return true;},IntPtr.Zero);return result;}
}
'@
$process=Start-Process $exe -PassThru
$deadline=[DateTime]::UtcNow.AddSeconds(20)
while(!(Test-Path $pidFile) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
Start-Sleep -Seconds 2
$result=[VisibleTest]::Check([int](Get-Content $pidFile))
if(!$process.WaitForExit(10000)){throw "Probe did not exit after cancellation. Evidence: $directory"}
if($result -ne 1){throw "Production confirmation is hidden/missing under NSIS. Evidence: $directory"}
if((Get-Content $answer).Trim() -ne 'False'){throw 'Cancel must return false'}
Write-Output "NSIS confirmation visibility and cancellation passed. Evidence: $directory"
