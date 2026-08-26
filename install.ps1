$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Version = if ($env:CLARVIS_VERSION) { $env:CLARVIS_VERSION } else { "0.0.1-beta" }
$Repository = if ($env:CLARVIS_RELEASE_REPOSITORY) { $env:CLARVIS_RELEASE_REPOSITORY } else { "getclarvis/clarvis" }
$InstallRoot = if ($env:CLARVIS_INSTALL_ROOT) { $env:CLARVIS_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Clarvis" }
if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') {
  throw "clarvis install failed: CLARVIS_VERSION must be an exact release version"
}

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$Target = switch ($Architecture) {
  "X64" { "windows-x64" }
  "Arm64" { "windows-arm64" }
  default { throw "clarvis install failed: unsupported architecture $Architecture" }
}
$Tag = "v$Version"
$Asset = "clarvis-$Tag-$Target.tar.gz"
$BaseUrl = if ($env:CLARVIS_RELEASE_BASE_URL) {
  $env:CLARVIS_RELEASE_BASE_URL.TrimEnd("/")
} else {
  "https://github.com/$Repository/releases/download/$Tag"
}

$Temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("clarvis-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Temporary | Out-Null
try {
  $Archive = Join-Path $Temporary $Asset
  $Checksums = Join-Path $Temporary "SHA256SUMS"
  if ($env:CLARVIS_RELEASE_DIRECTORY) {
    Copy-Item (Join-Path $env:CLARVIS_RELEASE_DIRECTORY "SHA256SUMS") $Checksums
    Copy-Item (Join-Path $env:CLARVIS_RELEASE_DIRECTORY $Asset) $Archive
  } else {
    Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $Checksums -UseBasicParsing
    Invoke-WebRequest -Uri "$BaseUrl/$Asset" -OutFile $Archive -UseBasicParsing
  }

  $Pattern = "^(?<hash>[0-9a-f]{64})  " + [regex]::Escape($Asset) + "$"
  $Matches = @(Get-Content $Checksums | ForEach-Object {
    if ($_ -match $Pattern) { $Matches.hash }
  })
  if ($Matches.Count -ne 1) { throw "SHA256SUMS has no unique SHA-256 entry for $Asset" }
  $Actual = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Matches[0]) { throw "archive SHA-256 does not match SHA256SUMS" }

  $Extracted = Join-Path $Temporary "extracted"
  New-Item -ItemType Directory -Path $Extracted | Out-Null
  & tar.exe -xzf $Archive -C $Extracted
  if ($LASTEXITCODE -ne 0) { throw "tar failed to extract the Clarvis archive" }
  $Payload = Join-Path $Extracted "clarvis"
  $Runtime = Join-Path $Payload "runtime\bun.exe"
  $Entry = Join-Path $Payload "packages\code\src\cli.ts"
  $Manifest = Join-Path $Payload "release.json"
  if (!(Test-Path $Runtime -PathType Leaf) -or !(Test-Path $Entry -PathType Leaf) -or !(Test-Path $Manifest -PathType Leaf)) {
    throw "archive payload is incomplete"
  }
  $env:CLARVIS_INSTALL_ROOT = $InstallRoot
  $Reported = (& $Runtime $Entry --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $Reported -ne "clarvis $Version") {
    throw "staged Clarvis reported an unexpected version"
  }

  $Versions = Join-Path $InstallRoot "versions"
  $Destination = Join-Path $Versions $Tag
  New-Item -ItemType Directory -Force -Path $Versions | Out-Null
  if (Test-Path $Destination) {
    $ExistingManifest = Join-Path $Destination "release.json"
    if (!(Test-Path $ExistingManifest -PathType Leaf) -or
        (Get-FileHash $Manifest -Algorithm SHA256).Hash -ne (Get-FileHash $ExistingManifest -Algorithm SHA256).Hash) {
      throw "$Destination contains a different build"
    }
  } else {
    Move-Item -Path $Payload -Destination $Destination
  }

  $Bin = Join-Path $InstallRoot "bin"
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  $Launcher = Join-Path $Bin "clarvis.cmd"
  if (Test-Path $Launcher -PathType Leaf) {
    $ExistingLauncher = Get-Content -Raw $Launcher
    if (!$ExistingLauncher.Contains("managed by getclarvis/clarvis installer")) {
      throw "refusing to overwrite the unmanaged launcher at $Launcher"
    }
  }

  $CurrentTemporary = Join-Path $InstallRoot (".current-" + [guid]::NewGuid())
  [System.IO.File]::WriteAllText($CurrentTemporary, "$Tag`n", [System.Text.UTF8Encoding]::new($false))
  Move-Item -Force -Path $CurrentTemporary -Destination (Join-Path $InstallRoot "current")

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
  [System.IO.File]::WriteAllText($Launcher, $LauncherText, [System.Text.UTF8Encoding]::new($false))

  if ($env:CLARVIS_SKIP_PATH -ne "1") {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Entries = @($UserPath -split ";" | Where-Object { $_ })
    if ($Entries -notcontains $Bin) {
      [Environment]::SetEnvironmentVariable("Path", (($Entries + $Bin) -join ";"), "User")
      $env:Path = "$env:Path;$Bin"
      Write-Output "added $Bin to the user PATH; open a new terminal if this shell does not see it"
    }
  }
  Write-Output "installed clarvis $Version for $Target"
  Write-Output "command: $Launcher"
} finally {
  Remove-Item -Recurse -Force -Path $Temporary -ErrorAction SilentlyContinue
}
