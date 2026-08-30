---
name: clarvis-performance-validation
description: "Revalidate Clarvis TUI startup and real-run performance across clean and marketplace-heavy profiles, including plugin hashing, background MCP OAuth, skills, and subagents. Use for startup regressions, plugin-cost investigations, or performance claims; do not use as a generic profiler or release preflight."
---

# Clarvis performance validation

Produce a reproducible performance verdict, not a single attractive number. Separate the first
usable composer, full application hydration, environment resolution, kernel readiness, and the
first real run because one stage can improve while another regresses.

## Establish authority and scope

1. Read `AGENTS.md`, `packages/code/README.md`, `packages/kernel/README.md`,
   `packages/mcp-client/README.md`, `specs/hosts/code-performance.md`,
   `specs/hosts/code-bootstrap.md`, `specs/hosts/environments.md`, `specs/hosts/plugins.md`,
   `specs/foundations/mcp-client.md`, `specs/engine/tool-dispatch.md`, and
   `specs/known-issues.md`.
2. Inspect `git status --short`, the current commit, Bun version, OpenTUI versions, power state,
   CPU policy, load, and terminal dimensions. Preserve unrelated changes.
3. Build the artifact under test once with `bun run build:code`. Use that exact artifact for both
   arms of an A/B comparison, then run `bun run smoke` before making a performance claim.
4. Ask for explicit authorization before installing remote marketplace content, using a real
   subscription, copying credentials, opening an OAuth browser, or making provider calls. Do not
   treat prior authorization as permanent.
5. Put marketplace state, global Clarvis state, workspaces, and any copied credentials in explicit
   temporary directories. Keep the user's normal profile untouched and remove the copies after the
   run.

## Measure the staged boot

Use the supported benchmark from the repository root:

```bash
BENCH_N=7 bun run bench:code --arm=bundle
```

Do not add `--force` to obtain a publishable result. If environmental checks require `--force`,
label the whole sample untrusted and use it only for local direction. Compare runs only when power,
governor or profile, load, Bun version, artifact, polling interval, and machine are compatible.

Record minimum, median, and maximum for all four stages:

| Stage | What it proves | Defect signal |
| --- | --- | --- |
| `version` | launcher and module load | eager dependency growth before interactive boot |
| `shell` | renderer plus lightweight startup frame | OpenTUI or entrypoint cost before input exists |
| `startupReady` | focused startup composer | the user still cannot type or queue a task |
| `paint` / `ready` | complete header and application composer | full runtime hydration remains expensive |

The product target is a focused startup composer near 250 ms and below 500 ms on a comparable
host. A task submitted there must begin as soon as the run host is ready; it must not wait for full
application hydration. Report the complete application's readiness separately instead of hiding it
behind the earlier marker.

## Run a controlled clean-versus-marketplace A/B

Create two isolated profiles with the same artifact and workspace:

- a clean profile using only `builtin:default`;
- a marketplace-heavy profile containing every plugin in the selected pinned marketplace revision.

Record the marketplace repository and exact revision, installed plugin identities, declared MCP
servers, skill count, Markdown/resource count, and bytes. Never call a listing "validated" merely
because installation succeeded.

Measure and correlate these boundaries in both profiles:

1. first startup composer and complete app;
2. each plugin snapshot independently;
3. the combined Environment snapshot;
4. kernel readiness;
5. run admission;
6. first model/tool activity and run completion.

Use debug lifecycle durations or narrowly instrumented temporary diagnostics to attribute cost.
Remove diagnostic changes before handoff. Look first for repeated filesystem walks or hashes when
cost scales with plugin count. Ordinary projections may reuse a pinned contribution snapshot, but
run admission must still validate the exact qualified plugin identities and raw bounded skill or
resource bytes. Verify that snapshot reads size and read one opened descriptor, enforce both
manifest byte and character caps, and hash a canonical list of relative paths plus per-file digests.
Effective sidecar-derived catalog metadata must participate too. Metadata-only shortcuts and raw
delimiter concatenation are not acceptable performance fixes.

If one plugin skill cannot be captured within those bounds, confirm that the plugin's complete
skill-root surface is withheld; a constant unavailable sentinel must never leave valid siblings
readable under untracked drift. Builtin and custom standalone roots must both use exact `include`
lists from the admitted snapshot, excluding invalid or inactive skills.

In an isolated fixture, mutate one manifest, sidecar, and resource after Environment resolution.
Prove that lazy catalog, body, and resource access fails closed immediately and that the next
foreground run also fails admission. Trigger a durable memory-indexer pass after the foreground
handle closes and prove it reacquires the same Environment lease. These guard against optimizations
that silently weaken drift detection outside the obvious foreground boundary.

## Prove a real run in a PTY

Use `$tui-driver` or an equivalent real PTY against the freshly built artifact. Fixed sleeps and
render snapshots alone are insufficient.

1. Poll for the startup-composer marker.
2. Type a unique fixture token and press Enter before the complete-app marker appears.
3. Verify the exact draft or submission survives the root handoff and starts without a second
   Enter.
4. Repeat with no runnable provider/profile and verify an accepted startup submission becomes the
   complete composer's exact draft rather than disappearing.
5. Execute a bounded task that uses one installed skill, one working MCP tool, and exactly two
   parallel Clarvis subagents. Make the task read-only unless edits are part of the requested test.
6. Require both subagents to settle, the MCP result to appear, the fixture token to be preserved,
   and the parent run to complete.

Also send Ctrl+C and a non-SIGINT catchable signal such as SIGQUIT during the gap between renderer
creation and complete-app mount. The renderer must restore raw mode/alternate screen exactly once;
a resume/continue preflight failure must do the same. On FatalBoot, idle Ctrl+C must take the fatal
exit path while Ctrl+C during an in-flight retry remains inert.

Record timestamps for composer readiness, Environment resolution, kernel readiness, full app,
submission, first tool call, each subagent, and completion. A synthetic unit test does not replace
this run.

## Exercise ignored OAuth without blocking

Include at least one OAuth-backed MCP with no valid token in the isolated profile. Permit the app to
open the authorization URL, deliberately leave the browser unanswered, and submit the real run.

Accept only this behavior:

- browser authorization starts in the background;
- the run does not await the human callback;
- that MCP is inactive for the current run while other tools, skills, and subagents continue;
- authorization-pending does not consume reconnect budget or trip the MCP circuit breaker;
- concurrent callers share one pending authorization instead of opening duplicate browsers;
- an initial pending flow retains both manager limits until completion; a catalog pending flow
  retains connection capacity through cleanup without rewriting a failed completion as success;
- once either background connection bound is saturated, later run acquisitions degrade immediately instead
  of waiting for the connect timeout or consuming another connection slot;
- a pending/deferred server beside a terminal failure still yields a degraded runnable pool;
- if the callback later completes, the credential is persisted and a subsequent run can reuse it.

An ignored browser must never keep application boot, tool acquisition, run teardown, or process
exit waiting. Capture structured pending/degraded events; do not expose token material in logs or
the report.

## Interpret the result before changing code

Use the smallest stage that explains the regression:

| Observation | Investigate first |
| --- | --- |
| clean and plugin-heavy `shell` both regress | entrypoint graph, renderer creation, Bun/OpenTUI |
| only plugin-heavy Environment/kernel regresses | contribution discovery, repeated parsing, hashing, qualified projection reuse |
| composer is fast but task waits for full app | startup handoff and run-host admission ordering |
| missing OAuth adds seconds or minutes | connection acquisition waiting on the human callback |
| full app grows while composer stays flat | runtime chunk topology and eager app imports |
| one warm run is fast but cold runs vary | filesystem cache, CPU policy, external process startup |

Call a limit upstream-owned only after preserving evidence from a minimal experiment. For the
current Bun/OpenTUI path, compare split and non-split artifacts and test bytecode or full bundling
only when supported; record linker/runtime failures exactly. An upstream limitation does not excuse
a repo-owned plugin walk, OAuth wait, or eager import.

## Validate and report

After a change, run the narrow package builds, typechecks, lint, and tests that own it, plus:

```bash
bun run build:code
bun run smoke
BENCH_N=7 bun run bench:code --arm=bundle
bun run check:specs
bun run check:graph
bun run check:harness
git diff --check
```

Include the focused canaries for renderer lifecycle/startup handoff, bounded skill reads and
canonical snapshot hashing, lazy Environment drift, memory run leases, MCP retained admission, and
mixed MCP failure policy. Do not rely on the broad suite alone to identify which invariant broke.

Run MCP OAuth integration tests in an environment that permits loopback sockets. Re-run the clean
and marketplace PTY scenarios against the final artifact, not an earlier intermediate build.

The handoff must state:

- exact commit, artifact, environment, marketplace revision, plugin inventory, and commands;
- trusted or untrusted status and min/median/max for every boot stage;
- clean versus plugin-heavy Environment, kernel, full-app, and real-run timings;
- whether early submission, skill use, MCP use, exactly two subagents, ignored OAuth, later token
  reuse, and byte-mutation drift detection passed;
- source-owned fixes, direct Bun/OpenTUI limits, known issues, and unverified platforms;
- every temporary profile, browser flow, process, and credential copy cleaned up;
- README/spec disposition and that no commit or publication occurred unless explicitly authorized.
