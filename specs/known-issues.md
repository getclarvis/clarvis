# Known issues

What was **measured**, what was **ruled out**, and what was **tried and reverted**. `AGENTS.md`
carries the short form of each entry; this file carries the evidence.

It sits beside [`specs/README.md`](README.md)'s sixty-eight-document corpus rather than inside it, and
the distinction is load-bearing. That corpus specifies what Clarvis must do and cites the
lines that implement it; it cannot say what a CI run measured, what an RSS soak showed, or what was
attempted and abandoned. `specs/cross-cutting/build-and-ci.md`
§8 says so explicitly about the Bun crash below: it documents the retry state machine and reports the
rate as unknown to it. This file is where that kind of evidence lives, and its whole purpose is to
stop someone re-diagnosing what has already been diagnosed.

Entries carry their own verification or resolution dates; there is no single whole-file verification
date. A measurement taken from a CI run or a memory soak cannot be re-taken by reading source; those
are kept verbatim, with their original framing, and each entry's note says what a source read could
and could not settle.

---

## Four defects that were confirmed here, and have since been fixed

Carried from the gap report's §1.1 on 2026-08-22 and closed the same day. They are kept because the
diagnosis is the expensive part and each cost a real hunt; the fix is one line in three of the four.
Each is also recorded in its owning spec's §8.

**A `run_ended` event carrying `code` could not cross the kernel wire, and took the connection with
it.** The protocol declares `code?: string` on `run_ended` (`packages/protocol/src/runs.ts:293-309`)
and the engine mapper emits it whenever the trace entry has one, but the client codec's `run_ended`
schema was `.strict()` over `type`/`at`/`status`/`reason` alone. A strict object rejects the extra
key, `decodeRunEvent` answers `null`, and `connectKernelClient` reads that as a protocol violation:
it settles **every** live run `unavailable` and closes the transport. One field nobody had
round-tripped could end a client session.

Fixed by adding `code: text.optional()` to the codec
(`packages/kernel/src/transport/run-event-codec.ts:91`), and pinned by
`packages/kernel/tests/contract/transport-codecs.test.ts`'s "carries a failed run's error code
instead of killing the connection". The more useful half is the guard: the
`satisfies Record<RunEvent["type"], z.ZodType>` beneath the table constrains the *key set* only,
never a payload's shape, which is why `tsc` could not see this. `CodecFieldDrift`
(`packages/kernel/src/transport/run-event-codec.ts:455-470`) compares every variant's declared
fields against its schema's inferred fields in both directions and fails to compile on a mismatch,
naming the variant and the field. Deleting the new codec line reports
`{ variant: "run_ended"; drifted_field: "code" }` rather than a green build.

One trap in writing that guard, worth knowing before editing it: `Extract<RunEvent, { type: K }>` is
the obvious spelling and it is wrong here. One member declares a **union** discriminator —
`delegation_completed | delegation_failed` (`packages/protocol/src/runs.ts:433`) — and a union is not
assignable to one of its own literals, so `Extract` answers `never`, `keyof never` widens to
`string | number | symbol`, and the guard reports drift on a variant that has none.

**`TurnRef.error` was written and then dropped on the way to disk.** It is populated by `endTurn`
(`packages/code/src/adapters/session.ts:151`), and **both** legs of the wire conversion dropped it —
`metaToSession` on the way out and `sessionToMeta` on the way back — so a one-sided fix would not
have round-tripped. A run that failed came back after a reload saying only that it failed, which is
the exact undiagnosable case the field's own TSDoc describes it as fixing.

Fixed at `packages/code/src/adapters/session-store.ts:294` and `:323`, with the value masked and
bounded at the **producer** (`redactTurnError`, `:155`) so the in-memory and on-disk values stay
identical and the existing `redactPreviews: false` opt-out keeps working. The masking is not
optional: this is the first provider free text Clarvis writes into a session document, and an
unbounded message could push the document past `SESSION_MAX_BYTES`, after which the store swallows
the throw and silently stops persisting that session for its whole life. The read path validates the
`{code, message}` shape (`persistedTurnError`, `:284`) because a session document is the one input
here that no schema describes — `isSession` checks identity and `Array.isArray(turns)` and nothing
else, so an added key is not rejected on read and a corrupt one is not caught either.

**A `preDelegateTask` hook's `rewrite` verdict was computed and silently discarded.**
`runVerdictHooks` built the replacement arguments and returned them; `prepareSpawn` read only
`denied` and `advise`. A hook author who returns `rewrite` on `pre_tool_use` — where it **is**
honoured — reasonably expected the same here and got a no-op with the original brief spawned.

Resolved by **refusing it loudly** rather than honouring it: the sweep now runs with
`rewritable: false` (`packages/loop/src/runtime/subagents/delegate-task.ts:357`), so a `rewrite`
verdict denies the spawn instead of passing it through with arguments the hook believes it replaced.
That is the one outcome worse than either honouring or refusing, because the author is never told.
No capability is lost, which is what made refusing the cheaper answer: both child-spawn tools are
dispatched through the ordinary tool loop, so a `pre_tool_use` hook matching either still replaces
the brief and profile **upstream** of this validation, and there the model is told what actually ran through the
`[advisor]` channel and the trace records an `arguments_original`. Honouring it here would have meant
rebuilding that non-silence at a second site.

**The Providers footer omitted `add` and `delete` while Context Help showed them.** Reproduced in the
shipped application; the isolated panel test passed, and the test file recorded a hunt that had ruled
out the segment cap, level registration, surface flags and lower layers claiming `a`/`d`, naming
`overlay-host.mountView`'s `LAYER.LIST` layer as the nearest untested difference.

The cause was none of those: it was `tierLimit`'s flat cap on segment *count*
(`packages/code/src/ui/patterns/active-actions.ts:108-113`). The panel's nine footer segments measure
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

## Workspace-confined writes are still vulnerable to a parent-directory TOCTOU

**Status: open; security boundary, native cross-platform primitive required.** Re-verified against the
tree on 2026-08-22. Nothing in the diagnosis below has moved: `packages/tools/src/lib/atomic.ts` and
`packages/tools/src/lib/files.ts` are byte-identical to their state when this was first written, and
the only change to `packages/tools/src/lib/paths.ts` since then is comment-only. What did change is
recorded at the end.

`resolvePath(..., confineToWorkspace: true)` (`packages/tools/src/lib/paths.ts:53`) proves that a
pathname resolves below the workspace at one instant. The mutating tools later pass that same pathname
string to `mkdir`, staging, backup and `rename` operations. A process running concurrently can rename
an already-validated parent directory and replace it with a symlink (or a Windows junction) to an
outside directory in between. The final component may remain an ordinary file, so
`assertNotSymlink(target)` (`packages/tools/src/lib/atomic.ts:109`) passes while the subsequent
path-based operation follows the replaced parent and mutates outside the workspace.

The mechanism is visible in the function's return: `resolvePath` computes `abs` lexically
(`packages/tools/src/lib/paths.ts:60`), calls `assertWithinWorkspace` for its boolean verdict only
(`:61`, defined at `:159`), and returns `abs` (`:62`) — never the canonical form the check ran against.
Threading that canonical form through would not have helped; the gap is that nothing re-establishes
confinement after the check, not that the wrong string is carried.

This affects the mutation shape used by `write_file`, `edit_file`/`multi_edit`, `apply_patch` and
`replace`; `copy`, `move`, `remove` and `mkdir` use the same path-based boundary and belong in the same
eventual fix. Concretely, every one of them still ends at a pathname:
`packages/tools/src/lib/atomic.ts:69` stages with `fs.mkdir` (`:71`) then `fs.open(tmp, "wx")` (`:73`);
`writeAtomic` (`:132`) does `fs.mkdir` (`:135`) then `writeFileDurable(target, …)` (`:139`);
`commitWithRollback` renames by path (`:319`, `:330`). The tools reach those through
`packages/tools/src/tools/write-file.ts:96`, `edit-file.ts:55` (`editFileLocked` at `:32`, which
`multi-edit.ts:78` also uses), `apply-patch.ts:355`, `replace.ts:249`, `remove.ts:59`,
`copy.ts:118-121`, `move.ts:115-116` and `mkdir.ts:50`. The in-process locks in
`packages/tools/src/lib/atomic.ts` (the map at `:7`, `withFileLock` at `:36`, `withFileLocks` at `:59`)
serialize Clarvis calls by pathname, but do not pin a filesystem object and cannot coordinate with a
shell command or another process. Staging beside the destination makes replacement atomic for
observers; it does not make the destination confined.

Descriptor-backed file-content reads have a narrower primitive available: open the file, canonicalize
the live path, compare its exact `dev`/`ino` identity with the opened descriptor, and then read from
that descriptor. That is `assertOpenedFileConfined` (`packages/tools/src/lib/files.ts:112`, the
identity comparison at `:137`), reached from `readRawFile` at `:238` whenever `readFileOptions`
(`:47`) supplies the roots. It closes this file-open window on POSIX and Windows while keeping
legitimate in-workspace symlinks. `write_file` also propagates a `path_escape` (and every other
non-binary/non-size failure) from its optional prior-content read instead of treating the failure as
merely "no diff" — `packages/tools/src/tools/write-file.ts:75-93`, whose `catch` re-throws anything
that is not `is_binary` or `too_large` (`:86-92`). A third piece of the same reasoning lives on the
read side of grep: a confined directory search always uses the in-process scanner even when ripgrep is
installed, because handing a mutable directory pathname to a subprocess would reopen this window
(`packages/tools/src/lib/rg.ts:164`, reasoning at `:123` and `:193`). Those are real local fixes, but
none of them secures the later mutation.

Adding another `realpath`/`lstat` immediately before `rename` is not a fix. There is always one last
gap between the final check and the path-based mutation; a post-write check detects the escape only
after an outside file may already have been replaced. Rollback is path-based too and has the same race.
Do not add such a recheck while claiming the boundary is closed.

The durable fix needs a filesystem abstraction anchored to a trusted opened directory: on POSIX,
descriptor-relative resolution and mutation (`openat`/`renameat`, preferably with the platform's
beneath/no-symlink resolution guarantees); on Windows, the corresponding directory-handle-relative
operations with reparse-point controls. Node/Bun's ordinary path-based `fs` API does not expose one
portable primitive that supplies those guarantees, so this likely needs a small audited native layer
and a shared implementation used by every mutating tool. Until then, `confineToWorkspace` must not be
described as a strong write sandbox against a concurrently mutating workspace.

**What has moved since this was first recorded (2026-08-22).** Two things, neither of them behavioural.
First, the decision is now readable at the line that makes it: `resolvePath`'s `@remarks`
(`packages/tools/src/lib/paths.ts:27-51`) carries the exposure, the read-side asymmetry and the
rejected mitigations in the source itself, so an agent editing that function meets the threat model
without opening this file. Second, the write-side race has one pinning test — `"aborts write_file when
its prior read detects a parent-link race"`
(`packages/tools/tests/integration/no-isolation.test.ts:148`), which swaps the validated parent for an
outside symlink from inside the `fs.open` call and asserts `path_escape` with both the workspace file
and the outside file untouched; its siblings at `:78` and `:98` pin the same race for `read_file` and
`grep`. That test covers the prior *read*, not the write: `mkdir`, `remove`, `move` and `copy` call no
`readFileOptions` at all, and **the residual write-side exposure remains unpinned by any test**. No
descriptor- or handle-relative primitive was added anywhere in the monorepo — a search for
`openat`/`renameat`/`dirfd`/`RESOLVE_BENEATH` across every package returns only the prose reference
inside that TSDoc.

---

## One in-flight model call reserves the whole workflow tree budget, so a concurrent leader spawn is refused

**Resolved on 2026-08-27.** The manager/Admiral no longer contributes the workflow ledger as its
`outputBudget`; it remains on the primary session budget. The dedicated workflow-child ledger now
defaults to 640,000,000 output tokens (four primary-session-sized shares at default concurrency) and
divides headroom across `max_concurrency` with no extra manager share. The provider adapter still
safely reserves every retry attempt, but a manager call can
no longer make workflow-child headroom transiently read as zero.

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

**Resolved at the Clarvis lifecycle boundary on 2026-08-24.** The coordinated OpenTUI 0.5.7 upgrade
removed the historical row-proportional primitive slope. Production-component soaks then found
larger remount residue in Context Help, Profile Picker, Catalog Picker and the activity drawer.
Explicit bounded retention now closes every root-Portal member of that family; Context Help's last
pre-retention stable-portal 100-cycle samples were non-monotonic and ended at +2.39 MiB PSS/100. The
historical heading is retained because source and test documentation link to its anchor.

Under the former OpenTUI 0.4.3 pin, a `FloatFrame` overlay card — Context Help or any `ListPicker` —
leaked roughly **10 KiB of native memory per rendered row, per open**. The 2026-08-18 QA pass
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

### 2026-08-24 remeasurement during the performance review

The review now specified in
[`hosts/code-performance.md`](hosts/code-performance.md#81-measurement-snapshot--2026-08-24) drove the
current built artifact in a real 120x32 PTY on Bun 1.4.0. A 100-cycle Context Help open/close churn
moved process RSS from 173,328 KiB to 253,872 KiB before explicit collection; a following 100-cycle
agent-picker churn moved it from 241,488 KiB to 305,692 KiB. Those are immediate post-churn samples,
not leak rates, because heap/external allocations had not all been collected.

A second Context Help run used a 220 MiB fuse to reach the supported `/recover-memory` path, whose
successful backend rebuild invokes `Bun.gc(true)`. After 30 open/close cycles and recovery, process
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

### 2026-08-24 correction implementation and post-GC result

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
Profile Picker +12.71, Catalog Picker +14.26 and the 64-agent drawer +19.15 MiB/100. Retaining the
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
-2.04 MiB PSS/100 with zero new registrations, retained Profile Picker at -1.65, Catalog Picker at
-1.53, the retained drawer at -1.46, retained Activity Detail at -28.55, the retained worktree prompt
at -4.12, and the retained empty Workflows page at +1.17. Their remount comparators remained visibly
worse for Profile (+11.42), Catalog (+8.01), drawer (+25.13), and empty Workflows (+2.81) and created
100, 200, 0, and 200 registrations respectively. Negative endpoint deltas reflect collection of
warm-up arenas; they are not close-time memory savings.

### 2026-08-25 current-memory regression: slash, scroll and former F1

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
subsequently removed on 2026-08-25; these values remain historical attribution evidence.

Production: `OverlayRegion`, `TranscriptRegion`, `PlanOverlay`, `DiffViewer`, `InputDock`,
`AutocompletePopup`, `StableWindowedList`, `Help`, `ProfilePicker`, `CatalogPicker`, `ListPicker`,
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
unregisters its timeline on cleanup. Both were checked in the affected 0.4.3 pin —
`node_modules/@opentui/solid/index.js:547-568` and `:189-201` — and
`packages/code/src/views/overlays/FloatFrame.tsx:53` is still the `useTimeline` call the second
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
`packages/code/src/views/input/autocomplete.ts:169` — budgeted by `maxVisibleRows` at `:148` against
`floatMaxRows` (`packages/code/src/views/overlays/FloatFrame.tsx:24`), with the indicators at `:233`
and `:253` gated by `showOverflow` at `:178`. The TSDoc at `:151-165` cites this section by anchor, so
**the heading above is load-bearing**: renaming it breaks that citation and the one at
`packages/code/tests/integration/list-picker-render.test.tsx:217-220`. Three tests pin the behaviour —
`:216` (120 items, fewer than 30 mounted, "more" painted), `:238` (the window follows the selection),
`:253` (the wheel keeps mouse parity).

Mouse parity is kept rather than traded away: the container binds `onMouseScroll`
(`packages/code/src/views/overlays/ListPicker.tsx`, rendered `PickerRow` → `onWheel`) and a wheel notch moves
the selection, so the window follows it. `@opentui/core`'s `ScrollBox` offers no virtualization
option, which is why the list is windowed rather than virtualized inside one.

> **Correction, 2026-08-22, to that last sentence only.** `ScrollBoxOptions` in the pinned 0.4.3 does
> expose `viewportCulling?: boolean`
> (`node_modules/@opentui/core/renderables/ScrollBox.d.ts:18-32`), and it already defaults to `true`
> (`node_modules/@opentui/core/index.js:10194`). It is not virtualization and would not have helped:
> `_getVisibleChildren` (`node_modules/@opentui/core/index.js:9995-10007`) filters which
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

### Rescued from the deleted `tui-qa-findings-2026-08-18.md` §9

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

The 2026-08-28 production-policy soak for guided Extensions Step 3 used OpenTUI 0.5.7 and Bun 1.4.0
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

The same date's pending-operation soak held one marketplace installation open across 100 animated
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

Resolved in 2026-08-24 by a narrower exit contract. Clarvis stores no lifecycle registry and never
forces removal or deletes the branch. An interactive `--worktree` launch offers checkout removal
only after Git reports it clean; the operator must press `y`, the workspace closes first outside the
bounded platform-shutdown path, and cleanup rechecks cleanliness before `git worktree remove`. New checkouts live beneath the
primary checkout's `.clarvis/worktrees/`, which the mandatory inner `.gitignore` excludes before
creation. Only that canonical parent may be removed when empty; externally registered parents are
never removed. Dirty trees, signals, panics and headless modes keep the checkout.

## Retired: local subscription registrations always reported unavailable

Resolved in 2026-08-24 by restoring the two reviewed local public-client registrations under an
explicit `project-owner-approved-public-reference` decision. Commit `86e05a5f` had labelled both
records as unapproved references, so `subscriptionRegistration` returned `undefined` before
credential state or file permissions could matter and the TUI always showed “Integration not
enabled in this build”. The project decision is not represented as provider endorsement; future
unapproved `public-oss-reference` records still fail closed.

## A `FloatFrame` card's navigation row is budgeted against the terminal, not the card

**Open, low. The direct fix was tried, measured and reverted.**

`InteractionNavigationBar` (`packages/code/src/ui/patterns/navigation-bar.tsx:78-94`) delegates to
`NavigationBarForInteraction`, which reads `useTerminalDimensions()` and passes
`width={() => dimensions().width}` down
(`packages/code/src/ui/patterns/navigation-bar.tsx:51`, `:71`), so the segments are budgeted with
`budgetFooterActions(actions, terminalWidth)`
(`packages/code/src/ui/patterns/active-actions.ts`, `budgetFooterActions`). That is right for `ViewFrame`
(`packages/code/src/ui/patterns/view-frame.tsx:106-111`) and `PageFrame`
(`packages/code/src/views/PageFrame.tsx:52-54`), which span the terminal, and wrong inside a
`FloatFrame`: the card is `min(85% of the terminal, 100)` columns
(`packages/code/src/views/overlays/FloatFrame.tsx:14-17`, `:95-97`), so at 140 columns the card's
content has 96 and the row is measured against 138 — `fits` checks against `width - 2`
(`packages/code/src/ui/patterns/active-actions.ts`, `budgetFooterActions`). `NavigationBar` renders
`wrapMode="none"` with no `truncate` (`packages/code/src/ui/patterns/navigation-bar.tsx:40-42`) and
the card's navigation slot is a plain `<box flexGrow={1} minWidth={0}>` with no `overflow="hidden"`
(`packages/code/src/views/overlays/FloatFrame.tsx:110-115`) — unlike the card's own title and footer,
which both carry `truncate` (`:103`, `:117`) — so a row that overruns paints through the card's
border. `ListPicker` is now the remaining consumer
(`packages/code/src/views/overlays/ListPicker.tsx`, `InteractionNavigationBar`).

**Why passing the card's width is not the fix.** `budgetFooterActions` takes a *band* width and does
two things with it: `fits` width-checks each seat and subtracts the row's own 2 columns, while
`tierLimit` caps the *count* at 10 seats for widths at least 100, 4 at 72, 3 at 48, and 2 below
(`packages/code/src/ui/patterns/active-actions.ts`, `budgetFooterActions`, `tierLimit`). Only the fit
check needed to become card-aware. Passing the 96-column card interior drops the tier from 10 to 4
as well. The reverted experiment was measured on the former Context Help surface at a
48-column terminal, where it cost that surface its escape route:

```
before:  [↵] run  [↑/k] move  [esc/f1] close     35 cells in a 36-cell card - it fitted
after:   [↵] run  [↑/k] move                     tier 2, close dropped
```

That experiment was correctly reverted at the time because it removed the only visible close route.
Its dedicated test was removed with the surface; it is historical evidence, not a current acceptance
case for `ListPicker`.

**What a real fix needs:** separate the two budgets, so a caller can pass the card's width for `fits`
while the count tier stays keyed to the terminal — or reserve an essential `escape` action before
using the card width for both decisions. `budgetFooterActions` no longer has a special Help-group
reservation; any future correction must be expressed as generic essential/escape policy. That is
footer policy, not a width argument, which is why it was not done under a QA-fix change.

**Reverified 2026-08-25, still open for `ListPicker`.** Context Help is gone, but
`navigation-bar.tsx`, `active-actions.ts`, `FloatFrame.tsx` and `ListPicker.tsx` still pass terminal
width into one budget; the row still has no `truncate`, the card slot still has no clip, and
`budgetFooterActions` still has no card-aware second width. No current test pins the horizontal
overrun.

---

## `code`'s `!bash` fix for Windows is unverified

`runLocalBash` (`packages/code/src/adapters/local-shell.ts:101`) carried the same unconditional
`detached: true` as the tools' `shell` and was silently broken on Windows in the same way; it now
uses `ownProcessGroup()` (`packages/code/src/adapters/local-shell.ts:111`, reached through
`@clarvis/kernel/local` at line 2). The module has not been touched since this was filed —
`git diff` against the commit that deleted the old spec corpus reports no change to it — so both the
fix and the gap are exactly as recorded.

The change is POSIX-identical by construction: `ownProcessGroup` is `platform !== "win32"`
(`packages/tools/src/lib/process.ts:46`), so on POSIX the spawn is byte-for-byte the `detached: true`
it replaced. The risk was never a regression. It is that Windows `!bash` is still broken for some
*other* reason and nobody would learn it from CI.

Nothing exercises it there. The original reason — "the `tools (windows)` CI job runs `@clarvis/tools`
and `@clarvis/paths` only, and `code` is deliberately outside it" — is now stale in its details, and
the conclusion it supported is stronger rather than weaker. The job has since grown
(`.github/workflows/ci.yml`): it is named `tools, paths, plan, memory, keyboard policy (windows)` and
runs `@clarvis/paths`, `@clarvis/tools`, `@clarvis/plan` and `@clarvis/memory`, plus exactly three
`@clarvis/code` files — `keyboard-profile.test.ts`,
`keyspec.test.ts`, `active-actions.test.ts` (line 156). The job's own comment says why: "`code`
contributes only its platform-independent keyboard-policy tests here" (line 105). So `code` is no
longer wholly absent from the Windows leg, but the part of it that is present touches nothing in the
shell adapter, and `packages/code/tests/integration/local-shell.test.ts` — the suite that would
exercise this — is not among the three.

At the time this gap was recorded, none of it was running because the workflow had only a
`workflow_dispatch` trigger. The first public-beta preparation restored push-to-`main` and pull
request triggers on 2026-08-25. That makes the narrow Windows leg runnable again; it still does not
include `packages/code/tests/integration/local-shell.test.ts`, so it does not close this gap. No
post-restoration Windows result is recorded in this source-backed review.

What is verified on Windows is the helper, not the call site. `@clarvis/tools` is in the job, and
`packages/tools/tests/unit/process.test.ts:12` pins `ownProcessGroup("win32") === false` there.
Nothing pins that `runLocalBash` calls it, and no assertion about `!bash` behaviour has ever run on a
Windows host.

A concrete candidate for "some other reason" is visible in the module itself: the Windows path is not
the POSIX path with one flag flipped. `packages/code/src/adapters/local-shell.ts:107` branches the
executable — `bash` on POSIX, `shell.file` otherwise — so on Windows the whole `resolveShell` /
`shellArgs` PowerShell route, base64 `-EncodedCommand` payload included, is Windows-only code that no
test reaches. The suite's one win32 guard is scoped to shell *syntax* and not to any of that:
`packages/code/tests/integration/local-shell.test.ts:80` skips the bash-only-syntax test on win32,
while the two process-group tests beside it — "a grandchild holding the pipes past exit does not
wedge the job" (line 119) and "timeout kills the whole process group" (line 132) — are unguarded and
written in POSIX shell (`sleep 5 & echo launched`, `sleep 30 & sleep 30`), so on a Windows runner
they would die on the command text long before reaching the behaviour they check. Guarding them would
be the wrong repair for the same reason the `monitor` gap stayed hidden: it would turn a real
unknown into a green run.

One failure mode around shell resolution on this path *has* been identified, and it was found from
the POSIX side, not the Windows one. `resolveShell()` with no arguments memoizes process-wide, so
reaching it while `process.platform` reads `win32` pins PowerShell for every later caller —
`runLocalBash` included, which then tries to spawn the absolute `powershell.exe` path on a POSIX host
and settles every `!` command as a spawn failure. The TSDoc on `windowsClipboardArgs`
(`packages/code/src/adapters/platform.ts:66`, function at line 75) records it and the fix: pass the
platform explicitly so the call can neither read a poisoned entry nor write one. Production never saw
it, because `process.platform` is a constant there; the suite did, because the clipboard tests pin
win32 to exercise that branch. It is worth knowing here because it is evidence about what this path
is sensitive to, and because the test that covers it,
`packages/code/tests/integration/shell-cache-isolation.test.ts:34`, is itself skipped on win32.

---

## The Codex workspace sandbox can reject ephemeral loopback listeners

**Status: confirmed environmental limitation on 2026-08-30; not a Clarvis product regression and
not evidence that port `0` is occupied.**

Some repository tests deliberately bind a local listener on `127.0.0.1` with port `0`, asking the OS
for an available ephemeral port. Examples include `captureServer` in
`packages/mcp-client/tests/integration/remote-transport.test.ts`, the OAuth fixture in
`packages/mcp-client/tests/integration/oauth-transport.test.ts`, and the native-network enforcement
case in `packages/tools/tests/integration/sandbox.test.ts` (`Bun.listen`). Inside a Codex
workspace sandbox that prohibits listener creation, these otherwise independent tests can fail with
the shared Bun signature:

```text
Failed to start server. Is port 0 in use?
```

That wording is misleading in this environment. Port `0` is a request for dynamic allocation, not a
specific occupied port, and a sandbox denial can surface through the same runtime error. A cluster of
listener-based failures with this exact signature must therefore be classified first as an execution
environment failure. Rerun the affected test file or package outside the Codex sandbox before changing
Clarvis code or reporting a product defect. Only a reproduction outside that sandbox is product
evidence.

This exception is deliberately narrow. It does not make an assertion failure, protocol mismatch,
timeout after a listener was successfully created, or a failure on an unrestricted host ignorable.
The handoff must name the exact command and error and keep the affected surface unverified until the
outside-sandbox rerun passes. `AGENTS.md` carries this entry's short operational rule under **Known
environmental failures**.

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

Over the complete retained Actions history (107 runs, 2026-07-28 → 2026-08-01, recounted
2026-08-01): of the **84** runs whose `linux` job actually reached the test step, **26 died by
signal — 31.0%**. Every one of the 26 was in `@clarvis/code`, and every one exited **132**
(128 + SIGILL). That uniformity is what lets the CI wrapper key on the exit code.

Split on the pin commit (`e201dfd`, 2026-07-28): **8/22 = 36.4%** on the 1.3.14 era, **18/62 =
29.0%** on 1.3.11.

The other 10 failures at that step were ordinary — a ripgrep guard in `tools`, a `coverage:check`
threshold — and are not this.

The `tools (windows)` job failed 14 times in the same window with **zero** signal deaths. Every
`panic:` line in those runs' logs is prefixed `linux`, because `gh run view --log-failed` prints
every failed job in the run.

**No new sample is recorded here since 2026-08-01.** CI push and pull-request triggers were restored
on 2026-08-25, but no post-restoration GitHub-runner result is part of this review. Treat 31.0% as a
historical figure attached to the 1.3.11 pin and the suite as it stood then, not as a live rate.

### What it is

The historical upstream family is **oven-sh/bun#17241** (identical trace from plain TypeScript, no
FFI), duped into **[#15964, "Worker & worker_threads stability"](https://github.com/oven-sh/bun/issues/15964)**.
That tracking issue was closed by [PR #37075](https://github.com/oven-sh/bun/pull/37075), merged on
2026-08-08; the fix shipped in [Bun 1.4](https://bun.com/blog/bun-v1.4) on 2026-08-20. Clarvis is now
pinned to 1.4.0, but an upstream merge is not evidence that the exact GitHub-runner signature is
gone. `packages/code/tests/helpers/tree-sitter-preload.ts:19-26` records the historical attribution
at the one place in the tree that acts on it.

**The earlier attribution to JSC GC thread suspension (oven-sh/bun#31832) was wrong** — that issue
is `docker exec`-specific and lists 1.3.11 as *good*. Do not re-file it there.

The fault address varies run to run — `0xFFFFFFFFFFFFFFF8` in 16 of the 26, plus `0x0`, `0x18`,
`0xC`, `0x2E64F3C3A68` — which is the tell for heap corruption rather than one bad pointer. Most
crashes land ~1-2s in, a few as late as ~22s.

### What it is not

Seven things were measured and excluded. The version pin has since moved to 1.4.0; the evidence
below remains attached to the runtime named by each measurement.

- **Not caused by coverage.** Of the 26 crashes, **13 ran with `--coverage` and 13 without**. The
  split is still reachable: `packages/code/package.json:25` runs the suite bare and
  `packages/code/package.json:30` runs the same files under `--coverage`.
- **Not proven cured merely by changing the pin.** `@clarvis/loop` measured ~30s on 1.3.11 against
  ~122-170s on 1.3.14; that was the reason for the old pin, not a crash fix. Bun 1.4 now includes the
  upstream Worker lifetime repair, but Clarvis still needs its own GitHub-runner canary before the
  narrow crash retry can be removed.
- **Not a teardown or process-exit problem.** The crash lands *mid-file*, with most of the suite
  still to run. Awaiting `destroyTreeSitterClient()` in a root `afterAll` did not stop it, and that
  call is deliberately absent from the preload today
  (`packages/code/tests/helpers/tree-sitter-preload.ts:61-63`) for an unrelated reason: it would
  unregister the singleton the stubs decorate.
- **Not `avx512`.** One crashing runner advertised it and dev hardware did not, which looked
  decisive; a later crash came from a runner reporting only `sse42 popcnt avx avx2`, and the
  upstream twin (#17241) was reported from a machine without it.
- **Not cross-file state; `--isolate` does not help.** Measured by re-running one commit six times:
  linux failed 3 of 6 under `--isolate`, the same rate as without. Note the flag does not exist in
  1.3.11, so that experiment ran on 1.3.14 — re-checked before the migration on 2026-08-22,
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
(`packages/code/tests/helpers/tree-sitter-preload.ts:67`), so the count is **0**; the same file's
TSDoc at lines 41-45 carries the 82-worker measurement and the reasoning at the one place a reader
who is about to delete the stub will see it. `packages/code/bunfig.toml:12-17` keeps the preload
ahead of anything that loads `src/`, which is what makes a prototype stub reach every instance.

`packages/code/tests/integration/tree-sitter-preload.test.ts:18` and `:24` pin it by reading the
client's private `worker` field (`workerOf`, `:15-16`) — for a freshly constructed client and for the
singleton. Swapping `globalThis.Worker` cannot detect the spawn — the bundle does not resolve
`Worker` from the global scope, so that assertion passes with the stub removed; the test file records
that trap at `:7-13`.

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

`tooling/ci/retry-code-coverage.sh` wraps the CI test step and retries a Bun crash signal (132/134/139) up
to 3× by re-running `@clarvis/code` alone, then `coverage:check`. All of it is intact:
`MAX_RETRIES=3` at `:31`, `is_crash_exit` matching exactly `132 | 134 | 139` at `:34-39`, the loop at
`:55-64`, the narrowed re-run at `:58` and the `coverage:check` at `:61`.

- A real test failure is never retried.
- Neither is 130/143 — SIGINT/SIGTERM mean *somebody asked this to stop*, and
  `bun --workspaces --parallel` reports a sibling-kill as 130, so a blanket "retry anything ≥ 128"
  would silently re-run genuine failures. The argument is preserved in the script's own header at
  `:10-20`, including the measurement that a failing package under the current `--sequential` root
  script exits 3 rather than 130 — and the note that the wrapper does not rely on that staying true.
- It cannot mask a crash in another package: that package's lcov would be missing and
  `coverage:check` throws (`:22-28`). That argument depends on `@clarvis/code` being the **last**
  workspace in the sequential run, which `package.json:29` and `package.json:36` still make true. A
  reordering of the `workspaces` array silently weakens this.

At the historical 31% rate the expected residual red after three retries was ~0.9%.

The `segfault-canary` workflow (`workflow_dispatch` only) measures arms at n ≥ 30 on demand
(`.github/workflows/segfault-canary.yml`, `on.workflow_dispatch.inputs`). Its `jsc.options` declares
the four arms `none`, `no-concurrent-gc`, `single-marker`, and `no-concurrent-jit`; the `measure` step
counts `status -ge 128` rather than the wrapper's narrow set, because a counter wants every signal
death and a retry wants only the ones it is entitled to swallow.

### Where the mitigation stands today

**Checked 2026-08-25.** CI now runs on pushes to `main`, pull requests, and manual dispatch. The
wrapper remains wired into the Linux test step, so the restored workflow exercises it without a
separate migration. Bun 1.4.0 is installed locally and carries the upstream fix; there is still no
post-restoration GitHub-runner sample recorded here. The
retirement gate is at least 30 `@clarvis/code` coverage iterations on Bun 1.4 with zero exits 132,
134 or 139. Until that sample exists, `tooling/ci/retry-code-coverage.sh` remains the sole isolated
shell exception. The pre-commit hook invokes `bun run check:pre-commit` directly, not the retry.

Two files in the tree point a reader at this document by path —
`tooling/ci/retry-code-coverage.sh:7` and `.github/workflows/segfault-canary.yml` (top comment) — which is the
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
wrapper matches `132 | 134 | 139` and nothing else (`tooling/ci/retry-code-coverage.sh:36`), so an exit-1
death of this kind is never retried and never re-runs `@clarvis/code`.

### The `--isolate` theory was wrong; the cause is a leaked pino destination in our own suite

The original reading was: nothing in `loop` constructs a `WriteStream` — there is no
`createWriteStream` anywhere in its `src/` or `tests/`, still true on 2026-08-22 — therefore this is
inside Bun, plausibly its `--isolate` implementation reattaching a stream to an fd that is already
registered. **That theory is superseded.** The mechanism is named in the tree, at
`packages/loop/tests/unit/logger.test.ts:5-18`: `createLogger`'s stdout branch calls `pino(options)`
with no stream argument (`packages/loop/src/logger.ts:55`), so pino builds a brand-new `SonicBoom`
around fd 1 every time, with no reuse and no pooling. Left undestroyed, that handle stays alive —
and its write-readiness watch stays registered — for the rest of the process; over a large test run
that repeatedly proved enough to collide with a later, unrelated fd-1 write elsewhere, surfacing as
a `WriteStream` construction failing with `EEXIST` on `epoll_ctl` deep in Bun's runtime. Production
never hits it: `createLogger` is called once per process and the destination lives for the process's
whole lifetime.

The mitigation is `destroyStdoutDestination` (`packages/loop/tests/unit/logger.test.ts:19`), which
reaches the stream through pino's publicly exported `symbols.streamSym` and destroys it; the loop
suite's only `destination: 1` site (line 53) calls it at line 59. It landed in `dcc62896`
(2026-07-28), whose message records it as "a leaked pino stdout destination in logger.test.ts that
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
history (107 runs, 2026-07-28 → 2026-08-01, checked 2026-08-01) found **zero** recurrences: of the
36 `linux` failures at the test step, 26 were the `code` signal death and the other 10 were ordinary
assertion or threshold failures.

Read that window against the fix date. The sweep **begins on the day `dcc62896` landed**, so its
zero recurrences are equally consistent with "the leak was closed at the start of the window" and
with "one observation was noise". It is not independent evidence that the entry was a phantom.
Nothing has been added to it in this review. CI triggers were restored on 2026-08-25, so future
source-grounded sweeps can add evidence once those runs exist; the historical window itself remains
unchanged.

### Residual: the same leak is unmitigated in `@clarvis/kernel`

The loop-side fix was applied to the one site that had it; the class was not closed repo-wide.
`packages/kernel/tests/integration/serve.test.ts` builds five `destination: 1` loggers — lines 40,
50, 61, 87 and 107 — and destroys none of them; its only `afterEach` (line 125) restores
`CLARVIS_AGENT_TOOLS_ENABLED` and touches no stream. Kernel's `test` script carries no `--isolate`
(`packages/kernel/package.json:46`), so every file in that suite shares one process, which is
exactly the "large test run" condition the loop test's own remark identifies. Those five sites are
deliberate — they exist to prove `serveFileKernelOverStdio` refuses a logger bound to its own wire —
so the repair is to destroy each handle, not to remove the tests. If `epoll_ctl EEXIST` is ever seen
again, look at `@clarvis/kernel` before looking at Bun.

---

## The TUI workflow view could enter an unbounded reactive remount loop

**Status: root cause reproduced and fixed; real-model multi-run soak still pending.**

**Verification, 2026-08-22.** Every fix, guard, bound, counter and test named below is still present
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
JSX tree each factory returns — `renderMountedView` at `packages/code/src/views/app/OverlayRegion.tsx:12`,
with the `untrack` boundary at `:17`. The initial workflow load now belongs to `onMount`
(`packages/code/src/views/config/WorkflowsHub.tsx:346`), which is what makes the surviving
construction-time selection read in `reloadOnce` (`:139`) harmless, and workflow polling is
single-flight with one coalesced trailing refresh (`refreshActive`/`refreshQueued` at `:300`,
`requestRefresh` at `:307`). A follow-up review explicitly rejected putting `untrack` into generic
level, list-row and picker-preview hosts: those callbacks may own a reactive structural branch, and
suppressing that dependency would freeze legitimate UI changes. That rejection still holds in the
tree — no view host, hub menu or picker preview carries an `untrack`; the only other uses are the
theme token writer, the list-navigation enablement gate and the debug counter in
`packages/code/src/views/blocks.tsx:67`. MCP capability refresh
(`packages/code/src/adapters/mcp-capabilities-bridge.ts:115`) also became single-flight after the
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
  (`packages/capability/src/extension-admission.ts:76`);
- a timeout does not release the physical-work permit until the underlying operation settles —
  `packages/capability/src/extension-admission.ts:69` on the permit, and
  `packages/code/src/core/diagnostic-events.ts:156` on why `diagnosticAsync` refuses to race the
  operation it observes;
- streams, response bodies, event queues, transcript windows, restored histories and exports have
  both item and aggregate-byte budgets (`packages/code/src/adapters/store.ts:84` and `:89`);
- plans, workflows, memories, traces, worktrees, plugins, skills and configuration catalogs use
  bounded incremental scans and reject oversized records before materializing or persisting them
  (`packages/kernel/src/workflows/workflow-store.ts:108`, `packages/skills/src/limits.ts:18`);
- completed runs release transient ingestion and owner-scoped state on absolute deadlines
  (`packages/kernel/src/runs/managed-run.ts:66`);
- the TUI keeps a bounded viewport, hydrates large details on demand
  (`packages/code/src/adapters/store.ts:307`), disables production renderer console caching
  (`packages/code/src/adapters/platform.ts:230`), and exposes a last-resort RSS fuse whose default
  threshold is 2 GiB (`DEFAULT_TUI_RSS_LIMIT_BYTES`,
  `packages/code/src/adapters/memory-pressure.ts`);
- interactive `--debug` writes bounded, redacted JSONL with lifecycle, memory, command, view and
  refresh counters; repeated counters use first-eight-and-powers-of-two sampling
  (`packages/code/src/adapters/diagnostic-session.ts:545`) so a runaway stays observable without the
  log becoming another leak.

The RSS fuse is a secondary defense, not protection from this class of loop. In the reproduction its
500 ms interval (`MEMORY_PRESSURE_SAMPLE_MS`, `packages/code/src/adapters/memory-pressure.ts:5`)
stopped running after navigation because the self-feeding promise/microtask chain starved timers. An
independent process watchdog is still required for destructive soak tests. The overlay harness now
provides one for its child processes; ordinary interactive and real-model multi-run work still
requires host-level process-tree monitoring.

The tests include the exact `OverlayRegion + WorkflowsHub` composition
(`packages/code/tests/integration/overlay-region-render.test.tsx:224`), factory-construction
invariants (`:185`), slow single-flight polling
(`packages/code/tests/integration/workflows-hub-render.test.tsx:206`), thousand-event refresh storms
(`packages/code/tests/component/mcp-bridge.test.ts:419` and `:457`, 1,000 queued refreshes each),
repeated-run (`workflows-hub-render.test.tsx:324`), never-settling-operation (`:257`),
oversized-body, sparse-file, deep-schema, wide-catalog and transcript-restoration cases. The counter
sampler's own test is written against this very defect's counter:
`packages/code/tests/unit/diagnostics.test.ts:240` drives `overlay.view.factory` 1,024 times and
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
`packages/kernel/src/workflows/workflows-service.ts:590`, reached from the read paths through
`reconcilePersisted` at `:169`. Age and workspace-wide leases are deliberately not used because
neither proves that this particular execution is dead. The repair is lazy rather than a restart
sweep, and its residual is documented at the function itself: if the crashed run's journal was never
recoverable — unopenable, quarantined as corrupt, refused as oversized, or past the boot budget — no
persisted record exists, so no evidence ever appears and the workflow stays `running` for good. An
eager restart sweep would read the same absent evidence, so what is genuinely unbuilt is a repair
that does not depend on the trace, and no such source of truth exists today.

---

## Settled transcript blocks can remount and flicker under unrelated live activity

**Resolved on 2026-08-31 under OpenTUI 0.5.9.** Code now freezes terminal candidates into immutable
publication batches, commits semantics independently from view readiness, mounts history through a
narrow publication-only port, and renders the content-height `LiveTranscriptTail` as the final child
of the same chronological ScrollBox. One serial hidden owner settles syntax and two equal physical
observations; the same owner then becomes visible at its exact marker row, while the tail retains the
handoff snapshot until that owner is ready. Direct ScrollBox children outside two prepared
viewports in the last scroll direction and one retained viewport behind are disposed, while exact
extents preserve the reader anchor. Native scroll admits lazy history at either edge, and an
off-tail newer count is a top overlay rather than another row
below history. Stored reconciliation closes the publisher explicitly. The normative contract is
[`hosts/code-transcript-stability.md`](hosts/code-transcript-stability.md).

The quoted `later batch` wording below is retained only as the exact historical symptom. That
superseded bottom boundary is not current UI: newer work is now admitted by downward native scroll,
with a non-interactive count overlaid at the top only while the reader is away from the tail.

The first real-model run exposed one further OpenTUI interaction before closure: the final outcome
and long answer stayed behind a `1 later batch` boundary until a one-column resize created a new
layout epoch. The semantic terminal batch was intact. OpenTUI 0.5.9 documents that viewport culling
skips offscreen render hooks, so `CommittedHistory` suspends culling only during its single candidate
and restores it after the marker commit.

That change was necessary but not sufficient. A second real subscription run still retained `1
later batch` for more than 30 seconds, and Page Down did not release it. During that stable failure,
the event queue and run-handle count were zero, renderer lifecycle passes stopped at 29, native
renderables stayed at 204, and RSS stayed near 332 MiB; this was one abandoned syntax candidate, not
continuing transcript accumulation. OpenTUI's own `ScrollbackSurface.settle` uses a 2-second bound
while waiting for `CodeRenderable.highlightingDone`, so Clarvis gave the hidden candidate one
2-second lease and one fresh syntax subtree. The original recovery then switched the whole batch to
a plain text owner. That advanced the physical window, but it was not visually safe: the generic
projection did not include `args.content`, so it could remove a `write_memory`/`write_file` body.

An installed `clarvis-release-003-final3` capture exposed that remaining defect directly. Frames
132-160 retained the parsed `write_memory` frontmatter, then lost its body and painted `Syntax
formatting was simplified because highlighting did not settle.`; ordinary write presentation
degraded later. The trigger was a second bug in `SyntaxPublicationBoundary`: optional
`measurementRevision` used `undefined` both as a real inactive value and as the not-yet-observed
sentinel. After `number -> undefined -> number`, the later token could inherit `completed=true`, no
new syntax measurement started, and the leases expired into the destructive fallback.

The correction separates revision initialization from its value. A later numeric token always
re-arms measurement. Recovery no longer constructs a warning/text dump: a never-published candidate
keeps the same `BlockView` and native Markdown/diff/code renderers, disables parser work through
their public `filetype` setters and bypasses only unfinished syntax work after the bounded retry. If
the owner already painted, its
identity is retained while it waits for public syntax completion, then its marker commits only after
two equal positive observations. If the parser stays pending, that owner remains visible and
unchanged instead of being remounted or degraded. The
deterministic regression records every handoff frame of a real `write_memory` body across more than
two forced lease intervals and a resize, then resolves a deliberately pending highlight to prove
there is no late mutation. `CommittedHistory` also retains the monotonic `rich` or `plain-semantic`
decision by batch id and purges it with the source publication; the eviction regression proves a
parser-independent owner remounts without restarting highlighting or changing variant.

The follow-on visual regression was closed with an installed `0.0.3-beta` artifact in a real PTY.
The captured subscription run exercised parsed `write_memory`, an ordinary write diff, long Markdown,
native scroll in both directions, return-to-tail submission and terminal settlement. The settled
memory and diff bodies retained their native presentation throughout later tools and assistant output;
no simplified-format warning, raw/parsed oscillation or transparent owner was observed.

The deterministic navigation regression then exposed a separate 120-to-119-column feedback loop:
admitting overscan made OpenTUI's vertical bar visible, reduced content width, invalidated every
marker, removed overscan, and hid the bar again. History now reserves the bar's one column
permanently and changes only indicator opacity. The navigation case asserts that loading and
remounting both edges retain one layout epoch; the forced short-lease terminal case reaches zero
unmeasured newer entries with fewer than ten frame listeners.

Checked-in evidence covers the originally reported `write_memory`, a real diff, ordinary
`write_file`, long later assistant output, same-tool regrouping, isolation of child tools/content from
the Lead transcript with exactly two typed delegation markers, explicit selection of one isolated
child transcript, recorded history cells, atomic outcome/final publication,
replay/session/degraded equivalence, hydration, whole-owner eviction/remount, exact marker height,
bounded row residency and the import boundary. Workflow activity is likewise pinned to the footer
strip/Sidebar rather than a transcript row. A later installed-artifact capture exposed a separate
Lead-projection leak: the provider's `await_agents` composing phase briefly rendered
`Wait for agents starting…`. The Lead contract now suppresses every composing, started, output and
terminal row for the closed supervision/spawn/delegation/workflow-orchestration tool set; typed
delegation events remain the only owners of the two friendly lifecycle markers, and ordinary Lead
`thinking`/`working` may remain visible. The same installed-artifact validation spawned two real
sub-agents: the Sidebar revealed automatically, the Lead projection showed only the typed lifecycle
markers, and selecting a child opened its isolated transcript without collapsing it. Escape plus
`/activity agents` reopened the Sidebar, and returning to Lead preserved the main transcript. The
primary tests are
`packages/code/tests/integration/transcript-publication-render.test.tsx` and
`packages/code/tests/integration/transcript-window-render.test.tsx`; the pure publication and marker
ledgers are covered by `packages/code/tests/unit/{transcript-publication,transcript-physical-window}.test.ts`,
and the architecture guard is in
`packages/code/tests/architecture/architecture-boundary.test.ts`.

The visible symptom is an already-settled Markdown or diff body briefly returning to an unparsed or
transparent state while the run has moved on to later tools or the model's answer. The report that
started the investigation named `write_memory`; the same behavior had been observed in ordinary
writes and diffs. The exact instrumented capture below proves `write_memory` and a synthetic diff,
not every anecdotal surface.

The pre-fix ownership path made the symptom possible. In that historical snapshot,
`TranscriptRegion` mounted every historical block and the live elicitation control inside one
sticky-bottom ScrollBox (`packages/code/src/views/app/TranscriptRegion.tsx`, former
`TranscriptRegion` history loop). Each production `BlockView` received a reactive
`group={() => ts.toolGroups().get(node.key)}` accessor. That map belonged to the live
`visibleNodes -> window -> grouped -> toolGroups -> focusables` chain
(`packages/code/src/views/transcript-state.ts`, `createTranscriptState`), and `BlockView` read the
group through a memo that controls structural head/member/solo rendering
(`packages/code/src/views/blocks.tsx`, `BlockView`). An event did not need to patch the old
diff/content itself to invalidate the owner that mounted it.

The local renderer harness used the then-current OpenTUI 0.5.7 dependency and a production-shaped group
accessor. It was deliberately instrumented at native-renderable identity, not inferred from terminal
screenshots:

- A settled `write_memory` without a real diff carried 1,226 Markdown characters over 44 lines.
  While 539 later assistant-response characters arrived, the capture observed **188 distinct
  `CodeRenderable` instances and 187 replacements**; visible samples repeatedly alternated between
  raw and parsed Markdown.
- Removing only the production-shaped reactive `group` prop from the same harness produced **one
  `CodeRenderable` and zero visible-mode transitions**.
- A settled synthetic diff driven through 40 otherwise unrelated group updates produced **41
  distinct `DiffRenderable` instances and 72 invisible samples**. Its control retained one diff
  renderable with zero invisible samples.

These are local ad hoc measurements, not a checked-in benchmark, and the counts should not be read
as a product rate. Their value is causal narrowing: content, parser setup and later activity stayed
the same while the production group dependency was the only controlled difference.

The old `StableDiff` and `StableMarkdown` boundary did not contradict the result. It hid a candidate
until descendant `CodeRenderable.highlightingDone` promises had painted
(`packages/code/src/ui/patterns/stable-syntax.tsx`, `waitForSyntaxFrame`, `StableMarkdown` and
`StableDiff`). That protects one continuous mount. Cleanup abandons the old revision, and a
reconstructed ancestor starts a new hidden/raw-to-parsed lifecycle. The existing test called "a
finalized diff keeps one renderable while an active sibling updates" mounts the sibling **outside**
an isolated `BlockView` and never supplies the production group accessor
(`packages/code/tests/integration/tool-diff-render.test.tsx`). It proves the local component boundary
and missed the old production composition.

A separate OpenTUI layout harness isolated the second mechanism. With settled history and a growing
live tail in the same `stickyScroll` / `stickyStart="bottom"` ScrollBox, expanding the tail from one
to three rows changed which settled history rows occupied the captured viewport. An experimental
separate two-row sibling kept that capture byte-identical. That result proved the distinction between
owner stability and viewport translation; it did **not** establish a separate panel as acceptable
product UX. A fixed sibling reserves dead space and makes the same answer change regions when it
commits. The final contract therefore keeps one chronological ScrollBox: while explicitly following
the tail, the whole native viewport may translate upward exactly as normal scrolling does, but an
older owner cannot reflow, remount or change identity, and the live-to-committed handoff preserves
the artifact's content row.

The original experiment did **not** validate those acceptance surfaces. The later installed-artifact
run covered the built release, measured lazy navigation, retention/remount while moving between Lead
and child projections, and a real-model multi-agent run in a PTY. A physical iTerm session, theme
change and platform canaries remain separate environment-specific evidence rather than prerequisites
for this resolved renderer defect. The implemented fix has both layers:

1. a production `TranscriptRegion` regression that asserts
   native renderable identity and never-visible raw/transparent frames; and
2. Lead loaders, tools, retries, pending elicitation and future same-agent live motion are
   content-height state after the frozen owners in the same ScrollBox. Child and workflow lifecycle
   motion stays in the footer/explicit Sidebar; child transcript content becomes eligible only after
   explicit isolated selection — never as a row inserted into the Lead history.

Do not apply a broad `untrack` to generic transcript hosts as a shortcut. The workflow-remount entry
above already records why generic structural owners may legitimately depend on reactive state. The
durable boundary is publication: freeze group/section/display metadata before append, and keep live
dependencies out of committed history.

---

## Ten behaviours that turn on something outside this repository

Carried here from the gap report's §4 on 2026-08-22 and re-verified entry by entry. What these share
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
(`packages/kernel/src/models/model-catalog.ts:152`), from an artifact copy beside a bundle (`:162`),
or from a `configDir` cache preferred over both (`:225`–`:243`). Every price, context window,
capability set and reasoning-effort list the product shows comes out of it, and `prompt_cache` mode
is *derived* from the shape of a published price because models.dev publishes no `supports_caching`
flag (`:437`–`:440`).

The asset remains installed but no longer enters interactive first boot. Code's foundation never
calls the models service; the first Model, Effort or Providers mount invokes a single-flight loader.
The clean-HOME artifact smoke requires the asset while rejecting any pre-paint
`catalog.load.started` event (`packages/code/src/runtime.tsx`, `ensureModelsCatalog`;
`packages/code/tooling/artifact/smoke.ts`).

**The snapshot is not raw models.dev, and that moves where the risk sits.** It is already in
projected `CatalogData` shape: two top-level keys, `source` equal to `https://models.dev/api.json`,
166 providers, 5,501 models. So the `.passthrough()` schemas (`:43`, `:55`, `:66`, `:73`, stated in
TSDoc at `:78`) are not what absorbs an upstream change — `projectModelsDevApi` (`:607`) is, and it
absorbs silently. It reads every provider's models through `asRecord(p.models)` (`:613`), so any
change to the root shape collapses at that one nesting key rather than being reported.

*Measured on this tree.* Wrapping the committed payload one level deep — `{ providers: … }`, the
shape an added envelope would produce — projects to **1 provider and 0 models**; an array root
projects to 3 providers and 0 models. `refreshModelsCatalog` (`:700`–`:703`) then writes whatever
projected, with no plausibility check of any kind, and `loadCatalogData` (`:225`–`:243`) prefers any
cache that satisfies the schema. A zero-model cache therefore shadows the good bundle permanently,
and `--refresh` cannot repair it, because the same fetch produces the same cache.

*What the repository does today.* `packages/kernel/tests/unit/prompt-cache-mode.test.ts:46`–`:84`
holds whole-corpus invariants over the committed snapshot, and the artifact copy is guarded end to
end (`packages/code/tooling/artifact/build.ts`'s `ASSETS`, `packages/code/tooling/artifact/smoke.ts`'s
`REQUIRED_ASSETS`). **The refresh path is now guarded too**, which is the half of this that was a
live defect rather than a dependency risk: `refreshModelsCatalog` refuses a projection in which no
provider carries any model, and says so, rather than writing it — so the catalog the host already has
survives a payload this build cannot read. Nothing still re-checks a cache on the way back *in*; a
cache written before this guard existed is not re-validated on load.

*Two corrections to the gap report.* It calls `KNOWN_BASE_URL`'s seven entries "a curated list with
no stated derivation" and cites `:544`–`:552`. The table is at `:558`–`:566`; `:544`–`:557` is its
TSDoc, and it states the derivation in as many words — "A gap-filler, not a registry … Membership is
therefore not an endorsement and not exhaustive." Second, a count floor is the wrong remedy: a
proposed `MIN_CATALOG_PROVIDERS = 20` / `MIN_CATALOG_MODELS = 500` turns two currently-green tests
red, because `packages/kernel/tests/integration/model-catalog.test.ts:346` and `:382` each mock
`fetch` with one provider holding one model. A structural predicate — some provider has at least one
model — catches every root-shape change a count floor catches, needs no re-tuning as the market
moves, and breaks neither fixture.

*What would settle it.* A payload contract from models.dev, or a schema it versions. Neither exists,
so the achievable posture is a guard on the way in, never a guarantee.

### The foreign plugin-dialect tables rest on a census taken outside this tree

`EXTERNAL_TOOL_NAMES` and `EXTERNAL_TOOLS_WITHOUT_COUNTERPART`
(`packages/capability/src/hooks-config.ts:137-186`) exist because a measurement
was taken over a public catalog of plugin manifests, and that catalog is not in this repository.
`packages/kernel/src/plugins/hook-dialects.ts:11`–`:13` states that naming the hosts is deliberately
avoided — "Naming the hosts would date the file and invite a class per vendor, when what varies
between them is data" — which is a good rule and also means the census can never be reconstructed
from the tree.

*What breaks if the census is stale.* A foreign name that gains a Clarvis counterpart, or a sixth
name that has none, changes what a filter matches. The failure is silent in the worst direction: the
TSDoc at `:113-124` records that of the thirty-nine names those filters used, five existed here,
and the other thirty-four "translated cleanly, installed, were approved, and then matched nothing".

*The in-tree architecture defect is resolved; the external census provenance remains open.*
`packages/kernel/tests/architecture/external-tool-names.test.ts:20-41` now normalizes every real
registry name before comparing it with `EXTERNAL_TOOLS_WITHOUT_COUNTERPART`, so a future host tool
whose separators differ from the census key does contradict the table and fail the test. The same
suite also checks every mapped target against the built-in registry or the explicit capability-tool
set, and proves that set has not become redundant. This closes the previously near-vacuous assertion;
it does not make the public catalog that motivated the table reproducible inside this repository.

*Correction on the census count.* The report says the 196-plugin figure is "cited four times" and
names three sites, one of which — `packages/kernel/src/plugins/plugin-manifest.ts:140-145` —
carries a **different** measurement (twenty plugins declaring a non-default skills location, holding
316 skills, at `:138`) and no `196` anywhere. Four is the right count and the composition is wrong:
the string appears at `packages/capability/src/hooks-config.ts:119`,
`packages/loop/src/settings/settings-schema.ts:212`, `packages/skills/src/schema.ts:51` and
`packages/code/src/views/config/MarketplaceBrowser.tsx:73`. The last two are named nowhere in the
report.

*What would settle the remaining issue.* The catalog, or a published registry of the foreign dialect.
Neither is here, so the architecture test can pin internal consistency but cannot prove that the
hand-maintained vocabulary is exhaustive or current.

### The prompt-cache design turns on provider behaviour, and two of its numbers are in-tree after all

The `openai-compatible` session-affinity design (`packages/llm/src/ai-sdk/request-options.ts:143`–
`:159`) turns on OpenRouter treating `session_id` as the primary backend-affinity key and
`prompt_cache_key` as a fallback, and on the two engaging at different moments. Nothing in this tree
can observe either.

*The gap report says "None is reproducible from this tree." That is wrong for two of the claims, and
they are the two it singles out as most exotic.* Both reproduce from the committed snapshot:

- The "120:1 against a cache read" ratio is exact in-tree arithmetic. `deepseek/deepseek-v4-pro` in
  `packages/kernel/src/data/models-dev.json` carries `input: 0.435` and `cache_read: 0.003625`; the
  quotient is 120 exactly.
- The router census at `packages/kernel/src/models/model-catalog.ts:498`–`:500` — "642 of the 680
  catalog models whose pricing reads `explicit` sit behind one … against 30 on `anthropic` and 8 on
  `openai`" — reproduces to the unit. Counting models with `cost.cache_write > 0` and grouping by the
  snapshot's own provider `kind` gives 680 total: 642 `openai-compatible`, 30 `anthropic`, 8
  `openai`, 0 `google`.

*What genuinely is not reproducible here*, and stays a claim in a comment: the `deepseek-v4-pro`
affinity probe (`request-options.ts:149`–`:154`), the "~95 chars/s a real run streams at"
(`packages/llm/src/ai-sdk/streaming.ts:36`–`:37`), the "~3000 reports per call at ~1 ms
inter-arrival" (`streaming.ts:123`–`:125`), the DeepInfra no-op and Novita lottery measurements
(`model-catalog.ts:504`–`:513`), and the 2,929,430-token / 35.7% incident that
`specs/cross-cutting/prompt-cache.md` is built around.

*Two defects in the same family that the report does not name.* Both are silent and both are green
today. `packages/memory/tests/architecture/indexer-surface-identity.test.ts:11` says
`specs/cross-cutting/prompt-cache.md` "prices that at 120:1"; that document contains no such figure
— its only `120` is a line citation at `:301`. And
`packages/code/tests/integration/providers-key-render.test.tsx:973` restates the Novita spread as a
"49-92% lottery" where the owning statement at `model-catalog.ts:510` reads 54.6%, 73.0%, 92.5% and
51.9% — the floor is 51.9, and the restatement has drifted.

*What would settle it.* Live provider runs, repeated, against endpoints whose behaviour changes
without notice. A test in this tree can pin the *mechanism* — and several do
(`packages/llm/tests/integration/wire-cache-diff.test.ts`,
`packages/loop/tests/prefix-stability.ts`) — but it cannot re-take the observation.

### Three readings of dependency-internal behaviour, and the report is wrong about the first

The gap report groups these as one item. They have three different answers.

**`MarkerSite` is checkable here, and nothing checks it.** The report says the derivation at
`packages/llm/src/ai-sdk/request-options.ts:309`–`:350` "is not verifiable here" because
`convertToOpenAICompatibleChatMessages` lives inside `@ai-sdk/openai-compatible`. It is a **public
subpath export** of a package this workspace already installs:
`node_modules/@ai-sdk/openai-compatible/package.json` maps `"./internal"`, and the symbol is declared
in `dist/internal/index.d.ts`. So the derivation could be pinned by a test, and no such test exists.
One of the three arms is pinned incidentally:
`packages/llm/tests/integration/provider-request-shape.test.ts:187` asserts `markedIndices` equals
`[0, 1]`, wire index 0 is the lifted system message (`request-options.ts:585`), and `markedIndices`
(`:89`–`:98`) only counts a message whose `content` is an **array** carrying `cache_control` — which
happens only if the real SDK spread the message-level `providerOptions`. The multi-part-user and
assistant-text-only shapes of the `"message"` arm are pinned nowhere.

**`MCPClientHandle.protocolVersion` still depends on an SDK call guarantee, but exposes nothing.**
The capture works by replacing `transport.setProtocolVersion`
(`packages/mcp-client/src/client.ts:218`–`:223`), and whether the SDK calls that method exactly once,
or at all, is outside this tree. The field is typed `string | undefined` (`:66`) and its one reader
guards it (`packages/mcp-client/src/connection.ts:352`), so a version that never arrives degrades to
an absent diagnostic field rather than to anything worse. The half worth pinning is the *forwarding*,
not the capture: `:219`–`:223` re-binds the original and calls through, which is what keeps
`mcp-protocol-version` on every post-handshake HTTP request. As of 2026-08-22 a test drives that
against a real SDK client and a real HTTP server
(`packages/mcp-client/tests/integration/protocol-version.test.ts`).

**A `null` tool result is now determined, and cannot come from the real SDK.** `CallToolResultSchema`
extends a `z.looseObject` and the response is parsed with `safeParse`, so a `null` payload resolves as
a rejection and never reaches the mapper. `interpretCallResult` no longer dereferences unguarded:
`packages/mcp-client/src/tool-results.ts:101`–`:110` returns an `mcp_runtime_error` for a nullish
result, and the TSDoc at `:85`–`:98` records that the branch defends the `MCPClientFactory`
substitution seam and **not** the SDK. That distinction is load-bearing — a reader who takes it for
an SDK guard will reopen the question.

*What would settle the first item.* A test over `./internal` asserting, for each of the message
shapes the derivation enumerates, where the SDK reads provider metadata from. That is possible here
and has not been done. Nothing binds a future version of either dependency; a test converts a
reading into a regression alarm, which is the most this repository can do about a third party.

### Three external binaries the behaviour depends on, and one guard that never runs

**`ripgrep`, and this is worse than the report says.** The whole of the guard is
`if (process.env.CI) expect(rgAvailable).toBe(true);` at
`packages/tools/tests/contract/grep-parity.test.ts:16`, and that line is the **only** reader of
`process.env.CI` anywhere in `packages/`. Nothing under `tooling/`, `.githooks/`, the root
`package.json` or `bunfig.toml` sets it; GitHub Actions does. Restored push and pull-request CI now
enforces the guard, while local pre-commit runs still do not set `CI`: a local machine without `rg`
skips the parity contract at `:20` rather than failing it. The environment precondition is therefore
remote-CI-enforced but not local-gate-enforced.

**Native sandbox backends are operationally gated, with one macOS platform risk.** Bubblewrap and
Seatbelt outcomes are discriminated typed probes carrying a reason, decided behind injectable seams,
fail-closed by default, and surfaced to the operator (`packages/tools/src/sandbox.ts`,
`SandboxProbe`, `probeSandbox`). Linux and macOS CI enable real-host canaries for workspace
write/read-only behavior, scratch writes, undeclared-path and process isolation, host/denied
networking, and the kernel toolchain-inspection path (`packages/tools/tests/integration/sandbox.test.ts`,
`enforces the native sandbox against real host resources`;
`packages/kernel/tests/integration/sandbox-policy.test.ts`, `inspects a discovered toolchain without
executing it through the real native backend`; `.github/workflows/ci.yml`, `jobs.linux` and
`jobs.sandbox-macos`).

**A resolved 2026-08-30 Seatbelt regression made installed Apple Git look absent.** A real Clarvis
run executed `git status --short` inside Seatbelt; `xcode-select` could not read
`/var/select/developer_dir`, printed “No developer tools were found” and opened the Command Line
Tools installer even though host `/usr/bin/git --version` reported Apple Git 2.39.5. The first exact
link allowance was insufficient: Seatbelt's `file-test-existence` checks also require the authored
alias parents, and the real Git then required authored `/etc/gitconfig` checks beside canonical
`/private/etc`. A later macOS 14 CI runner proved that Apple Git can consult
`/var/db/xcode_select_link` as well: its canonical `/private/var/db` tree was admitted, but the
authored alias was not, so Seatbelt denied the readlink and reproduced the same fallback. The final
policy admits read-only `/etc`, `/private/etc`, the `/var` link and only the authored/canonical
`var/select` and `var/db` trees. It does not admit general `/private/var` or writes. The opt-in macOS
canary now resolves both selectors inside the generated profile before it executes the installed
`/usr/bin/git --version`; a selector regression therefore stops before the Git shim can request the
graphical installer. It also rejects the developer-tools fallback
(`packages/tools/tests/integration/sandbox.test.ts`, `runs the installed Apple Git without
triggering the developer-tools fallback`).

The remaining risk is specific and external: Apple marks `sandbox-exec` deprecated, and Apple DTS
states that the Sandbox Profile Language is not a supported API for third-party products
([Apple Developer Forums](https://developer.apple.com/forums/thread/661939)). Clarvis does not hide
that with an optional fallback by default: if `/usr/bin/sandbox-exec` or the profile stops working,
the Seatbelt probe reports unavailable and a required run fails closed. The CI canary detects drift
on the supported macOS runner, but cannot turn this private/deprecated OS surface into a durable Apple
compatibility promise.

**`git`, and a citation the report gets wrong.** It cites
`packages/code/src/adapters/marketplace.ts:197`–`:205` as "spawns `git` directly through
`Bun.spawn`". Those lines are TSDoc `@remarks`, not code, and that module contains no spawn at all:
it imports `gitCloneAsync` at `:14` and calls it at `:211`, and the spawn is
`packages/code/src/adapters/plugin-install.ts:112`. The substance is right and is already
recorded at the declaration — against a remote kernel, installing a plugin would reach the kernel's
filesystem while adding a marketplace would clone onto the operator's own laptop. What is recorded
nowhere is the precondition itself: `git` must be on the **client's** `PATH` for the browse path, and
nothing in the tree fails if that seam is later rewired. Git is separately the authority for every
launch-time worktree fact.

*What would settle these.* For `ripgrep`, making the assertion unconditional — the binary is
genuinely required, and the current condition is dead surface. For `git`, an architecture test over
the client-side seam. Neither is a question about the outside world; both are simply not done.

### No `clarvis.tasks.v2` server exists here, and the harness has never met the adapter

`TASKS_PROTOCOL` is `"clarvis.tasks.v2"` (`packages/tasks/src/settings.ts:5`). No server implementing
it exists in this repository, and Clarvis ships none by design: the provider is operator-owned. Every
exercise of `createMcpTaskProvider` drives a hand-built `TaskServerPort` — `canonicalPort` at
`packages/tasks/tests/component/mcp-provider.test.ts:68`–`:100` is a stateless map of canned
envelopes whose `callTool` (`:95`–`:98`) returns `results[tool]` and records the call. The kernel side
is fakes too (`packages/kernel/tests/component/task-server-port.test.ts`,
`packages/kernel/tests/component/task-provider-factory.test.ts`).

*The actionable part the report does not state.* The conformance harness has never been run against
the MCP adapter. `assertTaskProviderConformance`
(`packages/tasks/src/testing/provider-conformance.ts:109`) has exactly one consumer suite,
`packages/tasks/tests/component/conformance.test.ts`, and all three providers it is handed are built
by `makeProvider()` (`:7`, `:96`, `:127`) from
`packages/tasks/tests/helpers/provider.ts:72` — an in-memory fake that shares no line of code with
`packages/tasks/src/mcp-provider.ts`. So the adapter's snake_case field mapping, its projection of
`available_intents` and its envelope forwarding are exercised only against assertions written beside
them, never against the contract.

*And the harness's own TSDoc is wrong.* `provider-conformance.ts:9` says "the four suites that do use
it are this package's own". There is one.

*What would settle it.* A real server, whose existence anywhere is outside this tree. The substitute
available here is a stateful reference `TaskServerPort` behind `createMcpTaskProvider`, run through
the harness — the only composition that would put the adapter and the contract on the same axis.

### `link()` atomicity and `fsync` durability are asserted by comment, and only one of them is stale

**The `link()` half stands, and is worse than the report says.**
`packages/paths/src/local-lease.ts:972`–`:974` is a `//` comment asserting that "the canonical path
appears in one step and already refers to complete, fsync'd bytes", immediately above
`await link(temp, path)` at `:975`; `:977` reads `EEXIST` as contention and returns null, `:978`
rethrows anything else. Three things compound it. The comment violates this repository's own standard
(no `//` in `src/` outside an otherwise-empty block); `tryPublish` at `:949` carries no TSDoc at all;
and the synchronous twin `tryPublishSync` at `:1003` reaches `linkSync(temp, path)` at `:1026` with
the rationale recorded **nowhere**, so the invariant is documented on one of two identical paths.

*What breaks if the premise is false.* Publication **is** the mutual exclusion. On a filesystem whose
`link` replaces rather than refuses, two acquirers both believe they hold the lease. That consequence
is pinned behaviourally — `packages/paths/tests/contract/local-lease.test.ts:53`–`:74` asserts the
second `acquireLocalLease` returns null while the first still owns the record — but nothing in
`packages/paths/tests` exercises `link`'s `EEXIST` refusal directly, so the suite pins the outcome on
whatever filesystem it runs on and never the premise it rests on. A filesystem without hard links
fails acquisition loudly rather than degrading, because `:978` rethrows and `acquireLocalLease`
(`:1061`–`:1084`) does not catch.

**The `writeFileDurable` half is largely stale.** The dependency is already recorded in TSDoc:
`packages/paths/src/atomic.ts:488`–`:496` explains why `rename` is atomic but not durable, `:260`–
`:264` says Windows will not open or sync a directory handle at all and that treating the refusal as
a no-op is what keeps the writer portable, and `:237`–`:243` says a durable write then silently
degrades to an atomic one. The degradation is pinned
(`packages/paths/tests/contract/atomic.test.ts:352`–`:364` for the never-throws property,
`:467`–`:477` for one `paths.fsync_dir_unsupported` line per errno). "No test in
`packages/memory/tests` simulates a power loss" is literally true and misleading:
`packages/memory/tests/integration/journal-recovery.test.ts` simulates the *interruption* the journal
exists for. What is unobservable is the physical guarantee that `fsync`'d bytes survive a power cut,
and no unit suite can observe it.

*What would settle the first half.* Two unconditional assertions on the primitive plus one that binds
them to `acquireLocalLease`, so the test fails on a filesystem where the design's premise is false
rather than passing as an operating-system probe. The second half cannot be settled here at all.

### The plan file's YAML dialect is the dependency's default, not a declared contract

`packages/plan/src/format.ts:128` calls `parseYaml(match[1]!)` with **no options**, and `:322` calls
`stringifyYaml(fm, { lineWidth: 0 })`. The timestamps go out unquoted (`:284`–`:285`) while
`planDocumentSchema` requires `z.string().datetime()` (`packages/plan/src/schemas.ts:145`–`:146`). The
installed `yaml` is 2.9.0, and the dialect the plan store's on-disk format depends on is whatever that
package defaults to.

*The report says a dialect change "would break parsing silently at the schema". That is wrong in
direction, and it misses the half that is genuinely silent.* Measured here on yaml 2.9.0:

- Under `{ version: "1.1" }`, `created_at: 2026-07-27T10:00:00.000Z` resolves to a `Date`.
  `planDocumentSchema.parse` at `format.ts:244` then throws, and the round-trip at
  `packages/plan/tests/unit/plan-format.test.ts:30` goes red. That failure is **loud**, and the
  pre-commit gate catches it.
- The silent half is `unknown_frontmatter`. `unknownFrontmatterSchema`
  (`packages/plan/src/schemas.ts:109`–`:113`) is `z.record(z.string(), z.unknown())` and accepts
  any value, so a 1.1/1.2 divergence that lands there
  raises nothing: `owner_note: yes` becomes boolean `true` and `window: 10:30` becomes the number
  `630` — both measured — and `renderPlan` writes those back into the user's own plan file. The one
  fixture is `owner_note: hello` (`plan-format.test.ts:25`), which is dialect-insensitive.

*The runtime consequence, if such a change ever shipped past the gate, is silent too.*
`packages/plan/src/file-repository.ts:502`–`:512` logs `plan.document.unparsable` at `warn` and
`:655`–`:657` skips the file, so every plan would vanish from `list_plans` while the files sit
untouched on disk.

*The `%YAML 1.1` directive path is closed, but by the regex rather than by the parser.* Measured:
`parseYaml("%YAML 1.1\n---\ncustom: yes")` yields `{ custom: true }` — the default parse honours a
directive — while `splitDocument`'s regex at `format.ts:126` is non-greedy over `\n---\n`, so a
directive can only reach `match[1]` bare, where `parseYaml` throws "Missing directives-end/doc-start
indicator line". The closure is incidental, and a later relaxation of that regex would open it.

*What would settle it.* Pinning `{ version: "1.2", schema: "core" }` at both call sites and asserting
the scalar types through `parsePlan`/`renderPlan` rather than against the `yaml` package. Not done.

### The Bun crash's evidence is no longer outside this corpus — resolved

The gap report says `tooling/ci/retry-code-coverage.sh` and `.github/workflows/segfault-canary.yml` "both
point at a `specs/known-issues.md` that is not part of this corpus, so the measured crash rate, the
retry's expected residual failure rate, and whether any canary arm has been run are unknown to these
documents." Every checkable part of that is now stale, and this is the file it named.

Verified 2026-08-22: `tooling/ci/retry-code-coverage.sh:7` reads "specs/known-issues.md). A death by one of
the crash signals is retried; a real" and `.github/workflows/segfault-canary.yml` (top comment) reads
"@clarvis/code suite (see specs/known-issues.md). One arm per dispatch;". Both paths resolve. (The
report cites `:3`–`:7` and `:3`–`:4`; the path literal is on `:7` and `:4`, the earlier lines being
the surrounding prose.) The rate is carried above under *The rate, measured* — 26 of 84 runs, 31.0%,
every one in `@clarvis/code` and every one exit 132 — and the residual under *Mitigations in place*:
at 31% the expected residual red is ~0.9%. The upstream family is oven-sh/bun#17241 duped into
#15964, and the retracted attribution to #31832 is recorded so it is not re-filed there.

**One sub-claim survives, and it is permanent unless CI returns.** The four JSC arms are declared
(`.github/workflows/segfault-canary.yml`, `on.workflow_dispatch.inputs.jsc.options`) and **no result for any of them is recorded
anywhere in the tree** — which is as much as can be established here; the canary deliberately
remains `workflow_dispatch`-only because each batch is expensive. Report this item as resolved on rate, residual, upstream issue and
mechanism, and unanswered on arm results.

### ~~The Bun version story is inconsistent~~ — resolved 2026-08-22

The recorded baseline really was split: mise and all three CI jobs ran 1.3.11, both server stages
ran 1.3.14, root `@types/bun` was 1.3.14, and the 20 manifest floors were `>=1.3.11`. That let code
typecheck against runtime APIs the developer and CI executable did not necessarily have, while the
server image ran a version neither of them qualified.

The active contract is now exact Bun 1.4.0 for executable pins and `>=1.4.0` for every manifest.
`tooling/checks/bun-version.ts:47-152` derives the canonical version from `mise.toml` and checks all
three CI setup steps and their version/revision evidence, the crash-canary default and its evidence,
both Docker stages, all workspaces discovered from the root manifest, `@types/bun`, and both the
declared and resolved lockfile entries. It runs inside `lint:intent` (`package.json:41`), and the nine
cases in `tooling/tests/unit/bun-version.test.ts:65-134` make every drift class fail independently.

The old 1.3.11-versus-1.3.14 performance measurements above remain historical evidence, not a claim
about 1.4. Likewise, fixture prose in `packages/memory/src/testing.ts` and its tests deliberately
mentions old versions; the checker enumerates executable contracts instead of rewriting arbitrary
prose.

Local Linux qualification on 2026-08-22 produced two attributable results. The Bun 1.4.0 Code
coverage-plus-architecture canary completed 30/30 process-fresh iterations with zero signal exits
and zero test failures. The seven-sample TUI benchmark was trusted (AC power, performance governor,
16 cores, load/core 0.068–0.093): source and bundle first-paint medians improved from 1325.90/1327.12
ms on 1.3.11 to 1134.21/1134.64 ms on 1.4.0; bundled `--version` improved from 418.02 to 281.66 ms.
This local candidate evidence does not stand in for the still-unrun GitHub 1.3 control arm or the
Windows/macOS jobs.

---

## Complete TUI hydration remains above 500 ms under Bun 1.4.0 and OpenTUI 0.5.7

**Mitigated at the functional-input boundary on 2026-08-29; strict complete hydration remains
unresolved.** The lightweight entry now paints a focused startup composer before importing the
complete application runtime. A forced three-sample local bundle batch was untrusted because
load/core was 0.369 against the 0.35 gate, but its staging was stable: minimal shell and focused
input both had a 182 ms median, while complete header and input hydration had a 675 ms median. One
nine-plugin real launch reached the focused composer at 264 ms and complete hydration at 1,110 ms.
These samples are not mutually comparable; they establish which stage remains expensive, not a
cross-machine absolute baseline.

The repository-owned multiplicative waits were separately reproduced and corrected. Repeated plugin
parsing/hashing had made the same nine-plugin Environment take about 32.9 seconds; pinned projections
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
`.agents/skills/clarvis-performance-validation/SKILL.md`.

---

## Windows release packaging exposed host-specific artifact assumptions

**Resolved for the published `v0.0.1-beta` artifacts on 2026-08-26.** Manual release workflow run
`32972288986` built, packaged, smoked, and installer-smoked `darwin-x64`, `darwin-arm64`,
`linux-x64`, and `linux-arm64`. Both `windows-x64` and `windows-arm64` stopped earlier in
`bun --filter @clarvis/code build:install` with `artifact has no dynamic import for the AiSdkAdapter
chunk`; packaging and installer smoke therefore never ran on either Windows target. The manual
dispatch could not publish and its publish job was skipped by design.

The bundle still contained the adapter in a lazy chunk. The failure was in the assertion that
verified that graph: `assertLazyProviderArtifact` extracted the generated chunk name with
`providerChunk.path.split("/")`. Bun's Windows artifact path uses backslashes, so the assertion
treated the complete path as the basename and searched the emitted JavaScript for an impossible
dynamic-import specifier containing that absolute path. Both Windows architectures failed at the
same assertion; the four slash-separated native jobs passed it.

The contract now separates a generated chunk path on either slash before matching its basename.
`packages/code/tests/architecture/artifact-contract.test.ts` pins the regression with a
Windows-shaped absolute path while retaining the generated `./chunk-provider123.js` import. Manual
rerun `32988189314` verified that correction on both Windows architectures: `build:install` passed.
It then exposed a separate failure in `release:package`. Runtime dependency discovery passed a
non-package generated call specifier into the closure, and `packageManifest` consequently tried to
open `node_modules/package.json`. Both Windows jobs failed there; the other four targets again
completed packaging, release smoke, installer smoke, and artifact upload. The emitted specifier was
not present in the job log, so the narrower source token cannot be claimed from that run alone.

Runtime call discovery now uses one pure package-name validator for ordinary calls and direct
`createRequire(import.meta.url)(...)` calls, confirms every discovered package directory exists, and
rejects any invalid name that reaches manifest resolution. The unit regression covers package
subpaths plus relative, absolute Windows/POSIX, built-in, and internal specifiers.

Official tag-triggered release run
[`32998576908`](https://github.com/getclarvis/clarvis/actions/runs/32998576908) then ran from release
commit `4aab234b7a70229949d042ce451a57a9e4eb2672`. All six native package jobs passed. In particular,
both Windows architectures completed `build:install`, `release:package`, `release:smoke`, and
`release:install-smoke`, and the publish job verified all six archive sidecars before publishing the
release. This closes the packaging incident. It does not add a native Windows PTY first-paint claim:
Windows release smoke covers the manifest and CLI fast paths, while real-PTY first paint remains in
the POSIX release jobs.

---

## Windows gaps, in detail

The short form is in `AGENTS.md`. The reasoning behind each suppression predicate — and, for two of
them, why the predicate is a defect marker rather than a statement of inapplicability.

Every gap below is **still open**. The four platform gaps came first; the three that follow them —
the pid-liveness errno, the surfaces outside the job's four packages, and the two absent
`O_NOFOLLOW` guarantees — were carried here from the gap report's §6 on 2026-08-22. Every predicate,
guard and behaviour named here was verified present in the tree on that date. Two things around them
have moved since the record was first written, and both change how the gaps can now be worked on:

- **The restored Windows leg exposed a test-owned file-handle leak; its native rerun is pending.** CI was disabled on
  2026-08-18 and push/pull-request triggers were restored on 2026-08-25. The public `main` run
  `32963947832` on 2026-08-26 exercised the retained
  `tools, paths, plan, memory, keyboard policy (windows)` job. Its first attempt failed in
  `@clarvis/paths` when Bun reported a `FileHandle` finalized before explicit close during a live
  lease-contention test. An isolated rerun passed all `@clarvis/paths` tests, then exposed six
  platform-invalid `@clarvis/tools` fixtures: POSIX temp commands under PowerShell, a filesystem
  socket on Windows, a POSIX `/dev/null` command, and two `/proc`-based unwritable-path assumptions.
  The test-only corrections in this tree keep the run-owned-temp scenario cross-platform, scope the
  genuinely POSIX cases to the POSIX shell, and force spill-write failure with a portable
  file-as-parent `ENOTDIR` shape. Public run `32968159089` then passed `@clarvis/paths` (222 pass,
  14 platform skips), `@clarvis/tools` (1102 pass, 64 platform skips), and `@clarvis/plan` (288 pass,
  3 platform skips). It reached `@clarvis/memory`, where 629 tests passed before the non-repository
  workspace-state case failed in fixture teardown: Windows returned `EBUSY` while recursively
  removing the temporary root. A first correction gave the shared fixture five bounded `fs.rm`
  retries with a 20 ms delay, but public run `32969624120` disproved it: Paths (222 pass, 14 platform
  skips), Tools (1102 pass, 64 platform skips) and Plan (288 pass, 3 platform skips) all passed again,
  then Memory reached 629 passing tests before the same case failed after 41.19 ms with the same
  `EBUSY`; the keyboard-policy step was skipped. The retry has therefore been removed rather than
  retained as a false fix. The cause is the production probe: `captureWorkspaceState` launched its
  three Git commands in parallel under `Promise.all`, so the first expected non-repository rejection
  returned `undefined` while sibling processes could still hold the temporary directory as their
  current directory. It now uses `Promise.allSettled` and chooses the first failure only after every
  child callback has settled. The existing non-repository integration case remains the regression:
  its `finally` removes the workspace immediately after the capture returns. Public run
  `32970820273` verified the correction and completed the whole Windows job: Paths reported 222 pass
  and 14 platform skips; Tools 1102 pass and 64 platform skips; Plan 288 pass and 3 platform skips;
  Memory 630 pass, 1 platform skip and 0 failures; and the three keyboard-policy files 36 pass and 0
  failures. Main run
  [`33012772530`](https://github.com/getclarvis/clarvis/actions/runs/33012772530) reproduced the
  earlier finalizer signature after those three successful executions. The first error was a
  `FileHandle` for a `clarvis-local-lease-*` temp path being closed during garbage collection; the
  immediately following housekeeping test then failed while checking files it should preserve.
  This was not a spill-age or housekeeping defect. The heartbeat-loss diagnostic test acquired an
  asynchronous lease, deliberately made `renew()` mark it lost, and ended without calling
  `release()`. Its fixture cleanup removed the directory but could not close the held descriptor.
  The regression now releases the lease in `finally` and asserts the expected `false` result: a lost
  lease cannot remove the canonical entry, but `release()` must still stop heartbeat work and close
  its handle. A fresh Windows run remains the native verification for that correction.
- **Two diagnostics were added to make these gaps diagnosable without a runner**, because "the
  windows job will settle it" was not a plan while the workflow was disabled. They remain useful
  even after trigger restoration and are described under the gaps they serve.

### `monitor` captures no output

`monitor_start` redirects its child's stdout and stderr into an inherited file descriptor
(`packages/tools/src/tools/monitor.ts:285`, `stdio: ["ignore", fd, fd]` — one `openSync(lp, "a")`
handed to both slots), and on Windows nothing arrives — the log is empty, not merely differently
encoded.

Only the write side is implicated: reads stat and read the log by path, and every monitor test
asserting bookkeeping rather than captured output passes. `shell` is unaffected because it captures
over pipes (`packages/tools/src/tools/shell.ts:258`, `stdio: ["ignore", "pipe", "pipe"]`).

Nine `monitor` tests are suppressed behind `monitorCapturesOutput`
(`packages/tools/tests/helpers/fixtures.ts:281`; the nine call sites are
`packages/tools/tests/integration/monitor.test.ts:70,130,176,208,314,335,384,403,422`) — a predicate
kept **separate from `posixShell` on purpose**, because those tests are suppressed by a defect, not
by inapplicability.

**Ruled out, with the reasoning that ruled it out.** Opening the log twice (one handle per stdio
slot) was tried and changed nothing. The experiment is `50ea97c`, reverted the same day in `2705c3a`
(2026-07-28). Its hypothesis was that handing the *same* descriptor to two stdio slots is the one
thing this path does that the working `shell` path does not — Node services that on Windows by
duplicating the underlying handle per slot, and Bun reimplements `child_process` — so two independent
`"a"` handles would remove the sharing while interleaving identically and leaving POSIX untouched.
The commit's own diagnostic still stands and is worth keeping: *that the log is completely empty* is
the evidence, because if either stream were connected, PowerShell's own parse errors would have
landed in it. Neither stdout nor stderr reaches the file. The remaining explanation is that
inheriting a numeric descriptor does not work there at all, so the fix is to let the child open the
log itself rather than inherit it.

Note that `packages/tools/src/tools/monitor.ts:169` cites that experiment as `50aa7c2`. That hash
does not resolve; the commit is `50ea97c`.

**What was built instead of a runner.** `tools.monitor_spawn`
(`packages/tools/src/tools/monitor.ts:272`, naming platform, `detached`, the stdio slots and the log
path) and `tools.monitor_poll` (`:383`, naming `running`, `offset` and `log_bytes`) are a deliberate
write-side/read-side pair: a `running` monitor whose poll reports zero bytes answers "which side
fails" directly, from a single hand-run on a Windows host, with no CI job involved.

### PowerShell serializes stderr as CLIXML

When stderr is redirected, a `shell` caller sees `#< CLIXML <Objs…>` with escaped ANSI codes rather
than the message. How Windows stderr should be presented is an open product decision.

This one has **no predicate of its own** — `grep -rni clixml` finds the string nowhere in the tree
but `AGENTS.md`. The stderr fixtures that would surface it are scoped by `posixShell` instead
(`packages/tools/tests/integration/shell.test.ts:50`, "captures stderr separately", which uses
`1>&2`), and that is correct on its own terms: the redirection syntax genuinely is POSIX. But it
means the CLIXML gap is recorded here and nowhere else in code. Anyone deciding the product question
should give it a named predicate at that point, not before.

### `exitCaptureWrapper` cannot carry `exit N` from a PowerShell statement

It tests `$?` ahead of `$LASTEXITCODE` (`packages/tools/src/shell.ts:166`), so only a native command
keeps its real status; a pure-cmdlet command reports only `0` or `1`, because PowerShell gives cmdlet
failures no richer status. That ordering is deliberate and documented on the function
(`packages/tools/src/shell.ts:155`): `$LASTEXITCODE` is sticky for the whole payload — once any
native command has run it stays set — so testing it first would make `git status; Write-Output ok`
report git's status rather than the payload's.

### `apply_patch` reports `io_error` where POSIX reports `not_a_file`

When the target's parent is itself a file, POSIX raises `ENOTDIR`, which `fsError` maps
(`packages/tools/src/errors.ts:99`, with the `ENOTDIR` branch at `:103`); Windows raises something
else that reaches the `io_error` fallback, and **which code that is has not been identified**. Find
it and add it to `fsError` rather than widening the fallback. The assertion is scoped to POSIX until
then (`packages/tools/tests/integration/apply-patch.test.ts:95`).

The datum was always present — it is in the error message — and nothing but the model ever read it,
so no CI job retained it. The fallback now also emits `tools.fs_error_unmapped`
(`packages/tools/src/errors.ts:106`) carrying `errno_code`, `syscall`, `path` and `platform`, at
`debug`, since an unusual errno is an ordinary outcome rather than a degradation. One Windows run
with debug logging on now answers the question that CI was previously the only way to ask.

### Three pid-liveness probes spell "exists but is not mine" as `EPERM` alone

Four modules probe whether a pid is alive with a signal-0 `process.kill`, and they split three to
one on what an unclassifiable errno means. That split is deliberate and each owning spec records the
direction its site chose (`specs/foundations/paths.md:615`–`:623`,
`specs/execution/tools-shell-and-monitor.md:272`–`:282`, `specs/capabilities/memory-store.md:436`,
`specs/foundations/trace.md:706`–`:710`), so it is not the defect. The defect is the **errno
spelling** the three fail-open sites share:

| Site | Line | Reads "alive" as |
| --- | --- | --- |
| `packages/memory/src/file-store/lock.ts` | `:78` | `code === "EPERM"` |
| `packages/tools/src/lib/monitor.ts` | `:106` | `code === "EPERM"` |
| `packages/trace/src/journal-recovery.ts` | `:84` | `code === "EPERM"` |
| `packages/paths/src/local-lease.ts` | `:195` | `errno !== "ESRCH"` |

On Windows, libuv's `uv_kill` opens the target and passes an `OpenProcess` failure through
`uv_translate_sys_error`, which maps `ERROR_ACCESS_DENIED` to `EACCES` rather than `EPERM`. Under
that reading the three `=== "EPERM"` sites report a live process owned by another principal as
**dead**, and `packages/tools` is one of the four packages the Windows job runs.
`packages/paths/src/atomic.ts:28` already treats `EPERM` and `EACCES` as one Windows family, which is
the in-tree precedent. **This is read off libuv's error table, not measured here** — no Windows
runner has confirmed it, and none can while CI is dispatch-only.

**The obvious repair is wrong, and the trap is worth recording.** Converging all five on
`!== "ESRCH"` widens "alive" to every error the probe can raise, and `process.kill` raises more than
errnos. Measured on the pinned Bun on Linux: `process.kill(2147483647, 0)` throws `ESRCH`, but
`2147483648`, `4294967296` and `1.5` all throw a `TypeError` with `code === "ERR_INVALID_ARG_TYPE"` —
the probe was never made. All three sites accept the pid from a file with no upper-bound check
(`packages/trace/src/journal-recovery.ts:115` admits any JSON number,
`packages/memory/src/file-store/lock.ts:72` guards `Number.isInteger(pid) && pid > 0` and no more,
`packages/tools/src/lib/monitor.ts:117` admits any number in a guard whose own TSDoc says it exists
"to reject corrupt sidecars"). Under a blanket `!== "ESRCH"` such a file reads as alive forever:
memory's `stealable()` never returns true and every `store.exclusive` ends in "timed out waiting for
tree lock"; trace's journal is never recovered and never quarantined; monitor never GCs the sidecar.
The narrow repair — pre-guard the pid, then accept the closed set `EPERM | EACCES` — keeps each
site's chosen direction and loses nothing.

Note that the existing tests are **vacuous with respect to this**:
`packages/tools/tests/integration/monitor-lib.test.ts:82`–`:89` and `:91`–`:97` stub `EPERM` → alive
and `ESRCH` → dead, both already true today, and
`packages/trace/tests/integration/journal.test.ts:424` uses `pid: 2_147_483_646`, just under the
boundary. Only an `EACCES` case would be non-vacuous.

### Packages outside the Windows job, and the three different things their surfaces are

The job covers four packages plus three keyboard-policy test files. The gap report tabulates five
POSIX-shaped surfaces with no Windows evidence in the
packages it does not cover. Re-verified, those five are three different kinds of thing, and two of
them are not gaps at all.

**A product guarantee that silently does not hold there.** The trace store and the memory tree are
owner-confined by mode bits: `packages/trace/src/json-trace-store.ts:417`, `:419`, `:422`, `:427`,
`:598`, `:746`, `packages/trace/src/journal.ts:153`, and, in
`packages/memory/src/file-store/`, `layout.ts:32`, `journal.ts:119`, `revisions.ts:99` and
`lock.ts:102`/`:104`. None of those calls *fails* on Windows — `chmodSync` there moves only the
read-only attribute and `mode` on `mkdirSync`/`openSync` is ignored — so the code is not a
correctness bug. The confinement simply does not exist. That is a finding about the product, not
about the tests, and relabelling it as a test problem is how it would get lost.

**Test assertions that would not run.** Six file-mode expectations in `@clarvis/trace` and
`@clarvis/memory` would fail on Windows and under root alike; the established remedy is a named
`modeBitsEnforced` predicate wrapping the mode expectation only, never the surrounding test. Eighteen
`symlinkSync` call sites would fail for want of the privilege: seventeen in `@clarvis/skills`
(`tests/integration/symlink.test.ts:40,58,76,86,110`, `scan.test.ts:96,149,164,180,195`,
`diagnostics.test.ts:160,161`, `bounds.test.ts:285,309`, `paths.test.ts:64`,
`sidecar.test.ts:203,232`) and one in `@clarvis/memory`
(`tests/integration/file-provider.test.ts:187`); `packages/code/tests/integration/marketplace.test.ts`
has three more, equally outside the job. Five of the skills sites link a **file**, where the
`"junction"` substitution that `packages/tools/tests/helpers/fixtures.ts:332` and
`packages/plan/tests/integration/file-repository.test.ts:48` use does not apply — the guard there has
to be a probe, not a substitution. Two of them (`paths.test.ts:64`, `scan.test.ts:164`) are *escape*
tests, so guarding them suppresses a security assertion; say so at the point it happens rather than
letting it pass as routine.

**Two rows that are not gaps.** `packages/skills/src/scan.ts:416`–`:418` is listed as "POSIX
separator normalisation". It is the opposite: `toPosixRel` splits on `path.sep` and joins with `/`,
which is the platform-*correct* normalisation for a display path and the same idiom `@clarvis/tools`
uses deliberately. Rewriting it to a bare `path.relative` would make resource paths host-shaped and
break `references/api.md` lookups on Windows, so the row is not merely harmless — acting on it would
introduce the bug.

**And one row that is simply true.** `!bash`'s `ownProcessGroup()` call is unexercised — the job runs
three keyboard-policy files from `@clarvis/code` and nothing that touches the shell adapter. That is
its own entry above.

### `O_NOFOLLOW` is absent on Windows, and neither path that asks for it is pinned

Two packages open a file read-only with `O_NOFOLLOW` where the host defines it. Nothing asserts the
flag word at either call site, and the `win32` arm of the first is dead code on every host the suite
has ever run on.

`packages/tools/src/lib/files.ts:68` returns early on `win32` with Node's portable `"r"` mode,
dropping both `O_NONBLOCK` and `O_NOFOLLOW`. Losing `O_NONBLOCK` is harmless and the TSDoc at
`:59`–`:63` says why — Windows filesystem paths expose no FIFOs. Losing `O_NOFOLLOW` is a real
reduction: `noFollow` becomes advisory there, and the three callers that ask for it
(`packages/tools/src/lib/files.ts:226`, `packages/tools/src/lib/logslice.ts:39`,
`packages/tools/src/tools/file-stat.ts:100`) pass no compensating confinement. The TSDoc's
"descriptor metadata remains the authority on every platform" (`:64`–`:65`) is true only where a
`confinement` is supplied.

`packages/plan/src/file-repository.ts:91`–`:92` composes the same flag word and `:181` opens with it.
The compensating controls are the `lstat` in `confined` and the `entry.isFile()` filter in
`planEntries`; `O_NOFOLLOW` only narrows the window between those and the `open`. Its junction-based
root-escape check is written *for* Windows and gated on a capability probe
(`packages/plan/tests/integration/file-repository.test.ts:43`–`:48`, used at `:220` with `"junction"`
at `:230`) — so the gap report's "was not run on Windows" is half stale: it is written for Windows and
has simply not executed since the triggers were disarmed.

The fix is a handle-relative open — the same `openat`-shaped remedy the write-side TOCTOU entry above
demands — and specifically **not** an `lstat` pre-check on Windows, which would convert a known
absence into a believed protection. What *is* available from a POSIX host today is an assertion on
the real read path that the flag word carries the bit. A pure test of the flag *arithmetic* proves
nothing: measured during the 2026-08-22 investigation pass and not re-run here, extracting the
composition into a helper and asserting both arms left `@clarvis/plan` green at 266 passing while the
call site was reduced to `constants.O_RDONLY`.

### The separator half of the path checks belongs to the runner

`assertWithinWorkspace` folds case only where the host filesystem ignores it —
`caseInsensitive` defaults to `process.platform === "win32"`
(`packages/tools/src/lib/paths.ts:163`) and `forCompare` (`:103`–`:105`) applies it. The **fold
itself is pinned** from Linux, because the parameter is injectable:
`packages/tools/tests/integration/paths.test.ts:78`–`:84` asserts both directions. What is not
pinnable here is the drive-letter shape, and the reason is structural rather than neglect: the prefix
test at `paths.ts:174` uses `path.sep`, a host constant, so on a POSIX host the comparison builds
`c:\proj/` and would pass or fail for the wrong reason. The test says so at
`packages/tools/tests/integration/paths.test.ts:64`–`:68`, and
`packages/tools/tests/unit/powershell-dialect.test.ts:312`–`:315` says the same about
`PathFact.withinWorkspace`.

Threading a path flavour through `canonicalizeAllowingMissing` (`paths.ts:236`) and `resolvePath`
(`:53`) to make this testable was considered and rejected: it replaces a host truth with a parameter
across a confinement boundary, and a caller who could supply `caseInsensitive: false` on Windows
would have the mirror of the escape `paths.ts:93`–`:96` already records. The honest position is that
this one needs the runner.

The gap report groups the `apply_patch` errno with these as runner-blocked. It is not, any more —
see its own entry above.

### `backgroundSettleIsMeasurable` — the measurement, not the behaviour

`&` is PowerShell's background-**job** operator, which hosts the pipeline in a second runspace; that
startup was seen at 4081ms on one runner and **12993ms** on another, and the second exceeds the 10s
child the fixture backgrounds, so no threshold can separate "returned promptly" from "waited for the
child". The measurement is not merely noisy there, it is undecidable, and a threshold picked anyway
is a coin toss wearing an assertion's clothes.

Only the stopwatch is suppressed there; every assertion about what the call *did* still runs. The
test at `packages/tools/tests/integration/shell.test.ts:322` executes on every platform — no error,
exit 0, `ready` on stdout, `timed_out` false — and only line `:330`,
`if (backgroundSettleIsMeasurable) expect(elapsed).toBeLessThan(10_000);`, is conditional. Restoring
a timing check on Windows means making the property structural rather than temporal: have the child
touch a marker file and assert the marker is absent when the call returns.

This is the exception that proves the rule below rather than a licence to ignore it.

### Do not scope a test to POSIX just because it fails on Windows

`windows-latest` carries Git-for-Windows' coreutils on `PATH`, so `printf`, `seq`, `sleep`, `yes`
and `head` all run there; only genuine *shell syntax* (`1>&2`, `$$`, `for … in`, `while [ … ]`,
`trap`) is unavailable.

A guard applied on the wrong premise turns a real defect into a green run — which is exactly how the
`monitor` gap above stayed hidden. `posixShell`
(`packages/tools/tests/helpers/fixtures.ts:203`) is for syntax; a defect gets its own named
predicate.

Two more predicates in the same file carry platform truths worth knowing: `modeBitsEnforced`
(`:190`) is false on Windows **and** under root (both make a "permission denied" assertion
unprovable), and `makeSymlink` (`:332`) needs `"dir"` to pick the junction Windows requires for a
directory link.

The discipline held as the file grew: `canSymlink` (`:313`) and `nonUtf8FilenamesSupported` (`:250`)
are **probed** rather than derived from `process.platform`, because Windows can symlink given
Developer Mode or elevation and encoding validity is a property of the filesystem rather than the OS;
`detachedSleepCommand` (`:224`) records that `setsid(1)` is util-linux and absent on macOS and the
BSDs, where the fixture silently stopped constructing its scenario at all and passed vacuously on
Linux while failing everywhere else. `lines()` (`:343`) normalizes CRLF so a fixture never fails on
the line ending alone.

Four packages joined the Windows job after this record was written. Plan and Paths retain local
predicates in `packages/plan/tests/integration/file-repository.test.ts:33`,
`packages/paths/tests/component/workspace-state.test.ts:44` and
`packages/paths/tests/contract/atomic.test.ts:47` each declare their own local
`modeBitsEnforced`; Memory now does the same in `packages/memory/tests/integration/file-store.test.ts`
and probes file-symlink capability in `file-provider.test.ts`. None of those is wrong,
but none of them can distinguish a defect from an inapplicability the way a named predicate does. If
a Windows defect is found in one of those packages, give it a named predicate there rather than an
inline platform check.

---

## Two CI flakes that were diagnosed and fixed, recorded so they are not re-diagnosed

Both predate the change that found them and both were reproduced from `main`'s own history, not
from a branch. Neither is a Bun runtime death, so neither belongs with the entries above; both were
tests whose timing assumptions were wrong.

**`@clarvis/plan` — `plan store > independent stores contending on the on-disk lock all succeed`,
red on the Windows runner.** Last seen on `main` in run `30777232473`. The lockfile wait budget was
`LOCK_ATTEMPTS × LOCK_RETRY_MS` = 200 × 10ms = **two seconds**, and the test puts 24 independent
repositories on one lock. The budget has to cover the time the whole *queue* takes to drain, not the
time one holder keeps the lock: the twenty-fourth waiter is still waiting while the twenty-three
ahead of it each take, write, fsync and release. On a Windows filesystem that exceeds two seconds,
and the waiter reported a timeout for a lock nobody was holding.

The budget is now 1000 attempts, ten seconds — `packages/plan/src/file-repository.ts:83-84`, with
the reasoning carried in that constant's own TSDoc. The ceiling that matters is `LOCK_STALE_MS`
(30s, `packages/plan/src/file-repository.ts:86`): a waiter that gives up sooner than it would judge
a holder dead can never reach the stale-steal branch, which is what recovers a crashed writer, so
the wait must sit comfortably between a realistic queue and that. The test itself is unchanged and
still puts 24 stores on one lock (`packages/plan/tests/integration/markdown-plan-store.test.ts:40`,
under `describe("plan store — Markdown effects")` at line 28).

Two mechanism details have moved since this was written, without disturbing the diagnosis. The
budget no longer drives a loop in the plan package: it is handed to the shared lease as
`waitMs: LOCK_ATTEMPTS * LOCK_RETRY_MS` (`packages/plan/src/file-repository.ts:430-434`), and
`acquireLocalLease` re-derives the attempt count from it (`packages/paths/src/local-lease.ts:1061`),
so `LOCK_ATTEMPTS` is now the budget expressed in units of `LOCK_RETRY_MS` rather than a literal
iteration count. And recovery is two-part rather than mtime alone: `reclaimLocalLease`
(`packages/paths/src/local-lease.ts:1072`) requires both that the lock be older than `staleMs`
(`packages/paths/src/local-lease.ts:344`) and that the recorded pid be dead
(`packages/paths/src/local-lease.ts:351`). A live writer keeps itself young through
`LOCK_HEARTBEAT_MS` (5s, `packages/plan/src/file-repository.ts:87`). The budget-under-the-ceiling
rule is therefore still the constraint to preserve when either number is touched.

**`@clarvis/server` — `bin: fail-closed bind-address gate`, exit `137` where `1` was expected.**
Last seen on `main` in run `30770028108`. `readUntilSettled` broke out of its read loop as soon as a
gate marker reached stderr and then called `proc.kill("SIGKILL")` unconditionally. But the marker
means the bin has *decided* to exit, not that it has exited — so on a loaded runner the kill landed
first and the refusal reported `128 + 9` instead of the `1` the gate's contract names. The helper now
gives a refusal a bounded grace period to exit on its own and keeps the kill for the "passes the
gate and keeps serving" case it was written for.

The helper stands as described: `readUntilSettled` at
`packages/server/tests/architecture/bin-bind-gate.test.ts:93` still ends its read loop on a
`GATE_MARKERS` hit (line 71), but a stderr containing `"refusing a"` now races `proc.exited` against
a 5000ms timer and returns the natural exit code when it wins
(`packages/server/tests/architecture/bin-bind-gate.test.ts:117-123`); the unconditional
`proc.kill("SIGKILL")` survives only as the fall-through at line 125. `spawnBin`'s
`timeout: 10_000` / `killSignal: "SIGKILL"` (lines 59-65) is documented in place as the last-resort
net for a run that settles on no marker at all, not as the reaper for the ordinary path. The two
cases that were flaking assert `code` is `1` at lines 144 and 151.

Neither reproduces locally with any useful frequency: 12 consecutive runs of the server case and 6
of the plan case were green on a Linux workstation while both were failing on CI. That is the same
lesson as the `code` signal death above — a local run is not evidence about a CI flake — and it is
why both were diagnosed from the failure's own shape rather than by trying to reproduce them.

**One thing that has changed about the guard rather than the fix.** The `windows` job still runs
`bun --filter @clarvis/plan test`, and push/pull-request triggers were restored on 2026-08-25. A
future run can therefore surface a regression again, but no development machine here reproduces the
Windows filesystem timing that found it and no post-restoration result is recorded yet. The run IDs
above cannot be re-checked from a source tree and are kept verbatim as the record of where each was
last observed.

---

## Why delegation was not extracted into its own package

Extracting `runtime/delegation.ts` + `runtime/subagents/` + `runtime/capabilities/{delegation,agents}.ts`
as a `@clarvis/delegation` package was specified, measured and **abandoned**. It was not a matter of
effort; it did not build. Recorded so nobody pays for the measurement twice.

The abandonment still stands. The generated block in `specs/package-coupling-analysis.md` reports
18 packages, 47 internal edges and 3 optional edges, and its table has no `delegation` row — the
package was never created, and the graph check would fail the gate if the document and the manifests
disagreed.

What has changed since the original analysis is that **two of the six obstacles dissolved as
side-effects of other work**, and the coupling numbers moved with them. Both halves are recorded
below: the measurement as it was taken, then the state of its subject today.

### The obstacles as originally measured

- **The coupling is bidirectional.** The subsystem reached ~50 symbols across 24 modules outward
  (`budget/`, `context/`, `support/`, `tools/`, `plans/`, `plan/`, `usage.ts`, `run-shape.ts`,
  `capability-event.ts`, `loop/`) — and nine engine modules reached ~20 symbols *back in*:
  `orchestrator.ts`, `execute-run.ts` (`planProjection`), `entry-inputs.ts`, `vision-prepass.ts`,
  `entry-seed.ts`, `run-shape.ts`, `open-tool-pool.ts`, `settings-specs.ts` and
  `capabilities/plans.ts`. Leaving the assembly in `entry-inputs.ts` — the only tractable scope —
  closes a **package cycle**, and `tsc -b` project references refuse one. This is not the
  `workflows` shape: there the kernel builds the capability and injects it, so the loop never
  imports it.
- **The cycle lands on the eager configuration path**, because `settings-specs.ts` value-imports the
  delegation/agents settings.
- **`run-shape.ts` ↔ `spawn-shape.ts`** was a literal two-file cycle across the proposed boundary;
  that one *was* fixable, and is what the `@clarvis/supervision` extraction fixed.
- **`vision-prepass.ts` calls `runSubagent` on the core run path.** Running a nested agent is
  engine, not capability, and no boundary drawn around `runtime/subagents/` separates the two.
  **Resolved** by the vision-routing work: the pre-pass is now a single `llm.call` naming a model,
  so it spawns nothing. The remaining obstacles still stand on their own.
- **`buildDelegationOrchestration` returns both contributions** — `delegation` *and* `plans` — over
  one shared `PlanSession`. Splitting it is a redesign, and `plans` stays in the engine anyway.
- **The tests could not follow.** 46 files / ~10,900 LOC touch spawn, supervision or delegation, and
  nearly all drive `executeRun`, so by the rule that governed every prior extraction they stay — the
  new package would be born near-empty against its own floor.

### The same obstacles, re-read against the tree (2026-08-22)

- **The bidirectional coupling is smaller but intact.** Re-measuring the nine subsystem files gives
  **41 named symbols across 17 engine modules** outward: `budget/budget.ts`, `capability-event.ts`,
  `context/{compaction-prompt,context-compaction,tool-spill}.ts`,
  `loop/{lifecycle-hooks,loop-contract,loop-shared,run-agent}.ts`,
  `support/{bounded,concurrency,signals}.ts`,
  `tools/{ask-user-tool,builtin/grants,mcp-registry,wire-names}.ts` and `usage.ts`. Three of the
  original targets — `plans/`, `plan/` and `run-shape.ts` — are no longer reached at all. Inward,
  **16 symbols across 8 modules**: `packages/loop/src/runtime/entry-seed.ts:3`,
  `run-shape.ts:8`, `tools/tool-effect.ts:14`, `entry-inputs.ts:40`/`:42`/`:45`/`:46`/`:47`,
  `open-tool-pool.ts:10`, `orchestrator.ts:20`, `vision-prepass.ts:8`, plus the package entry
  `packages/loop/src/lib.ts:44`. The direction of the edges is unchanged, so the package cycle is
  unchanged; only its width moved.
- **The eager configuration path is clear — this obstacle is gone.**
  `packages/loop/src/runtime/capabilities/settings-specs.ts:42-46` now imports
  `AGENTS_REQUEST_PARAMS`, `AGENTS_SETTINGS_FIELDS` and `agentsSettingsSpec` from
  `@clarvis/supervision`, whose owner is `packages/supervision/src/settings.ts:146`, `:157` and
  `:169`. `BUILTIN_SETTINGS_SPECS` at `settings-specs.ts:44` names none of the delegation modules.
  Nothing on the configuration path value-imports `capabilities/agents.ts` or
  `capabilities/delegation.ts` any more, so a hypothetical extraction would no longer drag the cycle
  onto the eager path. Do not re-derive this as a live obstacle.
- **`run-shape.ts` ↔ `spawn-shape.ts` stays fixed.** `packages/loop/src/runtime/spawn-shape.ts:6`
  carries `import type { RunShape } from "./run-shape.ts"`, and `run-shape.ts` imports nothing back;
  the surviving edge is one-way and type-only, so it is erased at emit.
- **`vision-prepass.ts` stays free of spawning.** The pre-pass is a single provider call at
  `packages/loop/src/runtime/vision-prepass.ts:146` (`await p.deps.llm.call({`). `runSubagent`
  exists in exactly two places in the tree, both inside the proposed boundary: its definition at
  `packages/loop/src/runtime/subagents/run-subagent.ts:148` and its one call at
  `packages/loop/src/runtime/subagents/delegate-task.ts:589`. The residual inward edge from the
  pre-pass is a single text helper (`userText`, `vision-prepass.ts:8`).
- **`buildDelegationOrchestration` no longer exists — this obstacle is gone.** The planning move
  (commit `58bd33cc`, *move planning out of the engine and onto capability seams*) split it. What
  remains is `buildDelegationContribution` at `packages/loop/src/runtime/delegation.ts:218`,
  returning one contribution; `PlanSession` and `planProjection` are exported from
  `packages/plan/src/capability/index.ts:54` and `:55`. `packages/loop/src/runtime/capabilities/plans.ts`
  is deleted, and `packages/loop/src/runtime/execute-run.ts` contains no occurrence of `plan` at all.
  The premise "`plans` stays in the engine anyway" is now false: planning took exactly the shape this
  extraction could not, reaching the loop only through `@clarvis/capability`
  (`packages/plan/src/capability/index.ts:10` states the entry must never import `@clarvis/loop`).
- **The test obstacle is unchanged, and re-measures to the same numbers.** 46 test files under
  `packages/loop/tests` name `delegate_task`, `runSubagent`, the capability constructors or the five
  `agent_*` tools, totalling **10,495 LOC**; 33 of them reach `executeRun` directly or through
  `packages/loop/tests/integration/_helpers.ts:197`. The original 46 files / ~10,900 LOC holds.

### What a real extraction would still cost

The 26-field delegation assembly is now **20 fields** — `DelegationCapabilityDeps` at
`packages/loop/src/runtime/capabilities/delegation.ts:39`, supplied in full at
`packages/loop/src/runtime/entry-inputs.ts:176`. Moving it to the kernel is still its own work, and
so is separating "the engine can run a nested agent" from "the `delegate_task` tool". Neither is
scheduled.

Two things did come out of this analysis rather than nothing: `@clarvis/supervision` (which took the
registry, the `agents` settings block and the `run-shape`/`spawn-shape` knot) and the delegation↔tracker
decoupling — `TASK_TRACKING_PORT`, resolved off the run's service registry at
`packages/loop/src/runtime/capabilities/delegation.ts:25` and `:109`, so the engine never names the
package that tracks its tasks. The five supervision tools stayed in the engine deliberately: they are
policy over substrate and read only four engine modules
(`packages/loop/src/runtime/capabilities/agents.ts:14`, `:21`, `:29`, `:40`).

---

## Layout decisions that were tried and reverted

Both reverts still hold as of 2026-08-22. What moved is where the guards live and what the second
half's supporting prose is allowed to cite, not what either revert prevents.

### A `config/` layer under `~/.clarvis`

It read well as a lifetime split but made the global tree disagree with the workspace one, where
`<ws>/.clarvis/settings.json` and `<ws>/.clarvis/agents/` have always sat at the root.

The two trees still agree, and neither carries a `config/` segment: `globalPaths`
(`packages/paths/src/global.ts:103`) puts `settings.json` at `:110` and `agents/` at `:105`/`:111`
directly under the global root, exactly as `workspacePaths` (`packages/paths/src/workspace.ts:100`)
puts them at `:108` and `:103`/`:109` directly under `<ws>/.clarvis`.

It also broke `bun run smoke` for four days without naming itself: the fixture seeded the old shape,
the artifact booted to a fleet-less header, and the failure surfaced as a 90-second timeout.
_(That is a CI observation and is **unverifiable** by reading source — the four days and the
90-second timeout cannot be re-measured. What can be checked is that both repairs are still in the
tree, and they are.)_

- The fixture builds its HOME from `globalPaths()` instead of string joins. It has since moved out
  of `packages/code/tooling/artifact/smoke.ts` into `makeCleanHome`
  (`packages/code/tooling/artifact/pty.ts:273`), which resolves the layout with
  `globalPaths(undefined, { home })` at `:275` and writes only `paths.settingsFile`. The entry script
  still exists — root `package.json:69` → `packages/code/package.json:19` — and reaches the layout
  the same way (`packages/code/tooling/artifact/smoke.ts:132`).
- `packages/paths/tests/architecture/invariant.test.ts` scans package `tooling/` as well as `src/` —
  restricting it to `src/` is what let the drift through. The two globs are at `:51`, and the TSDoc
  above them at `:40` still names the artifact smoke and the 90-second timeout as the reason the
  second glob exists.

### A mid-run open-task nudge

Specified and rejected, and still not implemented. The pending-task gate is a `FinalizeGate` only:
`pendingGate` at `packages/plan/src/capability/orchestration.ts:531`, over `pendingTaskGate` at
`:465`, registered in the contribution's `gates` array at `:721` and nowhere else. The engine runs
gates at exactly two points in `packages/loop/src/runtime/loop/run-agent.ts` — the `submit_result`
handler (`:381`, `runGates` at `:392`) and the contract-less text-only path (`onTextOnly` at `:583`,
`runGates` at `:612`, reached only after the `if (contract)` branch has returned). So a run cancelled
mid-flight is never asked about its open tasks: cancellation returns `cancelledResult()` directly
(`:176`, used at `:191` and `:253`) without touching a gate. And nothing marks a task `in_progress`
when the lead does the work itself rather than delegating it — the sole automatic writer is
`markSpawned` (`packages/plan/src/capability/delegation-port.ts:41`), reachable only through
delegation.

The plans capability does contribute a `beforeIteration` hook
(`packages/plan/src/capability/orchestration.ts:732`), which is the obvious place such a nudge would
land. It only resets the per-iteration flags and republishes the plan as canonical context. It does
not nudge.

Adding a per-iteration nudge was rejected because `PENDING_TASKS_NOTE` opens with "Do NOT finalize
yet" and asks for "a short result", so a model that is mid-implementation either ignores it or
complies by **inventing a verification result** — into what this repository calls the auditable
record, and against the agents' own honesty rules. Both quoted strings are still in the note
(`packages/plan/src/capability/messages.ts:162`, the two phrases at `:164` and `:165`).

The honesty rules have been renamed since this was written: there is no `<honesty_policy>` section in
the shipped fleet any more — the string "honesty" does not appear anywhere under `packages/` — and
the prohibition now lives in the `<report>` and `<never>` blocks. "Never claim a path, symbol, output
or result you did not observe" is `packages/kernel/src/config/builtin-agents/coder.ts:149`, and
"Report an edit that did not happen, or a test or build that did not run" is `coder.ts:169` and
`packages/kernel/src/config/builtin-agents/marshall.ts:308` (its `<never>` block opens at `:304`).
The argument is unchanged; only the tag the old text cited is gone.

If it is ever added it must read _close the task or state why you cannot_, never _mark it done_, and
must not fire while the agent is still producing file writes.

---
