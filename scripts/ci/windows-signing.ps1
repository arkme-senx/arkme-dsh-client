param([ValidateSet('login','verify')][string]$Operation='login')
$ErrorActionPreference='Stop'
function Check-Certificate {
 $thumb=$env:SIMPLYSIGN_CERTIFICATE_SHA1 -replace '\s',''
 if($thumb -notmatch '^[A-Fa-f0-9]{40}$'){throw 'Certificate thumbprint required'}
 $cert=Get-Item "Cert:\CurrentUser\My\$thumb" -ErrorAction SilentlyContinue
 if(!$cert -or !$cert.HasPrivateKey -or $cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date).AddHours(1)){return $false}
 if(!$env:SIMPLYSIGN_PUBLISHER -or $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne $env:SIMPLYSIGN_PUBLISHER){throw 'Unexpected certificate publisher'}
 if(!($cert.EnhancedKeyUsageList | Where-Object {$_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3'})){throw 'Certificate is not valid for code signing'}
 return $true
}
if($Operation -eq 'verify'){
 if(!(Check-Certificate)){throw 'Signing certificate unavailable'}
 $tool=Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
 if(!$tool){throw 'SignTool not installed'}
 $targets=@(Get-ChildItem release-ci -Filter *.exe -File)
 $targets+=Get-ChildItem release-ci/win-unpacked -Filter *.exe -Recurse -File | Where-Object {$_.Name -in @('arkme.exe','arkme Test.exe','elevate.exe')}
 if($targets.Count -lt 2){throw 'Missing signed executable outputs'}
 foreach($file in $targets){
  $s=Get-AuthenticodeSignature $file.FullName
  if($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne ($env:SIMPLYSIGN_CERTIFICATE_SHA1 -replace '\s','') -or !$s.TimeStamperCertificate){throw 'Authenticode or timestamp verification failed'}
  & $tool.FullName verify /pa /all /tw $file.FullName
  if($LASTEXITCODE -ne 0){throw 'SignTool verification failed'}
 }
 # Verify the final ZIP bytes separately, without repacking them.
 $zip=Get-ChildItem release-ci -Filter *.zip -File | Select-Object -First 1
 $dir=Join-Path $env:RUNNER_TEMP ('arkme-zip-'+[guid]::NewGuid())
 try{Expand-Archive $zip.FullName $dir; $exe=Get-ChildItem $dir -Recurse -File | Where-Object {$_.Name -in @('arkme.exe','arkme Test.exe')} | Select-Object -First 1
  if(!$exe){throw 'ZIP application missing'};$s=Get-AuthenticodeSignature $exe.FullName
  if($s.Status -ne 'Valid' -or !$s.TimeStamperCertificate -or $s.SignerCertificate.Thumbprint -ne ($env:SIMPLYSIGN_CERTIFICATE_SHA1 -replace '\s','')){throw 'ZIP signature invalid'}
 }finally{Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue}
 @{verified=$true;timestamp=$true;certificate_sha1=$env:SIMPLYSIGN_CERTIFICATE_SHA1} | ConvertTo-Json -Compress | Set-Content release-ci/signing-evidence.json -Encoding utf8NoBOM
 exit 0
}
# Installation is pinned by both version URL and independently configured digest.
$url='https://files.certum.eu/software/SimplySignDesktop/Windows/9.4.4.92/SimplySignDesktop-9.4.4.92-64-bit-en.msi'
$installer=Join-Path $env:RUNNER_TEMP 'SimplySignDesktop-9.4.4.92.msi'
Invoke-WebRequest $url -OutFile $installer
if($env:SIMPLYSIGN_INSTALLER_SHA256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash $installer -Algorithm SHA256).Hash -ne $env:SIMPLYSIGN_INSTALLER_SHA256){throw 'Installer digest mismatch'}
$signature=Get-AuthenticodeSignature $installer
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Asseco'){throw 'Installer signature invalid'}
$p=Start-Process msiexec.exe -ArgumentList @('/i',"`"$installer`"",'/qn','/norestart') -Wait -PassThru
if($p.ExitCode -notin @(0,3010)){throw 'SimplySign installation failed'}
$app=Get-ChildItem "$env:ProgramFiles\Certum" -Recurse -Filter 'SimplySignDesktop.exe' -File | Select-Object -First 1
if(!$app){throw 'SimplySign executable not found; inspect pinned installer layout'}
$process=Start-Process $app.FullName -PassThru
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$process.Id)
function Login-Controls {
 $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
 foreach($window in $windows){
  $edits=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)))
  $buttons=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)))
  $login=@($buttons | Where-Object {$_.Current.Name -match '^(Connect|Log in|Login|Sign in)$' -and $_.Current.IsEnabled})
  if($edits.Count -eq 2 -and $login.Count -eq 1){return @{Account=$edits[0];Token=$edits[1];Submit=$login[0]}}
 }
 return $null
}
$deadline=(Get-Date).AddSeconds(45);$controls=$null
while((Get-Date) -lt $deadline){$controls=Login-Controls;if($controls){break};Start-Sleep -Milliseconds 500}
if(!$controls){throw 'SimplySign login controls unavailable on hosted runner; token was not requested'}
if(!$env:SIMPLYSIGN_ACCOUNT){throw 'SimplySign account required'}
for($attempt=1;$attempt -le 2;$attempt++){
 $token=$null
 try{
  $start=New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName='node';$start.ArgumentList.Add('scripts/ci/token.mjs');$start.ArgumentList.Add([string]$attempt)
  $start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $child=[System.Diagnostics.Process]::Start($start)
  $token=$child.StandardOutput.ReadToEnd();$null=$child.StandardError.ReadToEnd();$child.WaitForExit()
  if($child.ExitCode -ne 0 -or $token -notmatch '^\d{6}$'){throw 'Token request failed'}
  ([System.Windows.Automation.ValuePattern]$controls.Account.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($env:SIMPLYSIGN_ACCOUNT)
  ([System.Windows.Automation.ValuePattern]$controls.Token.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($token)
  $token=$null
  ([System.Windows.Automation.InvokePattern]$controls.Submit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  $deadline=(Get-Date).AddSeconds(20)
  while((Get-Date) -lt $deadline){if(Check-Certificate){Write-Output 'SimplySign certificate ready';exit 0};Start-Sleep -Milliseconds 500}
 }catch{if($attempt -eq 2){throw 'SimplySign login failed after two attempts'}}finally{$token=$null}
 $controls=Login-Controls;if(!$controls){throw 'SimplySign login unavailable for retry'}
}
throw 'SimplySign certificate unavailable'
