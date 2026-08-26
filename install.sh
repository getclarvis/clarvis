#!/bin/sh
set -eu

version=${CLARVIS_VERSION:-0.0.1-beta}
repository=${CLARVIS_RELEASE_REPOSITORY:-getclarvis/clarvis}
install_root=${CLARVIS_INSTALL_ROOT:-${XDG_DATA_HOME:-"$HOME/.local/share"}/clarvis}
bin_dir=${CLARVIS_BIN_DIR:-${XDG_BIN_HOME:-"$HOME/.local/bin"}}

fail() {
  printf 'clarvis install failed: %s\n' "$1" >&2
  exit 1
}

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
    curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$1" --output "$2"
  }
elif command -v wget >/dev/null 2>&1; then
  download() {
    wget --https-only --quiet "$1" -O "$2"
  }
else
  fail "curl or wget is required"
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/clarvis-install.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
archive="$temporary/$asset"
checksums="$temporary/SHA256SUMS"
download "$base_url/SHA256SUMS" "$checksums"
download "$base_url/$asset" "$archive"

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

mkdir -p "$temporary/extract"
tar -xzf "$archive" -C "$temporary/extract"
payload="$temporary/extract/clarvis"
[ -d "$payload" ] || fail "archive does not contain the clarvis payload"
runtime="$payload/runtime/bun"
entry="$payload/packages/code/src/cli.ts"
[ -f "$runtime" ] && [ -f "$entry" ] && [ -f "$payload/release.json" ] || fail "archive payload is incomplete"
chmod 755 "$runtime"
reported=$(CLARVIS_INSTALL_ROOT="$install_root" "$runtime" "$entry" --version) || fail "staged Clarvis did not start"
[ "$reported" = "clarvis $version" ] || fail "staged Clarvis reported an unexpected version"

versions="$install_root/versions"
destination="$versions/$tag"
mkdir -p "$versions" "$bin_dir"
if [ -e "$destination" ]; then
  [ -d "$destination" ] || fail "$destination exists and is not a directory"
  cmp -s "$payload/release.json" "$destination/release.json" || fail "$destination contains a different build"
else
  mv "$payload" "$destination"
fi

launcher="$bin_dir/clarvis"
if [ -e "$launcher" ] && ! grep -Fq 'managed by getclarvis/clarvis installer' "$launcher" 2>/dev/null; then
  fail "$launcher already exists and is unmanaged"
fi

current_temporary="$install_root/.current.$$"
printf '%s\n' "$tag" >"$current_temporary"
mv -f "$current_temporary" "$install_root/current"

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

printf 'installed clarvis %s for %s\n' "$version" "$target"
printf 'command: %s\n' "$launcher"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'add %s to PATH to run clarvis from any shell\n' "$bin_dir" ;;
esac
