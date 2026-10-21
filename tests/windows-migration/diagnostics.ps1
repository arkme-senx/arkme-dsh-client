$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-diagnostic-test-'+[guid]::NewGuid())
$private="Authorization: Bearer secret-value`nPath=C:\Users\alice\app.exe`n/Users/alice/Documents/file.txt`nemail alice@example.org`ncomputer: private-pc`nAAAA\alice`n192.168.3.231`n{`"token`":`"json-secret`"}`n/mnt/private-owner/file"
function Assert-True($Value,$Message) {if(!$Value){throw $Message}}
try {
 $clean=Protect-InstallerDiagnosticText $private 12000
 foreach($secret in @('secret-value','alice','private-pc','192.168','json-secret','private-owner')) {Assert-True (!$clean.Contains($secret)) 'privacy leak'}
 $report=[ordered]@{schema=1;event_id=[guid]::NewGuid().ToString('N');platform='windows';os_version='10.0.22631';architecture='x64';version='3.0.12';build=290;stage='Apply';result='failure';error_code='INSTALL_FAILED';recovery='completed';scope='current';elapsed_ms=123;details=$private;log=$private}
 $script:calls=0
 Save-InstallerDiagnostic $report $root {param($json) $script:calls++;Assert-True (!$json.Contains('alice')) 'network leak';return $false}
 Assert-True ($script:calls -eq 1) 'first delivery not attempted'
 $stored=@(Get-ChildItem $root -Filter '*.json')
 Assert-True ($stored.Count -eq 1) 'failed delivery lost report'
 Assert-True (!(Get-Content $stored[0].FullName -Raw).Contains('alice')) 'raw log persisted'
 $report.event_id=[guid]::NewGuid().ToString('N')
 Save-InstallerDiagnostic $report $root {param($json) $script:calls++;return $true}
 Assert-True ($script:calls -eq 3) 'retry must attempt at most two reports'
 Assert-True (@(Get-ChildItem $root -Filter '*.json').Count -eq 0) 'accepted reports not removed'
 $report.event_id=[guid]::NewGuid().ToString('N')
 Save-InstallerDiagnostic $report $root {throw 'network unavailable'}
 Assert-True (@(Get-ChildItem $root -Filter '*.json').Count -eq 1) 'transport exception must retain queued report'
 Write-Output 'Installer diagnostic fixtures passed'
} finally {if(Test-Path $root){Remove-Item -LiteralPath $root -Recurse -Force}}

$fixture=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../fixtures/installer-diagnostics/path-redaction.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$clean=Protect-InstallerDiagnosticText $fixture.input 12000
foreach($value in $fixture.keep){if(!$clean.Contains($value)){throw "Lost context: $value in $clean"}}
foreach($value in $fixture.hide){if($clean.Contains($value)){throw "Leaked: $value"}}
if((Protect-InstallerDiagnosticText $clean 12000) -cne $clean){throw 'Redaction must be idempotent'}
