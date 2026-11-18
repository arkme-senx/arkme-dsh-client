# Real registry and Windows 8.3 names; no production registration or executable runs.
param([string]$MigrationScript="$PSScriptRoot\..\..\build\windows-migration.ps1")
$ErrorActionPreference='Stop'
. $MigrationScript -Action Library
$LegacyKey='Software\ArkmeLegacyLayoutTest\'+[guid]::NewGuid().ToString('N')
function Get-LegacyRegistryLocations {
 [pscustomobject]@{Hive=[Microsoft.Win32.RegistryHive]::CurrentUser;View=[Microsoft.Win32.RegistryView]::Registry64}
}
$root=Join-Path $env:TEMP ('arkme legacy layout '+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory $root
$junction=Join-Path $root 'link'
$failures=@();$count=0
function Check-Layout([string]$Name,[string]$RegisteredRoot,[string]$Command,[bool]$Expected) {
 $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($LegacyKey)
 try {
  $key.SetValue('InstallLocation',$RegisteredRoot)
  $key.SetValue('DisplayName',([char]0x5373).ToString()+[char]0x6211)
  $key.SetValue('DisplayVersion','2.5.0')
  $key.SetValue('UninstallString',$Command)
 } finally {$key.Dispose()}
 $accepted=$false;$errorText=''
 try { $legacy=Get-LegacyInstall;$accepted=($legacy.Root -ieq $root) } catch {$errorText=$_.Exception.Message}
 $script:count++
 if($accepted -ne $Expected){$script:failures+=($Name+': '+$errorText);Write-Output ('FAIL '+$Name+': '+$errorText)}
 else {Write-Output ('PASS '+$Name)}
}
try {
 $file=Join-Path $root 'unins000.exe'
 [IO.File]::WriteAllText($file,'fixture; never execute')
 $fso=New-Object -ComObject Scripting.FileSystemObject
 $short=$fso.GetFolder($root).ShortPath
 if($short -notmatch '~[0-9]+'){throw 'Fixture requires real Windows 8.3 names; do not silently skip.'}
 $shortFile=Join-Path $short 'unins000.exe'
 Check-Layout 'long paths' $root ('"'+$file+'"') $true
 Check-Layout 'both short paths' $short ('"'+$shortFile+'"') $true
 Check-Layout 'short uninstall only' $root ('"'+$shortFile+'"') $true
 Check-Layout 'short root only' $short ('"'+$file+'"') $true
 Check-Layout 'unquoted short uninstall' $root $shortFile $true
 Check-Layout 'case insensitive long path' $root $file.ToUpperInvariant() $true
 Check-Layout 'unquoted long path' $root $file $true
 Check-Layout 'other uninstaller index' $root (Join-Path $root 'unins001.exe') $false
 Check-Layout 'different root' $root (Join-Path $env:TEMP 'unins000.exe') $false
 Check-Layout 'command arguments' $root ('"'+$file+'" /SILENT') $false
 Check-Layout 'command chaining' $root ('"'+$file+'" & calc.exe') $false
 Check-Layout 'unmatched leading quote' $root ('"'+$file) $false
 Check-Layout 'unmatched trailing quote' $root ($file+'"') $false
 Check-Layout 'repeated quotes' $root ('""'+$file+'""') $false
 Check-Layout 'trailing newline' $root ('"'+$file+'"'+[char]10) $false
 Check-Layout 'embedded newline' $root ($file+[char]13+'extra') $false
 Check-Layout 'empty command' $root '' $false
 Check-Layout 'relative command' $root 'unins000.exe' $false
 Check-Layout 'parent traversal' $root (Join-Path $root 'child\..\unins000.exe') $false
 Check-Layout 'alternate stream' $root ($file+':stream') $false
 Check-Layout 'network path' $root '\\localhost\c$\unins000.exe' $false
 $null=New-Item -ItemType Junction $junction -Target $root
 Check-Layout 'junction in uninstall path' $root (Join-Path $junction 'unins000.exe') $false
 Check-Layout 'junction in registered root' $junction $file $false
 if((Get-Content $file -Raw) -ne 'fixture; never execute'){throw 'Uninstaller fixture mutated.'}
 if($failures.Count){throw ($failures -join '; ')}
 Write-Output "Windows legacy layout fixtures passed ($count cases)."
} finally {
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($LegacyKey)
 if(Test-Path -LiteralPath $junction){[IO.Directory]::Delete($junction)}
 Remove-Item -LiteralPath $root -Recurse -Force
}
