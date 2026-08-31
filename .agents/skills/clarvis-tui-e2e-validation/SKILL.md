---
name: clarvis-tui-e2e-validation
description: "Validate complete Clarvis terminal-UI integration journeys in a real PTY with screenshots, frame evidence, and observable assertions. Use for interactive regressions, transcript or overlay UX changes, release canaries, and claims that a TUI flow works end to end; do not use for headless unit tests alone."
---

# Clarvis TUI end-to-end validation

Prove the user journey against the artifact that will actually be handed off. A passing component
render or textual snapshot is supporting evidence, not a substitute for driving the full-screen
application and inspecting what a person sees.

## Establish the contract

1. Read `AGENTS.md`, `packages/code/README.md`, the owning `specs/hosts/code-*.md` files, and
   `specs/known-issues.md`. Inspect the worktree and preserve unrelated changes.
2. Write the journey as observable checkpoints before running it: initial state, user actions,
   intermediate transitions, terminal outcome, and the visual invariants that must remain unchanged.
3. Build the current TUI artifact, or deliberately enable source mode. Record which one is under
   test; never validate a stale installed bundle and attribute the result to current source.
4. Use isolated Clarvis state and a disposable workspace unless the scenario explicitly requires
   the user's real profile. Real subscriptions, credentials, provider calls, browser authorization,
   installation, or deletion still require the authorization applicable to that action.

## Aggregate mechanics through `$tui-driver`

Use the `tui-driver` skill as the operational layer for starting the real PTY, observing the screen,
driving keyboard or pointer input, waiting for rendered state, recording frames, and capturing
screenshots. Read and follow that skill when executing this workflow. Do not reproduce its command
catalog in this skill or invent a parallel driver abstraction.

Prefer observable readiness tokens and stable frames over fixed sleeps. Match the terminal size,
keyboard path, mouse path, theme, and artifact type implicated by the defect. A PTY result proves
the PTY path only; preserve any remaining physical-terminal limitation in the verdict.

## Exercise the complete journey

- Start from the state a user actually encounters, including first paint when relevant.
- Drive every transition that owns the reported behavior rather than jumping directly to a final
  fixture. Include keyboard and pointer routes when both are product contracts.
- For real runs, verify submission, live model text, tool activity, sidebar or overlay transitions,
  settlement, subsequent turns, scrolling away from and back to the tail, and explicit navigation
  back from retained surfaces as applicable.
- Use unique visible tokens so evidence cannot accidentally match splash copy, placeholders, stale
  history, or another projection.
- Validate failure and recovery paths when they are part of the change. A notification without the
  intended state transition is not success.

For transcript work, treat continuity as a first-class assertion: already painted cells keep their
row and style while mutable content grows; native scrolling admits history before it reaches the
viewport; returning from a child or overlay preserves the reader state; explicit submit returns to
the Lead tail; lazy residency stays bounded; and live-to-settled Markdown, diffs, writes, and memory
tools do not flicker, disappear, or downgrade visually.

## Capture and inspect visual evidence

Capture at least the first meaningful frame, each state-changing boundary implicated by the change,
and the settled result. Use a short frame sequence around movement or flicker defects; one final
image cannot prove that rows did not jump between frames.

Inspect the rendered images themselves. Check geometry, spacing, clipping, focus, hierarchy,
scrollbars, colors or syntax styling, stale labels, duplicate activity, and continuity with adjacent
history. Text extraction may support assertions but cannot establish visual quality on its own.
Name or index evidence so each image maps back to a checkpoint and artifact.

## Make the validation repeatable

Turn stable checkpoints into repository tests when the driver supports a durable assertion without
encoding incidental timing or terminal noise. Keep screenshots for visual claims and semantic
assertions for behavior; do not replace one with the other. Re-run the journey against the final
rebuilt artifact after the last source change.

For soak or memory-sensitive work, repeat complete turns and navigation cycles while collecting the
repository's diagnostic ledger. Assert bounded semantic turns, physical owners, renderer listeners,
pending handles and queues, as well as an environment-qualified RSS ceiling. A quiet screen alone
does not prove bounded retention.

## Report the verdict

State the artifact, commit/worktree state, terminal dimensions and profile isolation; enumerate the
journeys and checkpoints; link or name the screenshots and frame sequences; list exact automated
checks; and classify each requirement as passed, failed, or unverified. Report driver, provider, OS,
and physical-terminal limitations precisely. Stop all spawned PTYs and disclose any retained test
workspace or state. Do not claim success until both behavior and the relevant visual evidence agree.
