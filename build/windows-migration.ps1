# Executed only by the signed production NSIS installer. Windows PowerShell 5.1.
[CmdletBinding()]
param(
  [ValidateSet('Prepare','Apply','Commit','Finalize','Rollback','Check','UpdateCheck','Report','Library')][string]$Action,
  [string]$Destination,
  [ValidateSet('current','all')][string]$Scope = 'current',
  [string]$Manifest,
  [string]$Stage,
  [string]$UninstallerName,
  [string]$InstallerPath,
  [string]$CompletionFile,
  [ValidateSet('','NSIS')][string]$FailureContext='',
  [string]$ShortcutPolicyFile,
  [string]$ErrorFile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$LegacyKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\fcf12080-f7e3-1067-bed2-21ffecf3ae64_is1'
$Publisher = 'Senqisi (Wuhan) Technology Co., Ltd.'
$RetiredSuffix = '.jiwo-v3-retired'
$script:ProtectedJournalDirectory=''
$script:PreservedLegacy=$null

function Assert-WindowsCompatibility([version]$Version,[int]$Architecture) {
  if ($Version.Major -lt 10 -or $Architecture -ne 9) { throw 'This production release requires Windows 10/11 on native x64 hardware.' }
}
function Assert-UpgradeAllowed([string]$OldVersion,[long]$OldCode,[string]$NewVersion,[long]$NewCode) {
  # Flutter uses semanticVersion+build in its Inno registration.
  if ($OldVersion -match '^(2\.\d+\.\d+)\+(\d+)$') {
    $OldVersion=$Matches[1]; $OldCode=[Math]::Max($OldCode,[long]$Matches[2])
  }
  try { $old=[version]$OldVersion; $new=[version]$NewVersion } catch { throw 'Unknown installed release version; refusing downgrade ambiguity.' }
  $oldMain=[version]("{0}.{1}.{2}" -f $old.Major,$old.Minor,[Math]::Max(0,$old.Build))
  $newMain=[version]("{0}.{1}.{2}" -f $new.Major,$new.Minor,[Math]::Max(0,$new.Build))
  $oldBuild=[Math]::Max($OldCode,[long][Math]::Max(0,$old.Revision))
  if ($oldMain -gt $newMain -or $oldBuild -gt $NewCode) { throw 'A newer release/build is installed. Downgrades are not supported.' }
}
function Get-DiskRequirements([string]$TargetDrive,[string]$StageDrive,[long]$PayloadBytes,[long]$BackupBytes,[long]$InstallerBytes,[string]$CacheDrive=$StageDrive) {
  $requirements=@{}
  $requirements[$TargetDrive]=$PayloadBytes+(2L*$BackupBytes)+268435456L
  if (!$requirements.ContainsKey($StageDrive)) { $requirements[$StageDrive]=0L }
  $requirements[$StageDrive]+=$PayloadBytes+67108864L
  if (!$requirements.ContainsKey($CacheDrive)) { $requirements[$CacheDrive]=0L }
  $requirements[$CacheDrive]+=$InstallerBytes+67108864L
  return $requirements
}
function Get-ReleaseManifest {
  $release=Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if (!$release.version -or $release.versionCode -le 0 -or @($release.files).Count -lt 2) { throw 'Invalid signed release manifest.' }
  return $release
}
function Assert-DiskCapacity {
  $release=Get-ReleaseManifest
  $payload=0L; $backup=0L
  foreach ($entry in $release.files) {
    if ($entry.path -match '(^[\\/]|\.\.|:)' -or $entry.size -lt 0) { throw 'Invalid release size manifest.' }
    $payload += [long]$entry.size
    $old=Join-Path $Destination $entry.path
    if (Test-Path -LiteralPath $old -PathType Leaf) { $backup += (Get-Item -LiteralPath $old).Length }
  }
  foreach ($name in @('Uninstall arkme.exe','Uninstall 即我.exe')) {
    $old=Join-Path $Destination $name
    if (Test-Path -LiteralPath $old -PathType Leaf) { $backup += (Get-Item -LiteralPath $old).Length }
  }
  $targetDrive=[IO.Path]::GetPathRoot($Destination); $stageDrive=[IO.Path]::GetPathRoot($Stage)
  $installerBytes=(Get-Item -LiteralPath $InstallerPath).Length
  $cacheDrive=[IO.Path]::GetPathRoot([Environment]::GetFolderPath('LocalApplicationData'))
  $requirements=Get-DiskRequirements $targetDrive $stageDrive $payload $backup $installerBytes $cacheDrive
  if($script:ProtectedJournalDirectory) {
    $journalDrive=[IO.Path]::GetPathRoot($script:ProtectedJournalDirectory)
    if(!$requirements.ContainsKey($journalDrive)){$requirements[$journalDrive]=0L}
    $requirements[$journalDrive]+=$payload+(2L*$backup)+67108864L
  }
  foreach ($drive in $requirements.Keys) {
    $info=New-Object IO.DriveInfo($drive)
    if ($info.AvailableFreeSpace -lt $requirements[$drive]) { throw "Insufficient free space on $drive for staging, new program and recovery backups." }
  }
}
function Test-ArkmeNode([string]$ExecutablePath,[string]$CommandLine,[string[]]$Roots=@()) {
  foreach ($root in $Roots) { if ($ExecutablePath.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return ($ExecutablePath -match '(?i)\\Arkme Harness\\' -or $CommandLine -match '(?i)\\Arkme Harness\\')
}
function Expand-LocalShortPath([string]$Path) {
  # NSIS may supply an 8.3 TEMP/profile path. Expand the existing ancestor first,
  # including when the installation/report directory has not been created yet.
  if (!('JiwoMigration.NativePath' -as [type])) {
    Add-Type -TypeDefinition @'
namespace JiwoMigration {
  public static class NativePath {
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    public static extern uint GetLongPathNameW(string path, System.Text.StringBuilder result, uint capacity);
  }
}
'@
  }
  $existing=$Path
  $suffix=New-Object 'System.Collections.Generic.List[string]'
  while (!(Test-Path -LiteralPath $existing)) {
    $parent=[IO.Path]::GetDirectoryName($existing)
    if (!$parent -or $parent -eq $existing) { throw 'Cannot resolve short install path.' }
    $suffix.Insert(0,[IO.Path]::GetFileName($existing))
    $existing=$parent
  }
  $buffer=New-Object Text.StringBuilder 32768
  $length=[JiwoMigration.NativePath]::GetLongPathNameW($existing,$buffer,[uint32]$buffer.Capacity)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Cannot resolve short install path.' }
  $expanded=$buffer.ToString()
  foreach ($part in $suffix) { $expanded=Join-Path $expanded $part }
  return $expanded
}
function Assert-LocalPath([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Contains('..') -or $Path.Substring(2).Contains(':') -or $Path -match '(^|\\)[^\\]*[. ](\\|$)') { throw 'Unsupported install path.' }
  if ($Path -match '(^|\\)[^\\]*~[0-9]+(\\|$)') {
    $Path=Expand-LocalShortPath $Path
    # An unresolved/literal short-looking name is still unsupported. Do not turn
    # normalization into permission to bypass the path or reparse-point checks.
    if ($Path -match '(^|\\)[^\\]*~[0-9]+(\\|$)' -or $Path -notmatch '^[A-Za-z]:\\' -or $Path.Contains('..') -or $Path.Substring(2).Contains(':') -or $Path -match '(^|\\)[^\\]*[. ](\\|$)') { throw 'Unsupported install path.' }
  }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.Length -lt 4) { throw 'A drive root cannot be an install directory.' }
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Install paths containing links or junctions are not supported.' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}
function Assert-Publisher([string]$File) {
  $File = Assert-LocalPath $File
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
      $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne $Publisher) {
    throw "Untrusted program signature: $File"
  }
}
function Test-LegacyDisplayIdentity([string]$Name,[string]$Version) {
  if ($Version -notmatch '^2\.\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$') { return $false }
  return $Name -match ('^即我(?:\s+(?:version\s+|版本\s*)?'+[regex]::Escape($Version)+')?$')
}
function Get-LegacyRegistryLocations {
  # HKCU\Software is shared across WOW64 views. HKLM uninstall keys are redirected.
  [pscustomobject]@{Hive=[Microsoft.Win32.RegistryHive]::CurrentUser;View=[Microsoft.Win32.RegistryView]::Registry64}
  [pscustomobject]@{Hive=[Microsoft.Win32.RegistryHive]::LocalMachine;View=[Microsoft.Win32.RegistryView]::Registry64}
  [pscustomobject]@{Hive=[Microsoft.Win32.RegistryHive]::LocalMachine;View=[Microsoft.Win32.RegistryView]::Registry32}
}
function Get-LegacyInstall {
  $found = @()
  foreach ($location in @(Get-LegacyRegistryLocations)) {
      $hive=$location.Hive; $view=$location.View
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      try {
        $key = $base.OpenSubKey($LegacyKey)
        if ($null -eq $key) { continue }
        try {
          if ($key.SubKeyCount -ne 0) { throw 'Unexpected legacy registration children.' }
          $root = Assert-LocalPath ([string]$key.GetValue('InstallLocation'))
          if (!(Test-LegacyDisplayIdentity ([string]$key.GetValue('DisplayName')) ([string]$key.GetValue('DisplayVersion')))) { throw 'Unknown Flutter installation identity/version.' }
          $uninstall = [string]$key.GetValue('UninstallString')
          if ($uninstall.Trim('"') -ine (Join-Path $root 'unins000.exe')) { throw 'Unknown Flutter uninstall layout.' }
          $found += [pscustomobject]@{ Root=$root; Hive=$hive; View=$view; Version=[string]$key.GetValue('DisplayVersion'); Scope=$(if ($hive -eq 'LocalMachine') {'all'} else {'current'}) }
        } finally { $key.Dispose() }
      } finally { $base.Dispose() }
  }
  if ($found.Count -gt 1) { throw 'Multiple Flutter installations found. Resolve them before migration.' }
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}
function Test-LegacyUninstallerIdentity([string]$Status,[string]$Signer,[string]$Description,[string]$Product) {
  # The historical Inno generator did not always sign its generated uninstaller.
  # Never execute this file. It is only retired with transaction-owned hashes.
  return ($Status -eq 'NotSigned' -or ($Status -eq 'Valid' -and $Signer -ceq $Publisher)) -and
    $Description.Trim() -ceq 'Setup/Uninstall' -and $Product.Trim() -ceq '即我'
}
function Assert-LegacyUninstaller([string]$File) {
  $null=Assert-LocalPath $File
  if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw 'Missing legacy Inno uninstaller.' }
  $signature=Get-AuthenticodeSignature -LiteralPath $File
  $signer=if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) } else { '' }
  $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($File)
  if (!(Test-LegacyUninstallerIdentity ([string]$signature.Status) $signer $info.FileDescription $info.ProductName)) { throw "Unknown or damaged legacy Inno uninstaller: $File" }
}
function Test-UserLocalCoexistence([string]$LegacyScope,[string]$TargetScope,[string]$LegacyRoot,[string]$Target,[string]$Profile,[bool]$Elevated,[bool]$ExistingArkme) {
  if (!$Profile -or !$Elevated -or !$ExistingArkme -or $LegacyScope -ne 'all' -or $TargetScope -ne 'current') { return $false }
  $prefix=$Profile.TrimEnd('\')+'\'
  return $LegacyRoot.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and $Target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
}
function Test-PathWithin([string]$Path,[string]$Root) {
  return $Root -and $Path.StartsWith($Root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Test-HistoricalFlutterSystemPath([string]$Path) {
  # Only this exact registered historical application directory is supported.
  # Assert-Legacy still verifies Inno identity, publisher, layout and safe paths.
  return $env:SystemRoot -and $Path.TrimEnd('\') -ieq (Join-Path $env:SystemRoot 'SysWOW64\jotmo')
}
function Test-InstallScopeCompatibility([string]$LegacyScope,[string]$TargetScope,[string]$LegacyRoot,[string]$Target,[string]$Profile,[bool]$Elevated,[bool]$ExistingArkme,[string[]]$ProgramRoots,[int]$OtherProfiles=-1,[bool]$Recovery=$false) {
  if ($LegacyScope -eq $TargetScope) { return $true }
  if (!$Elevated -or (!$ExistingArkme -and !$Recovery) -or !$Profile) { return $false }
  $oldUser=Test-PathWithin $LegacyRoot $Profile; $newUser=Test-PathWithin $Target $Profile
  $oldShared=(@($ProgramRoots | Where-Object { Test-PathWithin $LegacyRoot $_ }).Count -gt 0) -or (Test-HistoricalFlutterSystemPath $LegacyRoot)
  # A registered all-user Arkme may use a custom local path. Its existing
  # destination and protected ACLs are verified separately before replacement.
  if ($LegacyScope -eq 'current' -and $TargetScope -eq 'all') { return $oldUser -and !$newUser }
  if ($LegacyScope -eq 'all' -and $TargetScope -eq 'current') {
    return $newUser -and ($oldUser -or $oldShared) -and ($Recovery -or $OtherProfiles -eq 0)
  }
  return $false
}
function Get-OtherUserProfileCount {
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $profiles=@(Get-CimInstance Win32_UserProfile -ErrorAction Stop | Where-Object {!$_.Special})
  if (@($profiles | Where-Object {$_.SID -eq $sid}).Count -ne 1) { throw 'Cannot verify the current Windows user profile.' }
  return @($profiles | Where-Object {$_.SID -ne $sid}).Count
}

function Assert-LegacyScope($Install,[string]$Target,[string]$TargetScope,[bool]$Recovery=$false) {
  $hive=if ($Install.Scope -eq 'all') { 'LocalMachine' } elseif ($Install.Scope -eq 'current') { 'CurrentUser' } else { throw 'Unknown legacy scope.' }
  if ([string][Microsoft.Win32.RegistryHive]$Install.Hive -ne $hive -or [string][Microsoft.Win32.RegistryView]$Install.View -notin @('Registry32','Registry64')) { throw 'Invalid legacy registry identity.' }
  if ($Install.Scope -eq $TargetScope) { return }
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=New-Object Security.Principal.WindowsPrincipal($identity)
  $elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $targetHive=if ($TargetScope -eq 'all') {'LocalMachine'} else {'CurrentUser'}
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$targetHive,[Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key=$base.OpenSubKey($ElectronKeys[0])
    try { $existing=$null -ne $key -and [string]$key.GetValue('InstallLocation') -ieq $Target } finally { if ($key) { $key.Dispose() } }
  } finally { $base.Dispose() }
  $profile=[Environment]::GetFolderPath('UserProfile')
  $roots=@($env:ProgramW6432,${env:ProgramFiles(x86)}) | Where-Object {$_}
  $others=if(!$Recovery -and $Install.Scope -eq 'all' -and $TargetScope -eq 'current'){Get-OtherUserProfileCount}else{-1}
  if (!(Test-InstallScopeCompatibility $Install.Scope $TargetScope $Install.Root $Target $profile $elevated $existing $roots $others $Recovery)) {
    throw "Installation scope conflict: legacy=$($Install.Scope) target=$TargetScope legacyPath=$($Install.Root) targetPath=$Target otherUserProfiles=$others. Mixed-scope migration requires the same elevated user, a verified existing Arkme, and no other profiles when retiring a machine-wide Flutter into a user install."
  }
  if ($Recovery -and $Install.Scope -eq 'all' -and $TargetScope -eq 'current' -and !(Test-PathWithin $Install.Root $profile) -and !$script:ProtectedJournalDirectory) { throw 'Machine-wide recovery requires protected installer storage.' }

}
function Get-LegacyShortcutCandidates($Install) {
  $folders=if ($Install.Scope -eq 'all') { @('CommonDesktopDirectory','CommonPrograms','Startup') } else { @('DesktopDirectory','Programs','Startup') }
  foreach ($folder in $folders) {
    $dir=[Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)
    if ($dir) { Join-Path $dir '即我.lnk' }
  }
}
function Assert-Legacy($Install, [string]$Target, [string]$InstallScope) {
  Assert-LegacyScope $Install $Target $InstallScope
  $old = $Install.Root.TrimEnd('\'); $new = (Assert-LocalPath $Target).TrimEnd('\')
  if ($old -ieq $new -or $old.StartsWith($new+'\',[StringComparison]::OrdinalIgnoreCase) -or $new.StartsWith($old+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'New and legacy installation directories must not overlap.' }
  if (!(Test-Path -LiteralPath (Join-Path $old 'flutter_windows.dll') -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $old 'data\flutter_assets') -PathType Container)) { throw 'Unknown Flutter program layout.' }
  foreach ($name in @('jotmo.exe','unins000.exe')) {
    $program=Join-Path $old $name
    if (Test-Path -LiteralPath ($program+$RetiredSuffix)) { throw 'Unresolved retired legacy program; recover its installation transaction before continuing.' }
  }
  Assert-Publisher (Join-Path $old 'jotmo.exe')
  Assert-LegacyUninstaller (Join-Path $old 'unins000.exe')
  $incoming=Get-ReleaseManifest
  Assert-UpgradeAllowed $Install.Version (Get-LegacyVersionCode (Join-Path $old 'jotmo.exe')) $incoming.version $incoming.versionCode
}
function Get-LegacyVersionCode([string]$Launcher) {
  # Flutter's signed PE revision is build evidence when nonzero. Older binaries
  # without that resource provide no authoritative build code; never invent one.
  return [long][Math]::Max(0,([Diagnostics.FileVersionInfo]::GetVersionInfo($Launcher)).FilePrivatePart)
}
function Initialize-MigrationExitNative {
  if ('JiwoMigrationExit' -as [type]) { return }
  Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public static class JiwoMigrationExit {
  delegate bool EnumWindow(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow f,IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder b,int n);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint flags,uint ms,out UIntPtr result);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr menu,int i);
  [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr menu,uint i,uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr menu,int i);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu,uint i,StringBuilder b,int n,uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p,uint flags,StringBuilder path,ref int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
  static bool Matches(int pid,string path) {
    var p=OpenProcess(0x1000,false,pid); if(p==IntPtr.Zero)return false;
    try { var b=new StringBuilder(32768);int n=b.Capacity;return QueryFullProcessImageName(p,0,b,ref n)&&String.Equals(b.ToString(),path,StringComparison.OrdinalIgnoreCase); }
    finally {CloseHandle(p);}
  }
  static List<IntPtr> Windows(int pid,string cls,bool prefix) {
    var found=new List<IntPtr>();
    EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==(uint)pid){var b=new StringBuilder(256);GetClassName(h,b,256);if(prefix?b.ToString().StartsWith(cls,StringComparison.Ordinal):b.ToString()==cls)found.Add(h);}return true;},IntPtr.Zero);
    return found;
  }
  public static bool IsExitLabel(string label) {
    string s=label.Split('\t')[0].Replace("&","").Replace(" ","").Trim().ToLowerInvariant();
    return s=="退出" || s=="exit" || s=="quit" || s=="退出即我" || s=="退出jotmo" || s=="exitjiwo" || s=="exitjotmo" || s=="quitjiwo" || s=="quitjotmo";
  }
  public static void QuitFlutter(int pid,string path) {
    if(!Matches(pid,path))return;
    var roots=Windows(pid,"FLUTTER_RUNNER_WIN32_WINDOW",false);
    if(roots.Count!=1)throw new InvalidOperationException("Cannot uniquely identify the verified Flutter main window.");
    IntPtr root=roots[0];
    // tray_manager's verified native callback opens its actual menu. Never guess command IDs.
    if(!PostMessage(root,0x401,IntPtr.Zero,new IntPtr(0x205)))throw new InvalidOperationException("Could not request the Flutter tray menu.");
    try {
      var timer=Stopwatch.StartNew();
      while(timer.ElapsedMilliseconds<4000) {
        foreach(var popup in Windows(pid,"#32768",false)) {
          UIntPtr value;
          if(SendMessageTimeout(popup,0x1E1,IntPtr.Zero,IntPtr.Zero,2,250,out value)==IntPtr.Zero)continue;
          var menu=new IntPtr(unchecked((long)value.ToUInt64())); int count=GetMenuItemCount(menu);uint exit=0;int matches=0;
          for(int i=0;i<count;i++) {
            var label=new StringBuilder(512);GetMenuString(menu,(uint)i,label,label.Capacity,0x400);
            if(IsExitLabel(label.ToString()) && GetSubMenu(menu,i)==IntPtr.Zero && (GetMenuState(menu,(uint)i,0x400)&3)==0) {exit=GetMenuItemID(menu,i);matches++;}
          }
          if(matches!=1 || exit==UInt32.MaxValue)continue;
          if(!Matches(pid,path))return;
          UIntPtr ignored;SendMessageTimeout(root,0x1F,IntPtr.Zero,IntPtr.Zero,2,500,out ignored);
          if(!PostMessage(root,0x111,new IntPtr(unchecked((long)exit)),IntPtr.Zero))throw new InvalidOperationException("Could not request the verified Flutter exit action.");
          return;
        }
        Thread.Sleep(50);
      }
      throw new InvalidOperationException("Could not locate the verified Flutter tray exit menu item.");
    } finally {
      if(Matches(pid,path)){UIntPtr ignored;SendMessageTimeout(root,0x1F,IntPtr.Zero,IntPtr.Zero,2,250,out ignored);}
    }
  }
  public static void QuitArkme(int pid,string path) {
    if(!Matches(pid,path))return;
    foreach(var h in Windows(pid,"Chrome_WidgetWin_",true)) {
      if(!Matches(pid,path))return;
      PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);
    }
  }
  public static bool Confirm(string apps,bool retry) {
    using(var form=new Form()) {
      form.Text="安装即我";form.ClientSize=new Size(460,260);form.StartPosition=FormStartPosition.CenterScreen;
      form.FormBorderStyle=FormBorderStyle.FixedDialog;form.MaximizeBox=false;form.MinimizeBox=false;form.TopMost=true;
      form.Font=new Font("Microsoft YaHei UI",10);form.AutoScaleMode=AutoScaleMode.Dpi;
      var label=new Label();label.AutoSize=false;label.Location=new Point(24,24);label.Size=new Size(410,160);
      label.Text=(retry?"以下应用仍未退出：":"以下应用正在运行：")+"\r\n\r\n"+apps+"\r\n\r\n"+(retry?"退出未完成，请重试，或从客户端正常退出后重试。":"安装需要退出这些应用。");
      var cancel=new Button();cancel.Text="取消安装";cancel.Size=new Size(112,36);cancel.Location=new Point(182,202);cancel.DialogResult=DialogResult.Cancel;
      var proceed=new Button();proceed.Text=retry?"退出并重试":"退出并继续";proceed.Size=new Size(132,36);proceed.Location=new Point(304,202);proceed.DialogResult=DialogResult.OK;
      form.Controls.Add(label);form.Controls.Add(cancel);form.Controls.Add(proceed);form.CancelButton=cancel;form.AcceptButton=proceed;
      // nsExec starts PowerShell with STARTF_USESHOWWINDOW/SW_HIDE. The first
      // native show is suppressed despite WinForms reporting Visible=true.
      // Queue a second show after ShowDialog has consumed that startup hint.
      form.Shown+=(sender,args)=>form.BeginInvoke(new Action(()=>{ShowWindow(form.Handle,5);form.Activate();}));
      return form.ShowDialog()==DialogResult.OK;
    }
  }
}
'@
}
function Invoke-MigrationExit([scriptblock]$GetProcesses,[scriptblock]$Confirm,[scriptblock]$Request,[scriptblock]$Wait) {
  $remaining=@(& $GetProcesses);$retry=$false
  while($remaining.Count) {
    if(!(& $Confirm $remaining $retry)) { throw 'Installation cancelled before application exit completed.' }
    & $Request $remaining | Out-Null
    $remaining=@(& $Wait $GetProcesses)
    if(!$remaining.Count) { $remaining=@(& $GetProcesses) }
    $retry=$true
  }
}
function Initialize-MigrationProcessNative {
  if ('JiwoMigrationProcess' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public sealed class JiwoMigrationProcess : IDisposable {
  IntPtr handle;
  public string Path { get; private set; }
  public long CreationTicks { get; private set; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr p,uint flags,StringBuilder path,ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
  public bool HasExited {
    get { long c,e,k,u; if(!GetProcessTimes(handle,out c,out e,out k,out u))throw new Win32Exception();return e!=0; }
  }
  public static JiwoMigrationProcess Open(int pid) {
    var h=OpenProcess(0x1000,false,pid);
    if(h==IntPtr.Zero) { int error=Marshal.GetLastWin32Error();if(error==87 && pid>0)return null;throw new Win32Exception(error,"Cannot verify a running app/kernel process."); }
    var result=new JiwoMigrationProcess();result.handle=h;
    try {
      long c,e,k,u;
      if(!GetProcessTimes(h,out c,out e,out k,out u))throw new Win32Exception();
      if(e!=0){result.Dispose();return null;}
      result.CreationTicks=DateTime.FromFileTimeUtc(c).Ticks;
      var path=new StringBuilder(32768);int size=path.Capacity;
      if(!QueryFullProcessImageName(h,0,path,ref size))throw new Win32Exception();
      result.Path=path.ToString();return result;
    } catch { bool exited=false;try{exited=result.HasExited;}finally{result.Dispose();}if(exited)return null;throw; }
  }
  public string OwnerSid() {
    IntPtr token=IntPtr.Zero, data=IntPtr.Zero;
    try {
      if(!OpenProcessToken(handle,8,out token))throw new Win32Exception();
      int needed;GetTokenInformation(token,1,IntPtr.Zero,0,out needed);
      if(needed<=0)throw new Win32Exception();
      data=Marshal.AllocHGlobal(needed);
      if(!GetTokenInformation(token,1,data,needed,out needed))throw new Win32Exception();
      return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;
    } finally {if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(token!=IntPtr.Zero)CloseHandle(token);}
  }
  public void Dispose() {if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
}
'@
}
function Get-MigrationProcesses([string[]]$Roots) {
  Initialize-MigrationProcessNative
  $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach($item in @(Get-CimInstance Win32_Process -Filter "Name = 'jotmo.exe' OR Name = 'Jotmo-Kernel.exe' OR Name = 'arkme.exe' OR Name = 'node.exe'")) {
    if($item.Name -ieq 'node.exe' -and !(Test-ArkmeNode $item.ExecutablePath $item.CommandLine $Roots)){continue}
    # Hold one handle across image/token reads: an exited PID must never resolve
    # to a replacement process. Only proven termination may be ignored.
    $process=[JiwoMigrationProcess]::Open([int]$item.ProcessId)
    if(!$process){continue}
    try {
      if(!$item.CreationDate -or [Math]::Abs($process.CreationTicks-$item.CreationDate.ToUniversalTime().Ticks) -ge 10){throw 'A running process changed during verification. Retry installation after exiting the application normally.'}
      $processPath=$process.Path
      $belongs=$item.Name -ieq 'node.exe' -and (Test-ArkmeNode $processPath $item.CommandLine $Roots)
      foreach($root in $Roots){if($processPath.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){$belongs=$true}}
      if($belongs){
        try { $ownerSid=$process.OwnerSid() }
        catch { if($process.HasExited){continue};throw }
        if($process.HasExited){continue}
        if($ownerSid -ne $currentSid){throw 'A verified app is running for another Windows user, or its owner cannot be verified. Exit that session normally before migration.'}
        [pscustomobject]@{Name=$item.Name;ProcessId=$item.ProcessId;ExecutablePath=$processPath}
      } elseif($item.Name -ieq 'Jotmo-Kernel.exe'){throw 'A kernel is running outside verified install directories. Exit it normally before migration.'}
    } finally { $process.Dispose() }
  }
}
function Stop-Normally([string[]]$Roots) {
  Invoke-MigrationExit { Get-MigrationProcesses $Roots } {
    param($items,$retry)
    Initialize-MigrationExitNative
    $labels=@($items | ForEach-Object {if($_.Name -ieq 'jotmo.exe'){'即我 2.0'}elseif($_.Name -ieq 'arkme.exe'){'Arkme'}else{'相关内核'}} | Select-Object -Unique)
    Write-Output ('Running before exit: '+(($items | ForEach-Object {$_.Name+' pid='+$_.ProcessId+' path='+$_.ExecutablePath}) -join '; ')) | Out-Host
    [JiwoMigrationExit]::Confirm(($labels -join '、'),$retry)
  } {
    param($items)
    foreach($item in $items) {
      if($item.Name -notin @('jotmo.exe','arkme.exe')){continue}
      # Revalidate the exact executable before sending a normal UI action. No taskkill/TerminateProcess.
      Assert-Publisher $item.ExecutablePath
      try {
        if($item.Name -ieq 'jotmo.exe'){[JiwoMigrationExit]::QuitFlutter([int]$item.ProcessId,$item.ExecutablePath)}
        else{[JiwoMigrationExit]::QuitArkme([int]$item.ProcessId,$item.ExecutablePath)}
      } catch { Write-Warning ($item.Name+' exit request failed: '+$_.Exception.Message) }
    }
  } {
    param($get)
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
      $remaining=@(& $get)
      if(!$remaining.Count){return}
      Start-Sleep -Milliseconds 250
    } while([DateTime]::UtcNow -lt $deadline)
    Write-Warning ('Still running: '+(($remaining | ForEach-Object {$_.Name+' pid='+$_.ProcessId}) -join '; '))
    $remaining
  }
}
function Assert-Payload([string]$Root, [string]$ManifestFile) {
  $payloadTimer=[Diagnostics.Stopwatch]::StartNew()
  try {
    Assert-Publisher (Join-Path $Root 'arkme.exe')
    $entries = @((Get-Content -LiteralPath $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json).files)
    if ($entries.Count -lt 2) { throw 'Missing release file manifest.' }
    foreach ($entry in $entries) {
      if ($entry.path -match '(^[\\/]|\.\.|:)' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid release file manifest.' }
      $file = Assert-LocalPath (Join-Path $Root $entry.path)
      if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $entry.sha256) { throw "Installed payload verification failed: $($entry.path)" }
    }
  } finally {
    Write-Output ("Phase=verify-payload root="+$Root+" elapsedMs="+$payloadTimer.ElapsedMilliseconds)
  }
}
function Get-LegacyShortcuts($Install) {
  $folders = if ($Install.Scope -eq 'all') { @('CommonDesktopDirectory','CommonPrograms','Startup') } else { @('DesktopDirectory','Programs','Startup') }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in $folders) {
    $dir = [Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)
    if (!$dir) { continue }
    $file = Join-Path $dir '即我.lnk'
    if (Test-Path -LiteralPath ($file+$RetiredSuffix)) { throw 'Unresolved retired legacy shortcut; recover its installation transaction first.' }
    if (Test-Path -LiteralPath $file) {
      $null = Assert-LocalPath $file
      if ($shell.CreateShortcut($file).TargetPath -ieq (Join-Path $Install.Root 'jotmo.exe')) { $file }
    }
  }
}
function Invoke-Retirement([string[]]$Files, [scriptblock]$CommitRegistration) {
  $moved = @()
  try {
    foreach ($file in $Files) {
      if (Test-Path -LiteralPath ($file+$RetiredSuffix)) { throw "Retirement backup already exists: $file" }
      Move-Item -LiteralPath $file -Destination ($file+$RetiredSuffix)
      $moved += $file
    }
    # The registry deletion is the commit marker, and MUST be the final mutation.
    & $CommitRegistration
  } catch {
    foreach ($file in $moved) {
      if (!(Test-Path -LiteralPath $file) -and (Test-Path -LiteralPath ($file+$RetiredSuffix))) { Move-Item -LiteralPath ($file+$RetiredSuffix) -Destination $file }
    }
    throw
  }
}
$ElectronGuid = '14ace15a-7c69-5467-bedd-7df6c628d51a'
$ElectronKeys = @("Software\$ElectronGuid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$ElectronGuid", 'Software\Classes\arkme')
function Get-RegistryNode($Key) {
  if ($null -eq $Key) { return $null }
  $values = @(); $children = @()
  foreach ($name in $Key.GetValueNames()) {
    $values += [pscustomobject]@{ Name=$name; Kind=[string]$Key.GetValueKind($name); Value=$Key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  }
  foreach ($name in $Key.GetSubKeyNames()) {
    $child = $Key.OpenSubKey($name)
    try { $children += [pscustomobject]@{ Name=$name; Node=(Get-RegistryNode $child) } } finally { $child.Dispose() }
  }
  return [pscustomobject]@{ Values=$values; Children=$children }
}
function Set-RegistryNode($Key,$Node) {
  foreach ($value in $Node.Values) {
    $kind = [Microsoft.Win32.RegistryValueKind]$value.Kind
    $data = switch ($value.Kind) {
      'Binary' { ,([byte[]]$value.Value); break }
      'None' { ,([byte[]]$value.Value); break }
      'MultiString' { ,([string[]]$value.Value); break }
      'DWord' { [int]$value.Value; break }
      'QWord' { [long]$value.Value; break }
      default { [string]$value.Value }
    }
    $Key.SetValue([string]$value.Name,$data,$kind)
  }
  foreach ($child in $Node.Children) {
    if ($child.Name.Contains('\')) { throw 'Invalid registry snapshot.' }
    $subkey = $Key.CreateSubKey([string]$child.Name)
    try { Set-RegistryNode $subkey $child.Node } finally { $subkey.Dispose() }
  }
}
function Get-RegistrySnapshots($Legacy) {
  $snapshots = @()
  $hive = if ($Scope -eq 'all') { 'LocalMachine' } else { 'CurrentUser' }
  foreach ($keyPath in $ElectronKeys) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive,[Microsoft.Win32.RegistryView]::Registry64)
    try {
      $key = $base.OpenSubKey($keyPath)
      try { $snapshots += [pscustomobject]@{ Hive=$hive; View='Registry64'; Path=$keyPath; Node=(Get-RegistryNode $key) } } finally { if ($key) { $key.Dispose() } }
    } finally { $base.Dispose() }
  }
  if ($null -ne $Legacy) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Legacy.Hive,$Legacy.View)
    try {
      $key = $base.OpenSubKey($LegacyKey)
      try { $snapshots += [pscustomobject]@{ Hive=[string]$Legacy.Hive; View=[string]$Legacy.View; Path=$LegacyKey; Node=(Get-RegistryNode $key) } } finally { $key.Dispose() }
    } finally { $base.Dispose() }
  }
  return $snapshots
}
function Assert-RegistryNodeShape($Node) {
  if ($null -eq $Node) { return }
  $seen=@{}
  foreach ($value in $Node.Values) {
    if ($value.Name -isnot [string] -or $seen.ContainsKey($value.Name) -or $value.Kind -notin @('String','ExpandString','MultiString','Binary','None','DWord','QWord')) { throw 'Invalid saved registry value.' }
    $seen[$value.Name]=$true
    switch ($value.Kind) {
      { $_ -in @('String','ExpandString') } { if ($value.Value -isnot [string]) { throw 'Invalid saved registry string.' }; break }
      'MultiString' {
        if ($value.Value -isnot [Array]) { throw 'Invalid saved registry string array.' }
        foreach ($item in $value.Value) { if ($item -isnot [string]) { throw 'Invalid saved registry string array.' } }; break
      }
      { $_ -in @('Binary','None') } {
        if ($value.Value -isnot [Array]) { throw 'Invalid saved registry byte array.' }
        foreach ($item in $value.Value) { if (($item -isnot [byte] -and $item -isnot [int] -and $item -isnot [long]) -or $item -lt 0 -or $item -gt 255) { throw 'Invalid saved registry byte array.' } }; break
      }
      default {
        if ($value.Value -isnot [int] -and $value.Value -isnot [long]) { throw 'Invalid saved registry integer.' }
        if ($value.Kind -eq 'DWord' -and ($value.Value -lt [int]::MinValue -or $value.Value -gt [int]::MaxValue)) { throw 'Invalid saved registry DWORD.' }
      }
    }
  }
  $seen=@{}
  foreach ($child in $Node.Children) {
    if ($child.Name -isnot [string] -or !$child.Name -or $child.Name.Contains('\') -or $seen.ContainsKey($child.Name) -or $null -eq $child.Node) { throw 'Invalid saved registry child.' }
    $seen[$child.Name]=$true
    Assert-RegistryNodeShape $child.Node
  }
}
function Assert-RegistryRecoveryScope($Snapshots,$Legacy) {
  $targetHive = if ($Scope -eq 'all') { 'LocalMachine' } else { 'CurrentUser' }
  if ($Legacy) { Assert-LegacyScope $Legacy $Destination $Scope $true }
  $seen=@{}
  foreach ($snapshot in $Snapshots) {
    $legacyEntry=$null -ne $Legacy -and $snapshot.Path -eq $LegacyKey
    $expectedHive=if ($legacyEntry) { [string][Microsoft.Win32.RegistryHive]$Legacy.Hive } else { $targetHive }
    $expectedView=if ($legacyEntry) { [string][Microsoft.Win32.RegistryView]$Legacy.View } else { 'Registry64' }
    if ($snapshot.Hive -ne $expectedHive -or $snapshot.View -ne $expectedView -or (!$legacyEntry -and $snapshot.Path -notin $ElectronKeys) -or $seen.ContainsKey($snapshot.Path)) { throw 'Invalid registry recovery scope.' }
    $seen[$snapshot.Path]=$true
    Assert-RegistryNodeShape $snapshot.Node
  }
  if ($seen.Count -ne ($ElectronKeys.Count + [int]($null -ne $Legacy))) { throw 'Incomplete registry recovery scope.' }
}
function Read-RegistrySnapshot($Snapshot) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$Snapshot.Hive,[Microsoft.Win32.RegistryView]$Snapshot.View)
  try {
    $key=$base.OpenSubKey($Snapshot.Path)
    try { return (Get-RegistryNode $key) } finally { if ($key) { $key.Dispose() } }
  } finally { $base.Dispose() }
}
function Write-RegistrySnapshot($Snapshot) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$Snapshot.Hive,[Microsoft.Win32.RegistryView]$Snapshot.View)
  try {
    $base.DeleteSubKeyTree([string]$Snapshot.Path,$false)
    if ($null -ne $Snapshot.Node) {
      $key=$base.CreateSubKey([string]$Snapshot.Path)
      try { Set-RegistryNode $key $Snapshot.Node } finally { $key.Dispose() }
    }
  } finally { $base.Dispose() }
}
function Restore-RegistrySnapshots($Snapshots,$Legacy=$null) {
  Assert-RegistryRecoveryScope $Snapshots $Legacy
  foreach ($snapshot in $Snapshots) { Write-RegistrySnapshot $snapshot }
}
function Get-TransactionRegistryValues($Journal,[string]$KeyPath) {
  $values=@{}
  if ($KeyPath -eq $ElectronKeys[0]) {
    $values=@{InstallLocation=$Destination;KeepShortcuts='true';ShortcutName='即我'}
  } elseif ($KeyPath -eq $ElectronKeys[1]) {
    $argument=if ($Scope -eq 'all') {'/allusers'} else {'/currentuser'}
    $command='"'+(Join-Path $Destination 'Uninstall arkme.exe')+'" '+$argument
    $icon=if (@($Journal.Files | Where-Object { $_.Path -eq 'uninstallerIcon.ico' }).Count) {Join-Path $Destination 'uninstallerIcon.ico'} else {(Join-Path $Destination 'arkme.exe')+',0'}
    $values=@{DisplayName=$Journal.RegistryMetadata.displayName;DisplayVersion=$Journal.InstallerVersion;UninstallString=$command;QuietUninstallString=$command+' /S';DisplayIcon=$icon;Publisher=$Journal.RegistryMetadata.publisher;Comments=$Journal.RegistryMetadata.description}
    foreach ($name in @('NoModify','NoRepair','JiwoVersionCode')) {
      [pscustomobject]@{Name=$name;Kind='DWord';Value=$(if ($name -eq 'JiwoVersionCode') {$Journal.InstallerVersionCode} else {1})}
    }
  }
  foreach ($name in $values.Keys) { [pscustomobject]@{Name=$name;Kind='String';Value=$values[$name]} }
}
function Assert-RegistryTransition($Current,$Original,$Expected,[bool]$AllowEstimatedSize=$false) {
  # Missing nodes/values can be an interrupted write or interrupted restoration.
  # Every present value must still be an exact old value or a recorded release value.
  if ($null -eq $Current) { return }
  $oldValues=if ($null -eq $Original) {@()} else {@($Original.Values)}
  $oldChildren=if ($null -eq $Original) {@()} else {@($Original.Children)}
  $seen=@{}
  foreach ($value in $Current.Values) {
    if ($seen.ContainsKey($value.Name)) { throw 'Duplicate registry value in recovery metadata.' }; $seen[$value.Name]=$true
    $matches=@(@($oldValues)+@($Expected) | Where-Object { $_.Name -eq $value.Name -and $_.Kind -eq $value.Kind -and (ConvertTo-Json -InputObject $_.Value -Compress -Depth 64) -ceq (ConvertTo-Json -InputObject $value.Value -Compress -Depth 64) })
    # NSIS computes this informational value from the on-disk directory size.
    $size=$AllowEstimatedSize -and $value.Name -eq 'EstimatedSize' -and $value.Kind -eq 'DWord' -and $value.Value -is [ValueType] -and [long]$value.Value -ge 0 -and [long]$value.Value -le [int]::MaxValue
    if (!$matches.Count -and !$size) { throw 'Unknown or newer registry value was preserved during recovery.' }
  }
  $seen=@{}
  foreach ($child in $Current.Children) {
    if (!$child.Name -or $child.Name.Contains('\') -or $seen.ContainsKey($child.Name)) { throw 'Invalid registry child in recovery metadata.' }; $seen[$child.Name]=$true
    $old=@($oldChildren | Where-Object { $_.Name -eq $child.Name })
    if ($old.Count -ne 1) { throw 'Unknown registry child was preserved during recovery.' }
    Assert-RegistryTransition $child.Node $old[0].Node @()
  }
}
function Invoke-ShortcutReconciliation($Snapshots,[string]$NewExecutable,[string]$LegacyExecutable,[bool]$HadExistingInstall,[scriptblock]$ReadShortcut,[scriptblock]$WriteShortcut,[scriptblock]$RemoveShortcut) {
  $allowed=@($NewExecutable)
  if ($LegacyExecutable) { $allowed += $LegacyExecutable }
  $current=@{}
  # Inspect every candidate before changing any. Never trust a same-name shortcut alone.
  foreach ($entry in $Snapshots) {
    $link=& $ReadShortcut $entry.Path
    if ($link.Exists -and ($link.Target -notin $allowed -or $link.Arguments -ne '') -and !(Test-OriginalCompatibleShortcut $entry $link)) { throw 'An unknown shortcut target/arguments occupies an app entry; preserved without changes.' }
    if (!$entry.Canonical -and !$entry.Existed -and $link.Exists) { throw 'A shortcut appeared after preflight; preserved without changes.' }
    $current[$entry.Path]=$link
  }
  foreach ($group in @($Snapshots | Group-Object Role)) {
    $entries=@($group.Group)
    $canonical=@($entries | Where-Object { $_.Canonical })
    if ($canonical.Count -ne 1) { throw 'Invalid shortcut snapshot layout.' }
    $desired=$canonical[0]
    $wanted=@($entries | Where-Object { $_.Existed -and !($_.PSObject.Properties['Compatibility'] -and $_.Compatibility -eq 'stale-flutter' -and $_.Role -eq 'Startup') }).Count -gt 0
    if (!$HadExistingInstall -and $group.Name -ne 'Startup') { $wanted=$current[$desired.Path].Exists }
    if ($wanted) {
      if (!$current[$desired.Path].Exists -or $current[$desired.Path].Target -ine $NewExecutable) { $null=& $WriteShortcut $desired.Path $NewExecutable }
      $verified=& $ReadShortcut $desired.Path
      if (!$verified.Exists -or $verified.Target -ine $NewExecutable -or $verified.Arguments -ne '') { throw 'New shortcut verification failed; previous entry was not removed.' }
    }
    foreach ($entry in $entries) {
      if ($wanted -and $entry.Canonical) { continue }
      $link=& $ReadShortcut $entry.Path
      if (!$link.Exists) { continue }
      if (($link.Target -notin $allowed -or $link.Arguments -ne '') -and !(Test-OriginalCompatibleShortcut $entry $link)) { throw 'Shortcut changed during migration; unknown entry was preserved.' }
      $null=& $RemoveShortcut $entry.Path
      if ((& $ReadShortcut $entry.Path).Exists) { throw 'Old shortcut could not be retired.' }
    }
  }
}
function Get-ShortcutLocations($Legacy=$null) {
  $folders = if ($Scope -eq 'all') { @('CommonDesktopDirectory','CommonPrograms','Startup') } else { @('DesktopDirectory','Programs','Startup') }
  foreach ($folder in $folders) {
    $directory=[Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)
    if (!$directory) { continue }
    $role=if ($folder -eq 'Startup') {'Startup'} elseif ($folder -match 'Programs') {'Programs'} else {'Desktop'}
    foreach ($name in @('arkme.lnk','即我.lnk')) {
      [pscustomobject]@{Path=(Join-Path $directory $name);Role=$role;Canonical=($name -eq '即我.lnk')}
    }
  }
  if($Legacy -and $Legacy.Scope -ne $Scope) {
    $otherFolders=if($Legacy.Scope -eq 'all'){@('CommonDesktopDirectory','CommonPrograms')}else{@('DesktopDirectory','Programs')}
    foreach($folder in $otherFolders){$directory=[Environment]::GetFolderPath([Environment+SpecialFolder]::$folder);if($directory){[pscustomobject]@{Path=(Join-Path $directory '即我.lnk');Role=$(if($folder -match 'Programs'){'Programs'}else{'Desktop'});Canonical=$false}}}
  }
}
function Get-ShortcutPaths { return @(Get-ShortcutLocations | ForEach-Object { $_.Path }) }
function Read-ManagedShortcut([string]$Path) {
  $null=Assert-LocalPath $Path
  if (!(Test-Path -LiteralPath $Path)) { return [pscustomobject]@{Exists=$false;Target='';Arguments=''} }
  $shell=New-Object -ComObject WScript.Shell
  $link=$shell.CreateShortcut($Path)
  return [pscustomobject]@{Exists=$true;Target=$link.TargetPath;Arguments=$link.Arguments}
}
function Get-ShortcutTargetVersion([string]$Target) { return [Diagnostics.FileVersionInfo]::GetVersionInfo($Target) }
function Get-ShortcutCompatibility($Location,$Link) {
  if (!$Location.Canonical -or $Link.Arguments -ne '' -or !$Link.Target -or [IO.Path]::GetFileName($Link.Target) -ine 'jotmo.exe') { throw 'Unknown shortcut identity or arguments.' }
  $target=Assert-LocalPath $Link.Target
  $root=[IO.Path]::GetDirectoryName($target)
  $drive=New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($target))
  if (!$drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Shortcut target drive is unavailable or not a fixed local disk.' }
  if (!(Test-Path -LiteralPath $target)) { return 'stale-flutter' }
  if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw 'A non-file occupies the old shortcut target.' }
  Assert-Publisher $target
  $info=Get-ShortcutTargetVersion $target
  if ($info.ProductName -cne '即我' -or $info.OriginalFilename -ine 'jotmo.exe' -or $info.FileMajorPart -ne 2) { throw 'Shortcut target is not a supported Flutter 2.x release.' }
  foreach ($item in @((Join-Path $root 'flutter_windows.dll'),(Join-Path $root 'data\flutter_assets'))) { $null=Assert-LocalPath $item }
  if (!(Test-Path -LiteralPath (Join-Path $root 'flutter_windows.dll') -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $root 'data\flutter_assets') -PathType Container)) { throw 'Unrecognized Flutter shortcut target layout.' }
  $incoming=Get-ReleaseManifest
  Assert-UpgradeAllowed $info.FileVersion ([long]$info.FilePrivatePart) $incoming.version $incoming.versionCode
  return 'verified-flutter'
}
function Test-OriginalCompatibleShortcut($Entry,$Link) {
  return $Entry.PSObject.Properties['Compatibility'] -and $Entry.Compatibility -in @('verified-flutter','stale-flutter') -and $Entry.Existed -and $Link.Exists -and $Link.Arguments -eq '' -and $Link.Target -ieq $Entry.Target -and (Get-FileHash -LiteralPath $Entry.Path -Algorithm SHA256).Hash -ieq $Entry.Hash
}
# Coexisting shared Flutter owns its links, including per-user Startup entries.
# Keep the existing Arkme links too: their executable path does not change.
function Assert-PreservedShortcuts($Legacy,[scriptblock]$ReadShortcut) {
  $allowed=@((Join-Path $Destination 'arkme.exe'),(Join-Path $Legacy.Root 'jotmo.exe'))
  foreach ($location in @(Get-ShortcutLocations)) {
    $link=& $ReadShortcut $location.Path
    if ($link.Exists -and ($link.Target -notin $allowed -or $link.Arguments -ne '')) {
      $kind=Get-ShortcutCompatibility $location $link
      Write-Host "Preserving compatible shortcut kind=$kind path=$($location.Path) target=$($link.Target)"
    }
  }
}
function Write-ShortcutPolicy {
  $preserve=[bool]$script:PreservedLegacy
  if ($preserve) { Assert-PreservedShortcuts $script:PreservedLegacy {param($p) Read-ManagedShortcut $p} }
  if ($ShortcutPolicyFile) {
    [IO.File]::WriteAllText($ShortcutPolicyFile,"[Shortcuts]`r`nPreserve="+[int]$preserve+"`r`n",[Text.Encoding]::ASCII)
  }
}
function Reconcile-InstalledShortcuts {
  $journal=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $legacyExecutable=if ($journal.Legacy) {Join-Path $journal.Legacy.Root 'jotmo.exe'} else {''}
  $newExecutable=Join-Path $Destination 'arkme.exe'
  Invoke-ShortcutReconciliation $journal.Shortcuts $newExecutable $legacyExecutable $journal.HadExistingInstall {
    param($file) Read-ManagedShortcut $file
  } {
    param($file,$target)
    $null=Assert-LocalPath $file
    $temporary=Join-Path ([IO.Path]::GetDirectoryName($file)) ('.jiwo-shortcut-'+[Guid]::NewGuid().ToString()+'.lnk')
    try {
      $shell=New-Object -ComObject WScript.Shell
      $link=$shell.CreateShortcut($temporary)
      $link.TargetPath=$target; $link.Arguments=''; $link.WorkingDirectory=$Destination
      $link.IconLocation=$target+',0'; $link.Description='即我'; $link.Save()
      $check=Read-ManagedShortcut $temporary
      if (!$check.Exists -or $check.Target -ine $target -or $check.Arguments -ne '') { throw 'New shortcut could not be staged.' }
      if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temporary,$file,[NullString]::Value) }
      else { [IO.File]::Move($temporary,$file) }
    } finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force } }
  } {
    param($file)
    $null=Assert-LocalPath $file
    Remove-Item -LiteralPath $file -Force
  }
}
function Get-ProtectedJournalBase { return (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Jiwo Installer Transactions') }
function Get-ProtectedJournalDirectory {
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $digest=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Destination.ToLowerInvariant().TrimEnd('\'))))).Replace('-','').ToLowerInvariant() } finally {$sha.Dispose()}
  return (Join-Path (Get-ProtectedJournalBase) ($sid+'-'+$digest))
}
function Initialize-JournalLocation($Legacy) {
  $script:ProtectedJournalDirectory=''
  $local=Join-Path $Destination '.jiwo-v3-transaction'
  $secure=Get-ProtectedJournalDirectory
  if ((Test-Path -LiteralPath $local) -and (Test-Path -LiteralPath $secure)) { throw 'Two recovery locations exist; preserve both for inspection.' }
  $machineSource=$Legacy -and $Legacy.Scope -eq 'all' -and $Scope -eq 'current'
  # New machine-source transactions always have administrator-protected metadata.
  # An old user-local journal is still readable for the previously supported layout.
  if ((Test-Path -LiteralPath $secure) -or ($machineSource -and !(Test-Path -LiteralPath $local))) { $script:ProtectedJournalDirectory=$secure }
}
function Get-JournalDirectory {
  if ($script:ProtectedJournalDirectory) { return $script:ProtectedJournalDirectory }
  return (Join-Path $Destination '.jiwo-v3-transaction')
}
function New-ProtectedDirectory([string]$Path,[bool]$PublicDiscovery=$false) {
  $null=Assert-LocalPath $Path
  if (Test-Path -LiteralPath $Path) { Assert-ProtectedObject $Path $false; return }
  $security=New-Object Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true,$false)
  $admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $security.SetOwner($admin)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
    $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
  if($PublicDiscovery) {
    # NSIS can discover that protected recovery exists and request UAC; contents
    # of the per-transaction children are restricted to Administrators/SYSTEM.
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))
  }
  $null=[IO.Directory]::CreateDirectory($Path,$security)
  Assert-ProtectedObject $Path $false
}
function New-JournalDirectory {
  $directory=Get-JournalDirectory
  if ($script:ProtectedJournalDirectory) {
    New-ProtectedDirectory (Get-ProtectedJournalBase) $true
    New-ProtectedDirectory $directory
  } else { $null=New-Item -ItemType Directory -Path $directory }
}

function Save-Journal($Journal) {
  $directory = Get-JournalDirectory
  $file = Join-Path $directory 'journal.json'
  $temporary = Join-Path $directory 'journal.pending'
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Journal | ConvertTo-Json -Depth 64))
  $stream = [IO.File]::Open($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temporary,$file,[NullString]::Value) }
  else { [IO.File]::Move($temporary,$file) }
}
function Test-TrustedOwnerSid([string]$Sid) {
  return $Sid -in @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
}
function Assert-ProtectedObject([string]$Path,[bool]$Ancestor) {
  $acl = Get-Acl -LiteralPath $Path
  if (!(Test-TrustedOwnerSid ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value))) { throw 'Untrusted owner on elevated migration recovery path.' }
  $dangerous = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  if (!$Ancestor) { $dangerous = $dangerous -bor [Security.AccessControl.FileSystemRights]::Write }
  # Read the stored SID directly. Access exposes localized NTAccount names;
  # converting application-package names back to SID can fail on Windows even
  # for standard read-only ACEs (S-1-15-2-1 / S-1-15-2-2).
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $dangerous) -ne 0 -and !(Test-TrustedOwnerSid $sid)) { throw 'Untrusted write, deletion, or ACL-control permission on elevated recovery path.' }
  }
}
function Assert-JournalTrust([string]$Directory) {
  $null = Assert-LocalPath $Directory
  if ($Scope -eq 'all' -or $script:ProtectedJournalDirectory) {
    # A protected directory alone is insufficient: owners can replace ACLs and files
    # can retain explicit permissions. Verify every object before reading metadata.
    Assert-ProtectedObject $Directory $false
    $cursor=[IO.Path]::GetDirectoryName($Directory); $destinationParent=$true
    while ($cursor) {
      Assert-ProtectedObject $cursor (!$destinationParent)
      $destinationParent=$false
      $parent=[IO.Path]::GetDirectoryName($cursor)
      if ($parent -eq $cursor) { break }; $cursor=$parent
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $Directory -Force)) {
      if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected object in protected migration journal.' }
      Assert-ProtectedObject $file.FullName $false
    }
  }
}
function Get-OverlayEntries([string]$Stage, [string]$UninstallerName) {
  $manifestEntries = @((Get-ReleaseManifest).files)
  $paths = @($manifestEntries | ForEach-Object { [string]$_.path }) + @($UninstallerName)
  if ($UninstallerName -ne 'Uninstall arkme.exe') { throw 'Unexpected production uninstaller name.' }
  Assert-Publisher (Join-Path $Stage $UninstallerName)
  if (Test-Path -LiteralPath (Join-Path $Stage 'uninstallerIcon.ico')) { $paths += 'uninstallerIcon.ico' }
  foreach ($relative in $paths) {
    if ($relative -match '(^[\\/]|\.\.|:)' -or $relative.StartsWith('.jiwo-')) { throw 'Invalid overlay path.' }
    $target = Assert-LocalPath (Join-Path $Destination $relative)
    $exists = Test-Path -LiteralPath $target
    if ($Scope -eq 'all') {
      $cursor=$target
      while ($cursor -and $cursor.StartsWith($Destination,[StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $cursor) { Assert-ProtectedObject $cursor $false }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
      }
    }
    if ($exists -and !(Test-Path -LiteralPath $target -PathType Leaf)) { throw 'A directory occupies an application file path.' }
    $source=Join-Path $Stage $relative
    [pscustomobject]@{ Path=$relative; Existed=$exists; Hash=$(if ($exists) {(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash} else {''}); NewHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash; NewSize=(Get-Item -LiteralPath $source).Length }
  }
}
function Assert-ElectronDestination {
  $found = $false
  $expectedHive = if ($Scope -eq 'all') { 'LocalMachine' } else { 'CurrentUser' }
  foreach ($hive in @('CurrentUser','LocalMachine')) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive,[Microsoft.Win32.RegistryView]::Registry64)
    try {
      $key = $base.OpenSubKey($ElectronKeys[0])
      if ($key) {
        try {
          if ($hive -ne $expectedHive -or [string]$key.GetValue('InstallLocation') -ine $Destination) { throw 'Existing Arkme installation must keep its original scope and directory.' }
          if ([string]$key.GetValue('ShortcutName') -notin @('arkme','即我') -or [string]$key.GetValue('MenuDirectory') -ne '') { throw 'Unknown existing Arkme shortcut layout.' }
          Assert-Publisher (Join-Path $Destination 'arkme.exe')
          $uninstallKey=$base.OpenSubKey($ElectronKeys[1])
          if (!$uninstallKey) { throw 'Incomplete existing Arkme registration.' }
          try {
            $oldCode=[long]$uninstallKey.GetValue('JiwoVersionCode',0)
            $fileVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Destination 'arkme.exe'))
            $oldCode=[Math]::Max($oldCode,[long]$fileVersion.FilePrivatePart)
            $incoming=Get-ReleaseManifest
            Assert-UpgradeAllowed ([string]$uninstallKey.GetValue('DisplayVersion')) $oldCode $incoming.version $incoming.versionCode
          } finally { $uninstallKey.Dispose() }
          $found = $true
        } finally { $key.Dispose() }
      }
    } finally { $base.Dispose() }
  }
  return $found
}
# Coexistence keeps machine-wide Flutter outside the per-user Arkme transaction.
function Select-MigrationLegacy($Legacy) {
  $script:PreservedLegacy=$null
  if ($Legacy -and $Legacy.Scope -eq 'all' -and $Scope -eq 'current') {
    if (!(Assert-ElectronDestination)) { throw 'Preserving shared Flutter requires a verified existing current-user Arkme.' }
    $profile=[Environment]::GetFolderPath('UserProfile')
    $old=Assert-LocalPath $Legacy.Root
    if (!(Test-PathWithin $Destination $profile) -or $old -ieq $Destination -or
        (Test-PathWithin $Destination $old) -or (Test-PathWithin $old $Destination)) {
      throw 'Shared Flutter and current-user Arkme directories must be separate.'
    }
    $script:PreservedLegacy=$Legacy
    Write-Host "Preserving all-user Flutter: $old; updating current-user Arkme only: $Destination"
    return $null
  }
  return $Legacy
}
function Select-OverlayEntries($Entries,[bool]$RegularUpdate) {
  foreach ($entry in $Entries) {
    # Keep the executable/uninstaller witnesses required by schema 2. Unchanged
    # assets are never mutated, so they need no backup or recovery entry.
    if (!$RegularUpdate -or !$entry.Existed -or $entry.Hash -ine $entry.NewHash -or $entry.Path -in @('arkme.exe','Uninstall arkme.exe')) { $entry }
  }
}
function Test-RegularUpdate([bool]$Existing,$Legacy) {
  if (!$Existing -or $Legacy) { return $false }
  $info=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Destination 'arkme.exe'))
  return $info.ProductName -ceq '即我' -and $info.FileMajorPart -ge 3
}
function Begin-Overlay([string]$Stage, [string]$UninstallerName, $Legacy) {
  $phaseTimer=[Diagnostics.Stopwatch]::StartNew()
  Assert-Payload $Stage $Manifest
  Write-Output ("Phase=validate-stage elapsedMs="+$phaseTimer.ElapsedMilliseconds); $phaseTimer.Restart()
  $existing = Assert-ElectronDestination
  $directory = Get-JournalDirectory
  if (Test-Path -LiteralPath $directory) { throw 'Unresolved migration recovery directory.' }
  $regular=Test-RegularUpdate $existing $Legacy
  $allEntries=@(Get-OverlayEntries $Stage $UninstallerName)
  $entries = @(Select-OverlayEntries $allEntries $regular)
  Write-Output ("Install route="+$(if($regular){'regular-update'}else{'migration'})+" totalFiles="+$allEntries.Count+" transactionFiles="+$entries.Count)
  Assert-FilesReleased $entries
  Write-Output ("Phase=plan-and-lock-check elapsedMs="+$phaseTimer.ElapsedMilliseconds); $phaseTimer.Restart()
  if (!$existing -and @($entries | Where-Object { $_.Existed }).Count) { throw 'Unregistered files occupy the destination. Choose a separate empty program directory.' }
  $shortcuts = @()
  $preserveShortcuts=[bool]$script:PreservedLegacy
  if ($preserveShortcuts) { Assert-PreservedShortcuts $script:PreservedLegacy {param($p) Read-ManagedShortcut $p} }
  foreach ($location in @(Get-ShortcutLocations $Legacy | Where-Object { !$preserveShortcuts })) {
    $file=$location.Path
    $target=''
    $compatibility=''
    $exists = Test-Path -LiteralPath $file
    if ($exists) {
      $null = Assert-LocalPath $file
      if ($Scope -eq 'all' -and $location.Role -ne 'Startup' -and $file -in @(Get-ShortcutPaths)) { Assert-ProtectedObject $file $false }
      $link=Read-ManagedShortcut $file
      $target = $link.Target
      $allowed = @((Join-Path $Destination 'arkme.exe'))
      if ($Legacy) { $allowed += (Join-Path $Legacy.Root 'jotmo.exe') }
      if ($target -notin $allowed -or $link.Arguments -ne '') {
        try { $compatibility=Get-ShortcutCompatibility $location $link }
        catch { throw "Shortcut compatibility check failed. Path=$file Target=$target Arguments=$($link.Arguments). $($_.Exception.Message)" }
        Write-Host "Shortcut compatibility=$compatibility path=$file target=$target; only the shortcut enters the transaction"
      }
    }
    if (Test-Path -LiteralPath ($file+'.jiwo-v3-restore')) { throw 'An unknown shortcut recovery temporary file already exists.' }
    $shortcuts += [pscustomobject]@{ Path=$file; Role=$location.Role; Canonical=$location.Canonical; Target=$target; Compatibility=$compatibility; Existed=$exists; Hash=$(if ($exists) {(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash} else {''}) }
  }
  $incoming=Get-ReleaseManifest
  $legacyFiles=@()
  if ($Legacy) {
    $legacyPaths=@((Join-Path $Legacy.Root 'jotmo.exe'),(Join-Path $Legacy.Root 'unins000.exe'))
    $legacyPaths+=@(Get-LegacyShortcuts $Legacy | Where-Object { $_ -notin @($shortcuts | ForEach-Object { $_.Path }) })
    foreach ($file in $legacyPaths) {
      $legacyFiles += [pscustomobject]@{Path=$file;Hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}
    }
  }
  $journal = [pscustomobject]@{ Schema=2; HadExistingInstall=([bool]($existing -or $Legacy)); InstallerVersion=$incoming.version; InstallerVersionCode=$incoming.versionCode; RegistryMetadata=$incoming.registryMetadata; Destination=$Destination; Scope=$Scope; State='preparing'; PreserveShortcuts=$preserveShortcuts; Files=$entries; Shortcuts=$shortcuts; Registry=@(Get-RegistrySnapshots $Legacy); Legacy=$Legacy; LegacyFiles=$legacyFiles }
  Assert-JournalMetadata $journal
  New-JournalDirectory
  Assert-JournalTrust $directory
  Save-Journal $journal
  for ($i=0; $i -lt $entries.Count; $i++) {
    if ($entries[$i].Existed) { Copy-DurableFile (Join-Path $Destination $entries[$i].Path) (Join-Path $directory "file-$i") }
    Copy-DurableFile (Join-Path $Stage $entries[$i].Path) (Join-Path $directory "payload-$i")
  }
  for ($i=0; $i -lt $shortcuts.Count; $i++) {
    if ($shortcuts[$i].Existed) { Copy-DurableFile $shortcuts[$i].Path (Join-Path $directory "shortcut-$i") }
  }
  # All staged/backup bytes are flushed before the active marker permits replacement.
  Write-Output ("Phase=backup-and-stage elapsedMs="+$phaseTimer.ElapsedMilliseconds); $phaseTimer.Restart()
  $journal.State = 'active'; Save-Journal $journal
  Assert-RecoveryScene $directory $journal
  Assert-FilesReleased $entries
  for ($i=0; $i -lt $entries.Count; $i++) {
    $entry=$entries[$i]
    $target = Join-Path $Destination $entry.Path
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force
    Install-StagedFile (Join-Path $directory "payload-$i") $target $entry.NewHash
  }
  # Install-StagedFile already verifies transferred bytes. Finalize performs
  # the one complete destination verification before commit/retirement.
  Write-Output ("Phase=replace-and-verify elapsedMs="+$phaseTimer.ElapsedMilliseconds)
}
function Assert-FilesReleased($Entries,[int]$WaitMilliseconds=10000) {
  $deadline=[DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
  foreach ($entry in $Entries) {
    if (!$entry.Existed -or $entry.Hash -ieq $entry.NewHash) { continue }
    $target=Join-Path $Destination $entry.Path
    while ($true) {
      try {
        $handle=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $handle.Dispose()
        break
      } catch {
        # Child processes/antivirus may release handles shortly after normal exit.
        # Only retry sharing/lock violations; permissions and unknown failures abort.
        $cause=$_.Exception.GetBaseException(); $code=$cause.HResult -band 0xffff
        if ($code -notin @(32,33) -or [DateTime]::UtcNow -ge $deadline) {
          throw "Program file is still in use or inaccessible before replacement: $target. $($cause.Message)"
        }
        Start-Sleep -Milliseconds 200
      }
    }
  }
}
function Copy-DurableFile([string]$Source,[string]$Target) {
  $inputFile=[IO.File]::OpenRead($Source)
  try {
    $outputFile=[IO.File]::Open($Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $inputFile.CopyTo($outputFile); $outputFile.Flush($true) } finally { $outputFile.Dispose() }
  } finally { $inputFile.Dispose() }
}
function Get-TransferPath([string]$Target,[string]$Hash) { return $Target+'.jiwo-v3-transfer-'+$Hash.ToLowerInvariant() }
function Install-StagedFile([string]$Source,[string]$Target,[string]$Hash) {
  $null=Assert-LocalPath $Source; $null=Assert-LocalPath $Target
  if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ine $Hash) { throw 'Staged file integrity check failed.' }
  if ((Test-Path -LiteralPath $Target -PathType Leaf) -and (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -ieq $Hash) {
    Remove-Item -LiteralPath $Source -Force
    return
  }
  # Copy to the destination volume before atomic replacement. This also gives
  # newly created files the destination's access rights, not the private journal's.
  $temporary=Get-TransferPath $Target $Hash
  $null=Assert-LocalPath $temporary
  if(Test-Path -LiteralPath $temporary){Assert-RestoreTemporary $temporary $Source;Remove-Item -LiteralPath $temporary -Force}
  Copy-DurableFile $Source $temporary
  if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ine $Hash) { throw 'Transfer integrity check failed.' }
  try {
    if (Test-Path -LiteralPath $Target) { [IO.File]::Replace($temporary,$Target,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$Target) }
  } catch { throw "Atomic replacement failed: $Target. $($_.Exception.Message)" }
  Remove-Item -LiteralPath $Source -Force
}

function Assert-JournalMetadata($Journal) {
  if ($Journal.Schema -ne 2 -or $Journal.Destination -ine $Destination -or $Journal.Scope -ne $Scope -or $Journal.State -notin @('preparing','active','committed','rolledback')) { throw 'Invalid migration recovery metadata.' }
  if ($Journal.InstallerVersion -notmatch '^\d+\.\d+\.\d+$' -or $Journal.InstallerVersionCode -le 0 -or $Journal.RegistryMetadata.displayName -cne ('即我 '+$Journal.InstallerVersion) -or !$Journal.RegistryMetadata.publisher -or !$Journal.RegistryMetadata.description) { throw 'Invalid transaction release identity.' }
  $seen=@{}
  foreach ($entry in $Journal.Files) {
    $name=([string]$entry.Path).Replace('/','\')
    if (!$name -or $name -match '(^[\\/]|\.\.|:|[\\/]{2}|(^|[\\/])\.([\\/]|$))' -or $name.StartsWith('.jiwo-',[StringComparison]::OrdinalIgnoreCase) -or $seen.ContainsKey($name) -or $entry.Existed -isnot [bool] -or $entry.NewHash -notmatch '^[a-f0-9]{64}$' -or $entry.NewSize -lt 0 -or ($entry.Existed -and $entry.Hash -notmatch '^[a-f0-9]{64}$') -or (!$entry.Existed -and $entry.Hash -ne '')) { throw 'Invalid transaction file ownership.' }
    $seen[$name]=$true
    $null=Assert-LocalPath (Join-Path $Destination $name)
  }
  if (!$seen.ContainsKey('arkme.exe') -or !$seen.ContainsKey('Uninstall arkme.exe')) { throw 'Incomplete transaction payload inventory.' }
  $locations=@(Get-ShortcutLocations)
  # Previously shipped schema-2 records used LegacyFiles for external links.
  # Accept that complete original inventory or the complete expanded inventory.
  if(@($Journal.Shortcuts).Count -ne $locations.Count){$locations=@(Get-ShortcutLocations $Journal.Legacy)}
  if ($Journal.PSObject.Properties['PreserveShortcuts']) {
    if ($Journal.PreserveShortcuts -isnot [bool]) { throw 'Invalid shortcut preservation policy.' }
    if ($Journal.PreserveShortcuts) {
      if ($Journal.Legacy -or !$Journal.HadExistingInstall -or $Journal.Scope -ne 'current') { throw 'Invalid preserved shortcut scope.' }
      $locations=@()
    }
  }
  $seen=@{}
  foreach ($entry in $Journal.Shortcuts) {
    $location=@($locations | Where-Object { $_.Path -ieq $entry.Path -and $_.Role -eq $entry.Role -and $_.Canonical -eq $entry.Canonical })
    if ($location.Count -ne 1 -or $seen.ContainsKey($entry.Path) -or $entry.Existed -isnot [bool] -or ($entry.Existed -and $entry.Hash -notmatch '^[a-f0-9]{64}$') -or (!$entry.Existed -and $entry.Hash -ne '')) { throw 'Invalid shortcut recovery location or ownership.' }
    if ($entry.PSObject.Properties['Compatibility'] -and $entry.Compatibility -ne '') {
      if ($entry.Compatibility -notin @('verified-flutter','stale-flutter') -or !$entry.Canonical -or !$entry.Existed -or [IO.Path]::GetFileName($entry.Target) -ine 'jotmo.exe') { throw 'Invalid compatible shortcut ownership.' }
      $null=Assert-LocalPath $entry.Target
    }
    $seen[$entry.Path]=$true
  }
  if ($seen.Count -ne $locations.Count) { throw 'Incomplete shortcut recovery inventory.' }
  $legacyPaths=@()
  if ($Journal.Legacy) {
    Assert-LegacyScope $Journal.Legacy $Destination $Scope $true
    $old=Assert-LocalPath $Journal.Legacy.Root
    if ($old -ieq $Destination -or $old.StartsWith($Destination+'\',[StringComparison]::OrdinalIgnoreCase) -or $Destination.StartsWith($old+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid legacy recovery location.' }
    $legacyPaths=@((Join-Path $old 'jotmo.exe'),(Join-Path $old 'unins000.exe'))
    $externalLinks=@(Get-LegacyShortcutCandidates $Journal.Legacy | Where-Object { $_ -notin @($Journal.Shortcuts | ForEach-Object { $_.Path }) })
    $legacyPaths+=@($Journal.LegacyFiles | Where-Object { $_.Path -in $externalLinks } | ForEach-Object { $_.Path })
  }
  $seen=@{}
  foreach ($entry in $Journal.LegacyFiles) {
    if ($entry.Path -notin $legacyPaths -or $seen.ContainsKey($entry.Path) -or $entry.Hash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid legacy recovery ownership.' }
    $seen[$entry.Path]=$true
  }
  if ($seen.Count -ne $legacyPaths.Count) { throw 'Incomplete legacy recovery inventory.' }
  Assert-RegistryRecoveryScope $Journal.Registry $Journal.Legacy
}
function Assert-OwnedFile([string]$Path,[string[]]$Hashes,[bool]$Required=$true) {
  $null=Assert-LocalPath $Path
  if (!(Test-Path -LiteralPath $Path)) {
    if ($Required) { throw "Missing transaction-owned file: $Path" }
    return
  }
  if (!(Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -notin $Hashes) { throw "Unknown file was preserved during recovery: $Path" }
}
function Assert-RestoreTemporary([string]$Path,[string]$Backup) {
  $null=Assert-LocalPath $Path
  if (!(Test-Path -LiteralPath $Path)) { return }
  if (!(Test-Path -LiteralPath $Path -PathType Leaf) -or !(Test-Path -LiteralPath $Backup -PathType Leaf)) { throw 'Unknown restoration temporary object.' }
  $length=(Get-Item -LiteralPath $Path).Length
  if ($length -gt (Get-Item -LiteralPath $Backup).Length) { throw 'Unknown restoration temporary contents.' }
  # A stopped CopyTo may leave only a prefix; compare it with the verified backup.
  $stream=[IO.File]::OpenRead($Backup); $hash=[Security.Cryptography.SHA256]::Create()
  try {
    $buffer=New-Object byte[] 65536
    $remaining=$length
    while ($remaining -gt 0) {
      $count=$stream.Read($buffer,0,[int][Math]::Min($buffer.Length,$remaining))
      if ($count -le 0) { throw 'Incomplete recovery backup.' }
      $null=$hash.TransformBlock($buffer,0,$count,$buffer,0); $remaining-=$count
    }
    $null=$hash.TransformFinalBlock([byte[]]@(),0,0)
    $expected=([BitConverter]::ToString($hash.Hash)).Replace('-','')
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $expected) { throw 'Unknown restoration temporary contents.' }
  } finally { $stream.Dispose(); $hash.Dispose() }
}
function Assert-JournalContents([string]$Directory,$Journal) {
  $allowed=@('journal.json','journal.pending')
  for ($i=0; $i -lt $Journal.Files.Count; $i++) {
    $entry=$Journal.Files[$i]; $allowed+="payload-$i"
    if ($entry.Existed) { $allowed+=@("file-$i","restore-$i") }
  }
  for ($i=0; $i -lt $Journal.Shortcuts.Count; $i++) { if ($Journal.Shortcuts[$i].Existed) { $allowed+="shortcut-$i" } }
  foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force)) {
    if ($item.Name -notin $allowed -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unknown files in the recovery directory were preserved; inspect them before retrying.' }
  }
  for ($i=0; $i -lt $Journal.Files.Count; $i++) {
    $entry=$Journal.Files[$i]; $backup=Join-Path $Directory "file-$i"; $payload=Join-Path $Directory "payload-$i"
    $target=Join-Path $Destination $entry.Path
    $newTransfer=Get-TransferPath $target $entry.NewHash
    if(Test-Path -LiteralPath $newTransfer){$witness=if($entry.Existed -and $entry.Hash -ieq $entry.NewHash -and !(Test-Path -LiteralPath $payload)){$backup}else{$payload};Assert-RestoreTemporary $newTransfer $witness}
    if($entry.Existed){$oldTransfer=Get-TransferPath $target $entry.Hash;if(Test-Path -LiteralPath $oldTransfer){Assert-RestoreTemporary $oldTransfer $backup}}
    if ($entry.Existed) {
      if ($Journal.State -eq 'preparing') { Assert-RestoreTemporary $backup (Join-Path $Destination $entry.Path) }
      else { Assert-OwnedFile $backup @($entry.Hash) ($Journal.State -eq 'active') }
      Assert-RestoreTemporary (Join-Path $Directory "restore-$i") $backup
    }
    if ($Journal.State -ne 'preparing') { Assert-OwnedFile $payload @($entry.NewHash) $false }
    elseif ((Test-Path -LiteralPath $payload) -and (Get-Item -LiteralPath $payload).Length -gt $entry.NewSize) { throw 'Invalid interrupted staging file.' }
  }
  for ($i=0; $i -lt $Journal.Shortcuts.Count; $i++) {
    $entry=$Journal.Shortcuts[$i]; $backup=Join-Path $Directory "shortcut-$i"
    if($entry.Existed){$transfer=Get-TransferPath $entry.Path $entry.Hash;if(Test-Path -LiteralPath $transfer){Assert-RestoreTemporary $transfer $backup}}
    if ($entry.Existed) {
      if ($Journal.State -eq 'preparing') { Assert-RestoreTemporary $backup $entry.Path }
      else { Assert-OwnedFile $backup @($entry.Hash) ($Journal.State -eq 'active') }
      Assert-RestoreTemporary ($entry.Path+'.jiwo-v3-restore') $backup
    } elseif (Test-Path -LiteralPath ($entry.Path+'.jiwo-v3-restore')) { throw 'Unexpected shortcut restoration temporary.' }
  }
}
function Assert-OverlayFiles([string]$Directory,$Entries,[string]$Root,[bool]$Preparing=$false) {
  for ($i=0; $i -lt $Entries.Count; $i++) {
    $entry=$Entries[$i]
    if ($entry.Existed -and !$Preparing) { Assert-OwnedFile (Join-Path $Directory "file-$i") @($entry.Hash) }
    $hashes=@($entry.Hash)
    if (!$Preparing) { $hashes+=@($entry.NewHash) }
    Assert-OwnedFile (Join-Path $Root $entry.Path) $hashes $entry.Existed
  }
}
function Assert-RecoveryScene([string]$Directory,$Journal) {
  Assert-JournalContents $Directory $Journal
  if ($Journal.State -notin @('preparing','active')) { return }
  Assert-OverlayFiles $Directory $Journal.Files $Destination ($Journal.State -eq 'preparing')
  foreach ($entry in $Journal.Shortcuts) {
    $link=Read-ManagedShortcut $entry.Path
    if ($link.Exists) {
      $original=$entry.Existed -and (Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash -ieq $entry.Hash
      $canCreate=$entry.Canonical -and ($entry.Role -ne 'Startup' -or @($Journal.Shortcuts | Where-Object { $_.Role -eq 'Startup' -and $_.Existed }).Count -gt 0)
      $replacement=$Journal.State -eq 'active' -and $canCreate -and $link.Target -ieq (Join-Path $Destination 'arkme.exe') -and $link.Arguments -eq ''
      if (!$original -and !$replacement) { throw 'An unknown shortcut was preserved during recovery.' }
    } elseif ($Journal.State -eq 'preparing' -and $entry.Existed) { throw 'An original shortcut disappeared before overlay.' }
    $retired=$entry.Path+$RetiredSuffix
    if (Test-Path -LiteralPath $retired) {
      if (!$entry.Existed) { throw 'Unexpected retired shortcut.' }
      Assert-OwnedFile $retired @($entry.Hash)
    }
  }
  foreach ($snapshot in $Journal.Registry) {
    $expected=@()
    if ($Journal.State -eq 'active') { $expected=@(Get-TransactionRegistryValues $Journal $snapshot.Path) }
    Assert-RegistryTransition (Read-RegistrySnapshot $snapshot) $snapshot.Node $expected ($Journal.State -eq 'active' -and $snapshot.Path -eq $ElectronKeys[1])
  }
  foreach ($entry in $Journal.LegacyFiles) {
    $active=Test-Path -LiteralPath $entry.Path; $retired=Test-Path -LiteralPath ($entry.Path+$RetiredSuffix)
    if ($active -eq $retired -or ($Journal.State -eq 'preparing' -and !$active)) { throw 'Ambiguous legacy program recovery state.' }
    $file=if ($active) {$entry.Path} else {$entry.Path+$RetiredSuffix}
    Assert-OwnedFile $file @($entry.Hash)
  }
}
function Restore-OverlayFiles($Directory,$Entries,[string]$Root) {
  Assert-OverlayFiles $Directory $Entries $Root
  for ($i=0; $i -lt $Entries.Count; $i++) {
    $entry=$Entries[$i]; $target=Join-Path $Root $entry.Path
    if ($entry.Existed) {
      $temporary=Join-Path $Directory "restore-$i"
      Assert-RestoreTemporary $temporary (Join-Path $Directory "file-$i")
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
      Copy-DurableFile (Join-Path $Directory "file-$i") $temporary
      Install-StagedFile $temporary $target $entry.Hash
    } elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
  }
}
function Remove-CommittedLegacyRetirements($Journal) {
  if ($Journal.State -ne 'committed') { throw 'Legacy cleanup requires a committed installation.' }
  # Validate the entire inventory before deleting anything. Active paths can
  # belong to a subsequently reinstalled Flutter and must never be touched.
  foreach ($entry in $Journal.LegacyFiles) {
    $retired=$entry.Path+$RetiredSuffix
    if (Test-Path -LiteralPath $retired) { Assert-OwnedFile $retired @($entry.Hash) }
  }
  foreach ($entry in $Journal.LegacyFiles) {
    $retired=$entry.Path+$RetiredSuffix
    if (Test-Path -LiteralPath $retired) {
      Assert-OwnedFile $retired @($entry.Hash)
      Remove-Item -LiteralPath $retired -Force
    }
  }
}
function Recover-Overlay([switch]$CommittedOnly) {
  $directory=Get-JournalDirectory
  if (!(Test-Path -LiteralPath $directory)) { return }
  Assert-JournalTrust $directory
  $file=Join-Path $directory 'journal.json'
  if ($CommittedOnly -and !(Test-Path -LiteralPath $file)) { throw 'Incomplete migration record; run the full installer manually.' }
  if (!(Test-Path -LiteralPath $file)) {
    # Also covers interruption between deleting the terminal journal and its directory.
    if (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) { [IO.Directory]::Delete($directory,$false); return }
    # The first durable save can stop after flushing pending but before its move.
    # No backup/staging/application writes are possible until that move succeeds.
    # Only the complete, sole preparing record can establish ownership. Incomplete
    # JSON has no reliable inventory, so preserve it (and every unknown object).
    $items=@(Get-ChildItem -LiteralPath $directory -Force)
    if ($items.Count -ne 1 -or $items[0].Name -cne 'journal.pending' -or $items[0].PSIsContainer -or ($items[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Incomplete recovery metadata; unknown transaction contents were preserved.'
    }
    $pending=Join-Path $directory 'journal.pending'
    $null=Assert-LocalPath $pending
    $initial=Get-Content -LiteralPath $pending -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-JournalMetadata $initial
    if ($initial.State -ne 'preparing') { throw 'An initial pending journal must describe an untouched preparing transaction.' }
    Assert-RecoveryScene $directory $initial
    # Atomic promotion keeps recovery repeatable even if cleanup itself stops.
    # Never synthesize an active/terminal state from a missing durable journal.
    [IO.File]::Move($pending,$file)
  }
  $journal=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-JournalMetadata $journal
  if ($CommittedOnly -and $journal.State -ne 'committed') { throw 'Unfinished migration; run the full installer manually.' }
  # This uses the original transaction's inventory, never the incoming EXE manifest.
  # Inspect the complete scene before the first recovery or cleanup mutation.
  Assert-RecoveryScene $directory $journal
  if ($journal.State -eq 'committed') { Remove-CommittedLegacyRetirements $journal }
  if ($journal.State -eq 'active') {
    Restore-OverlayFiles $directory $journal.Files $Destination
    for ($i=0; $i -lt $journal.Shortcuts.Count; $i++) {
      $entry=$journal.Shortcuts[$i]
      if ($entry.Existed) {
        $temporary=$entry.Path+'.jiwo-v3-restore'
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        Copy-DurableFile (Join-Path $directory "shortcut-$i") $temporary
        Install-StagedFile $temporary $entry.Path $entry.Hash
        $retired=$entry.Path+$RetiredSuffix
        if (Test-Path -LiteralPath $retired) { Remove-Item -LiteralPath $retired -Force }
      } elseif (Test-Path -LiteralPath $entry.Path -PathType Leaf) { Remove-Item -LiteralPath $entry.Path -Force }
    }
    Restore-RegistrySnapshots $journal.Registry $journal.Legacy
    foreach ($entry in $journal.LegacyFiles) {
      if (!(Test-Path -LiteralPath $entry.Path)) { Move-Item -LiteralPath ($entry.Path+$RetiredSuffix) -Destination $entry.Path }
    }
  }
  if ($journal.State -eq 'active') { $journal.State='rolledback'; Save-Journal $journal }
  # Remove scratch slots before their backups. A terminal state tolerates already
  # removed backups, so a second interruption during cleanup remains repeatable.
  for ($i=0; $i -lt $journal.Files.Count; $i++) {
    foreach ($name in @("restore-$i","payload-$i")) { $item=Join-Path $directory $name; if (Test-Path -LiteralPath $item -PathType Leaf) { Remove-Item -LiteralPath $item -Force } }
  }
  foreach($entry in $journal.Files) {
    foreach($hash in @($entry.NewHash,$entry.Hash) | Where-Object {$_}) {$item=Get-TransferPath (Join-Path $Destination $entry.Path) $hash;if(Test-Path -LiteralPath $item -PathType Leaf){Remove-Item -LiteralPath $item -Force}}
  }
  foreach($entry in $journal.Shortcuts){if($entry.Existed){$item=Get-TransferPath $entry.Path $entry.Hash;if(Test-Path -LiteralPath $item -PathType Leaf){Remove-Item -LiteralPath $item -Force}}}
  foreach ($entry in $journal.Shortcuts) { $item=$entry.Path+'.jiwo-v3-restore'; if (Test-Path -LiteralPath $item -PathType Leaf) { Remove-Item -LiteralPath $item -Force } }
  for ($i=0; $i -lt $journal.Files.Count; $i++) { $backup=Join-Path $directory "file-$i"; if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force } }
  for ($i=0; $i -lt $journal.Shortcuts.Count; $i++) { $backup=Join-Path $directory "shortcut-$i"; if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force } }
  foreach ($name in @('journal.pending','journal.json')) { $item=Join-Path $directory $name; if (Test-Path -LiteralPath $item -PathType Leaf) { Remove-Item -LiteralPath $item -Force } }
  [IO.Directory]::Delete($directory,$false)
}
function Assert-NewRegistration {
  $hive = if ($Scope -eq 'all') { 'LocalMachine' } else { 'CurrentUser' }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive,[Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $base.OpenSubKey($ElectronKeys[0])
    if (!$key) { throw 'New installation registration was not created.' }
    try { if ([string]$key.GetValue('InstallLocation') -ine $Destination) { throw 'New installation registration has an unexpected directory.' } } finally { $key.Dispose() }
    $key = $base.OpenSubKey($ElectronKeys[1])
    if (!$key) { throw 'New uninstall registration was not created.' }
    try {
      $incoming=Get-ReleaseManifest
      if ([string]$key.GetValue('DisplayName') -notlike '即我*' -or [string]$key.GetValue('DisplayVersion') -ne $incoming.version -or [long]$key.GetValue('JiwoVersionCode',0) -ne $incoming.versionCode) { throw 'New uninstall registration was not updated.' }
    } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Complete-Overlay {
  $file = Join-Path (Get-JournalDirectory) 'journal.json'
  $journal = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  $journal.State = 'committed'; Save-Journal $journal
}

# One admission check for the stock updater. Old releases retained committed
# journals; reuse their cleanup, but never roll back an unfinished transaction.
function Assert-NativeUpdate {
  $Destination = Assert-LocalPath $Destination
  Initialize-JournalLocation $null
  if (Test-Path -LiteralPath (Get-JournalDirectory)) {
    Recover-Overlay -CommittedOnly
  }
  $legacy=Select-MigrationLegacy (Get-LegacyInstall)
  if ($legacy) { throw 'Legacy installation remains. Run the full installer manually.' }
  $existing=Assert-ElectronDestination
  if (!(Test-RegularUpdate $existing $legacy)) { throw 'This installation requires the full manual migration installer.' }
}

# Best-effort diagnostics. Never throw through an installer/rollback boundary.
function Protect-InstallerDiagnosticText([string]$Text,[int]$Limit=12000) {
  $rules=@(
    @('(?i)(?:https?|file)://[^\s<>"\'']+','[REDACTED]'),
    @('(?i)\b(Bearer|Basic)\s+[^\s,;"\'']+','${1} [REDACTED]'),
    @('(?im)^([ \t]*(?:用户名|计算机|username|hostname|computer|machine|authorization|cookie|set-cookie|RunAs 用户|RunAs User)[ \t]*[:=][ \t]*)[^\r\n]*','${1}[REDACTED]'),
    @('(?i)(\b(?:authorization|cookie|password|passwd|token|secret|api[_-]?key|access[_-]?key|access[_-]?secret|用户名|计算机|username|hostname|computer|RunAs 用户|RunAs User)["'']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|''(?:\\.|[^''\\\r\n])*''|[^\s,;\r\n]+)','${1}[REDACTED]'),
    @('(?i)((?:[a-z]:)?[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\r\n"<>]+','${1}<user>'),
    @('(?i)(/(?:Users|home)/)[^/\r\n"<>]+','${1}<user>'),
    @('(?i)(/(?:mnt|media|Volumes)/)[^/\r\n"<>]+','${1}<volume>'),
    @('(/var/folders/)[^/\s]+/[^/\s]+','${1}<bucket>/<temp-id>'),
    @('\\\\[^\\\s]+\\[^\\\r\n"<>]+','\\<server>\<share>'),
    @('(?m)(^|[ \t=(])[A-Za-z0-9_.\-]+\\[A-Za-z0-9_.\-]+($|[ \t\r\n])','${1}<account>${2}'),
    @('(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b','[REDACTED]'),
    @('\b(?:\d{1,3}\.){3}\d{1,3}\b','[REDACTED]')
  )
  foreach ($rule in $rules) { $Text=[regex]::Replace($Text,$rule[0],$rule[1]) }
  $Text=[regex]::Replace($Text,'[\x00-\x08\x0b\x0c\x0e-\x1f]','')
  # Byte limits must agree with the backend, including Chinese messages.
  while ([Text.Encoding]::UTF8.GetByteCount($Text) -gt $Limit) { $Text=$Text.Substring(0,[Math]::Max(0,$Text.Length-128)) }
  return $Text
}
function Send-InstallerDiagnostic([string]$Json) {
  $client=$null; $content=$null; $request=$null
  try {
    Add-Type -AssemblyName System.Net.Http
    $handler=New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect=$false; $handler.UseCookies=$false
    $client=New-Object Net.Http.HttpClient($handler)
    $client.Timeout=[TimeSpan]::FromMilliseconds(1500)
    $content=New-Object Net.Http.StringContent($Json,[Text.Encoding]::UTF8,'application/json')
    $request=$client.PostAsync('https://api.jotmo.cc/api/public/v1/arkme/installer-reports',$content)
    if (!$request.Wait(1500)) { $client.CancelPendingRequests(); return $false }
    $response=$request.GetAwaiter().GetResult()
    try { return [int]$response.StatusCode -eq 202 } finally {$response.Dispose()}
  } catch { return $false }
  finally { if($content){$content.Dispose()}; if($client){$client.Dispose()} }
}
function Save-InstallerDiagnostic($Report,[string]$Directory,[scriptblock]$Send) {
  try {
    # Private local queue, separate from the rollback journal. Reject reparse paths.
    $null=Assert-LocalPath $Directory
    $null=New-Item -ItemType Directory -Path $Directory -Force
    $null=Assert-LocalPath $Directory
    $Report.details=Protect-InstallerDiagnosticText $Report.details 4096
    $Report.log=Protect-InstallerDiagnosticText $Report.log 12000
    $json=$Report | ConvertTo-Json -Depth 4 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 32768) { return }
    $file=Join-Path $Directory ($Report.event_id+'.json')
    $bytes=[Text.Encoding]::UTF8.GetBytes($json)
    $stream=New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    $items=@(Get-ChildItem -LiteralPath $Directory -File | Where-Object {$_.Name -match '^[a-f0-9]{32}\.json$'} | Sort-Object LastWriteTimeUtc -Descending)
    $index=0
    foreach ($item in $items) {
      $position=$index; $index++
      $null=Assert-LocalPath $item.FullName
      if ($item.Length -gt 32768 -or $position -ge 20 -or $item.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7)) {Remove-Item -LiteralPath $item.FullName -Force;continue}
      if ($position -lt 2) {
        try { $queued=Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch {continue}
        # Reconstruct the schema: do not upload arbitrary files/extra fields or a queued URL.
        $safe=[ordered]@{}
        foreach ($key in @('schema','event_id','platform','os_version','architecture','version','build','stage','result','error_code','recovery','scope','elapsed_ms')) {$safe[$key]=$queued.$key}
        if ($safe.os_version -notmatch '^\d{1,5}(?:\.\d{1,8}){1,3}$' -or $safe.architecture -notin @('x64','arm64') -or $safe.schema -ne 1 -or $safe.event_id -notmatch '^[a-f0-9]{32}$' -or $safe.version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$' -or $safe.build -isnot [ValueType] -or [long]$safe.build -lt 1 -or [long]$safe.build -gt 2147483647 -or $safe.elapsed_ms -isnot [ValueType] -or [long]$safe.elapsed_ms -lt 0 -or [long]$safe.elapsed_ms -gt 604800000 -or $safe.stage -notin @('Check','Prepare','Apply','Commit','Finalize','Rollback','UpdateCheck','Report') -or $safe.result -notin @('success','failure','cancelled') -or $safe.error_code -notin @('NONE','INSTALL_FAILED','SIGNATURE_CHECK_FAILED','CANCELLED') -or $safe.recovery -notin @('not_needed','completed','failed','unknown') -or $safe.scope -notin @('current','all','unknown')) {continue}
        $safe.details=Protect-InstallerDiagnosticText ([string]$queued.details) 4096
        $safe.log=Protect-InstallerDiagnosticText ([string]$queued.log) 12000
        if ($safe.event_id -ne $item.BaseName -or $safe.platform -ne 'windows') {continue}
        if (& $Send ($safe | ConvertTo-Json -Depth 4 -Compress)) {Remove-Item -LiteralPath $item.FullName -Force}
      }
    }
  } catch { Write-Output 'Installer diagnostic delivery deferred; installation result unchanged.' }
}
function Complete-InstallerDiagnostic([string]$Result,[string]$Recovery,[string]$Details,[long]$Elapsed) {
  try {
    $meta=Get-ReleaseManifest
    $code=if($Result -eq 'success'){'NONE'}elseif($Details -match '(?i)cancel|取消'){'CANCELLED'}elseif($Details -match '(?i)signature|签名'){'SIGNATURE_CHECK_FAILED'}else{'INSTALL_FAILED'}
    if($code -eq 'CANCELLED'){$Result='cancelled'}
    $diagnosticLog=$Details
    if (Test-Path -LiteralPath $log -PathType Leaf) {
      $inputFile=[IO.File]::Open($log,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
      try {
        $null=$inputFile.Seek([Math]::Max(0,$inputFile.Length-16000),[IO.SeekOrigin]::Begin)
        $buffer=New-Object byte[] 16000; $read=$inputFile.Read($buffer,0,$buffer.Length)
        $diagnosticLog=[Text.Encoding]::UTF8.GetString($buffer,0,$read)
      } finally {$inputFile.Dispose()}
    }
    $report=[ordered]@{schema=1;event_id=[guid]::NewGuid().ToString('N');platform='windows';os_version=[Environment]::OSVersion.Version.ToString();architecture='x64';version=[string]$meta.version;build=[long]$meta.versionCode;stage=$Action;result=$Result;error_code=$code;recovery=$Recovery;scope=$Scope;elapsed_ms=$Elapsed;details=$Details;log=$diagnosticLog}
    $directory=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Jiwo Installer Reports'
    Save-InstallerDiagnostic $report $directory {param($json) Send-InstallerDiagnostic $json}
  } catch { Write-Output 'Installer diagnostics unavailable; installation result unchanged.' }
}

if ($Action -eq 'Library') { return }
$timer=[Diagnostics.Stopwatch]::StartNew()
$log=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-install-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+$PID+'.log')
$transcribing=$false
$diagnosticResult=if($FailureContext -eq 'NSIS'){'failure'}else{'success'}; $diagnosticRecovery='not_needed'; $diagnosticDetails=if($FailureContext -eq 'NSIS'){'NSIS installation failed; recovery requested.'}else{''}
try { Start-Transcript -LiteralPath $log -ErrorAction Stop | Out-Null; $transcribing=$true } catch { Write-Warning 'Could not create installer diagnostic transcript.' }
try {
  Write-Output "Migration action=$Action scope=$Scope destination=$Destination log=$log"

  if ($Action -eq 'Report') { exit 0 }
  if ($Action -eq 'UpdateCheck') {
    Assert-NativeUpdate
    Write-ShortcutPolicy
    if (!$script:PreservedLegacy) {
      foreach ($location in @(Get-ShortcutLocations)) {
        $link=Read-ManagedShortcut $location.Path
        if ($link.Exists -and ($link.Target -ine (Join-Path $Destination 'arkme.exe') -or $link.Arguments -ne '')) { throw 'Shortcut migration requires the full installer; automatic update preserved the existing entry.' }
      }
    }
    Write-Output 'Install route=native-update admission=passed'
    exit 0
  }
  $os=Get-CimInstance Win32_OperatingSystem
  $processor=Get-CimInstance Win32_Processor | Select-Object -First 1
  Assert-WindowsCompatibility ([version]$os.Version) ([int]$processor.Architecture)
  $release=Get-ReleaseManifest
  $Destination = Assert-LocalPath $Destination
  # Recover any existing transaction before validating the replacement destination.
  Initialize-JournalLocation $null
  if ($Action -in @('Check','Prepare','Rollback')) {
    if (Test-Path -LiteralPath (Get-JournalDirectory)) { Stop-Normally @($Destination); Recover-Overlay }
    if ($Action -eq 'Rollback') { $diagnosticRecovery='completed'; exit 0 }
  }
  $discovered=Get-LegacyInstall
  Write-Host ("Legacy discovery="+$(if($discovered){"scope=$($discovered.Scope) root=$($discovered.Root) hive=$($discovered.Hive) view=$($discovered.View)"}else{'none'})+" targetScope=$Scope target=$Destination")
  $legacy = Select-MigrationLegacy $discovered
  Initialize-JournalLocation $legacy
  Write-ShortcutPolicy
  $roots = @($Destination)
  if ($script:PreservedLegacy) { $roots += $script:PreservedLegacy.Root }
  if ($null -ne $legacy) {
    Assert-Legacy $legacy $Destination $Scope
    $roots += $legacy.Root
  }
  if ($Action -in @('Check','Prepare')) { $null=Assert-ElectronDestination }
  Stop-Normally $roots
  if ($Action -in @('Prepare','Check')) { Assert-DiskCapacity }
  if ($Action -eq 'Apply') {
    Begin-Overlay $Stage $UninstallerName $legacy
  } elseif ($Action -eq 'Commit') {
    Assert-Payload $Destination $Manifest
  } elseif ($Action -eq 'Finalize') {
    Assert-NewRegistration
    Assert-Payload $Destination $Manifest
    Reconcile-InstalledShortcuts
    if ($null -ne $legacy) {
      $shortcuts = @(Get-LegacyShortcuts $legacy)
      $journal=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      Assert-JournalMetadata $journal
      $retireFiles=@((Join-Path $legacy.Root 'jotmo.exe'),(Join-Path $legacy.Root 'unins000.exe')) + $shortcuts
      foreach ($file in $retireFiles) {
        $owned=@(@($journal.LegacyFiles)+@($journal.Shortcuts) | Where-Object { $_.Path -ieq $file })
        if ($owned.Count -ne 1) { throw 'Legacy retirement file was not captured by this transaction.' }
        Assert-OwnedFile $file @($owned[0].Hash)
      }
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($legacy.Hive,$legacy.View)
      try {
        # Open writable before retiring files to fail before mutation on insufficient permissions.
        $check = $base.OpenSubKey($LegacyKey,$true)
        if ($null -eq $check) { throw 'Legacy registration changed during installation.' }
        if ((Assert-LocalPath ([string]$check.GetValue('InstallLocation'))) -ine $legacy.Root -or $check.SubKeyCount -ne 0) { $check.Dispose(); throw 'Legacy registration changed during installation.' }
        $check.Dispose()
        Invoke-Retirement $retireFiles { $base.DeleteSubKey($LegacyKey,$true) }
      } finally { $base.Dispose() }
    }
    Complete-Overlay
    if ($CompletionFile) { [IO.File]::WriteAllText($CompletionFile,[string]$release.versionCode,[Text.Encoding]::ASCII) }
    try {
      $committed=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      Recover-Overlay -CommittedOnly
    } catch { Write-Warning ('Installation committed; retirement cleanup will retry on the next install: '+$_.Exception.Message) }
  } elseif ($null -ne $legacy) { $null = @(Get-LegacyShortcuts $legacy) }
  exit 0
} catch {
  $failure = $_
  $message = $failure.Exception.Message
  $failureTrace = $failure.ScriptStackTrace
  $diagnosticResult='failure'
  if ($Action -eq 'Rollback') {$diagnosticRecovery='failed'}
  if ($Action -in @('Apply','Commit','Finalize')) {
    try { Recover-Overlay; $diagnosticRecovery='completed' } catch { $diagnosticRecovery='failed'; $message += ' Recovery: '+$_.Exception.Message }
  }
  $diagnosticDetails=$message+"`n"+$failureTrace
  $report = "完整日志：$log`r`n$message`r`nFailed at: $failureTrace`r`n"
  if ($ErrorFile) {
    try { [IO.File]::WriteAllText($ErrorFile,$report,[Text.Encoding]::Unicode) }
    catch { Write-Warning ('Could not write installer error report: '+$_.Exception.Message) }
  }
  Write-Output ('Failed at: '+$failureTrace)
  Write-Error $message -ErrorAction Continue
  exit 1
}
finally {
  Write-Output ('Migration action='+$Action+' elapsedMs='+$timer.ElapsedMilliseconds)
  if ($transcribing) { try { Stop-Transcript | Out-Null } catch {} }
  # Recovery and completion markers are already final before any network attempt.
  if ($diagnosticResult -ne 'success' -or $Action -in @('Check','Finalize','Rollback','UpdateCheck','Report')) {
    Complete-InstallerDiagnostic $diagnosticResult $diagnosticRecovery $diagnosticDetails $timer.ElapsedMilliseconds
  }
}
