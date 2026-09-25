# Known issues

What was **measured**, what was **ruled out**, and what was **tried and reverted**. `AGENTS.md`
carries the short form of each entry; this file carries the evidence.

It sits beside the contract corpus indexed by [`specs/README.md`](README.md) rather than inside it,
and the distinction is load-bearing. That corpus specifies what Clarvis must do and cites the stable
files, symbols, and tests that implement it; it cannot say what a CI run measured, what an RSS soak showed, or what was
attempted and abandoned. `specs/cross-cutting/build-and-ci.md`
§8 says so explicitly about the Bun crash below: it documents the retry state machine and reports the
rate as unknown to it. This file is where that kind of evidence lives, and its whole purpose is to
stop someone re-diagnosing what has already been diagnosed.

Entries carry their own verification or resolution evidence without embedding calendar dates.
Chronology belongs in `CHANGELOG.md`. A measurement taken from a CI run or a memory soak cannot be
re-taken by reading source; those results keep their original environment and run identity, and each
entry says what a source read could and could not settle.

---

## Hidden sub-agent transcript pressure needs PTY qualification

The incident trace identified substantially more child than Lead transcript events and nodes.
Interactive Code now routes hidden child detail into bounded tails and mounts only the selected
child store. The deterministic regression in
`packages/code/tests/unit/child-transcript-store.test.ts` verifies isolation and bounded retention
with 16 interleaved children and 32,801 synthetic child events, matching the incident's child-event
count without retaining operator content;
`packages/code/tests/component/run-host-export.test.ts` verifies persisted export. These tests do
not measure input latency, frame time or RSS in OpenTUI. An isolated PTY run with an equivalent
workload remains necessary before claiming the TUI performance incident resolved end to end.

---

## Smoke qualification remains environment-dependent

**Status: disposable fixtures are implemented; live qualification depends on the host.**
`createSmokeFixture` and `SmokeContext` give artifact, release, first-paint and installer callers
an exclusive root, explicit `CLARVIS_HOME`, allowlisted child environment and owned lifecycle.
A host with no usable temporary parent reports `smoke_fixture_no_usable_parent`; a host without
`script(1)` needs tmux for the PTY. Regression coverage is in
`packages/code/tests/unit/artifact-isolation.test.ts`,
`packages/code/tests/unit/benchmark-isolation.test.ts`, and
`tooling/tests/unit/harness-isolation-contract.test.ts`.

---

## Four defects that were confirmed here, and have since been fixed

Carried from the gap report's §1.1 and closed during the same audit. They are kept because the
diagnosis is the expensive part and each cost a real hunt; most fixes were small but non-obvious.
Each is also recorded in its owning spec's §8.

**A `run_ended` event carrying `code` could not cross the kernel wire, and took the connection with
it.** The protocol declares `code?: string` on `run_ended` (`packages/protocol/src/runs.ts`)
and the engine mapper emits it whenever the trace entry has one, but the client codec's `run_ended`
schema was `.strict()` over `type`/`at`/`status`/`reason` alone. A strict object rejects the extra
key, `decodeRunEvent` answers `null`, and `connectKernelClient` reads that as a protocol violation:
it settles **every** live run `unavailable` and closes the transport. One field nobody had
round-tripped could end a client session.

Fixed by adding `code: text.optional()` to the codec
(`packages/kernel/src/transport/run-event-codec.ts`), and pinned by
`packages/kernel/tests/contract/transport-codecs.test.ts`'s "carries a failed run's error code
instead of killing the connection". The more useful half is the guard: the
`satisfies Record<RunEvent["type"], z.ZodType>` beneath the table constrains the *key set* only,
never a payload's shape, which is why `tsc` could not see this. `CodecFieldDrift`
(`packages/kernel/src/transport/run-event-codec.ts`) compares every variant's declared
fields against its schema's inferred fields in both directions and fails to compile on a mismatch,
naming the variant and the field. Deleting the new codec line reports
`{ variant: "run_ended"; drifted_field: "code" }` rather than a green build.

One trap in writing that guard, worth knowing before editing it: `Extract<RunEvent, { type: K }>` is
the obvious spelling and it is wrong here. One member declares a **union** discriminator —
`delegation_completed | delegation_failed` (`packages/protocol/src/runs.ts`) — and a union is not
assignable to one of its own literals, so `Extract` answers `never`, `keyof never` widens to
`string | number | symbol`, and the guard reports drift on a variant that has none.

**`TurnRef.error` was written and then dropped on the way to disk.** It is populated by `endTurn` in
`createSession` (`packages/code/src/adapters/session.ts`), and **both** legs of the wire conversion dropped it —
`metaToSession` on the way out and `sessionToMeta` on the way back — so a one-sided fix would not
have round-tripped. A run that failed came back after a reload saying only that it failed, which is
the exact undiagnosable case the field's own TSDoc describes it as fixing.

Fixed in both conversion legs (`metaToSession` and `sessionToMeta` in
`packages/code/src/adapters/session-store.ts`), with the value masked and bounded at the
**producer** (`redactTurnError` in that file) so the in-memory and on-disk values stay
identical and the existing `redactPreviews: false` opt-out keeps working. The masking is not
optional: this is the first provider free text Clarvis writes into a session document, and an
unbounded message could push the document past `SESSION_MAX_BYTES`, after which the store swallows
the throw and silently stops persisting that session for its whole life. The read path validates the
`{code, message}` shape (`persistedTurnError` in that file) because a session document is the one input
here that no schema describes — `isSession` checks identity and `Array.isArray(turns)` and nothing
else, so an added key is not rejected on read and a corrupt one is not caught either.

**A `preSpawnSubagent` hook's `rewrite` verdict was computed and silently discarded.**
`runVerdictHooks` built the replacement arguments and returned them; `prepareSpawn` read only
`denied` and `advise`. A hook author who returns `rewrite` on `pre_tool_use` — where it **is**
honoured — reasonably expected the same here and got a no-op with the original brief spawned.

Resolved by **refusing it loudly** rather than honouring it: the sweep now runs with
`rewritable: false` (`packages/loop/src/runtime/subagents/spawn-subagent.ts`), so a `rewrite`
verdict denies the spawn instead of passing it through with arguments the hook believes it replaced.
That is the one outcome worse than either honouring or refusing, because the author is never told.
No capability is lost, which is what made refusing the cheaper answer: `spawn_subagent` is
dispatched through the ordinary tool loop, so a matching `pre_tool_use` hook still replaces
the brief and profile **upstream** of this validation, and there the model is told what actually ran through the
`[advisor]` channel and the trace records an `arguments_original`. Honouring it here would have meant
rebuilding that non-silence at a second site.

**The Providers footer omitted `add` and `delete` while Context Help showed them.** Reproduced in the
shipped application; the isolated panel test passed, and the test file recorded a hunt that had ruled
out the segment cap, level registration, surface flags and lower layers claiming `a`/`d`, naming
`overlay-host.mountView`'s `LAYER.LIST` layer as the nearest untested difference.

The cause was none of those: it was `tierLimit`'s flat cap on segment *count*
(`packages/code/src/ui/patterns/active-actions.ts`). The panel's nine footer segments measure
**120 columns**, so from 122 up the row physically fits them all — but the rung below 140 admitted
fewer candidates than the rung above, and `help` reserves one seat, so `delete` was dropped at 132
columns with 29 to spare. The harness's "ruled out the segment cap" was a false negative: raising the
cap changed nothing *in that harness* because it never had enough candidates to reach it.

Two earlier attempts got the number wrong in the same way, and both are the reason this entry gives
the derivation rather than a value. Raising only the 140 rung moved the defect into 100-139 instead
of closing it. Raising the 100 rung to 8 was derived against a fixture that had itself been reshaped
down to eight candidates; against the real nine it still dropped `delete`. The rungs at and above 100
are now one rung at 10, so for any terminal that wide `fits` alone decides — which is what the
function's own comment already claimed the design was.

Pinned by three tests in `packages/code/tests/unit/band-monotonic.test.ts`, the load-bearing one
being "above 100 columns nothing is dropped for any reason but width" — a property rather than a
number, so it survives a tenth candidate being added. It is deliberately scoped to 100 and up:
below that the low rungs are an editorial cap and a 30-column row is kept short even though more
would fit. Closing this also removed two assertions in
`packages/code/tests/integration/app-shell-render.test.tsx` that read as a rule about an active run
and were in fact pinning the same discontinuity — the identical shell at 200 columns showed both
hints on the unchanged code.


---

## Path-based writes retain a parent-directory TOCTOU

**Status: open; path-based mutation limitation.** A concurrent process can replace a parent
directory after `resolveFileToolPath` resolves a path and before `applyOpsAtomic` performs `mkdir`,
staging, or `rename` by pathname. The file tool does not pin the parent inode; host process
permissions govern access.

The durable fix requires descriptor-relative mutation for all write handlers, with platform-specific
handling of symlinks. Another `realpath` before a pathname-based rename
would leave a final gap. Production: `resolveFileToolPath` in
`packages/tools/src/lib/paths.ts` and `applyOpsAtomic` in `packages/tools/src/lib/atomic.ts`.
Test: `packages/tools/tests/integration/atomic.test.ts` covers mutation behavior; it does not close
this race.

---

## Workflow approval failure is persisted as only "was not started"

**Resolved.** Two `demo_01` manager runs persisted only `workflow 'audit' was not
started` and `workflow 'implement' was not started` after long waits. That historical context cannot
distinguish an explicit decline, a dismissed UI, malformed accepted content, or a real timeout, so
it is not evidence that the configured 30-minute wait elapsed. `run_workflow` now passes the manager
run's effective `elicit_wait_ms`, returns a distinct message for every non-start outcome, logs every
settled preflight as `workflow.review_resolved` with `decision` and `waited_ms`, and retains the shared
`capability.elicit_no_response` diagnostic for a genuine timeout. Production:
`buildRunWorkflowHandler` in `packages/workflows/src/run-workflow.ts` and the effective wait assembled
by `runManagerWorkflow` in `packages/kernel/src/workflows/workflows-service.ts`. Test:
`packages/workflows/tests/component/run-workflow.test.ts` (`starts the first round, interpolates the
declared args, and carries the synthesis`; refusal-reason cases; `fails closed when the workflow
approval wait times out`).

---

## One in-flight model call reserves the whole workflow tree budget, so a concurrent leader spawn is refused

**Resolved.** The manager/Admiral no longer contributes the workflow ledger as its
`outputBudget`; it remains on the primary run budget. The dedicated workflow-child ledger now
defaults to 640,000,000 output tokens (four times the primary-run default) and
divides headroom across concurrent auxiliary consumers with no extra manager share. The provider adapter still
safely reserves every retry attempt, but a manager call can
no longer make workflow-child headroom transiently read as zero.

**Follow-up resolved.** The raw workflow ledger was still contributed to ordinary
in-process children of the manager. For a provider model without an explicit output cap, the first
child's first call reserved every remaining token; siblings then failed their pre-loop budget check
with zero iterations. If that call's stream outcome was unknown at cancellation, conservative
settlement could persist the complete 640,000,000-token reservation as apparent spend. Each child
now receives a lazy per-call fair-share wrapper: attachment and pre-loop reads reserve nothing, and
unused headroom returns when that provider call settles. The divisor covers both possible leaders
and direct manager subagents. A leader's held subtree is partitioned again across its entry agent and
possible subagents. Production: `createFairShareOutputBudget`, `createDescendantOutputBudget`, and
`createLeaderOutputBudgetCapability` in `packages/workflows/src`. Tests:
`packages/workflows/tests/component/capability.test.ts` (`keeps the manager on its run budget while
capping concurrent descendant calls`; `does not reserve descendant headroom until its first model
call`) and `packages/workflows/tests/component/run-leader.test.ts` (`partitions one leader
reservation across its root and concurrent subagent calls`). `runManagerWorkflow` still constructs
the primary and auxiliary ledgers inside each execution; neither budget is accumulated across
session turns.

A genuine child-ledger refusal remains sticky for a batch, but now also marks the aggregate workflow
failed. A manager completion therefore cannot persist a successful workflow over skipped or failed
leaders. Production: `createWorkflowsCapability` and `createWorkflowLedger` in
`packages/workflows/src`, `WorkflowCtx.onBudgetExhausted` across the leader dispatch paths, and
`finalWorkflowStatus` in `packages/kernel/src/workflows/workflows-service.ts`.

The follow-up FIFO boundary reserves only after semaphore admission. Leaders waiting for a permit
hold no provisional headroom, so `max_concurrency: 1` remains a serial queue rather than becoming a
one-leader workflow; concurrent admitted leaders still reserve before model dispatch. Production:
`buildRunLeaderHandler` and `runOne` in `packages/workflows/src`. Tests:
`packages/workflows/tests/component/dispatch.test.ts` (`serial concurrency admits the queued tail
against headroom released by each predecessor`) and
`packages/workflows/tests/component/run-leader.test.ts` (`bounds concurrent leaders by the
semaphore, sums usage, and records the tree edges`).

The regression is held at both boundaries: `packages/workflows/tests/component/capability.test.ts`
asserts the manager has no workflow `outputBudget` while descendants do;
`packages/workflows/tests/unit/ledger.test.ts` pins reservation division without a manager share;
and `packages/kernel/tests/unit/workflows-service.test.ts` pins failed aggregate status for both
leader failure and reservation refusal.

---

## Every `FloatFrame` overlay leaks native memory per rendered row

**Resolved at the Clarvis lifecycle boundary.** The coordinated OpenTUI 0.5.7 upgrade
removed the historical row-proportional primitive slope. Production-component soaks then found
larger remount residue in Context Help, Agent Profile Picker, Catalog Picker and the activity drawer.
Explicit bounded retention now closes every root-Portal member of that family; Context Help's last
pre-retention stable-portal 100-cycle samples were non-monotonic and ended at +2.39 MiB PSS/100. The
historical heading is retained because source and test documentation link to its anchor.

Under the former OpenTUI 0.4.3 pin, a `FloatFrame` overlay card — Context Help or any `ListPicker` —
leaked roughly **10 KiB of native memory per rendered row, per open**. The original QA pass
originally misfiled this as a settings panel leak because the panel was reached through the
now-removed F2 overlay; the overlay was the measured leak source.

**Every number in the historical table is an RSS soak measurement taken inside a live renderer, and
none can be reconstructed by reading source.** They are kept verbatim, with their original framing,
and must not be trimmed or re-rounded. The affected dependency set was the exact coordinated
`@opentui/{core,keymap,solid}` 0.4.3 pin; the current package manifest instead pins all three at
0.5.9 (`packages/code/package.json`, `dependencies`). The 0.5.7 measurements below remain the
historical comparison that resolved this issue; the later lockstep patch update does not rewrite
their environment.

Measured with a 320-cycle open/close soak inside one renderer, sampling RSS at post-GC floors:

| Cycle | rows rendered | RSS floor, MiB/cycle |
| --- | ---: | ---: |
| no overlay (control) | 0 | **0.00** — 258 to 253 over 320 cycles |
| agent picker | ~7 | 0.10 |
| Context Help | ~30 | 0.49 |
| removed F2 overlay (historical measurement) | ~102 | 1.07 — 277 to 619 MiB over 320 cycles |

The control is what makes the rest mean anything: the identical render-and-capture loop with no
overlay is flat, so neither the harness nor the renderer's own frame loop is responsible.

### Remeasurement during the performance review

The review now specified in
[`hosts/code-performance.md`](hosts/code-performance.md#81-measurement-snapshot) drove the
current built artifact in a real 120x32 PTY on Bun 1.4.0. A 100-cycle Context Help open/close churn
moved process RSS from 173,328 KiB to 253,872 KiB before explicit collection; a following 100-cycle
agent-picker churn moved it from 241,488 KiB to 305,692 KiB. Those are immediate post-churn samples,
not leak rates, because heap/external allocations had not all been collected.

A second Context Help run used a 220 MiB fuse to reach the then-supported `/recover-memory` path, whose
successful backend rebuild invoked `Bun.gc(true)`. After 30 open/close cycles and recovery, process
RSS settled at 203,392 KiB versus 176,548 KiB before churn, about 26 MiB higher. Rebuilding the
backend is a confounder, so this confirms retained residue but does not supersede the controlled
post-GC per-row rates below. It also exposed a separate configuration property: with a healthy
baseline above 70% of a deliberately low fuse, the cooling phase cannot collect three samples below
its rearm threshold.

The expanded audit also tested the non-`FloatFrame` autocomplete popup while holding a non-empty
draft so the conditional Splash could not churn. Across 100 screen-verified `@` popup cycles, RSS
moved from 195,552 to 239,656 KiB and private dirty from 142,544 to 186,456 KiB immediately after
churn; a later sample without explicit GC had fallen to 202,192 KiB RSS and 148,992 KiB private
dirty. This is a **candidate**, not a confirmed leak rate: it still needs the forced-GC popup and
no-popup input-mutation controls specified in
[`hosts/code-performance.md`](hosts/code-performance.md#84-overlay-leak-implementation-and-correction-plan).
It is recorded because autocomplete does not use `FloatFrame`, so a complete remediation cannot
assume the known float-card cause is the only renderer lifecycle at risk.

### Correction implementation and post-GC result

The package-owned `bench:overlays` runner now executes each primitive case in a fresh OpenTUI
renderer process, warms it, forces collection before every batch sample and records RSS, Linux PSS,
private dirty, JS heap/external/array buffers, live renderables, renderer lifecycle passes, live key
layers, cumulative layer registrations and native-frame-control state
(`packages/code/tooling/benchmarks/overlays.tsx`, `runParent`, `runCase`, `collect`). On Bun 1.4.0 at
120x32, 100-cycle post-GC results after moving all three OpenTUI packages from 0.4.3 to 0.5.7 were:

| Case | RSS MiB/100 | PSS MiB/100 |
| --- | ---: | ---: |
| no-overlay state control | -4.11 | -4.07 |
| `FloatFrame`, 30 rows | +1.29 | +0.77 |
| retained autocomplete, ten visible rows | -1.37 | -1.48 |
| retained `PageFrame`, 30 rows | -1.12 | -1.36 |

The old row-proportional primitive slope therefore does not reproduce on 0.5.7. The +0.77 figure is
still positive growth, not a reduction, and it was insufficient to classify production consumers.
Fresh-process production cases found the following 300-cycle PSS slopes: Context Help +19.54,
Agent Profile Picker +12.71, Catalog Picker +14.26 and the 64-agent drawer +19.15 MiB/100. Retaining the
same component trees changed those values to +0.72, -0.23, -1.49 and +0.13 MiB/100 respectively.
Activity Detail with 200 Markdown sections (-16.92), Worktree Exit (+0.44), elicitation (+2.25),
HintToast (-4.25) and Splash (+1.63) did not reproduce the high remount slope.

The application now keeps the shell mounted behind Plan/Diff; lazily retains Plan, Diff, every
root-Portal float, autocomplete and the narrow drawer after first use; and gates inactive key
layers. `SurfaceBoundary` owns disposal/retention, activation identity and a stable root portal.
Putting `Portal` inside a remounted `FloatFrame` was rejected after it produced +48.21 MiB PSS/100
and accumulated 3,200 renderer lifecycle passes. A later absolute lifecycle-count test found the
remaining boundary: mutating an outer Portal host while removing conditional content orphaned two
text lifecycle passes per cycle. Portal placement therefore requires bounded `retain-one`; Context
Help has four action slots, Activity Detail clears its Markdown payload on close, and the worktree
prompt has fixed content. Configuration view frames keep their prior stack ownership: inactive
parents stay mounted, while a popped frame is disposed exactly once. The last pre-retention compact
Context tree measured a non-monotonic +2.39 MiB PSS/100; retained and retained-reprojected controls
ended at -2.85 and -1.59. No opportunistic GC was shipped.

The final 100-cycle native-render matrix after that policy change measured retained Context Help at
-2.04 MiB PSS/100 with zero new registrations, retained Agent Profile Picker at -1.65, Catalog Picker at
-1.53, the retained drawer at -1.46, retained Activity Detail at -28.55, the retained worktree prompt
at -4.12, and the retained empty Workflows page at +1.17. Their remount comparators remained visibly
worse for Profile (+11.42), Catalog (+8.01), drawer (+25.13), and empty Workflows (+2.81) and created
100, 200, 0, and 200 registrations respectively. Negative endpoint deltas reflect collection of
warm-up arenas; they are not close-time memory savings.

### Product-E2E overlay warm-up correction

The current-source TUI product audit reproduced two apparent production-policy failures on macOS
with Bun 1.4.0 and OpenTUI 0.5.9: the retained 100-row Catalog Picker measured 31–40 MiB RSS/100,
and the guard elicitation case hovered just above the 5 MiB/100 ceiling. Deterministic ownership
remained bounded in both cases. Longer discarded prefixes showed finite OpenTUI/native allocator
arena warm-up rather than a continuing post-warm-up owner slope, so the cases now declare their own
220- and 400-cycle warm-ups while preserving the global ten-cycle default, the 100 measured cycles,
the two-size matrix and the exact 5 MiB gate.

The final Catalog matrix measured 2.12 MiB RSS/100 at 120x32 and 1.39 at 80x24, with zero
renderable, lifecycle-pass, live-key-layer and registration deltas. Two consecutive final
elicitation matrices measured 2.00–2.79 at 120x32 and 3.20–3.59 at 80x24; each returned renderables,
lifecycle passes and live key layers to baseline. Its +100 cumulative registrations are expected:
the control deliberately mounts 100 distinct requests, one layer each, and no layer remains live.
Production: `packages/code/tooling/benchmarks/overlays.tsx`
(`catalog-picker-retained-100-rows`, `elicit-guard-confirm`, `runParent`).

### Current-memory regression: slash, scroll and former F1

**Resolved as allocation churn, with retained ownership still bounded.** Repeatedly typing and
deleting a bare `/` produced immediate PSS steps of roughly 5–6 MiB, command selection scroll showed
the same smaller pattern, and repeated F1 activation accumulated memory until Bun later reclaimed
it. The delayed fall without explicit collection distinguished this from the earlier monotonic
native-owner defect, but the current-memory pressure was still a product regression.

The bare-slash path rebuilt the complete command catalog, nested browse rows, sorting projection and
fuzzy display runs on every keystroke. F1 separately reprojected actions already known to the footer
and restarted the retained float timeline. `commandCatalog`,
`createCommandCompletionProvider`, `StableWindowedList` and the first-activation-only retained
`FloatFrame` timeline now centralize those behaviors. The fix remains lazy and bounded and does not
ship an opportunistic GC.

The fresh real-PTY follow-up recorded 225,704 → 234,532 KiB PSS over ten `/`+Backspace cycles and
233,484 → 235,672 KiB over ten command-scroll selections, both with plateaus or declines. After the
first retained activation, F1 close samples two through five recorded 238,200 → 240,636 KiB with a
decline, and the delayed combined-workload sample fell to 233,276 KiB. The controlled 100-cycle
post-GC matrix measured +0.58 MiB PSS for autocomplete visibility, -22.32 for autocomplete scroll,
+1.64 for retained Context Help and +2.20 for retained reprojected Context Help. All four kept
renderable, lifecycle-pass and key-layer deltas at zero. The negative value reflects collected
warm-up arenas, not a saving. A 300-cycle confirmation measured autocomplete scroll at -10.07 MiB
PSS/100 and reprojected retained Context Help at +1.25 MiB PSS/100, again with every ownership delta
at zero. The positive Context Help endpoint was bounded residual growth below policy, not a claimed
decrease or zero slope. The Context Help component, F1 action and their active soak cases were
subsequently removed; these values remain historical attribution evidence.

Production: `OverlayRegion`, `TranscriptRegion`, `PlanOverlay`, `DiffViewer`, `InputDock`,
`AutocompletePopup`, `StableWindowedList`, `Help`, `AgentProfilePicker`, `CatalogPicker`, `ListPicker`,
`LevelHost` and `createFieldEditor`. Tests: `overlay-region-render.test.tsx`,
`app-shell-render.test.tsx`, `field-editor-pick-render.test.tsx`, `input-dock-submit.test.tsx`,
`help-render.test.tsx`, `plan-overlay-render.test.tsx`, and `overlay-host.test.ts`.

**In the 0.4.3 run it was native, and nothing in the application retained it.** Across that soak: the JS heap after
`Bun.gc(true)` retains **0 bytes** (also measured directly over 500 mount/unmount cycles of a real
panel), the live renderable tree returns to exactly its baseline size (56 nodes), and the keymap's
registered-command count returns to exactly its baseline (102). The growth is monotonic across 320
cycles with no plateau, so it is a leak rather than allocator arena growth.

**Do not re-diagnose it as a Solid ownership bug.** `@opentui/solid`'s reconciler does call
`destroyRecursively()` on a removed node (`_removeNode`, on `process.nextTick`), and `useTimeline`
unregisters its timeline on cleanup. Both were checked in the affected 0.4.3 installation's compiled
`@opentui/solid` bundle — a historical dependency artifact that is not tracked in this repository — and
`packages/code/src/views/overlays/FloatFrame.tsx` is still the `useTimeline` call the second
theory was about. Re-reading either one buys nothing that has not already been paid for.

**The Clarvis-side amplifier is fixed.** `ListPicker` used to render **every** filtered row into a
`scrollbox`; the removed F2 overlay mounted its whole catalogue to show a dozen rows. `ListPicker`
now **windows** to the viewport with `windowRows`, the shape `AutocompletePopup` already used, and
carries overflow in `arrowUp`/`arrowDown` "N more" indicators. Historical measurements on that
removed overlay at 120x40 were **1.07 MiB/cycle before, 0.55-0.70 after**, against an unwindowed range
of 0.90-2.54 across four runs. The win remains relevant to current pickers and is proportional to how
much of the list is off-screen.

The fix is `packages/code/src/views/overlays/ListPicker.tsx` (`win`) — it memoizes
`windowRows(rows(), clamp(sel()), maxVisibleRows())` over the shared implementation at
`packages/code/src/ui/patterns/windowed-list.tsx` — budgeted by `maxVisibleRows` at
`packages/code/src/views/overlays/ListPicker.tsx` against `floatMaxRows`
(`packages/code/src/views/overlays/FloatFrame.tsx`), with the indicators at
`packages/code/src/views/overlays/ListPicker.tsx` gated by `showOverflow`. The
TSDoc cites this section by anchor, so
**the heading above is load-bearing**: renaming it breaks that citation and the one at
`packages/code/tests/integration/list-picker-render.test.tsx`. Three tests pin the behaviour —
 (120 items, fewer than 30 mounted, "more" painted) (the window follows the selection) (the wheel keeps mouse parity).

Mouse parity is kept rather than traded away: the container binds `onMouseScroll`
(`packages/code/src/views/overlays/ListPicker.tsx`, rendered `PickerRow` → `onWheel`) and a wheel notch moves
the selection, so the window follows it. `@opentui/core`'s `ScrollBox` offers no virtualization
option, which is why the list is windowed rather than virtualized inside one.

> **Correction to that last sentence only.** `ScrollBoxOptions` in the pinned 0.4.3 did
> expose `viewportCulling?: boolean`, and it already defaulted to `true`. It is not virtualization
> and would not have helped: `_getVisibleChildren` in that historical, untracked dependency bundle filters which
> **already-constructed** children get painted, never whether a child is mounted, so it cannot return
> an allocation made at construction. That it was on for the whole soak and changed nothing is
> corroborating evidence that the cost is paid at mount. The conclusion — window outside the box —
> stands; only the stated reason needed sharpening.

What remained at 0.4.3 was a fixed per-open cost that was **not** per-row — the card, the filter
field and the preview pane. The 0.5.7 result above supersedes that current-state conclusion.

The former Context Help later received its own bounded projection because it was not a `ListPicker`.
The historical improvement from +19.54 to +5.77 MiB PSS/100 proved that its old nested group/action
tree was an amplifier; stable portal ownership and the subsequent non-monotonic +2.39 result removed
the remaining confirmed Clarvis-side slope. The component and its F1 route are now retired, so this
paragraph records the remediation history rather than a current production surface.

In practice a session is unlikely to open a picker 300 times, and the QA fleet watchdog never fired
across three hours of driving; a healthy `clarvis` sits at ~200 MiB. This is recorded because
the *rate* is now known and the reproduction is cheap, not because it is urgent. The shipped
in-process guard is now 2 GiB, warns at 80%, clamps positive overrides to a 512 MiB floor and keeps
its separate efficiency advisory below the catastrophic fuse
(`packages/code/src/adapters/memory-pressure.ts`, `DEFAULT_TUI_RSS_LIMIT_BYTES`,
`MIN_TUI_RSS_LIMIT_BYTES`, `MEMORY_EFFICIENCY_*`). The historical post-fix F2-overlay rate of
0.55-0.70 MiB/cycle placed that guard thousands of opens away from a ~200 MiB baseline; current
picker rates should be re-measured independently before using that estimate.

### Rescued from the deleted TUI QA findings §9

The `(§9)` cross-reference above no longer resolves: that file was deleted in the same commit as this
one (`62b175a4`). Its measurements are recorded here so the misfiling cannot be repeated, and are
soak numbers with the same unverifiable status as the rest of this section.

§9 was filed as "a settings panel retains memory on every open and close", from post-GC **floors**
rather than peaks — peak-during-churn looks the same for a leak and for ordinary JIT warm-up. Floors
over 30-cycle batches: **227 MiB** at the prompt, **243 MiB** after the first batch and 75s idle,
**273 MiB** after the second — roughly **+0.75 MiB retained per open/close, with no plateau**. Two
other screens showed the same shape and were folded into it: the MCP browser climbed **~40 MiB over
30 cycles** with partial recovery, and Doctor's ten-cycle probe reached **604 MiB** before easing
back.

The subject was wrong. Opening a panel **directly** was flat — **340 to 351 MiB over 60 cycles** —
and only the route through the now-removed F2 overlay leaked. That control turned three
differently-sized "panel leaks" into one per-rendered-row rate. For current regressions, repeat the
same controlled measurement with an existing `ListPicker` rather than assuming a panel leak.

### Guided Extensions retained-selection soak

The production-policy soak for guided Extensions Step 3 used OpenTUI 0.5.7 and Bun 1.4.0
on macOS x64. It rendered 196 marketplace listings, 24 installed plugins and 50 standalone skills
in one retained composer, discarded 220 high-churn selection cycles so the finite catalog had been
traversed, then measured 100 further cycles at post-GC floors. The exact command was
`cd packages/code && bun run bench:overlays extensions-setup-retained-196-listings`.

| Terminal | RSS growth per 100 cycles | renderables | lifecycle owners | live key layers | key registrations |
| --- | ---: | ---: | ---: | ---: | ---: |
| 120 × 32 | +1.9609375 MiB | Δ0 | Δ0 | Δ0 | +0 |
| 80 × 24 | +0.6640625 MiB | Δ0 | Δ0 | Δ0 | +0 |

PSS is unavailable on macOS. A preliminary run that discarded only ten cycles crossed the 5
MiB/100 policy while the renderer was still materializing finite catalog content; the benchmark now
records and enforces the case-specific 220-cycle warm-up before measuring steady-state churn. The
threshold was not relaxed. The owning contract and executable case are
[`hosts/code-performance.md`](hosts/code-performance.md) (`PERF-19`) and
`packages/code/tooling/benchmarks/overlays.tsx`
(`extensions-setup-retained-196-listings`, `stableRegistrations`).

The companion pending-operation soak held one marketplace installation open across 100 animated
spinner cycles after ten discarded warm-up cycles. It used the same runtime and dimensions and ran
`cd packages/code && bun run bench:overlays extensions-setup-pending-install`.

| Terminal | RSS growth per 100 cycles | renderables | lifecycle owners | live key layers | key registrations |
| --- | ---: | ---: | ---: | ---: | ---: |
| 120 × 32 | +0.078125 MiB | Δ0 | Δ0 | Δ0 | +0 |
| 80 × 24 | +0.15234375 MiB | Δ0 | Δ0 | Δ0 | +0 |

This case keeps one active 200 ms spinner clock and a reactively gated existing level; it allocates
no timer per row and phase-copy changes do not register a new key layer. The owning invariants are
[`hosts/code-performance.md`](hosts/code-performance.md) (`PERF-20`) and
[`hosts/code-extensions.md`](hosts/code-extensions.md) (`EXT-6`).

The focused Plugins collection soak on the same runtime rendered the same 196 listings and 24
installed plugins, discarded 220 right/left round trips, then measured 100 more. The exact command
was `bun run bench:code-overlays marketplace-collections-retained-196-listings`.

| Terminal | RSS growth per 100 cycles | renderables | lifecycle owners | live key layers | key registrations |
| --- | ---: | ---: | ---: | ---: | ---: |
| 120 × 32 | +0.3203125 MiB | Δ0 | Δ0 | Δ0 | +0 |
| 80 × 24 | +0.62109375 MiB | Δ0 | Δ0 | Δ0 | +0 |

The first 12-cycle warm-up still measured finite native-render allocation at +6.88 MiB/100; the
production case now uses the existing 220-cycle finite-catalog warm-up and keeps the 5 MiB/100
threshold unchanged. The owning invariant is
[`hosts/code-performance.md`](hosts/code-performance.md) (`PERF-21`).

---

## Retired: automatic removal of dirty Clarvis worktrees

Resolved by a narrower exit contract. Clarvis stores no lifecycle registry and never
forces removal or deletes the branch. An interactive `--worktree` launch offers checkout removal
only after Git reports it clean; the operator must press `y`, the workspace closes first outside the
bounded platform-shutdown path, and cleanup rechecks cleanliness before `git worktree remove`. New checkouts live beneath the
primary checkout's `.clarvis/worktrees/`, which the mandatory inner `.gitignore` excludes before
creation. Only that canonical parent may be removed when empty; externally registered parents are
never removed. Dirty trees, signals, panics and headless modes keep the checkout.

## Retired: local subscription registrations always reported unavailable

Resolved by restoring the two reviewed local public-client registrations under an
explicit `project-owner-approved-public-reference` decision. Commit `86e05a5f` had labelled both
records as unapproved references, so `subscriptionRegistration` returned `undefined` before
credential state or file permissions could matter and the TUI always showed “Integration not
enabled in this build”. The project decision is not represented as provider endorsement; future
unapproved `public-oss-reference` records still fail closed.

## A band narrower than one whole segment announces nothing

**Open, low. The row never overflows; the cost is an empty band.**

The adaptation sequence is: full wording, authored short wording, wrap, and only then a dropped
segment. A segment that still does not fit is dropped even when it is `essential`, because the row
must never paint past its own container — that width check is what stopped a set of essentials from
overflowing before it existed. The consequence is that a container with fewer cells than one whole
segment shows an empty band rather than a clipped one. Reaching it needs a container narrower than
one segment: the shell's own 24-column floor is not, and a card's interior reaches that only on a
terminal at the floor. Production: `fitRow` and `budgetFooterActions` in
`packages/code/src/ui/patterns/active-actions.ts`. Test:
`packages/code/tests/unit/active-actions.test.ts` ("a band narrower than one segment seats nothing
rather than overflowing").

---

## Resolved: a `FloatFrame` card's navigation row was budgeted against the terminal, not the card

**Fixed by separating the row's fit budget from its editorial seat cap.**

`InteractionNavigationBar` used to read `useTerminalDimensions()` and pass the terminal width into
`budgetFooterActions`, which spends one number twice: `fits` width-checks the seats and subtracts the
row's own two columns, while `tierLimit` caps the seat *count*. A card is narrower than its terminal
(`floatContentWidth` in `packages/code/src/views/overlays/FloatFrame.tsx`), so its row was measured
against cells the card did not have, painted past its border, and — after the fix — was admitted by
the card's real interior.

The earlier attempt, passing the card's interior for both budgets, was correctly reverted: it cost
the former Context Help surface its escape route at 48 columns, because the tier fell from 10 to 4
the moment the interior reached `fits`. The two budgets are now separate (`FooterBudget` in
`packages/code/src/ui/patterns/active-actions.ts`): the band `width` decides which segments fit and
`capWidth` decides the editorial count cap. `NavigationBar` passes a container's real interior as the
band width and keeps the terminal as the cap scope; `ViewFrame` subtracts its own padding and the
pinned status beside it, `PageFrame` its padding, and a card `floatContentWidth` less its pinned
footer text. A card's own row no longer fixes its height either, so a confirmation's two verbs can
wrap instead of losing one.

The historical measurement stays as the reason the split exists:

```
before:          [↵] run  [↑/k] move  [esc/f1] close   35 cells in a 36-cell card - it fitted
one-width fix:   [↵] run  [↑/k] move                   tier 2, close dropped
split budgets:   the same three seats, fitted in the card
```

Production: `FooterBudget` and `budgetFooterActions` in
`packages/code/src/ui/patterns/active-actions.ts`, `NavigationBar` in
`packages/code/src/ui/patterns/navigation-bar.tsx`, and `floatContentWidth` in
`packages/code/src/views/overlays/FloatFrame.tsx`. Tests:
`packages/code/tests/unit/active-actions.test.ts` ("a card's row fits its own interior without losing
the terminal's seat cap") and `packages/code/tests/integration/float-frame-render.test.tsx` ("a card
never paints past a narrow viewport"). The band contract these fixes implement is in
[`hosts/code-keyboard.md`](hosts/code-keyboard.md) §3.6 and
[`hosts/code-input-and-overlays.md`](hosts/code-input-and-overlays.md) invariant 49.

---

## Restricted environments can reject ephemeral loopback listeners

**Status: confirmed environmental limitation; not a Clarvis product regression.**
Restricted execution environments can refuse ephemeral loopback listeners. Bun may then report
`Failed to start server. Is port 0 in use?` even though port `0` requests dynamic allocation.
Rerun an affected listener test with host permissions before attributing that signature to
Clarvis. An assertion failure or a timeout after successful listener creation is a separate issue.

---

## Bun dies by signal in the `@clarvis/code` suite

**Status: the upstream Worker lifetime fix shipped in Bun 1.4. Clarvis has not yet run the
GitHub-runner retirement canary, so the narrow CI retry remains temporarily in place and dormant —
see _Where the mitigation stands today_ below.**

`bun test` dies with `panic: Segmentation fault` then `Signaled: SIGILL` — one fault, not two: the
SIGILL is Bun's own crash handler trapping. It is a Bun runtime crash, not a failing assertion; it
lands right after a test *passed*, and has never reproduced locally.

### The rate, measured

> **Unverifiable by source read.** Everything in this subsection came from GitHub Actions history that
> is no longer retained. It cannot be re-derived by reading the tree, and it is kept verbatim in its
> original framing. What _can_ be checked is that its subject still exists — and it does: the suite,
> the wrapper, the pin and the canary are all still in place.

Over the complete retained Actions sample of 107 runs, **84** reached the `linux` test step and
**26 died by
signal — 31.0%**. Every one of the 26 was in `@clarvis/code`, and every one exited **132**
(128 + SIGILL). That uniformity is what lets the CI wrapper key on the exit code.

Split on the pin commit `e201dfd`: **8/22 = 36.4%** on the 1.3.14 era, **18/62 =
29.0%** on 1.3.11.

The other 10 failures at that step were ordinary — a `coverage:check`
threshold — and are not this.

**No newer sample is recorded here.** CI push and pull-request triggers were restored, but no
post-restoration GitHub-runner result is part of this review. Treat 31.0% as a
historical figure attached to the 1.3.11 pin and the suite as it stood then, not as a live rate.

### What it is

The historical upstream family is **oven-sh/bun#17241** (identical trace from plain TypeScript, no
FFI), duped into **[#15964, "Worker & worker_threads stability"](https://github.com/oven-sh/bun/issues/15964)**.
That tracking issue was closed by [PR #37075](https://github.com/oven-sh/bun/pull/37075), and the fix
shipped in [Bun 1.4](https://bun.com/blog/bun-v1.4). Clarvis is now
pinned to 1.4.0, but an upstream merge is not evidence that the exact GitHub-runner signature is
gone. `packages/code/tests/helpers/tree-sitter-preload.ts` records the historical attribution
at the one place in the tree that acts on it.

The fault address varies run to run — `0xFFFFFFFFFFFFFFF8` in 16 of the 26, plus `0x0`, `0x18`,
`0xC`, `0x2E64F3C3A68` — which is the tell for heap corruption rather than one bad pointer. Most
crashes land ~1-2s in, a few as late as ~22s.

### What it is not

Seven things were measured and excluded. The version pin has since moved to 1.4.0; the evidence
below remains attached to the runtime named by each measurement.

- **Not caused by coverage.** Of the 26 crashes, **13 ran with `--coverage` and 13 without**. The
  split is still reachable: `packages/code/package.json` runs the suite bare and
  `packages/code/package.json` runs the same files under `--coverage`.
- **Not proven cured merely by changing the pin.** `@clarvis/loop` measured ~30s on 1.3.11 against
  ~122-170s on 1.3.14; that was the reason for the old pin, not a crash fix. Bun 1.4 now includes the
  upstream Worker lifetime repair, but Clarvis still needs its own GitHub-runner canary before the
  narrow crash retry can be removed.
- **Not a teardown or process-exit problem.** The crash lands *mid-file*, with most of the suite
  still to run. Awaiting `destroyTreeSitterClient()` in a root `afterAll` did not stop it, and that
  call is deliberately absent from the preload today
  (`packages/code/tests/helpers/tree-sitter-preload.ts`) for an unrelated reason: it would
  unregister the singleton the stubs decorate.
- **Not `avx512`.** One crashing runner advertised it and dev hardware did not, which looked
  decisive; a later crash came from a runner reporting only `sse42 popcnt avx avx2`, and the
  upstream twin (#17241) was reported from a machine without it.
- **Not cross-file state; `--isolate` does not help.** Measured by re-running one commit six times:
  linux failed 3 of 6 under `--isolate`, the same rate as without. Note the flag does not exist in
  1.3.11, so that experiment ran on 1.3.14; a check before the migration confirmed that
  `bun test --help` under 1.3.11 still listed no `--isolate`. `@clarvis/workflows` still passes the
  flag; `@clarvis/loop` did until the 1.4 migration removed its measured 84.9% overhead, and
  `@clarvis/code` does not and never did.
- **Not reachable via `OTUI_NO_NATIVE_RENDER`.** It fails 275 tests outright; the suite's assertions
  depend on native rendering. The variable appears nowhere in the tree — the experiment was run and
  discarded, not committed.
- **Not tree-sitter highlighting** — but the old preload was not doing what it claimed. That one has
  its own subsection, below.

### Not tree-sitter highlighting — but the old preload was not doing what it claimed

Worth its own entry, because closing it fixed a real leak even though it did not fix the crash.

The preload called `getTreeSitterClient()` then `destroy()`, and `destroy()` fires the singleton's
`onDestroy`, which calls `destroySingleton()`. The instance stubs applied afterwards therefore
decorated an orphan, and every later consumer built a fresh client with a fresh worker. Measured
across one suite run: **82 workers spawned and 82 terminated** — the exact churn #15964 warns about.

The preload now stubs `TreeSitterClient.prototype.startWorker`
(`packages/code/tests/helpers/tree-sitter-preload.ts`), so the count is **0**; that method's TSDoc
carries the 82-worker measurement and the reasoning at the one place a reader
who is about to delete the stub will see it. `packages/code/bunfig.toml` keeps the preload
ahead of anything that loads `src/`, which is what makes a prototype stub reach every instance.

`packages/code/tests/integration/tree-sitter-preload.test.ts` pin it by reading the
client's private `worker` field (`workerOf`) — for a freshly constructed client and for the
singleton. Swapping `globalThis.Worker` cannot detect the spawn — the bundle does not resolve
`Worker` from the global scope, so that assertion passes with the stub removed; the test file records
that trap.

Two `markdown-stability.test.tsx` cases depended on live tree-sitter to consume `###`/`**`; they now
assert heading stability and block rendering instead, and **markdown concealment is not covered by
the automated suite**. That file was renamed to
`packages/code/tests/integration/markdown-render-contract.test.tsx` in `d4872d3f`; the two cases are
"a sealed heading stays visually stable while the streaming tail grows" and "the real assistant
renderer preserves mixed markdown and the oversized-tail fallback". The same file now pins the
retained-tree ownership and visible-content contract during settlement, but the suite's Tree-sitter
preload still cannot prove ANSI styling or concealment. `conceal` is set by
`packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`) and asserted by no automated
test; real-PTY validation remains required for that visual property.

### Mitigations in place

The retained retry now belongs to `runCiCoverage` in
[the coverage supervisor](../tooling/lib/ci-coverage.ts); `tooling/ci/retry-code-coverage.sh` is a
thin CLI entry. It runs complete workspace scripts sequentially, identifying the package whose
process actually completed. Only Code exits 132/134/139 get up to three additional attempts.
Recovery continues the remaining workspaces before global coverage validation.

- A real test failure is never retried, nor is a crash in another package.
- Neither is 130/143. The historical measurement that parallel Bun fan-out can report sibling
  termination as 130 remains the reason a blanket signal retry would be unsafe. The old sequential
  root probe reported an ordinary failure as 3, not 130. The supervisor does not depend on fan-out
  translating signals consistently: its adapter handles nullable exit codes plus actual signals,
  qualified by small subprocess fixtures with the pinned Bun runtime.
- The earlier argument that Code was necessarily last was incorrect for observed sequential
  fan-out ordering. Its position in the root manifest did not prove all other workspaces had passed.
  The supervisor therefore tracks each completed package explicitly and does not infer completion
  from another package's LCOV. It removes only the selected package's old LCOV before every attempt.
- Cancellation waits for the active child and prevents the next package or retry.

Production: `tooling/lib/ci-coverage.ts`, `runCiCoverage` and `executeCoverageCommand`.
Test: [supervisor tests](../tooling/tests/unit/ci-coverage.test.ts), order permutations, retry
classification/exhaustion, real Bun signal conversion, stale reports and cancellation.

At the historical 31% rate the expected residual red after three retries was ~0.9%.

The `segfault-canary` workflow (`workflow_dispatch` only) measures arms at n ≥ 30 on demand
(`.github/workflows/segfault-canary.yml`, `on.workflow_dispatch.inputs`). Its `jsc.options` declares
the four arms `none`, `no-concurrent-gc`, `single-marker`, and `no-concurrent-jit`; the `measure` step
counts `status -ge 128` rather than the wrapper's narrow set, because a counter wants every signal
death and a retry wants only the ones it is entitled to swallow.

### Where the mitigation stands today

**Checked.** CI runs on pushes to `main` and `develop`, pull requests, and manual dispatch. The
wrapper remains wired into the Linux test step, so the restored workflow exercises it without a
separate migration. Bun 1.4.0 is installed locally and carries the upstream fix; there is still no
post-restoration GitHub-runner sample recorded here. The
retirement gate is at least 30 `@clarvis/code` coverage iterations on Bun 1.4 with zero exits 132,
134 or 139. Until that sample exists, the Code-only retry remains in the coverage supervisor
behind `tooling/ci/retry-code-coverage.sh`. The pre-commit hook invokes `bun run check:pre-commit` directly, not the retry.

Two files in the tree point a reader at this document by path —
`tooling/ci/retry-code-coverage.sh` and `.github/workflows/segfault-canary.yml` (top comment) — which is the
strongest argument for `specs/known-issues.md` continuing to exist at exactly that path.

### On reading rates from small samples

3-of-6 versus 1-of-5 distinguishes nothing. Any future claim needs a sample big enough to mean
something, and **local runs prove nothing** — 25 consecutive full-suite runs on Linux produced 0
crashes while CI was failing a third of the time.

---

## `@clarvis/loop` intermittently dies with `epoll_ctl EEXIST` on CI

Seen once, on the `linux` job:

```
error: EEXIST: file already exists, epoll_ctl at new WriteStream (internal:fs/streams:244)
```

followed by `Cannot call afterEach() after the test run has completed` naming whichever integration
file was loading at the time, and `exited with code 1`.

**This is not the `code` segfault** and must not be filed under it — different package, different
exit code, no `panic`. That distinction is still operational rather than editorial: the retry
supervisor accepts Code's `132 | 134 | 139` and nothing else (`tooling/lib/ci-coverage.ts`), so an exit-1
death of this kind is never retried and never re-runs `@clarvis/code`.

### The `--isolate` theory was wrong; the cause is a leaked pino destination in our own suite

The original reading was: nothing in `loop` constructs a `WriteStream` — there is no
`createWriteStream` anywhere in its `src/` or `tests/`, still true in the current tree — therefore this is
inside Bun, plausibly its `--isolate` implementation reattaching a stream to an fd that is already
registered. **That theory is superseded.** The mechanism is named in the tree, at
`packages/loop/tests/unit/logger.test.ts`: `createLogger`'s stdout branch calls `pino(options)`
with no stream argument (`packages/loop/src/logger.ts`), so pino builds a brand-new `SonicBoom`
around fd 1 every time, with no reuse and no pooling. Left undestroyed, that handle stays alive —
and its write-readiness watch stays registered — for the rest of the process; over a large test run
that repeatedly proved enough to collide with a later, unrelated fd-1 write elsewhere, surfacing as
a `WriteStream` construction failing with `EEXIST` on `epoll_ctl` deep in Bun's runtime. Production
never hits it: `createLogger` is called once per process and the destination lives for the process's
whole lifetime.

The mitigation is `destroyStdoutDestination` (`packages/loop/tests/unit/logger.test.ts`), which
reaches the stream through pino's publicly exported `symbols.streamSym` and destroys it after the
suite's stdout-destination case. It landed in `dcc62896`, whose message records it as "a leaked pino
stdout destination in logger.test.ts that
could collide with Bun's own fd-1 bookkeeping over a large test run".

The Bun 1.4 qualification changed only the flag that measurement disproved. Five isolated Loop runs
had a 20.62 s median against 11.15 s on Bun 1.3.11; five Bun 1.4 shared-global runs all passed in
10.07–10.15 s, and a post-candidate 1.3 control returned to 11.68 s. `--isolate` was therefore
removed from the Loop scripts, while `--timeout 60000` remains: the separate Bun 1.4 timeout probe
still failed at the default five seconds. The fd-1 teardown fix above, the repository-wide
`mock.module()` ban and explicit fake-timer restoration are what make the shared-global suite
honest; removing isolation is not a substitute for any of them.

### The frequency numbers, and why the sweep proves less than it looks

Frequency is unmeasured — one observation is not a rate. A sweep of the complete retained Actions
sample of 107 runs found **zero** recurrences: of the
36 `linux` failures at the test step, 26 were the `code` signal death and the other 10 were ordinary
assertion or threshold failures.

Read that window against the fix boundary. The sweep **begins with `dcc62896`**, so its
zero recurrences are equally consistent with "the leak was closed at the start of the window" and
with "one observation was noise". It is not independent evidence that the entry was a phantom.
Nothing has been added to it in this review. CI triggers were restored, so future
source-grounded sweeps can add evidence once those runs exist; the historical window itself remains
unchanged.

### Residual: the same leak is unmitigated in `@clarvis/kernel`

The loop-side fix was applied to the one site that had it; the class was not closed repo-wide.
`packages/kernel/tests/integration/serve.test.ts` builds several `destination: 1` loggers and
destroys none of them; its `afterEach` restores
`CLARVIS_AGENT_TOOLS_ENABLED` and touches no stream. Kernel's `test` script carries no `--isolate`
(`packages/kernel/package.json`), so every file in that suite shares one process, which is
exactly the "large test run" condition the loop test's own remark identifies. Those five sites are
deliberate — they exist to prove `serveFileKernelOverStdio` refuses a logger bound to its own wire —
so the repair is to destroy each handle, not to remove the tests. If `epoll_ctl EEXIST` is ever seen
again, look at `@clarvis/kernel` before looking at Bun.

---

## The TUI workflow view could enter an unbounded reactive remount loop

**Status: root cause reproduced and fixed; real-model multi-run soak still pending.**

**Verification.** Every fix, guard, bound, counter and test named below is still present
in the tree at the citations given, and the two attributed commits still resolve. What cannot be
re-checked by reading source is the evidence itself: the 11 GiB incident, the instrumented
reproduction's counts, the `demo_02` physical-terminal validation and the `--debug` RSS samples are
runtime measurements, and no source read can confirm or refute them. They are kept here verbatim,
with their original framing, precisely so nobody re-measures them to learn what was already learned.
The source now settles part of the former residual: `bench:code-overlays` has a two-size post-GC
matrix, a parent RSS/time watchdog and a 5 MiB/100 production-policy gate. A real-model multi-run
process-tree soak remains unbuilt and user-controlled.

An interactive workflow session with more than one run made the terminal progressively less
responsive and was observed at approximately 11 GiB resident memory before the process was killed.
The exact interaction has since been reproduced with an isolated `CLARVIS_HOME` and an
empty workflow store: typing `/workflow`, moving to the command and pressing Enter drove the process
past 8 GiB before an external watchdog killed it.

The causal loop was a Solid ownership error. `OverlayRegion` executed a mounted view factory inside
the tracking scope of its `<For>` mapper. The factory constructed `WorkflowsHub`, whose initial
reload synchronously read `rows()` to preserve selection and then started `list()`. When that promise
resolved, `setRows()` invalidated the outer mapper, which reconstructed the whole hub and launched
another reload. One instrumented reproduction recorded 602,837 view-factory constructions,
602,837 hub constructions and 602,837 list starts. The boundary hazard had existed since
`445871f6`; `5873cce` made the workflow path self-feeding by adding the construction-time selection
read.

The direct fix invokes mounted view factories under `untrack`, while preserving reactivity in the
JSX tree each factory returns — `renderMountedView` at `packages/code/src/views/app/OverlayRegion.tsx`,
with the `untrack` boundary. The initial workflow load now belongs to `onMount`
(`packages/code/src/views/config/WorkflowsHub.tsx`), which is what makes the surviving
construction-time selection read in `reloadOnce` harmless, and workflow polling is
single-flight with one coalesced trailing refresh (`refreshActive`/`refreshQueued`,
`requestRefresh`). A follow-up review explicitly rejected putting `untrack` into generic
level, list-row and picker-preview hosts: those callbacks may own a reactive structural branch, and
suppressing that dependency would freeze legitimate UI changes. That rejection still holds in the
tree — no view host, hub menu or picker preview carries an `untrack`; the only other uses are the
theme token writer, the list-navigation enablement gate and the debug counter in
`packages/code/src/views/blocks.tsx`. MCP capability refresh
(`packages/code/src/adapters/mcp-capabilities-bridge.ts`) also became single-flight after the
audit found they could retain unbounded pending requests under a slow backend.

The broader audit did find independent amplifiers rather than an alternative explanation for the
explosive incident. Several collections could grow with the lifetime or number of runs: the rendered
transcript and markdown segments, restored and exported session histories, kernel event queues,
workflow and supervision activity, trace and feature indexes, provider and MCP response bodies,
filesystem catalogs, and timed-out extension work that continued physically after its caller
returned. Limits at only the TUI layer would hide those paths while background work and persisted
state continued growing, so the layered bounds remain valid.

The mitigation is deliberately layered:

- request, model, MCP, hook and capability execution now have bounded admission and wall clocks
  (`packages/capability/src/extension-admission.ts`);
- a timeout does not release the physical-work permit until the underlying operation settles —
  `packages/capability/src/extension-admission.ts` on the permit, and
  `packages/code/src/core/diagnostic-events.ts` on why `diagnosticAsync` refuses to race the
  operation it observes;
- live transcript output has both line and character caps (`packages/code/src/adapters/store.ts`),
  while hydrated tool bodies have independent count and aggregate-byte caps;
- plans, workflows, memories, traces, worktrees, plugins, skills and configuration catalogs use
  bounded incremental scans and reject oversized records before materializing or persisting them
  (`packages/kernel/src/workflows/workflow-store.ts`, `packages/skills/src/limits.ts`);
- completed runs release transient ingestion and owner-scoped state on absolute deadlines
  (`packages/kernel/src/runs/managed-run.ts`);
- the TUI keeps a bounded viewport, hydrates large details on demand
  (`packages/code/src/adapters/store.ts`), disables the production renderer console overlay
  (`packages/code/src/adapters/renderer-bootstrap.ts`, `buildRendererConfig`), and exposes a
  last-resort RSS fuse whose default threshold is 2 GiB (`DEFAULT_TUI_RSS_LIMIT_BYTES`,
  `packages/code/src/adapters/memory-pressure.ts`);
- interactive `--debug` writes bounded, redacted JSONL with lifecycle, memory, command, view and
  refresh counters; repeated counters use first-eight-and-powers-of-two sampling
  (`packages/code/src/adapters/diagnostic-session.ts`) so a runaway stays observable without the
  log becoming another leak.

The RSS fuse is a secondary defense, not protection from this class of loop. In the reproduction its
500 ms interval (`MEMORY_PRESSURE_SAMPLE_MS`, `packages/code/src/adapters/memory-pressure.ts`)
stopped running after navigation because the self-feeding promise/microtask chain starved timers. An
independent process watchdog is still required for destructive soak tests. The overlay harness now
provides one for its child processes; ordinary interactive and real-model multi-run work still
requires host-level process-tree monitoring.

The tests include the exact `OverlayRegion + WorkflowsHub` composition
(`packages/code/tests/integration/overlay-region-render.test.tsx`), factory-construction
invariants, slow single-flight polling
(`packages/code/tests/integration/workflows-hub-render.test.tsx`), thousand-event refresh storms
(`packages/code/tests/component/mcp-bridge.test.ts`, 1,000 queued refreshes each),
repeated-run (`workflows-hub-render.test.tsx`), never-settling-operation,
oversized-body, sparse-file, deep-schema, wide-catalog and transcript-restoration cases. The counter
sampler's own test is written against this very defect's counter:
`packages/code/tests/unit/diagnostics.test.ts` drives `overlay.view.factory` 1,024 times and
asserts the emitted counts are exactly `[1..8, 16, 32, 64, 128, 256, 512, 1024]`.

A physical-terminal validation in the real `demo_02` workspace opened the stale persisted workflow,
soaked its running poller for 15 seconds and cycled list/tree navigation 100 times. The external
sampler observed a 213,080 KiB peak and 194,452 KiB at the end; the debug log recorded one overlay
factory and one hub construction. That validates the interaction which triggered the incident, but it
does not substitute for the remaining acceptance work: a multi-run soak using a real model while
sampling the complete process tree.

A later `--debug` pass in that workspace, using its OpenRouter/DeepSeek profile, recorded 68 bounded
events: one overlay factory, one workflow-hub construction, no pending/failed async operation,
335,421,440 bytes as the largest process-reported RSS sample and 237,301,760 bytes at shutdown. The
log closed normally with `diagnostics.stop` and was 20,914 bytes; these are regression measurements,
not a claim that every real multi-run workload has been soaked.

The same validation exposed an independent crash-recovery defect: the persisted workflow stayed
`running` even though its manager and four leader traces had been recovered as `interrupted` after
the old process died. Workflow reads now reconcile a running record only when the matching root trace
already contains terminal evidence, persist the repaired body and summary, and close only edges that
are still running — `reconcileRunningWorkflowRecord` at
`packages/kernel/src/workflows/workflows-service.ts`, reached from the read paths through
`reconcilePersisted`. Age and workspace-wide leases are deliberately not used because
neither proves that this particular execution is dead. The repair is lazy rather than a restart
sweep, and its residual is documented at the function itself: if the crashed run's journal was never
recoverable — unopenable, quarantined as corrupt, refused as oversized, or past the boot budget — no
persisted record exists, so no evidence ever appears and the workflow stays `running` for good. An
eager restart sweep would read the same absent evidence, so what is genuinely unbuilt is a repair
that does not depend on the trace, and no such source of truth exists today.

---
## Settled transcript blocks can remount and flicker under unrelated live activity

**The production ownership path is replaced; row-architecture product qualification is separate.**
Code uses one projection of stable row IDs and one bounded native viewport under OpenTUI 0.5.9.
Terminal sealing revises record content, not membership in live/history trees. Exploration groups
exist from their first explicitly classified member; shell, mutation and unknown tools stay
individual. The normative contract is
[code-transcript-stability.md](hosts/code-transcript-stability.md).

The original native experiment on OpenTUI 0.5.7 isolated a real structural invalidation defect:
539 later assistant characters caused 188 distinct Code renderables and 187 replacements for a
settled 1,226-character Markdown result. Removing the reactive grouping prop kept one renderable.
A synthetic diff driven through 40 unrelated grouping updates created 41 diff renderables and 72
invisible samples; the control kept one diff and zero invisible samples. These were ad hoc causal
experiments, not product rates or comparable performance baselines for the current architecture.

Subsequent batch-based publication work exposed distinct problems: deleting the live flow child on
wheel-up changed scroll height and clamped reading; offscreen syntax candidates could wait forever
for render hooks skipped by culling; live-to-history transfer and solo-to-group-head conversion could
still recreate tool presenters. That architecture, its staging/measurement machinery and its owner
handoff APIs are removed. Do not reintroduce them as a fallback. Current rows can change height and
rewrap; a semantic anchor transaction preserves reading independently of parser ownership.
There is no handoff spacer or suspended culling path. Explicit return-to-tail waits for the newest
row window's layout, scrolls to the native bottom and releases its transaction with culling enabled.

Current deterministic evidence covers the native row and internal presenter through composition,
pending, execution, terminal and the next user message; finalized diff/code parsers through unrelated
deltas; group admission at 10/90/500 ms without a grouping timer; 500 members with bounded expansion;
80/81/1,001 rows; prepend plus concurrent append; sidebar width changes; and 100 Lead/child and
100 expansion cycles. Rapid projection requests are coalesced before admission so intermediate
unpainted destinations do not allocate whole native trees. The full Code coverage rerun passes
2,791 functional tests and 50 architecture tests, including these cycles, without the earlier
native allocation failure. That result is distinct from focused-test evidence.

Production: `TranscriptRows`, `TranscriptContent`, `TranscriptViewport` and `TranscriptRowView` in
[rows.ts](../packages/code/src/core/transcript/rows.ts),
[transcript-content.ts](../packages/code/src/adapters/transcript-content.ts),
[TranscriptViewport.tsx](../packages/code/src/views/transcript/TranscriptViewport.tsx), and
[TranscriptRowView.tsx](../packages/code/src/views/transcript/TranscriptRowView.tsx).
Test: [transcript-rows-render.test.tsx](../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../packages/code/tests/integration/transcript-content-render.test.tsx),
[transcript-window-render.test.tsx](../packages/code/tests/integration/transcript-window-render.test.tsx),
and [transcript-records.test.ts](../packages/code/tests/unit/transcript-records.test.ts).

Historical PTY captures and batch-owner memory measurements do not qualify the new implementation.
Linux PTY validation with an authorized Grok subscription exercises three concurrent children,
read exploration, continuous shell output, native mutation diff, missing-file error/recovery,
projection navigation and resize. A narrow-terminal Agents drawer deliberately obscures the
transcript; closing it restores the selected reading position. The final artifact's automated smoke
passes, and its restart restores the durable failure and recovered result. Recorded intermediate
frames and native identity assertions complement screenshots; none establishes every possible
terminal interleaving. The numerical historical benchmark exited 137, so a comparable 10% RSS
regression verdict remains unavailable. macOS runtime qualification is not established by
these Linux results.

---

## Ten behaviours that turn on something outside this repository

Carried here from the gap report's §4 and re-verified entry by entry. What these share
is that reading `packages/` cannot settle them: the fact each one depends on lives in a third party's
payload, in a dependency's own source, in a binary on the host, or on a platform nothing here runs.
Each entry says what the dependency is, what breaks concretely if it moves, what the repository does
about it today, and what would settle it.

Several of the report's own claims did not survive that re-verification. The corrections are inline
rather than gathered in a list, because a reader who opens one entry should not have to find them
somewhere else. Nine of the ten are open; the tenth is recorded below as resolved, because the
document it reported missing is this one.

### The models.dev catalog is an accepted dependency, and its payload shape is load-bearing

The owner has ruled on this one: models.dev stays. It is recorded as a dependency worth watching,
never as something to remove or reduce.

`packages/kernel/src/data/models-dev.json` is a 1.7 MB vendored snapshot, loaded from the source tree
(`packages/kernel/src/models/model-catalog.ts`), from an artifact copy beside a bundle,
or from a `configDir` cache preferred over both. Every price, context window,
capability set and reasoning-effort list the product shows comes out of it, and `prompt_cache` mode
is *derived* from the shape of a published price because models.dev publishes no `supports_caching`
flag.

The asset remains installed but no longer enters interactive first boot. Code's foundation never
calls the models service; the first Model, Effort or Providers mount invokes a single-flight loader.
The clean-HOME artifact smoke requires the asset while rejecting any pre-paint
`catalog.load.started` event (`packages/code/src/runtime.tsx`, `ensureModelsCatalog`;
`packages/code/tooling/artifact/smoke.ts`).

**The snapshot is not raw models.dev, and that moves where the risk sits.** It is already in
projected `CatalogData` shape: two top-level keys, `source` equal to `https://models.dev/api.json`,
166 providers, 5,501 models. So the `.passthrough()` schemas (stated in
TSDoc) are not what absorbs an upstream change — `projectModelsDevApi` is, and it
absorbs silently. It reads every provider's models through `asRecord(p.models)`, so any
change to the root shape collapses at that one nesting key rather than being reported.

*Measured on this tree.* Wrapping the committed payload one level deep — `{ providers: … }`, the
shape an added envelope would produce — projects to **1 provider and 0 models**; an array root
projects to 3 providers and 0 models. `refreshModelsCatalog` then writes whatever
projected, with no plausibility check of any kind, and `loadCatalogData` prefers any
cache that satisfies the schema. A zero-model cache therefore shadows the good bundle permanently,
and `--refresh` cannot repair it, because the same fetch produces the same cache.

*What the repository does today.* `packages/kernel/tests/unit/prompt-cache-mode.test.ts`
holds whole-corpus invariants over the committed snapshot, and the artifact copy is guarded end to
end (`packages/code/tooling/artifact/build.ts`'s `ASSETS`, `packages/code/tooling/artifact/smoke.ts`'s
`REQUIRED_ASSETS`). **The refresh path is now guarded too**, which is the half of this that was a
live defect rather than a dependency risk: `refreshModelsCatalog` refuses a projection in which no
provider carries any model, and says so, rather than writing it — so the catalog the host already has
survives a payload this build cannot read. Nothing still re-checks a cache on the way back *in*; a
cache written before this guard existed is not re-validated on load.

*Two corrections to the gap report.* It calls `KNOWN_BASE_URL`'s seven entries "a curated list with
no stated derivation" and cites `packages/kernel/src/models/model-catalog.ts`. The table's
TSDoc, and it states the derivation in as many words — "A gap-filler, not a registry … Membership is
therefore not an endorsement and not exhaustive." Second, a count floor is the wrong remedy: a
proposed `MIN_CATALOG_PROVIDERS = 20` / `MIN_CATALOG_MODELS = 500` turns two currently-green tests
red, because `packages/kernel/tests/integration/model-catalog.test.ts` each mock
`fetch` with one provider holding one model. A structural predicate — some provider has at least one
model — catches every root-shape change a count floor catches, needs no re-tuning as the market
moves, and breaks neither fixture.

*What would settle it.* A payload contract from models.dev, or a schema it versions. Neither exists,
so the achievable posture is a guard on the way in, never a guarantee.

### The foreign plugin-dialect tables rest on a census taken outside this tree

`EXTERNAL_TOOL_NAMES` and `EXTERNAL_TOOLS_WITHOUT_COUNTERPART`
(`packages/capability/src/hooks-config.ts`) exist because a measurement
was taken over a public catalog of plugin manifests, and that catalog is not in this repository.
`packages/kernel/src/plugins/hook-dialects.ts` states that naming the hosts is deliberately
avoided — "Naming the hosts would date the file and invite a class per vendor, when what varies
between them is data" — which is a good rule and also means the census can never be reconstructed
from the tree.

*What breaks if the census is stale.* A foreign name that gains a Clarvis counterpart, or a sixth
name that has none, changes what a filter matches. The failure is silent in the worst direction: the
TSDoc records that of the thirty-nine names those filters used, five existed here,
and the other thirty-four "translated cleanly, installed, were approved, and then matched nothing".

*The in-tree architecture defect is resolved; the external census provenance remains open.*
`packages/kernel/tests/architecture/external-tool-names.test.ts` now normalizes every real
registry name before comparing it with `EXTERNAL_TOOLS_WITHOUT_COUNTERPART`, so a future host tool
whose separators differ from the census key does contradict the table and fail the test. The same
suite also checks every mapped target against the built-in registry or the explicit capability-tool
set, and proves that set has not become redundant. This closes the previously near-vacuous assertion;
it does not make the public catalog that motivated the table reproducible inside this repository.

*Correction on the census count.* The report says the 196-plugin figure is "cited four times" and
names three sites, one of which — `packages/kernel/src/plugins/plugin-manifest.ts` —
carries a **different** measurement (twenty plugins declaring a non-default skills location, holding
316 skills) and no `196` anywhere. In the current source the public-catalog measurement
appears in three comments: `packages/capability/src/hooks-config.ts`,
`packages/loop/src/settings/settings-schema.ts` and `packages/skills/src/schema.ts`.
The former `MarketplaceBrowser` occurrence no longer exists; separate 196-item benchmark and render
fixtures are synthetic workload sizes, not another citation of the public census.

*What would settle the remaining issue.* The catalog, or a published registry of the foreign dialect.
Neither is here, so the architecture test can pin internal consistency but cannot prove that the
hand-maintained vocabulary is exhaustive or current.

### The prompt-cache design turns on provider behaviour, and two of its numbers are in-tree after all

The `openai-compatible` session-affinity design (`packages/llm/src/ai-sdk/request-options.ts`) turns on OpenRouter treating `session_id` as the primary backend-affinity key and
`prompt_cache_key` as a fallback, and on the two engaging at different moments. Nothing in this tree
can observe either.

*The gap report says "None is reproducible from this tree." That is wrong for two of the claims, and
they are the two it singles out as most exotic.* Both reproduce from the committed snapshot:

- The "120-to-1 against a cache read" ratio is exact in-tree arithmetic. `deepseek/deepseek-v4-pro` in
  `packages/kernel/src/data/models-dev.json` carries `input: 0.435` and `cache_read: 0.003625`; the
  quotient is 120 exactly.
- The router census at `packages/kernel/src/models/model-catalog.ts` — "642 of the 680
  catalog models whose pricing reads `explicit` sit behind one … against 30 on `anthropic` and 8 on
  `openai`" — reproduces to the unit. Counting models with `cost.cache_write > 0` and grouping by the
  snapshot's own provider `kind` gives 680 total: 642 `openai-compatible`, 30 `anthropic`, 8
  `openai`, 0 `google`.

*What genuinely is not reproducible here*, and stays a claim in a comment: the `deepseek-v4-pro`
affinity probe (`request-options.ts`), the "~95 chars/s a real run streams at"
(`packages/llm/src/ai-sdk/streaming.ts`), the "~3000 reports per call at ~1 ms
inter-arrival" (`streaming.ts`), the DeepInfra no-op and Novita lottery measurements
(`model-catalog.ts`), and the 2,929,430-token / 35.7% incident that
`specs/cross-cutting/prompt-cache.md` is built around.

*Two defects in the same family that the report does not name.* Both are silent and both are green
today. `packages/memory/tests/architecture/indexer-surface-identity.test.ts` says
`specs/cross-cutting/prompt-cache.md` "prices that at 120-to-1"; that document contains no such figure
— its only `120` belongs to an unrelated bound. And
`packages/code/tests/integration/providers-key-render.test.tsx` restates the Novita spread as a
"49-92% lottery" where the owning statement at `model-catalog.ts` reads 54.6%, 73.0%, 92.5% and
51.9% — the floor is 51.9, and the restatement has drifted.

*What would settle it.* Live provider runs, repeated, against endpoints whose behaviour changes
without notice. A test in this tree can pin the *mechanism* — and several do
(`packages/llm/tests/integration/wire-cache-diff.test.ts`,
`packages/loop/tests/prefix-stability.ts`) — but it cannot re-take the observation.

### Three readings of dependency-internal behaviour, and the report is wrong about the first

The gap report groups these as one item. They have three different answers.

**`MarkerSite` is checkable here, and nothing checks it.** The report says the derivation at
`packages/llm/src/ai-sdk/request-options.ts` "is not verifiable here" because
`convertToOpenAICompatibleChatMessages` lives inside `@ai-sdk/openai-compatible`. It is a **public
subpath export** of a package this workspace already installs:
`node_modules/@ai-sdk/openai-compatible/package.json` maps `"./internal"`, and the symbol is declared
in `dist/internal/index.d.ts`. So the derivation could be pinned by a test, and no such test exists.
One of the three arms is pinned incidentally:
`packages/llm/tests/integration/provider-request-shape.test.ts` asserts `markedIndices` equals
`[0, 1]`, wire index 0 is the lifted system message (`request-options.ts`), and `markedIndices`
 only counts a message whose `content` is an **array** carrying `cache_control` — which
happens only if the real SDK spread the message-level `providerOptions`. The multi-part-user and
assistant-text-only shapes of the `"message"` arm are pinned nowhere.

**`MCPClientHandle.protocolVersion` still depends on an SDK call guarantee, but exposes nothing.**
The capture works by replacing `transport.setProtocolVersion`
(`packages/mcp-client/src/client.ts`), and whether the SDK calls that method exactly once,
or at all, is outside this tree. The field is typed `string | undefined` and its one reader
guards it (`packages/mcp-client/src/connection.ts`), so a version that never arrives degrades to
an absent diagnostic field rather than to anything worse. The half worth pinning is the *forwarding*,
not the capture: re-binds the original and calls through, which is what keeps
`mcp-protocol-version` on every post-handshake HTTP request. A test now drives that
against a real SDK client and a real HTTP server
(`packages/mcp-client/tests/integration/protocol-version.test.ts`).

**A `null` tool result is now determined, and cannot come from the real SDK.** `CallToolResultSchema`
extends a `z.looseObject` and the response is parsed with `safeParse`, so a `null` payload resolves as
a rejection and never reaches the mapper. `interpretCallResult` no longer dereferences unguarded:
`packages/mcp-client/src/tool-results.ts` returns an `mcp_runtime_error` for a nullish
result, and the TSDoc records that the branch defends the `MCPClientFactory`
substitution seam and **not** the SDK. That distinction is load-bearing — a reader who takes it for
an SDK guard will reopen the question.

*What would settle the first item.* A test over `./internal` asserting, for each of the message
shapes the derivation enumerates, where the SDK reads provider metadata from. That is possible here
and has not been done. Nothing binds a future version of either dependency; a test converts a
reading into a regression alarm, which is the most this repository can do about a third party.

### External Git dependency for plugin browsing

**`git`, and a citation the report gets wrong.** It cites
`packages/code/src/adapters/marketplace.ts` as "spawns `git` directly through
`Bun.spawn`". Those lines are TSDoc `@remarks`, not code, and that module contains no spawn at all:
it imports `gitCloneAsync` and calls it, and the spawn is
`packages/code/src/adapters/plugin-install.ts`. The substance is right and is already
recorded at the declaration — against a remote kernel, installing a plugin would reach the kernel's
filesystem while adding a marketplace would clone onto the operator's own laptop. What is recorded
nowhere is the precondition itself: `git` must be on the **client's** `PATH` for the browse path, and
nothing in the tree fails if that seam is later rewired. Git is separately the authority for every
launch-time worktree fact.

*What would settle this.* An architecture test over the client-side Git seam.

### `link()` atomicity and `fsync` durability are asserted by comment, and only one of them is stale

**The `link()` half stands, and is worse than the report says.**
`packages/paths/src/local-lease.ts` contains a `//` comment asserting that "the canonical path
appears in one step and already refers to complete, fsync'd bytes" immediately above the
`await link(temp, path)` branch, which reads `EEXIST` as contention, returns null, and rethrows
anything else. Three things compound it. The comment violates this repository's own standard
(no `//` in `src/` outside an otherwise-empty block); `tryPublish` carries no TSDoc at all;
and the synchronous twin `tryPublishSync` reaches `linkSync(temp, path)` with
the rationale recorded **nowhere**, so the invariant is documented on one of two identical paths.

*What breaks if the premise is false.* Publication **is** the mutual exclusion. On a filesystem whose
`link` replaces rather than refuses, two acquirers both believe they hold the lease. That consequence
is pinned behaviourally — `packages/paths/tests/contract/local-lease.test.ts` asserts the
second `acquireLocalLease` returns null while the first still owns the record — but nothing in
`packages/paths/tests` exercises `link`'s `EEXIST` refusal directly, so the suite pins the outcome on
whatever filesystem it runs on and never the premise it rests on. A filesystem without hard links
fails acquisition loudly rather than degrading, because rethrows and `acquireLocalLease`
 does not catch.

**The `writeFileDurable` half is largely stale.** The dependency is already recorded in TSDoc:
`packages/paths/src/atomic.ts` explains why `rename` is atomic but not durable, and why unsupported directory sync errors degrade a durable write to an atomic one. The degradation is pinned by
`packages/paths/tests/contract/atomic.test.ts`, both for the never-throws property and for one
`paths.fsync_dir_unsupported` diagnostic per errno. "No test in
`packages/memory/tests` simulates a power loss" is literally true and misleading:
`packages/memory/tests/integration/journal-recovery.test.ts` simulates the *interruption* the journal
exists for. What is unobservable is the physical guarantee that `fsync`'d bytes survive a power cut,
and no unit suite can observe it.

*What would settle the first half.* Two unconditional assertions on the primitive plus one that binds
them to `acquireLocalLease`, so the test fails on a filesystem where the design's premise is false
rather than passing as an operating-system probe. The second half cannot be settled here at all.

### The plan file's YAML dialect is the dependency's default, not a declared contract

`packages/plan/src/format.ts` calls `parseYaml(match[1]!)` with **no options**, calls
`stringifyYaml(fm, { lineWidth: 0 })`. The timestamps go out unquoted while
`planDocumentSchema` requires `z.string().datetime()` (`packages/plan/src/schemas.ts`). The
installed `yaml` is 2.9.0, and the dialect the plan store's on-disk format depends on is whatever that
package defaults to.

*The report says a dialect change "would break parsing silently at the schema". That is wrong in
direction, and it misses the half that is genuinely silent.* Measured here on yaml 2.9.0:

- Under `{ version: "1.1" }`, an unquoted `created_at` representing ten o'clock UTC resolves to a
  `Date`.
  `planDocumentSchema.parse` at `format.ts` then throws, and the round-trip at
  `packages/plan/tests/unit/plan-format.test.ts` goes red. That failure is **loud**, and the
  pre-commit gate catches it.
- The silent half is `unknown_frontmatter`. `unknownFrontmatterSchema`
  (`packages/plan/src/schemas.ts`) is `z.record(z.string(), z.unknown())` and accepts
  any value, so a 1.1/1.2 divergence that lands there
  raises nothing: `owner_note: yes` becomes boolean `true` and an unquoted `window` value written as
  ten-colon-thirty becomes the number
  `630` — both measured — and `renderPlan` writes those back into the user's own plan file. The one
  fixture is `owner_note: hello` (`plan-format.test.ts`), which is dialect-insensitive.

*The runtime consequence, if such a change ever shipped past the gate, is silent too.*
`packages/plan/src/file-repository.ts` logs `plan.document.unparsable` at `warn` and skips the file,
so every plan would vanish from `list_plans` while the files sit
untouched on disk.

*The `%YAML 1.1` directive path is closed, but by the regex rather than by the parser.* Measured:
`parseYaml("%YAML 1.1\n---\ncustom: yes")` yields `{ custom: true }` — the default parse honours a
directive — while `splitDocument`'s regex at `format.ts` is non-greedy over `\n---\n`, so a
directive can only reach `match[1]` bare, where `parseYaml` throws "Missing directives-end/doc-start
indicator line". The closure is incidental, and a later relaxation of that regex would open it.

*What would settle it.* Pinning `{ version: "1.2", schema: "core" }` at both call sites and asserting
the scalar types through `parsePlan`/`renderPlan` rather than against the `yaml` package. Not done.

### The Bun crash's evidence is no longer outside this corpus — resolved

The gap report says `tooling/ci/retry-code-coverage.sh` and `.github/workflows/segfault-canary.yml` "both
point at a `specs/known-issues.md` that is not part of this corpus, so the measured crash rate, the
retry's expected residual failure rate, and whether any canary arm has been run are unknown to these
documents." Every checkable part of that is now stale, and this is the file it named.

Verified: `tooling/ci/retry-code-coverage.sh` still names this document for the retained crash
policy and retirement canary, and `.github/workflows/segfault-canary.yml` (top comment) reads
"@clarvis/code suite (see specs/known-issues.md). One arm per dispatch;". Both paths resolve. (The
report cites the path literal is, the earlier lines being
the surrounding prose.) The rate is carried above under *The rate, measured* — 26 of 84 runs, 31.0%,
every one in `@clarvis/code` and every one exit 132 — and the residual under *Mitigations in place*:
at 31% the expected residual red is ~0.9%. The upstream family is oven-sh/bun#17241 duped into
#15964, and the retracted attribution to #31832 is recorded so it is not re-filed there.

**One sub-claim survives, and it is permanent unless CI returns.** The four JSC arms are declared
(`.github/workflows/segfault-canary.yml`, `on.workflow_dispatch.inputs.jsc.options`) and **no result for any of them is recorded
anywhere in the tree** — which is as much as can be established here; the canary deliberately
remains `workflow_dispatch`-only because each batch is expensive. Report this item as resolved on rate, residual, upstream issue and
mechanism, and unanswered on arm results.

### ~~The Bun version story is inconsistent~~ — resolved

The recorded baseline really was split: mise and all three CI jobs ran 1.3.11, both server stages
ran 1.3.14, root `@types/bun` was 1.3.14, and the 20 manifest floors were `>=1.3.11`. That let code
typecheck against runtime APIs the developer and CI executable did not necessarily have, while the
server image ran a version neither of them qualified.

The active contract is now exact Bun 1.4.0 for executable pins and `>=1.4.0` for every manifest.
`tooling/checks/bun-version.ts` derives the canonical version from `mise.toml` and checks all
three CI setup steps and their version/revision evidence, the crash-canary default and its evidence,
all workspaces discovered from the root manifest, `@types/bun`, and both the
declared and resolved lockfile entries. It runs inside `lint:intent` (`package.json`), and the nine
cases in `tooling/tests/unit/bun-version.test.ts` make every drift class fail independently.

The old 1.3.11-versus-1.3.14 performance measurements above remain historical evidence, not a claim
about 1.4. Likewise, fixture prose in `packages/memory/src/testing.ts` and its tests deliberately
mentions old versions; the checker enumerates executable contracts instead of rewriting arbitrary
prose.

Local Linux qualification produced two attributable results. The Bun 1.4.0 Code
coverage-plus-architecture canary completed 30/30 process-fresh iterations with zero signal exits
and zero test failures. The seven-sample TUI benchmark was trusted (AC power, performance governor,
16 cores, load/core 0.068–0.093): source and bundle first-paint medians improved from 1325.90/1327.12
ms on 1.3.11 to 1134.21/1134.64 ms on 1.4.0; bundled `--version` improved from 418.02 to 281.66 ms.
This local candidate evidence does not stand in for the still-unrun GitHub 1.3 control arm or the
macOS job.

---

## Complete TUI hydration remains above 500 ms under Bun 1.4.0 and OpenTUI 0.5.7

**Mitigated at the functional-input boundary; strict complete hydration remains
unresolved.** The lightweight entry now paints a focused startup composer before importing the
complete application runtime. A forced three-sample local bundle batch was untrusted because
load/core was 0.369 against the 0.35 gate, but its staging was stable: minimal shell and focused
input both had a 182 ms median, while complete header and input hydration had a 675 ms median. One
nine-plugin real launch reached the focused composer at 264 ms and complete hydration at 1,110 ms.
These samples are not mutually comparable; they establish which stage remains expensive, not a
cross-machine absolute baseline.

The repository-owned multiplicative waits were separately reproduced and corrected. Repeated plugin
parsing/hashing had made the same nine-plugin Extension Profile take about 32.9 seconds; pinned projections
plus canonical per-file descriptor-bounded revalidation at admission and lazy skill reads reduced
the observed combined resolution to about 330 ms. Two unanswered MCP OAuth flows had each waited
about 302 seconds; background authorization
now leaves only those servers inactive and the real run completes while their browser pages are
ignored. Neither correction weakens fingerprint drift or token persistence.

Three artifact experiments bound the remaining complete-hydration path:

- disabling Bun splitting made both startup and complete paint worse;
- Bun bytecode emitted a CommonJS artifact that could not load OpenTUI's asynchronous ESM graph;
- absorbing OpenTUI into the application bundle failed on OpenTUI modules that use top-level await.

The direct failures mean Clarvis cannot currently replace the split ESM/OpenTUI load with those two
Bun artifact strategies. They do not prove every remaining 675 ms is irreducibly upstream, so future
work must keep measuring runtime chunk topology and must not reintroduce eager plugin walks. The
product mitigation is load-bearing: a task submitted in the startup composer begins when the run
host is ready, before complete-app mount. The revalidation procedure lives in
[the TUI skill's performance mode](../.agents/skills/clarvis-tui-validation/references/performance.md).

---

## Layout decisions that were tried and reverted

Both reverts still hold. What moved is where the guards live and what the second
half's supporting prose is allowed to cite, not what either revert prevents.

### A `config/` layer under `~/.clarvis`

It read well as a lifetime split but made the global tree disagree with the workspace one, where
`<ws>/.clarvis/settings.json` and `<ws>/.clarvis/agents/` have always sat at the root.

The two trees still agree, and neither carries a `config/` segment: `globalPaths`
(`packages/paths/src/global.ts`) puts `settings.json` and `agents/` directly under the global root,
exactly as `workspacePaths` (`packages/paths/src/workspace.ts`) puts them directly under
`<ws>/.clarvis`.

It also broke `bun run smoke` for four days without naming itself: the fixture seeded the old shape,
the artifact booted to a fleet-less header, and the failure surfaced as a 90-second timeout.
_(That is a CI observation and is **unverifiable** by reading source — the four days and the
90-second timeout cannot be re-measured. What can be checked is that both repairs are still in the
tree, and they are.)_

- The fixture builds its HOME from `globalPaths()` instead of string joins. It now lives in
  `createSmokeFixture`/`SmokeContext` (`packages/code/tooling/artifact/isolation.ts`), which derives
  the full global layout from an explicit fixture root, writes only `paths.settingsFile`, and owns
  cleanup. The retained `makeCleanHome` export is a private compatibility alias; the entry script
  still exists — root `package.json` → `packages/code/package.json` — and reaches the layout through
  the shared context (`packages/code/tooling/artifact/smoke.ts`).
- `packages/paths/tests/architecture/invariant.test.ts` scans package `tooling/` as well as `src/` —
  restricting it to `src/` is what let the drift through. The two globs remain, and their TSDoc
  still names the artifact smoke and the 90-second timeout as the reason the
  second glob exists.

### A mid-run open-task nudge

Specified and rejected, and still not implemented. The pending-task gate is a `FinalizeGate` only:
`pendingGate` at `packages/plan/src/capability/orchestration.ts`, over `pendingTaskGate`, registered in the contribution's `gates` array and nowhere else. The engine runs
gates at exactly two points in `packages/loop/src/runtime/loop/run-agent.ts` — the `submit_result`
handler (`runGates`) and the contract-less text-only path (`onTextOnly`,
`runGates`, reached only after the `if` branch has returned). So a run cancelled
mid-flight is never asked about its open tasks: cancellation returns `cancelledResult()` directly
 without touching a gate. The lead records its task progress explicitly through
`transition_plan_task`.

The plans capability does contribute a `beforeIteration` hook
(`packages/plan/src/capability/orchestration.ts`), which is the obvious place such a nudge would
land. It only resets the per-iteration flags and republishes the plan as canonical context. It does
not nudge.

Adding a per-iteration nudge was rejected because the then-current `PENDING_TASKS_NOTE` asked for
"a short result" before the work was necessarily ready, inviting an invented verification result in
the auditable record. The note now explicitly distinguishes delegation from closure and requires an
observed outcome before `done`, or a real reason for `abandoned`; it forbids invented results and
repeated-finalization bypasses. Production: `PENDING_TASKS_NOTE` in
`packages/plan/src/capability/messages.ts`. Test:
`packages/plan/tests/unit/plan-messages.test.ts`.

This wording repair does not add a mid-run gate. The shipped profiles carry short harness handoff
rules (`packages/kernel/src/config/builtin-agents/`), not a mechanism that proves work completed.
A runtime nudge that requests a result before completion creates the same bad choice for any profile.

If it is ever added it must read _close the task or state why you cannot_, never _mark it done_, and
must not fire while the agent is still producing file writes.
