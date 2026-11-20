$ErrorActionPreference='Stop'
$target=Join-Path $PSScriptRoot 'delayed-system\System32\WindowsPowerShell\v1.0'
New-Item -ItemType Directory -Force $target|Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
public static class DelayedIdentityQuery {
 public static int Main(string[] args) {
  Thread.Sleep(Int32.Parse(Environment.GetEnvironmentVariable("ARKME_TEST_QUERY_DELAY_MS") ?? "0"));
  var psi=new ProcessStartInfo(Environment.GetEnvironmentVariable("ARKME_TEST_REAL_POWERSHELL"),String.Join(" ",args));
  psi.EnvironmentVariables["SystemRoot"]=Environment.GetEnvironmentVariable("ARKME_TEST_REAL_SYSTEMROOT");
  psi.UseShellExecute=false;psi.CreateNoWindow=true;psi.RedirectStandardOutput=true;psi.RedirectStandardError=true;
  using(var p=Process.Start(psi)){var output=p.StandardOutput.ReadToEnd();var error=p.StandardError.ReadToEnd();p.WaitForExit();Console.Write(output);Console.Error.Write(error);return p.ExitCode;}
 }
}
'@ -OutputType ConsoleApplication -OutputAssembly (Join-Path $target 'powershell.exe')
