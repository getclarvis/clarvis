#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 8 ]]; then
  echo 'usage: qualify-runtime.sh --engine docker|podman --base image --artifact archive --report file' >&2
  exit 2
fi

bun run runtime:qualify "$@"
