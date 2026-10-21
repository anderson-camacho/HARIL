# HARIL remote installer for Windows PowerShell 5.1+.
# Published at: https://raw.githubusercontent.com/anderson-camacho/HARIL/main/scripts/install-online.ps1
# Downloads temporary source, invokes the normal installer, and never modifies a user's git checkout.
param(
  [switch]$NoGentleShell,
  [switch]$NoPath,
  [switch]$KeepSource,
  [string]$Ref = "main"
)
$ErrorActionPreference = "Stop"
$repo = "https://github.com/anderson-camacho/HARIL.git"
$release = "gentle-pi@4.1.0"
$root = Join-Path $env:TEMP ("haril-remote-" + [guid]::NewGuid().ToString("N"))
$source = Join-Path $root "source"
$zip = Join-Path $root "source.zip"
New-Item -ItemType Directory -Path $root -Force | Out-Null

function Run-Git([string[]] $GitArgs) {
  & git -c http.version=HTTP/1.1 @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

function Download-Archive {
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    $url = "https://codeload.github.com/anderson-camacho/HARIL/zip/refs/heads/$Ref"
    & curl.exe --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 --output $zip $url
    if ($LASTEXITCODE -eq 0 -and (Test-Path $zip) -and (Get-Item $zip).Length -gt 1000) {
      try {
        Expand-Archive -LiteralPath $zip -DestinationPath $root -ErrorAction Stop
        $folder = Get-ChildItem $root -Directory | Where-Object { $_.Name -like "HARIL-*" } | Select-Object -First 1
        if ($folder) { return $folder.FullName }
      } catch {
        Write-Warning "Downloaded archive could not be extracted: $($_.Exception.Message)"
      }
    }
  }
  return $null
}

function Download-Git {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Archive download failed and git was not found. Check GitHub access or install Git."
  }
  New-Item -ItemType Directory -Path $source -Force | Out-Null
  Run-Git -GitArgs @("-C", $source, "init", "--quiet")
  Run-Git -GitArgs @("-C", $source, "remote", "add", "origin", $repo)
  $downloaded = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & git -c http.version=HTTP/1.1 -C $source fetch --quiet --no-tags --depth 1 origin $Ref
    if ($LASTEXITCODE -eq 0) { $downloaded = $true; break }
    Write-Warning "GitHub download attempt $attempt failed."
    Start-Sleep -Seconds (2 * $attempt)
  }
  if (-not $downloaded) { throw "Unable to download HARIL from GitHub after three attempts." }
  Run-Git -GitArgs @("-C", $source, "checkout", "--quiet", "--detach", "FETCH_HEAD")
  return $source
}

function Add-HarilToUserPath {
  $bin = Join-Path $env:LOCALAPPDATA "HARIL\bin"
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
  try {
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    try { $kind = $key.GetValueKind("Path") } catch [System.IO.IOException] {}
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $already = @($raw -split ';' | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') }).Count -gt 0
    if (-not $already) {
      $newPath = if ([string]::IsNullOrWhiteSpace($raw)) { $bin } else { $raw.TrimEnd(';') + ";" + $bin }
      $key.SetValue("Path", $newPath, $kind)
      # Notify Explorer and new terminals without changing REG_EXPAND_SZ into REG_SZ.
      try {
        if (-not ("HarilEnvironmentNotifier" -as [type])) {
          Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HarilEnvironmentNotifier {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hwnd, uint message, UIntPtr wParam, string lParam,
    uint flags, uint timeout, out UIntPtr result);
}
'@
        }
        $result = [UIntPtr]::Zero
        [void][HarilEnvironmentNotifier]::SendMessageTimeout(
          [IntPtr]65535, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
      } catch {
        Write-Warning "PATH was saved, but Windows was not notified. Sign out and back in if a new terminal cannot find haril."
      }
      Write-Host "Added $bin to the current user's PATH (open a new terminal)."
    }
    if (-not (@($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') }).Count -gt 0)) {
      $env:Path += ";" + $bin
    }
  } finally { $key.Close() }
}

try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node 24.21+ is required. Install it from https://nodejs.org/en/download, then retry."
  }
  if (-not ($Ref -match '^[a-zA-Z0-9._/-]+$' ) -or $Ref.Contains("..")) {
    throw "Invalid source ref."
  }
  Write-Host "HARIL installer: fetching $Ref into a temporary directory (no local clone required)."
  $checkout = Download-Archive
  if (-not $checkout) {
    Write-Warning "GitHub ZIP unavailable; retrying with Git over HTTP/1.1."
    $checkout = Download-Git
  }
  $installer = Join-Path $checkout "install.cmd"
  if (-not (Test-Path $installer)) { throw "Source does not contain install.cmd; refusing to continue." }
  & $installer
  if ($LASTEXITCODE -ne 0) { throw "HARIL installer failed with exit code $LASTEXITCODE." }

  if (-not $NoPath) { Add-HarilToUserPath }
  $haril = Join-Path $env:LOCALAPPDATA "HARIL\bin\haril.cmd"
  & $haril --version
  if ($LASTEXITCODE -ne 0) { throw "Installed HARIL launcher did not pass the version check." }

  if (-not $NoGentleShell) {
    if (Get-Command gentle-shell -ErrorAction SilentlyContinue) {
      Write-Host "Gentle Shell is already installed; leaving it and its settings unchanged."
    } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
      Write-Host "Installing standalone Gentle Shell ($release); no changes to Pi's settings."
      & npm install --global $release --no-fund --no-audit
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "HARIL installed; Gentle Shell installation failed. Retry: npm install -g $release"
      }
    } else {
      Write-Warning "HARIL installed; npm not found, so Gentle Shell was not installed."
    }
    Write-Host "Gentle AI companion is bundled with gentle-pi. A standalone gentle-ai CLI is managed separately."
  }
  Write-Host "Ready. Open a NEW terminal: haril --version; haril doctor; haril update"
} finally {
  if ($KeepSource) {
    Write-Host "Temporary checkout kept at $root"
  } elseif (Test-Path $root) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
