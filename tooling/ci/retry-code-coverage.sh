#!/usr/bin/env bash
# CI wrapper for `bun run test:coverage`.
#
# Bun historically died by signal inside the @clarvis/code suite. Bun 1.4 ships
# the upstream Worker lifetime fix, but the GitHub-runner retirement canary has
# not yet run (the historical rate, upstream fix, and exit condition are in
# specs/known-issues.md). Until then a death by one of the exact crash signals is
# retried; a real test failure is never retried.
#
# Which signals count is deliberately narrow, and NOT a blanket "exit >= 128".
# Bun's crash handler ends in @trap() -> SIGILL (132); an uncaught fault
# surfaces as SIGSEGV (139) or SIGABRT (134). Two other signal deaths must NOT
# be retried: SIGINT (130) and SIGTERM (143) mean somebody asked this to stop --
# a cancelled workflow, or Bun killing sibling scripts after one of them failed.
# That second case is real and measured: under `bun --workspaces --parallel`, a
# failing package makes Bun SIGINT its siblings and the run exits 130, so a
# "retry anything >= 128" rule would silently re-run genuine failures the moment
# any script on this path gained --parallel. `test:coverage` uses --sequential,
# which preserves the real exit code (measured: a failing package exits 3, not
# 130) -- but the wrapper does not rely on that staying true.
#
# The retry re-runs @clarvis/code only: it is the last workspace in the
# sequential root script, so every other package already passed and left its
# lcov on disk. If any OTHER package ever dies by signal, its lcov is missing
# and `bun run coverage:check` fails loudly (tooling/checks/coverage.ts reads
# each report with a bare readFile, so an absent one throws ENOENT, and an empty
# one throws "LCOV report contains no own-source line data") -- this wrapper
# cannot mask that.
set -u

MAX_RETRIES=3

# Signal deaths that mean "Bun crashed", as 128 + signal number.
is_crash_exit() {
  case "$1" in
    132 | 134 | 139) return 0 ;; # SIGILL (Bun's @trap), SIGABRT, SIGSEGV
    *) return 1 ;;
  esac
}

note() {
  echo "::warning::bun crashed (exit $1) in the test suite -- retained Bun crash retry $2/$MAX_RETRIES re-runs @clarvis/code only"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "- bun crash (exit $1): retry $2/$MAX_RETRIES of @clarvis/code test:coverage" >>"$GITHUB_STEP_SUMMARY"
  fi
}

bun run test:coverage
status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi

attempt=0
while is_crash_exit "$status" && [ "$attempt" -lt "$MAX_RETRIES" ]; do
  attempt=$((attempt + 1))
  note "$status" "$attempt"
  bun --filter @clarvis/code test:coverage
  status=$?
  if [ "$status" -eq 0 ]; then
    bun run coverage:check
    exit $?
  fi
done

exit "$status"
