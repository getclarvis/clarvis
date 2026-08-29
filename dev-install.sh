#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' "clarvis-develop: Bun is required; install the version pinned in $repository/mise.toml" >&2
  exit 1
fi

exec bun "$repository/packages/code/tooling/development-install.ts" "$@"
