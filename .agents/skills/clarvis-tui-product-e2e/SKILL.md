---
name: clarvis-tui-product-e2e
description: "Run a comprehensive current-source Clarvis terminal-UI product audit across public journeys, visual states, integrations, failures, performance stages, and long-run stability. Use for exhaustive TUI E2E proof or broad daily-use bug hunts; use clarvis-tui-e2e-validation for one bounded journey and clarvis-performance-validation for performance-only work."
---

# Clarvis TUI product E2E

Produce an explicit feature-to-scenario ledger and enough evidence to find defects that make normal
Clarvis use slow, confusing, unsafe, unreliable, or visually unstable. A full audit is not a large
unit-test run: it drives the current checkout in a real PTY, inspects what the user sees, exercises
stateful integrations and failures, and repeats the critical journeys against the rebuilt bundle.

## Keep the inventory current

Treat [the coverage matrix](references/coverage-matrix.md) as a maintained baseline, not as authority
over the current product. Before every full audit, reconcile it with:

- `packages/code/src/app/commands.tsx`, `packages/code/src/keys/commands.ts`, and dynamic skill or MCP
  prompt registrations for the live command catalog;
- `packages/code/src/views/config/hub-items.ts` and the concrete views for settings and domain hubs;
- `packages/code/src/cli-args.ts`, `packages/code/src/app/layout.ts`, keyboard policy, startup routing,
  and transcript/input implementations;
- `packages/code/README.md`, current tests, artifact tooling, and `specs/known-issues.md` for operational
  behavior and environmental signatures.

Add, remove, rename, or split scenarios when those sources change. Never keep a scenario merely to
make an old checklist look complete, and never omit a live user route because the matrix predates it.

`sync-doc` maintenance rule: whenever documentation synchronization finds or applies a user-visible
TUI change, it must update this skill in the same change. Update the matrix for commands, flags,
settings, key or pointer behavior, user journeys, integrations, states, limits, and failure or
recovery behavior. Update this file when the execution or evidence method changes, and update the
report template when verdict semantics change.

This is static maintenance only. `sync-doc` must not launch Clarvis, build the bundle, open a PTY,
execute scenarios, or wait for E2E pass/fail results. A full product test is a separate invocation of
this skill. After updating the checklist, `sync-doc` may run this static drift check from the
repository root:

```bash
bun .agents/skills/clarvis-tui-product-e2e/scripts/check-live-inventory.ts
```

The check compares registered commands and Settings panels with the checklist and detects duplicate
scenario IDs. It does not test product behavior or produce an E2E verdict.

## Compose the supporting skills

1. Read `AGENTS.md`, inspect `git status --short`, and preserve unrelated worktree changes.
2. Read and follow `$clarvis-tui-e2e-validation` for each interactive journey and `$tui-driver` for
   PTY interaction, stable waits, frames, screenshots, and repeatable assertions.
3. Read and follow `$clarvis-performance-validation` for startup, clean-versus-extension-heavy runs,
   OAuth non-blocking behavior, lifecycle soaks, and performance interpretation.
4. Read the coverage matrix before planning and the report template before capturing results.
5. Run `scripts/check-live-inventory.ts` to catch static command and Settings drift, then manually
   reconcile the remaining product surface before planning the E2E.

If a supporting skill is unavailable, preserve its contract locally: a real PTY, current-artifact
provenance, semantic checkpoints, inspected visual evidence, isolated state, and explicit limitations
remain mandatory.

## Freeze provenance and isolation

Record the branch, full commit, worktree status, Bun and OpenTUI versions, OS and architecture,
terminal identity and dimensions, color mode, and exact launch command. Never invoke an installed
`clarvis` release and attribute it to the checkout.

For container scenarios, also record the configured and effective placement, engine/context and
version, immutable image ID, network policy, selected workspace or worktree identity, and container
generation. Prove those values from diagnostics and engine inspection rather than from the header
label alone. Use only test-owned recipe and runtime identities; never mount an engine socket or copy
the operator's host credentials into the guest.

Use two artifact rounds:

1. **Current source:** from a disposable workspace, launch the checkout's
   `packages/code/src/cli.ts` with `CLARVIS_CODE_SOURCE=1` and diagnostics enabled.
2. **Final bundle:** run `bun run build:code`, run `bun run smoke`, then launch the same checkout's
   CLI without `CLARVIS_CODE_SOURCE`.

Use a fresh temporary `CLARVIS_HOME` and disposable Git workspace per independent state family.
Never copy the user's normal keys or subscription files by default. Keep fixture credentials fake,
scrub secrets from commands and reports, and restrict destructive scenarios to test-owned paths.
Record retained directories; otherwise remove test-owned state and stop every PTY and child process.
Container cleanup additionally verifies that the disposable generation is gone and reports any
intentionally retained Docker mise cache volume; never delete an operator-owned cache or unrelated
container as test cleanup.

## Build a deterministic integration harness

Prefer local, scripted fixtures before external services. The complete harness should be able to
produce:

- streaming model text, reasoning, usage, optional cache telemetry, tool calls, elicitation,
  compaction, malformed events, provider errors, cancellation, and a stream that never settles;
- stateful Tasks behavior for the current `clarvis.tasks.v2` adapter, including conflict, degraded,
  unknown-outcome, and refresh paths;
- MCP tools and prompts, connection failure, reconnect, delayed responses, OAuth-pending behavior,
  and mixed healthy/degraded pools;
- local Extension Profiles, plugins, marketplace entries, skills, hooks, executables, trust changes,
  conflicting identities, large catalogs, and executable-file drift;
- seeded sessions, plans, memory, workflows, delegated agents, worktrees, settings revisions, and
  corrupt, truncated, oversized, or concurrently edited state.
- a host-model fixture reachable through the private container bridge, admitted Skill resources,
  host-backed Plan and read-only Memory capabilities, steer/cancel/follow-up traffic, a bounded guest
  service for loopback preview, and classified startup, integrity, recipe, handshake and teardown
  failures.

Use unique visible tokens for every scenario. When the repository lacks a durable fixture for an
important user route, record the gap; add a reusable test harness only when implementation is within
the requested scope. Synthetic fixtures prove Clarvis behavior at the fixture boundary, not real
provider, account, browser, or physical-terminal compatibility.

## Plan the proof

Copy every applicable row from the coverage matrix into a run ledger. For each scenario, define:

- preconditions and owned fixture state;
- initial visible state;
- exact keyboard or pointer actions;
- intermediate transitions and stable readiness tokens;
- settled behavior and persisted state;
- visual invariants, diagnostics, and resource or timing observations;
- cleanup and a `pass`, `fail`, `blocked`, or `unverified` verdict.

Do not collapse multiple features into one broad green row. Pair a happy path with cancellation,
failure, recovery, stale-completion, and resize or navigation interruption wherever those states are
possible. Test global and workspace scope plus their conflict behavior for persisted configuration.

## Execute in risk order

1. Prove boot, first paint, early input, onboarding or recovery, basic submission, cancellation,
   shutdown, and source provenance.
2. Exercise composer, navigation, all public commands, settings panels, transcript projections,
   sessions, model and agent selection, and local shell behavior.
3. Exercise plans, memory, tasks, workflows, subagents, tools, guard and sandbox, extensions, skills,
   hooks, MCP, trust, storage, diagnostics, worktrees, and reconnect behavior.
4. Inject slow, reordered, rejected, duplicated, never-settling, stale, and concurrent completions.
   Resize, navigate, press Escape or Ctrl+C, switch sessions, and start shutdown during transitions.
5. Run startup and overlay benchmarks, repeated complete-turn/navigation cycles, and an idle/active
   soak with diagnostics and process-tree memory observations.
6. Re-run every critical journey and every fixed defect against the final rebuilt bundle.
7. Run real-provider, browser OAuth, physical-terminal, or platform canaries only when their required
   credentials, account actions, host access, and authorization are available. Keep their verdicts
   separate from deterministic PTY results.

Poll observable readiness and stable frames instead of sleeping for an assumed duration. Inspect
images for geometry, focus, clipping, hierarchy, color, flicker, stale rows, and continuity; text
snapshots alone cannot pass a visual requirement. Use short frame sequences around animation,
scrolling, root replacement, and suspected redraw instability.

## Hunt daily-use instability

Actively look for lost or duplicated input, delayed Escape, incorrect Ctrl+C ownership, stale async
results, frozen mutation keys, invisible progress, accidental retries, focus theft, scroll jumps,
transcript repaint, clipped hints, misleading status, secret exposure, scope confusion, blind
overwrite, state corruption, unbounded listeners or owners, memory growth, orphan processes, and
shutdown that waits on background work.

Use an external watchdog for hangs and record the whole process tree separately from Clarvis's own
RSS telemetry. Interpret startup-composer readiness, complete-app paint, kernel/run readiness, and
run completion as distinct stages. Treat current benchmark thresholds as environment-qualified
criteria and refresh them from the owning tooling before use.

## Classify and report

Use these user-impact levels:

- **P0:** data loss or corruption, secret or trust-boundary failure, duplicate destructive action,
  unrecoverable process failure, or security escape;
- **P1:** routine workflow blocked, freeze or hang, lost input, wrong persistent state, crash, or no
  usable recovery;
- **P2:** material latency, flicker, clipping, misleading feedback, broken secondary route, or
  repeated friction with a workaround;
- **P3:** minor polish or low-frequency inconsistency without meaningful workflow impact.

Follow [the report template](references/report-template.md). Include artifact provenance, the complete
ledger, evidence locations, defects with reproduction steps, performance samples, cleanup, and every
environmental or external limitation. A complete verdict requires every matrix row to be passed,
failed, blocked, or unverified, no untriaged P0/P1, and final-bundle repetition of the critical path.
Unavailable external or physical canaries remain `unverified`; they never become implicit passes.
