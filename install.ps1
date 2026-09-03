param(
  [switch]$Uninstall,
  [switch]$Help
)

& {
  param(
    [switch]$Uninstall,
    [switch]$Help
  )

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Action = if ($Uninstall) { "uninstall" } else { "install" }
$Progress = @{ Current = 0; Total = 0 }
$MarkerText = "managed by getclarvis/clarvis installer"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Fail([string]$Message) {
  throw "clarvis $Action failed: $Message"
}

function Write-Step([string]$Message) {
  $Progress.Current += 1
  Write-Output "[$($Progress.Current)/$($Progress.Total)] $Message"
}

function Show-Usage {
  Write-Output "Usage: install.ps1 [-Uninstall] [-Help]"
  Write-Output ""
  Write-Output "  (no option)  Install or reinstall the selected Clarvis release."
  Write-Output "  -Uninstall   Remove only the managed application files, launcher, and user PATH entry."
  Write-Output "  -Help        Show this help."
  Write-Output ""
  Write-Output "Uninstall preserves Clarvis configuration, credentials, sessions, and project data."
}

function Test-ManagedLauncher([string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $Item = Get-Item -LiteralPath $Path -Force
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $Item.Length -gt 8192) {
      return $false
    }
    $Lines = (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop) -split "`r?`n"
    return ($Lines -ccontains "rem $MarkerText")
  } catch {
    return $false
  }
}

function Test-PathEntry([string]$Path) {
  return ($null -ne (Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue))
}

function Assert-ReplaceableFile([string]$Path, [string]$Description) {
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $Item) { return }
  if ($Item.PSIsContainer -or ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "$Path is not a regular $Description"
  }
}

function Remove-EmptyDirectory([string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Container)) { return }
  try {
    [System.IO.Directory]::Delete($Path, $false)
  } catch [System.IO.IOException] {
    return
  }
}

function Open-OperationLock([string]$InstallRoot) {
  $LockPath = Join-Path $InstallRoot "update.lock"
  try {
    $Handle = [System.IO.File]::Open(
      $LockPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    Fail "another Clarvis install, update, or uninstall is active; if it crashed, remove $LockPath"
  }
  $Bytes = [System.Text.Encoding]::UTF8.GetBytes("$PID $Action`n")
  $Handle.Write($Bytes, 0, $Bytes.Length)
  $Handle.Flush($true)
  return $Handle
}

function Close-OperationLock([System.IO.FileStream]$Handle, [switch]$BestEffort) {
  $LockPath = $Handle.Name
  $Handle.Dispose()
  if ($BestEffort) {
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  } else {
    Remove-Item -LiteralPath $LockPath -Force
  }
}

if ($Help) {
  Show-Usage
  return
}

$InstallRoot = if ($env:CLARVIS_INSTALL_ROOT) { $env:CLARVIS_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Clarvis" }
$Bin = Join-Path $InstallRoot "bin"
$Launcher = Join-Path $Bin "clarvis.cmd"
$Marker = Join-Path $InstallRoot ".clarvis-managed-install"

if ($Uninstall) {
  $Progress.Total = 3
  Write-Output "Clarvis uninstaller"
  Write-Output "install root: $InstallRoot"
  Write-Output "launcher: $Launcher"
  Write-Step "Checking that the installation is managed by Clarvis"

  if (!(Test-PathEntry $InstallRoot)) {
    Write-Output "Clarvis is not installed at $InstallRoot; nothing to remove."
    return
  }

  $RootItem = Get-Item -LiteralPath $InstallRoot -Force
  if (!$RootItem.PSIsContainer) { Fail "$InstallRoot exists and is not a directory" }
  if (($RootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "$InstallRoot is a reparse point; inspect it manually"
  }

  $LauncherIsManaged = Test-ManagedLauncher $Launcher
  $MarkerIsManaged = $false
  if (Test-PathEntry $Marker) {
    $MarkerItem = Get-Item -LiteralPath $Marker -Force
    if ($MarkerItem.PSIsContainer -or ($MarkerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "$Marker is not a regular managed marker"
    }
    if ($MarkerItem.Length -gt 128) { Fail "$Marker is too large to be a managed marker" }
    $MarkerValue = (Get-Content -LiteralPath $Marker -Raw).TrimEnd([char[]]"`r`n")
    if ($MarkerValue -cne $MarkerText) { Fail "$InstallRoot has an invalid managed marker" }
    $MarkerIsManaged = $true
  }

  $LegacyIsManaged = $false
  $Current = Join-Path $InstallRoot "current"
  if (!$MarkerIsManaged -and $LauncherIsManaged -and (Test-Path -LiteralPath $Current -PathType Leaf)) {
    $CurrentItem = Get-Item -LiteralPath $Current -Force
    if (($CurrentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and $CurrentItem.Length -le 128) {
      $CurrentTag = (Get-Content -LiteralPath $Current -Raw).Trim()
      $ReleaseManifest = Join-Path $InstallRoot "versions\$CurrentTag\release.json"
      if ($CurrentTag -cmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' -and
          (Test-Path -LiteralPath $ReleaseManifest -PathType Leaf)) {
        $LegacyIsManaged = $true
      }
    }
  }
  $LauncherOnlyIsManaged = $false
  if (!$MarkerIsManaged -and !$LegacyIsManaged) {
    $Versions = Join-Path $InstallRoot "versions"
    if (!(Test-PathEntry $Marker) -and
        !(Test-PathEntry $Current) -and
        !(Test-PathEntry $Versions)) {
      if ($LauncherIsManaged) {
        $LauncherOnlyIsManaged = $true
      } else {
        if (Test-PathEntry $Launcher) {
          Write-Output "left unrelated launcher unchanged: $Launcher"
        }
        Write-Output "No managed Clarvis installation remains at $InstallRoot; nothing to remove."
        return
      }
    } else {
      Fail "$InstallRoot is not an authenticated Clarvis installation; no files were removed"
    }
  }

  Write-Step "Acquiring the shared install and update lock"
  $OperationLock = $null
  try {
    $OperationLock = Open-OperationLock $InstallRoot
    Write-Step "Removing managed releases, launcher, and PATH entry"

    Assert-ReplaceableFile $Current "activation file"
    if (Test-PathEntry $Bin) {
      $BinItem = Get-Item -LiteralPath $Bin -Force
      if (!$BinItem.PSIsContainer -or ($BinItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "$Bin is not a regular managed directory; inspect it manually"
      }
    }
    $Versions = Join-Path $InstallRoot "versions"
    if (Test-PathEntry $Versions) {
      $VersionsItem = Get-Item -LiteralPath $Versions -Force
      if (!$VersionsItem.PSIsContainer -or ($VersionsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "$Versions is not a regular managed directory; inspect it manually"
      }
      Remove-Item -LiteralPath $Versions -Recurse -Force
    }
    Remove-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue

    if (Test-ManagedLauncher $Launcher) {
      Remove-Item -LiteralPath $Launcher -Force
    } elseif (Test-PathEntry $Launcher) {
      Write-Output "left unrelated launcher unchanged: $Launcher"
    }
    Remove-EmptyDirectory $Bin

    if ($env:CLARVIS_SKIP_PATH -ne "1") {
      $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
      $Entries = @($UserPath -split ";" | Where-Object { $_ })
      $FilteredEntries = @($Entries | Where-Object { $_ -ine $Bin })
      if ($FilteredEntries.Count -ne $Entries.Count) {
        [Environment]::SetEnvironmentVariable("Path", ($FilteredEntries -join ";"), "User")
        Write-Output "removed $Bin from the user PATH"
      }
    }

    Remove-Item -LiteralPath $Marker -Force -ErrorAction SilentlyContinue
    Close-OperationLock $OperationLock
    $OperationLock = $null
  } finally {
    if ($null -ne $OperationLock) { Close-OperationLock $OperationLock -BestEffort }
  }

  Remove-EmptyDirectory $InstallRoot
  if (Test-PathEntry $InstallRoot) {
    Write-Output "kept $InstallRoot because it contains files not owned by the installer"
  }

  if ($LauncherOnlyIsManaged) {
    Write-Output "uninstalled the stale Clarvis launcher"
  } else {
    Write-Output "uninstalled Clarvis"
  }
  Write-Output "Clarvis configuration, credentials, sessions, and project data were preserved."
  return
}

$Version = if ($env:CLARVIS_VERSION) { $env:CLARVIS_VERSION } else { "0.0.4-beta" }
$Repository = if ($env:CLARVIS_RELEASE_REPOSITORY) { $env:CLARVIS_RELEASE_REPOSITORY } else { "getclarvis/clarvis-releases" }
if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') {
  Fail "CLARVIS_VERSION must be an exact release version"
}

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$Target = switch ($Architecture) {
  "X64" { "windows-x64" }
  "Arm64" { "windows-arm64" }
  default { Fail "unsupported architecture $Architecture" }
}
$Tag = "v$Version"
$Asset = "clarvis-$Tag-$Target.tar.gz"
$BaseUrl = if ($env:CLARVIS_RELEASE_BASE_URL) {
  $env:CLARVIS_RELEASE_BASE_URL.TrimEnd("/")
} else {
  "https://github.com/$Repository/releases/download/$Tag"
}

if (Test-PathEntry $InstallRoot) {
  $RootItem = Get-Item -LiteralPath $InstallRoot -Force
  if (!$RootItem.PSIsContainer) { Fail "$InstallRoot exists and is not a directory" }
  if (($RootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "$InstallRoot is a reparse point"
  }
}
Assert-ReplaceableFile $Marker "managed marker"
Assert-ReplaceableFile (Join-Path $InstallRoot "current") "activation file"
if ((Test-PathEntry $Launcher) -and !(Test-ManagedLauncher $Launcher)) {
  Fail "refusing to overwrite the unmanaged launcher at $Launcher"
}

$Progress.Total = 8
Write-Output "Clarvis installer"
Write-Output "version: $Version"
Write-Output "target: $Target"
Write-Output "install root: $InstallRoot"
Write-Output "launcher: $Launcher"
Write-Step "Detected the $Target release target"
Write-Step "Preparing a private staging directory"
$Temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("clarvis-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Temporary | Out-Null
$OriginalInstallRootEnvironment = $env:CLARVIS_INSTALL_ROOT
$OperationLock = $null
$CurrentTemporary = $null
$LauncherTemporary = $null
$MarkerTemporary = $null
try {
  $Archive = Join-Path $Temporary $Asset
  $Checksums = Join-Path $Temporary "SHA256SUMS"
  Write-Step "Obtaining release checksums"
  if ($env:CLARVIS_RELEASE_DIRECTORY) {
    Copy-Item (Join-Path $env:CLARVIS_RELEASE_DIRECTORY "SHA256SUMS") $Checksums
  } else {
    Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $Checksums -UseBasicParsing
  }
  Write-Step "Obtaining $Asset"
  if ($env:CLARVIS_RELEASE_DIRECTORY) {
    Copy-Item (Join-Path $env:CLARVIS_RELEASE_DIRECTORY $Asset) $Archive
  } else {
    Invoke-WebRequest -Uri "$BaseUrl/$Asset" -OutFile $Archive -UseBasicParsing
  }

  Write-Step "Verifying the archive SHA-256 checksum"
  $Pattern = "^(?<hash>[0-9a-f]{64})  " + [regex]::Escape($Asset) + "$"
  $Matches = @(Get-Content $Checksums | ForEach-Object {
    if ($_ -match $Pattern) { $Matches.hash }
  })
  if ($Matches.Count -ne 1) { Fail "SHA256SUMS has no unique SHA-256 entry for $Asset" }
  $Actual = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Matches[0]) { Fail "archive SHA-256 does not match SHA256SUMS" }

  Write-Step "Extracting the verified archive"
  $Extracted = Join-Path $Temporary "extracted"
  New-Item -ItemType Directory -Path $Extracted | Out-Null
  & tar.exe -xzf $Archive -C $Extracted
  if ($LASTEXITCODE -ne 0) { Fail "tar failed to extract the Clarvis archive" }
  $Payload = Join-Path $Extracted "clarvis"
  $Runtime = Join-Path $Payload "runtime\bun.exe"
  $Entry = Join-Path $Payload "packages\code\src\cli.ts"
  $Manifest = Join-Path $Payload "release.json"
  if (!(Test-Path $Runtime -PathType Leaf) -or !(Test-Path $Entry -PathType Leaf) -or !(Test-Path $Manifest -PathType Leaf)) {
    Fail "archive payload is incomplete"
  }

  Write-Step "Testing staged Clarvis $Version"
  $env:CLARVIS_INSTALL_ROOT = $InstallRoot
  $Reported = (& $Runtime $Entry --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $Reported -ne "clarvis $Version") {
    Fail "staged Clarvis reported an unexpected version"
  }

  Write-Step "Activating Clarvis $Version"
  if (Test-Path -LiteralPath $InstallRoot) {
    $RootItem = Get-Item -LiteralPath $InstallRoot -Force
    if (!$RootItem.PSIsContainer) { Fail "$InstallRoot exists and is not a directory" }
    if (($RootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "$InstallRoot is a reparse point"
    }
  }
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  if (Test-PathEntry $Bin) {
    $BinItem = Get-Item -LiteralPath $Bin -Force
    if (!$BinItem.PSIsContainer -or ($BinItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "$Bin is not a regular managed directory"
    }
  } else {
    New-Item -ItemType Directory -Path $Bin | Out-Null
  }
  $OperationLock = Open-OperationLock $InstallRoot
  Assert-ReplaceableFile $Marker "managed marker"
  Assert-ReplaceableFile (Join-Path $InstallRoot "current") "activation file"
  if ((Get-Item -LiteralPath $Launcher -Force -ErrorAction SilentlyContinue) -and
      !(Test-ManagedLauncher $Launcher)) {
    Fail "refusing to overwrite the unmanaged launcher at $Launcher"
  }

  $Versions = Join-Path $InstallRoot "versions"
  $Destination = Join-Path $Versions $Tag
  if (Test-PathEntry $Versions) {
    $VersionsItem = Get-Item -LiteralPath $Versions -Force
    if (!$VersionsItem.PSIsContainer -or ($VersionsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "$Versions is not a regular managed directory"
    }
  } else {
    New-Item -ItemType Directory -Path $Versions | Out-Null
  }
  if (Test-PathEntry $Destination) {
    $DestinationItem = Get-Item -LiteralPath $Destination -Force
    if (!$DestinationItem.PSIsContainer -or
        ($DestinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "$Destination exists and is not a regular directory"
    }
    $ExistingManifest = Join-Path $Destination "release.json"
    if (!(Test-Path $ExistingManifest -PathType Leaf) -or
        (Get-FileHash $Manifest -Algorithm SHA256).Hash -ne (Get-FileHash $ExistingManifest -Algorithm SHA256).Hash) {
      Fail "$Destination contains a different build"
    }
  } else {
    Move-Item -Path $Payload -Destination $Destination
  }

  $MarkerTemporary = Join-Path $InstallRoot (".managed-" + [guid]::NewGuid())
  [System.IO.File]::WriteAllText($MarkerTemporary, "$MarkerText`n", $Utf8NoBom)
  Assert-ReplaceableFile $Marker "managed marker"
  Move-Item -Force -Path $MarkerTemporary -Destination $Marker
  $MarkerTemporary = $null

  $CurrentTemporary = Join-Path $InstallRoot (".current-" + [guid]::NewGuid())
  [System.IO.File]::WriteAllText($CurrentTemporary, "$Tag`n", $Utf8NoBom)
  Assert-ReplaceableFile (Join-Path $InstallRoot "current") "activation file"
  Move-Item -Force -Path $CurrentTemporary -Destination (Join-Path $InstallRoot "current")
  $CurrentTemporary = $null

  $LauncherText = @"
@echo off
rem managed by getclarvis/clarvis installer
setlocal EnableExtensions DisableDelayedExpansion
set "CLARVIS_INSTALL_ROOT=%~dp0.."
set /p CLARVIS_CURRENT=<"%CLARVIS_INSTALL_ROOT%\current"
setlocal EnableDelayedExpansion
if not "!CLARVIS_CURRENT:~0,1!"=="v" goto clarvis_invalid_release
if "!CLARVIS_CURRENT!"=="v" goto clarvis_invalid_release
for /f "delims=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-" %%A in ("!CLARVIS_CURRENT!") do goto clarvis_invalid_release
endlocal
"%CLARVIS_INSTALL_ROOT%\versions\%CLARVIS_CURRENT%\runtime\bun.exe" "%CLARVIS_INSTALL_ROOT%\versions\%CLARVIS_CURRENT%\packages\code\src\cli.ts" %*
exit /b %ERRORLEVEL%
:clarvis_invalid_release
>&2 echo clarvis: invalid managed release
exit /b 1
"@
  $LauncherTemporary = Join-Path $Bin (".clarvis-" + [guid]::NewGuid() + ".cmd")
  [System.IO.File]::WriteAllText($LauncherTemporary, $LauncherText, $Utf8NoBom)
  Move-Item -Force -Path $LauncherTemporary -Destination $Launcher
  $LauncherTemporary = $null

  if ($env:CLARVIS_SKIP_PATH -ne "1") {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Entries = @($UserPath -split ";" | Where-Object { $_ })
    if ($Entries -notcontains $Bin) {
      [Environment]::SetEnvironmentVariable("Path", (($Entries + $Bin) -join ";"), "User")
      $env:Path = "$env:Path;$Bin"
      Write-Output "added $Bin to the user PATH; open a new terminal if this shell does not see it"
    }
  }

  Close-OperationLock $OperationLock
  $OperationLock = $null
  Write-Output "installed clarvis $Version for $Target"
  Write-Output "command: $Launcher"
  Write-Output "uninstall: rerun this installer with -Uninstall"
} finally {
  if ($null -eq $OriginalInstallRootEnvironment) {
    Remove-Item Env:CLARVIS_INSTALL_ROOT -ErrorAction SilentlyContinue
  } else {
    $env:CLARVIS_INSTALL_ROOT = $OriginalInstallRootEnvironment
  }
  if ($null -ne $OperationLock) { Close-OperationLock $OperationLock -BestEffort }
  if ($null -ne $CurrentTemporary) {
    Remove-Item -LiteralPath $CurrentTemporary -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $LauncherTemporary) {
    Remove-Item -LiteralPath $LauncherTemporary -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $MarkerTemporary) {
    Remove-Item -LiteralPath $MarkerTemporary -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Recurse -Force -Path $Temporary -ErrorAction SilentlyContinue
}
} -Uninstall:$Uninstall -Help:$Help
