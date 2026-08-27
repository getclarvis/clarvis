#!/bin/sh
set -eu

version=${CLARVIS_VERSION:-0.0.1-beta}
repository=${CLARVIS_RELEASE_REPOSITORY:-getclarvis/clarvis}
install_root=${CLARVIS_INSTALL_ROOT:-${XDG_DATA_HOME:-"$HOME/.local/share"}/clarvis}
bin_dir=${CLARVIS_BIN_DIR:-${XDG_BIN_HOME:-"$HOME/.local/bin"}}
launcher="$bin_dir/clarvis"
marker_text='managed by getclarvis/clarvis installer'
marker="$install_root/.clarvis-managed-install"
action=install
step_number=0
step_total=0
temporary=
operation_lock=
current_temporary=
launcher_temporary=
marker_temporary=

usage() {
  printf '%s\n' \
    'Usage: install.sh [--uninstall]' \
    '' \
    '  (no option)    Install or reinstall the selected Clarvis release.' \
    '  --uninstall    Remove only the managed application files and launcher.' \
    '  --help         Show this help.' \
    '' \
    'Uninstall preserves Clarvis configuration, credentials, sessions, and project data.'
}

fail() {
  printf 'clarvis %s failed: %s\n' "$action" "$1" >&2
  exit 1
}

step() {
  step_number=$((step_number + 1))
  printf '[%s/%s] %s\n' "$step_number" "$step_total" "$1"
}

cleanup() {
  if [ -n "$operation_lock" ]; then
    rm -f "$operation_lock"
    operation_lock=
  fi
  if [ -n "$current_temporary" ]; then
    rm -f "$current_temporary"
    current_temporary=
  fi
  if [ -n "$launcher_temporary" ]; then
    rm -f "$launcher_temporary"
    launcher_temporary=
  fi
  if [ -n "$marker_temporary" ]; then
    rm -f "$marker_temporary"
    marker_temporary=
  fi
  if [ -n "$temporary" ]; then
    rm -rf "$temporary"
    temporary=
  fi
}

trap cleanup EXIT HUP INT TERM

acquire_operation_lock() {
  lock_path="$install_root/update.lock"
  if (umask 077; set -C; printf '%s %s\n' "$$" "$action" >"$lock_path") 2>/dev/null; then
    operation_lock=$lock_path
  else
    fail "another Clarvis install, update, or uninstall is active; if it crashed, remove $lock_path"
  fi
}

release_operation_lock() {
  [ -n "$operation_lock" ] || return 0
  rm -f "$operation_lock"
  operation_lock=
}

managed_launcher() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(wc -c <"$1")" -le 8192 ] &&
    grep -Fq "$marker_text" "$1" 2>/dev/null
}

case $# in
  0) ;;
  1)
    case $1 in
      --uninstall) action=uninstall ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) fail "unknown option: $1" ;;
    esac
    ;;
  *) fail "expected no option or --uninstall" ;;
esac

if [ "$action" = uninstall ]; then
  step_total=3
  printf 'Clarvis uninstaller\n'
  printf 'install root: %s\n' "$install_root"
  printf 'launcher: %s\n' "$launcher"
  step 'Checking that the installation is managed by Clarvis'

  launcher_is_managed=0
  if managed_launcher "$launcher"; then
    launcher_is_managed=1
  fi

  if [ ! -e "$install_root" ] && [ ! -L "$install_root" ]; then
    if [ "$launcher_is_managed" -eq 1 ]; then
      step 'No release root remains; removing the stale managed launcher'
      rm -f "$launcher"
      step 'Finishing uninstall'
      printf 'uninstalled the stale Clarvis launcher\n'
      printf 'Clarvis configuration, credentials, sessions, and project data were preserved.\n'
    else
      printf 'Clarvis is not installed at %s; nothing to remove.\n' "$install_root"
    fi
    exit 0
  fi

  [ ! -L "$install_root" ] || fail "$install_root is a symbolic link; inspect it manually"
  [ -d "$install_root" ] || fail "$install_root exists and is not a directory"

  marker_is_managed=0
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    [ ! -L "$marker" ] && [ -f "$marker" ] || fail "$marker is not a regular managed marker"
    [ "$(wc -c <"$marker")" -le 128 ] || fail "$marker is too large to be a managed marker"
    [ "$(cat "$marker")" = "$marker_text" ] || fail "$install_root has an invalid managed marker"
    marker_is_managed=1
  fi

  legacy_is_managed=0
  current="$install_root/current"
  if [ "$marker_is_managed" -eq 0 ] && [ "$launcher_is_managed" -eq 1 ] && [ -f "$current" ] && [ ! -L "$current" ]; then
    [ "$(wc -c <"$current")" -le 128 ] || fail "$current is too large to authenticate a legacy installation"
    current_tag=$(sed -n '1p' "$current")
    if printf '%s\n' "$current_tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' &&
      [ -f "$install_root/versions/$current_tag/release.json" ]; then
      legacy_is_managed=1
    fi
  fi
  if [ "$marker_is_managed" -eq 0 ] && [ "$legacy_is_managed" -eq 0 ] &&
    [ ! -e "$marker" ] && [ ! -L "$marker" ] &&
    [ ! -e "$current" ] && [ ! -L "$current" ] &&
    [ ! -e "$install_root/versions" ] && [ ! -L "$install_root/versions" ] &&
    [ ! -e "$launcher" ] && [ ! -L "$launcher" ]; then
    printf 'No managed Clarvis installation remains at %s; nothing to remove.\n' "$install_root"
    exit 0
  fi
  [ "$marker_is_managed" -eq 1 ] || [ "$legacy_is_managed" -eq 1 ] ||
    fail "$install_root is not an authenticated Clarvis installation; no files were removed"

  step 'Acquiring the shared install and update lock'
  acquire_operation_lock
  step 'Removing managed releases and launcher'
  rm -rf "$install_root/versions"
  rm -f "$install_root/current" "$marker"
  if [ "$launcher_is_managed" -eq 1 ]; then
    rm -f "$launcher"
  elif [ -e "$launcher" ] || [ -L "$launcher" ]; then
    printf 'left unrelated launcher unchanged: %s\n' "$launcher"
  fi
  release_operation_lock
  if ! rmdir "$install_root" 2>/dev/null; then
    printf 'kept %s because it contains files not owned by the installer\n' "$install_root"
  fi
  printf 'uninstalled Clarvis\n'
  printf 'Clarvis configuration, credentials, sessions, and project data were preserved.\n'
  exit 0
fi

printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' ||
  fail "CLARVIS_VERSION must be an exact release version"

case $(uname -s) in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case $(uname -m) in
  x86_64 | amd64) architecture=x64 ;;
  arm64 | aarch64) architecture=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

target="$platform-$architecture"
tag="v$version"
asset="clarvis-$tag-$target.tar.gz"
base_url=${CLARVIS_RELEASE_BASE_URL:-"https://github.com/$repository/releases/download/$tag"}

command -v tar >/dev/null 2>&1 || fail "tar is required"
if [ -n "${CLARVIS_RELEASE_DIRECTORY:-}" ]; then
  download() {
    cp "$CLARVIS_RELEASE_DIRECTORY/${1##*/}" "$2"
  }
elif command -v curl >/dev/null 2>&1; then
  download() {
    if [ -t 2 ]; then
      curl --fail --location --proto '=https' --tlsv1.2 --progress-bar --show-error "$1" --output "$2"
    else
      curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$1" --output "$2"
    fi
  }
elif command -v wget >/dev/null 2>&1; then
  download() {
    if [ -t 2 ]; then
      wget --https-only "$1" -O "$2"
    else
      wget --https-only --quiet "$1" -O "$2"
    fi
  }
else
  fail "curl or wget is required"
fi

step_total=8
printf 'Clarvis installer\n'
printf 'version: %s\n' "$version"
printf 'target: %s\n' "$target"
printf 'install root: %s\n' "$install_root"
printf 'launcher: %s\n' "$launcher"
step "Detected the $target release target"
step 'Preparing a private staging directory'
temporary=$(mktemp -d "${TMPDIR:-/tmp}/clarvis-install.XXXXXX")
archive="$temporary/$asset"
checksums="$temporary/SHA256SUMS"
step 'Obtaining release checksums'
download "$base_url/SHA256SUMS" "$checksums"
step "Obtaining $asset"
download "$base_url/$asset" "$archive"

step 'Verifying the archive SHA-256 checksum'
expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$checksums")
[ "${#expected}" -eq 64 ] || fail "SHA256SUMS has no exact SHA-256 entry for $asset"
case "$expected" in *[!0-9a-f]*) fail "SHA256SUMS has an invalid digest for $asset" ;; esac
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive" | awk '{ print $1 }')
else
  fail "sha256sum or shasum is required"
fi
[ "$actual" = "$expected" ] || fail "archive SHA-256 does not match SHA256SUMS"

step 'Extracting the verified archive'
mkdir -p "$temporary/extract"
tar -xzf "$archive" -C "$temporary/extract"
payload="$temporary/extract/clarvis"
[ -d "$payload" ] || fail "archive does not contain the clarvis payload"
runtime="$payload/runtime/bun"
entry="$payload/packages/code/src/cli.ts"
[ -f "$runtime" ] && [ -f "$entry" ] && [ -f "$payload/release.json" ] || fail "archive payload is incomplete"
chmod 755 "$runtime"

step "Testing staged Clarvis $version"
reported=$(CLARVIS_INSTALL_ROOT="$install_root" "$runtime" "$entry" --version) || fail "staged Clarvis did not start"
[ "$reported" = "clarvis $version" ] || fail "staged Clarvis reported an unexpected version"

step "Activating Clarvis $version"
[ ! -L "$install_root" ] || fail "$install_root is a symbolic link"
mkdir -p "$install_root" "$bin_dir"
acquire_operation_lock
if [ -e "$launcher" ] && ! managed_launcher "$launcher"; then
  fail "$launcher already exists and is unmanaged"
fi

versions="$install_root/versions"
destination="$versions/$tag"
if [ -e "$versions" ] || [ -L "$versions" ]; then
  [ ! -L "$versions" ] && [ -d "$versions" ] || fail "$versions is not a regular managed directory"
else
  mkdir -p "$versions"
fi
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ ! -L "$destination" ] && [ -d "$destination" ] || fail "$destination exists and is not a regular directory"
  cmp -s "$payload/release.json" "$destination/release.json" || fail "$destination contains a different build"
else
  mv "$payload" "$destination"
fi

marker_temporary="$install_root/.managed.$$"
printf '%s\n' "$marker_text" >"$marker_temporary"
chmod 600 "$marker_temporary"
mv -f "$marker_temporary" "$marker"
marker_temporary=

current_temporary="$install_root/.current.$$"
printf '%s\n' "$tag" >"$current_temporary"
mv -f "$current_temporary" "$install_root/current"
current_temporary=

quoted_root=$(printf '%s' "$install_root" | sed "s/'/'\\\\''/g")
launcher_temporary="$bin_dir/.clarvis.$$"
{
  printf '%s\n' '#!/bin/sh' '# managed by getclarvis/clarvis installer' 'set -eu'
  printf "CLARVIS_INSTALL_ROOT='%s'\n" "$quoted_root"
  printf '%s\n' 'export CLARVIS_INSTALL_ROOT' \
    'tag=$(sed -n "1p" "$CLARVIS_INSTALL_ROOT/current")' \
    'printf "%s\n" "$tag" | grep -Eq "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$" || { echo "clarvis: invalid managed release" >&2; exit 1; }' \
    'root="$CLARVIS_INSTALL_ROOT/versions/$tag"' \
    'exec "$root/runtime/bun" "$root/packages/code/src/cli.ts" "$@"'
} >"$launcher_temporary"
chmod 755 "$launcher_temporary"
mv -f "$launcher_temporary" "$launcher"
launcher_temporary=
release_operation_lock

printf 'installed clarvis %s for %s\n' "$version" "$target"
printf 'command: %s\n' "$launcher"
printf 'uninstall: rerun this installer with --uninstall\n'
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'add %s to PATH to run clarvis from any shell\n' "$bin_dir" ;;
esac
