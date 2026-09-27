---
name: clarvis-tui-validation
description: "Test Clarvis end to end with tui-driver: happy paths, secondary flows, selected journeys or the full app. Includes configured-provider selection, disposable credentials, host execution and performance investigations."
---

# Clarvis TUI validation

Use one validation workflow for interactive behavior and performance. Follow the repository's
[operating and evidence-reuse rules](../../../AGENTS.md#repository-skills-and-evidence-reuse).
Choose the mode from the user's request and name the checkpoints before execution.
Read the available `opentui` skill for TUI work and `tui-driver` for PTY mechanics.
Reviewing or editing this skill is static work: do not inspect personal credentials or launch
provider requests merely to validate its instructions.

## Select the scope

| Request                                                           | Read next                                                                      | Required outcome                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| One interactive regression or bounded journey                     | This file and [execution setup](references/execution-setup.md)                 | Reproduction, affected transitions, recovery, and final-artifact verification                 |
| Happy paths, happy plus secondary flows, or selected E2E journeys | [journey-profiles.md](references/journey-profiles.md)                          | Execute the selected actions and assert each observable outcome                               |
| Startup, plugin cost, latency, or retention                       | [performance.md](references/performance.md)                                    | Comparable measurements of the implicated stages and correctness checks                       |
| Complete product E2E or a broad daily-use audit                   | [full-audit.md](references/full-audit.md), then its matrix and report template | Per-scenario evidence, explicit gaps, triaged defects, and critical paths on the final bundle |

Combine modes only when the request spans them. Full-audit mode includes performance work once;
a focused defect does not inherit the entire matrix, marketplace A/B, or resource soak.
Honor an already specified scope. For an ambiguous request such as “test the app”, offer the four
profiles in [journey-profiles.md](references/journey-profiles.md) in one scope question. Prepare the
artifact and fixtures while awaiting the choice; do not silently select a full audit. If no choice
arrives and the request permits a default, state that you are running happy paths only.
Documentation synchronization uses the static maintenance section in
[full-audit.md](references/full-audit.md#maintain-the-inventory) without launching the app.

Before any PTY execution, follow [execution-setup.md](references/execution-setup.md) for host versus
sandbox preflight, provider discovery/selection, isolated copies, and cleanup. The focused mode
needs that setup too, but does not need the broad journey catalog.

## Pin the contract and artifact

Read the relevant sections of [the Code README](../../../packages/code/README.md), select owning
specs through [the spec index](../../../specs/README.md), and check matching entries in
[known issues](../../../specs/known-issues.md). Inspect their production symbols and tests before
choosing expectations. Reuse this reading across checkpoints while the files are unchanged.

Record the full commit and worktree changes, exact launch command, artifact flavor/build identity,
Bun/OpenTUI versions, OS/architecture, terminal dimensions and keyboard profile, plus fixture and
configuration identities. Launch the checkout's `packages/code/src/cli.ts` for source diagnosis.
The current CLI always loads source; `CLARVIS_CODE_SOURCE` is only a legacy hint. For bundle
evidence, use `bun run build:code` when the artifact needs rebuilding, run `bun run smoke`, and
launch `bun /absolute/checkout/packages/code/dist/index.js` directly. Resolve
the entry to an absolute path when the disposable workspace is elsewhere. A source-only result does
not qualify the bundle; repeat affected checkpoints after the final relevant build.

Use the isolated roots and selected-provider fixture from the setup reference; Git is needed only
for Git/worktree behavior. Reuse a fixture for intentional multi-turn, cache, or recovery tests;
reset unrelated state families. Keep required provider credentials on the test host, outside the
Clarvis execution guest, logs, and evidence. Preserve unrelated user state.

For `--remote`, record local and remote artifact identities, the destination form without private
host data, absolute remote workspace, OpenSSH executable/config posture, host-key verification and
the authentication mechanism without key material. Verify port, agent and X11 forwarding stay
disabled, only the remote installation supplies settings/OAuth/state, and reconnect creates one new
SSH process. A fake SSH executable proves argv/wire composition; it does not qualify encryption,
host-key authentication, network interoperability or a second physical machine.

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
- For auxiliary formulation or review work, capture the semantic activity sequence rather than only
  its final iteration. Verify that a short read or search remains observable after the next thinking
  transition, and do not expect an activity the agent did not actually perform.

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
only if normal shutdown fails, recording which path was tested. Retain named evidence, remove test-owned credentials and disposable state, and follow the
repository handoff contract.
