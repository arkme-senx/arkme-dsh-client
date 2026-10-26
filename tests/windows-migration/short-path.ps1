# Real Windows 8.3 aliases, signed payload verification and safety regressions.
param([string]$MigrationScript="$PSScriptRoot\..\..\build\windows-migration.ps1")
$ErrorActionPreference='Stop'
. $MigrationScript -Action Library
function Assert-True($Value,[string]$Message) { if (!$Value) { throw $Message } }
function Assert-Rejected([string]$Path) {
  $rejected=$false
  try { $null=Assert-LocalPath $Path } catch { $rejected=$true }
  Assert-True $rejected ('Unsafe path accepted: '+$Path)
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo short path regression '+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
$junction=Join-Path $root 'junction'
try {
  $fso=New-Object -ComObject Scripting.FileSystemObject
  $short=$fso.GetFolder($root).ShortPath
  Assert-True ($short -match '~[0-9]+') 'Fixture requires real Windows 8.3 names; do not silently skip coverage.'
  Write-Output ('Long fixture: '+$root)
  Write-Output ('Short fixture: '+$short)
  # Exercise the exact Apply failure chain with a real signed Windows binary.
  # Only the test publisher is changed; production publisher validation is intact.
  $signed=Join-Path $PSHOME 'powershell.exe'
  $signature=Get-AuthenticodeSignature -LiteralPath $signed
  Assert-True ($signature.Status -eq 'Valid') 'Signed payload fixture must have a valid Authenticode signature.'
  $Publisher=$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
  $stage=Join-Path $root 'jiwo-stage'
  $null=New-Item -ItemType Directory -Path $stage
  Copy-Item -LiteralPath $signed -Destination (Join-Path $stage 'arkme.exe')
  [IO.File]::WriteAllText((Join-Path $stage 'app.asar'),'payload fixture')
  $inventory=@('arkme.exe','app.asar') | ForEach-Object { @{path=$_;sha256=(Get-FileHash (Join-Path $stage $_) -Algorithm SHA256).Hash.ToLowerInvariant()} }
  $manifest=Join-Path $root 'manifest.json'
  @{files=@($inventory)} | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $manifest
  Assert-Payload (Join-Path $short 'jiwo-stage') $manifest
  Assert-True ((Assert-LocalPath $short) -ieq $root) 'Existing short directory must normalize to the long name.'
  $future=Join-Path $short 'not-created\Jiwo Installer Reports'
  Assert-True ((Assert-LocalPath $future) -ieq (Join-Path $root 'not-created\Jiwo Installer Reports')) 'New destinations must normalize their existing short ancestor.'
  $Publisher='Untrusted test publisher'
  $rejected=$false
  try { Assert-Publisher (Join-Path $short 'jiwo-stage\arkme.exe') } catch { $rejected=$_.Exception.Message -like 'Untrusted program signature:*' }
  Assert-True $rejected 'Short-path normalization must not bypass publisher checks.'
  $Publisher=$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
  [IO.File]::WriteAllText((Join-Path $stage 'app.asar'),'tampered fixture')
  $rejected=$false
  try { Assert-Payload (Join-Path $short 'jiwo-stage') $manifest } catch { $rejected=$_.Exception.Message -like '*payload verification failed*' }
  Assert-True $rejected 'Short-path normalization must not bypass payload hash checks.'
  foreach ($bad in @('C:\','\\server\share\app',(Join-Path $short '..\escape'),(Join-Path $short 'file:stream'),(Join-Path $short 'trailing.\child'),(Join-Path $short 'trailing \child'),(Join-Path $short 'UNKNOWN~1\child'))) { Assert-Rejected $bad }
  $literal=Join-Path $root 'LITERAL~1'
  $null=New-Item -ItemType Directory -Path $literal
  Assert-Rejected $literal
  $target=Join-Path $root 'junction target'
  $null=New-Item -ItemType Directory -Path $target
  $null=New-Item -ItemType Junction -Path $junction -Target $target
  Assert-Rejected (Join-Path $short 'junction\child')
  Write-Output 'Windows short-path regression tests passed.'
} finally {
  # Remove the test-owned junction itself before recursive fixture cleanup.
  if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
  Remove-Item -LiteralPath $root -Recurse -Force
}
