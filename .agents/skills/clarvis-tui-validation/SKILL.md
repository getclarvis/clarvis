---
name: clarvis-tui-validation
description: "Validate Clarvis TUI behavior in a real PTY, investigate startup or runtime performance, or audit complete product journeys. Select focused, performance, or full-audit mode for the requested evidence."
---

# Clarvis TUI validation

Use one validation workflow for interactive behavior and performance. Follow the repository's
[operating and evidence-reuse rules](../../../AGENTS.md#repository-skills-and-evidence-reuse).
Choose the mode from the user's request and name the checkpoints before execution.

## Select the scope

| Request                                         | Read next                                                                      | Required outcome                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| One interactive regression or bounded journey   | This file is sufficient                                                        | Reproduction, affected transitions, recovery, and final-artifact verification                 |
| Startup, plugin cost, latency, or retention     | [performance.md](references/performance.md)                                    | Comparable measurements of the implicated stages and correctness checks                       |
| Complete product E2E or a broad daily-use audit | [full-audit.md](references/full-audit.md), then its matrix and report template | Per-scenario evidence, explicit gaps, triaged defects, and critical paths on the final bundle |

Combine modes only when the request spans them. Full-audit mode includes performance work once;
a focused defect does not inherit the entire matrix, marketplace A/B, or resource soak.
Documentation synchronization uses the static maintenance section in
[full-audit.md](references/full-audit.md#maintain-the-inventory) without launching the app.

## Pin the contract and artifact

Read the relevant sections of [the Code README](../../../packages/code/README.md), select owning
specs through [the spec index](../../../specs/README.md), and check matching entries in
[known issues](../../../specs/known-issues.md). Inspect their production symbols and tests before
choosing expectations. Reuse this reading across checkpoints while the files are unchanged.

Record the full commit and worktree changes, exact launch command, artifact flavor/build identity,
Bun/OpenTUI versions, OS/architecture, terminal dimensions and keyboard profile, plus fixture and
configuration identities. Launch the checkout's `packages/code/src/cli.ts` with
`CLARVIS_CODE_SOURCE=1` for source diagnosis. For bundle evidence, use `bun run build:code` when the
artifact needs rebuilding, run `bun run smoke`, and launch that CLI with source mode unset. Resolve
the CLI to an absolute path when the disposable workspace is elsewhere. A source-only result does
not qualify the bundle; repeat affected checkpoints after the final relevant build.

Use a temporary `CLARVIS_HOME` and disposable workspace appropriate to the scenario; Git is needed
only for Git/worktree behavior. Reuse a fixture for intentional multi-turn, cache, or recovery tests;
reset unrelated state families. A request to use an existing subscription or configured engine
already authorizes that use within the task. Check session authorization before asking again.
Keep required host credentials outside the guest, logs, and evidence; remove any test-owned copies
after use. Preserve unrelated user state.

For Docker, inspect the effective engine/context, immutable image ID, generation, network policy,
and workspace mount. The header alone does not prove placement. Sandbox fallback is a distinct
result and cannot pass a Docker checkpoint. Match development versus installed runtime resolution
to the artifact being tested; use a workspace shared by the configured macOS engine.

## Drive and observe the journey

Use the available `tui-driver` skill for PTY mechanics. If unavailable, use an equivalent real PTY
that supports the needed input and evidence; record any missing capability. Do not maintain another
copy of its command catalog here.

- Drive the actual initial state, actions, intermediate transitions, settled state, and recovery.
  Choose unique output tokens that cannot match the prompt, stale history, or another projection.
- Poll for observable state with bounded waits. A wait timeout is a failed checkpoint even if the
  driver command exits successfully. Capture the current frame, diagnose the cause, and retry from
  a known state instead of treating a warning or notification as completion.
- Cover the keyboard/pointer routes and size classes implicated by the contract. A real-provider
  request includes actual provider traffic; fixtures supply deterministic failure/race coverage.
- Capture and inspect images at meaningful transitions and settlement for visual claims. Inspect
  geometry, focus, clipping, styling, stale/duplicate activity, and continuity. Text snapshots
  support semantic assertions; motion or flicker needs a short sequence of rendered frames.
- For transcript changes, verify painted row/style continuity, history admission, explicit return
  to the Lead tail, retained reader state, and live-to-settled content without disappearance.

Reuse existing fixtures and tests before adding a harness. Add durable behavioral assertions when
a fix needs regression protection; avoid encoding incidental timing or screen wording. Once the
affected checks pass on the final artifact, finish the scoped task unless evidence exposes another
relevant failure.

## Record results and clean up

Record each checkpoint's proof method, artifact, expected/observed behavior, evidence path, and
`pass`, `fail`, `partial`, `blocked`, or `unverified` verdict. A pass requires all requested proof
for that checkpoint. Suite totals alone cannot pass interactive or real-account requirements;
physical-terminal and native-platform claims require those environments to be exercised.

Report findings and fix only within the user's authorized scope. Retain exact failing commands,
reproduction and recovery, distinguish environmental failures using known issues, and link the
evidence. For a focused task, a compact handoff is enough; the full report template is for audits.

Quit normally and verify exit plus owned child-process/listener cleanup. Use bounded forced cleanup
only if normal shutdown fails, recording which path was tested. Docker cleanup must remove only the
test container generation; report intentionally retained mise caches and never delete an operator's
cache. Retain named evidence, remove test-owned credentials and disposable state, and follow the
repository handoff contract.
