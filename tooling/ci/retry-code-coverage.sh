#!/usr/bin/env bash
# The retained Bun crash policy and its retirement canary live in specs/known-issues.md.
# Keep this compatibility entry thin: the importable supervisor owns all retries and cancellation.
set -euo pipefail
exec bun run "$(dirname "$0")/../checks/ci-coverage.ts" "$@"
