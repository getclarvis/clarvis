# Installation

> Install, verify, update, or remove a portable Clarvis beta without requiring a development toolchain.

Portable Clarvis releases are self-contained. They include the exact Bun runtime and native OpenTUI
dependencies, so an end user does not need Bun, Node.js, a compiler, a package manager,
administrator access, or a source checkout.

> These commands work only after `v0.0.1-beta` and its assets appear on
> [GitHub Releases](https://github.com/getclarvis/clarvis/releases). Confirm the release exists before
> running an installer.

## Supported release targets

| Operating system | Architectures        | Archive target                 | `v0.0.1-beta` release evidence                                   |
| ---------------- | -------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Linux (glibc)    | x64, arm64           | `linux-x64`, `linux-arm64`     | Native package and install smoke passed; PTY first paint covered |
| macOS            | Intel, Apple silicon | `darwin-x64`, `darwin-arm64`   | Native package and install smoke passed; PTY first paint covered |
| Windows          | x64, arm64           | `windows-x64`, `windows-arm64` | Native package and install smoke passed; CLI fast paths covered  |

The [official `v0.0.1-beta` release workflow](https://github.com/getclarvis/clarvis/actions/runs/32998576908)
completed all six native target jobs. On Linux and macOS, release smoke includes first paint under a
real PTY. On Windows, it verifies the manifest, `--version`, `--help`, installation, and
reinstallation without asserting native PTY first paint. A manual Windows launch and SmartScreen
observation remain separate from this automated evidence. Headless use is available with
`clarvis -p`.

## Linux and macOS

Prerequisites are `tar`, `mktemp`, `curl`, and either `sha256sum` or `shasum`. The beta Linux
archives target GNU/glibc systems; Alpine and other musl-only distributions are not supported by
these portable assets.

Install from the versioned beta tag:

```bash
curl -fsSL https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.sh | sh
```

If you prefer to inspect the installer before executing it, download it first (`less` is used here
only for review):

```bash
(
set -e
installer=$(mktemp "${TMPDIR:-/tmp}/clarvis-install.XXXXXX")
trap 'rm -f "$installer"' 0 HUP INT TERM
curl -fsSL https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.sh -o "$installer"
less "$installer"
sh "$installer"
)
```

The default managed installation lives beneath `${XDG_DATA_HOME:-$HOME/.local/share}/clarvis`. A
small launcher is placed in `${CLARVIS_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/clarvis`. The
installer does not edit shell profiles; if the resolved launcher directory is absent from `PATH`, it
prints the line appropriate for adding it and a new shell may be required.

## Windows PowerShell

Windows requires PowerShell with `Invoke-RestMethod` (`irm`), `Invoke-Expression` (`iex`),
`Invoke-WebRequest`, `Get-FileHash`, and the system `tar.exe`.

```powershell
irm https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.ps1 | iex
```

To inspect the PowerShell installer before executing it:

```powershell
$installer = Join-Path ([System.IO.Path]::GetTempPath()) ("clarvis-install-" + [guid]::NewGuid() + ".ps1")
try {
  Invoke-WebRequest https://raw.githubusercontent.com/getclarvis/clarvis/v0.0.1-beta/install.ps1 -OutFile $installer -ErrorAction Stop
  Get-Content $installer
  & $installer
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

The managed installation defaults to `%LOCALAPPDATA%\Clarvis`. Its `bin` directory is added to the
user `PATH` unless `CLARVIS_SKIP_PATH=1` is set. Reopen the terminal if `clarvis` is not immediately
found.

## What the installer verifies

For the detected operating system and architecture, the installer:

1. downloads the target's versioned `.tar.gz` archive and `SHA256SUMS` from the same release;
2. requires one exact checksum entry and verifies the downloaded bytes;
3. extracts to a private staging directory;
4. verifies that the staged CLI reports the requested version;
5. refuses to replace an unrelated command at the launcher path;
6. activates the new version only after those checks succeed.

Each archive also has an internal `release.json` manifest with the exact path, size, and SHA-256 of
every payload file. Clarvis verifies that manifest again before an update is activated.

To verify the downloaded archive manually, download both the archive and `SHA256SUMS`, isolate the
line whose filename exactly matches the archive, and use the platform's SHA-256 tool. Do not install
an asset when its name or digest differs.

## Run and update

```bash
clarvis --version
cd /path/to/project
clarvis
clarvis --update
```

The updater works only for a managed portable installation. It does not run automatically on
startup. It stages and verifies the candidate, retains the previous version, and changes the active
version last. Source checkouts and `bun link` installations intentionally refuse self-update; update
those through Git and the development setup instead.

A prerelease can advance to a newer prerelease or the later stable release. A stable installation
does not select prereleases.

## Unsigned beta binaries

The first beta is not yet code-signed or notarized. macOS Gatekeeper or Windows SmartScreen may ask
the user to confirm a downloaded application. Read the platform warning, confirm the release URL and
SHA-256, and follow the operating system's normal approval UI. The Clarvis installers do not disable
or bypass platform protections.

## Remove Clarvis

There is no automatic uninstaller in the first beta. Before removing anything, locate the managed
root and launcher and confirm they belong to Clarvis.

On Linux or macOS, remove only the marked launcher at
`${CLARVIS_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/clarvis` and the Clarvis directory at
`${CLARVIS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/clarvis}`. On Windows, remove the
Clarvis directory beneath `%LOCALAPPDATA%` and remove its `bin` entry from the user `PATH`.

User configuration and credentials default to `~/.clarvis` (or `%USERPROFILE%\.clarvis`) and are
separate from the managed binary. Removal of the application does not delete that state. Delete it
only after backing up anything needed and confirming that stored provider credentials and sessions
are no longer required.

Installation paths can be overridden with the documented operator variables in
[`install.sh`](https://github.com/getclarvis/clarvis/blob/main/install.sh) and
[`install.ps1`](https://github.com/getclarvis/clarvis/blob/main/install.ps1). If an override was
used, remove the resolved paths rather than the defaults.
