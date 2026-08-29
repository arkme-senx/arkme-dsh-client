param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$InstallDirectory,
  [string]$ScreenshotPath = "",
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InstallerPath)) {
  throw "Windows installer does not exist: $InstallerPath"
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ArkmeInstallerUiNative {
  public delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr window, out Rect rect);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(
    IntPtr parent,
    EnumWindowProc callback,
    IntPtr parameter
  );

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(
    IntPtr window,
    StringBuilder className,
    int maximumLength
  );

  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(
    IntPtr window,
    uint message,
    IntPtr wordParameter,
    IntPtr longParameter
  );

  public static IntPtr FindVisibleListView(IntPtr parent) {
    IntPtr result = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr window, IntPtr parameter) {
      StringBuilder className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      if (className.ToString() == "SysListView32" && IsWindowVisible(window)) {
        result = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$installerProcessName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedInstaller)
$probeStartedAt = Get-Date
$launcher = Start-Process `
  -FilePath $resolvedInstaller `
  -ArgumentList "/D=$InstallDirectory" `
  -PassThru

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $installerProcess = $null

  while ((Get-Date) -lt $deadline -and $null -eq $installerProcess) {
    $installerProcess = Get-Process -Name $installerProcessName -ErrorAction SilentlyContinue |
      Where-Object {
        $_.StartTime -ge $probeStartedAt.AddSeconds(-2) -and
        $_.MainWindowHandle -ne [IntPtr]::Zero
      } |
      Select-Object -First 1

    if ($null -eq $installerProcess) {
      Start-Sleep -Milliseconds 100
    }
  }

  if ($null -eq $installerProcess) {
    throw "Windows installer did not expose a visible window within $TimeoutSeconds seconds"
  }

  Start-Sleep -Milliseconds 500
  $installerProcess.Refresh()
  $window = $installerProcess.MainWindowHandle
  $rect = New-Object ArkmeInstallerUiNative+Rect
  if (-not [ArkmeInstallerUiNative]::GetWindowRect($window, [ref]$rect)) {
    throw "Unable to read the Windows installer window bounds"
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $detailsControl = [ArkmeInstallerUiNative]::FindVisibleListView($window)
  $detailsVisible = `
    $detailsControl -ne [IntPtr]::Zero -and `
    [ArkmeInstallerUiNative]::IsWindowVisible($detailsControl)
  $detailsItemCount = 0

  if ($detailsVisible) {
    $detailsDeadline = (Get-Date).AddSeconds(5)
    do {
      $detailsItemCount = [ArkmeInstallerUiNative]::SendMessage(
        $detailsControl,
        0x1004,
        [IntPtr]::Zero,
        [IntPtr]::Zero
      ).ToInt32()
      if ($detailsItemCount -eq 0) {
        Start-Sleep -Milliseconds 100
      }
    } while ($detailsItemCount -eq 0 -and (Get-Date) -lt $detailsDeadline)
  }

  if ($ScreenshotPath -ne "") {
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
      } finally {
        $graphics.Dispose()
      }
      $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $bitmap.Dispose()
    }
  }

  $result = [pscustomobject]@{
    width = $width
    height = $height
    detailsVisible = $detailsVisible
    detailsItemCount = $detailsItemCount
    screenshot = $ScreenshotPath
  }
  $result | ConvertTo-Json -Compress

  if ($height -lt 320 -or -not $detailsVisible -or $detailsItemCount -lt 1) {
    throw "Windows installer is missing visible installation details (height=$height, detailsVisible=$detailsVisible, detailsItemCount=$detailsItemCount)"
  }
} finally {
  Get-Process -Name $installerProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -ge $probeStartedAt.AddSeconds(-2) } |
    Stop-Process -Force -ErrorAction SilentlyContinue

  if (-not $launcher.HasExited) {
    Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
  }
}
