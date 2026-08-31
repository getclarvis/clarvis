# Transcript publication, physical viewport and visual stability

> Implemented by `packages/code/src/adapters/{store,transcript-publication}.ts`,
> `packages/code/src/run-host.ts`,
> `packages/code/src/views/history/CommittedHistory.tsx`,
> `packages/code/src/views/history/TranscriptScrollBox.ts`,
> `packages/code/src/views/history/physical-window.ts`,
> `packages/code/src/views/live/LiveTranscriptTail.tsx`,
> `packages/code/src/views/app/TranscriptRegion.tsx` and
> `packages/code/src/ui/patterns/stable-syntax.tsx`. Production-shaped renderer regressions live in
> `packages/code/tests/integration/transcript-publication-render.test.tsx`; pure publication,
> physical-window and replay contracts live in
> `packages/code/tests/unit/{transcript-publication,transcript-physical-window}.test.ts`; exact
> pre-paint ScrollBox correction is covered by
> `packages/code/tests/integration/transcript-scrollbox-render.test.tsx`.

---

## 1. Purpose

This document owns the transcript's **publication lifecycle and physical viewport**: which state may
still change, when one semantic artifact becomes immutable, how its actual terminal-row geometry is
measured, and which owners may remain mounted. Clarvis separates an immutable committed history from
a mutable live frontier. Background work may append after history, but cannot patch, move, hide,
reparse or remount a committed artifact that remains in the current physical window.

The physical window is row-driven. A node count, source-character count, estimated renderable cost or
turn count may protect an abuse boundary, but none may decide the ordinary viewport. Only geometry
observed from a settled OpenTUI renderable in the current layout epoch can become a physical marker.
Unknown history has a load boundary, never a guessed spacer.

Explicit presentation actions remain distinct from background mutation. Scrolling across a lazy-load
boundary, folding, opening detail, selecting a sub-agent, changing ASCII mode, opening/closing the
Sidebar and resizing the terminal may change which immutable owners are mounted or invalidate their
geometry. The first live Plan, first workflow leader and first delegation each own one independent,
execution-scoped automatic Sidebar reveal with the same anchor requirement. Repeated events for the
same section cannot flap the layout after an explicit close; the first event for another section may
still reopen and reorient the combined Sidebar. Escape makes only that repeated automatic intent
sticky: `/activity [plan|workflow|agents]` can explicitly reopen any available section. The bounded
footer pointer remains for agent/workflow activity, while Plan never contributes footer text. Those
actions prepare replacement owners before visibility and preserve a physical anchor; ordinary later
run, tool, workflow and memory updates do neither. Typed delegation creation and
settlement may append their own new frozen Lead markers, but never mutate or reposition an existing
owner.

This document does **not** own:

- one node's appearance, Markdown segmentation, tool renderer, display cap or fold affordance —
  [code-transcript.md](code-transcript.md);
- run-event mapping, persistence or transport order — [kernel-runs.md](kernel-runs.md);
- live-handle, status-line and session ownership — [code-run-host.md](code-run-host.md);
- persisted-turn reconstruction — [sessions.md](sessions.md);
- startup and process-memory budgets — [code-performance.md](code-performance.md).

The split is load-bearing: [code-transcript.md](code-transcript.md) answers **how one snapshot
renders**; this document answers **when that snapshot is publishable, where it may move, and how much
of it may stay physically resident**.

The visible transcript is one chronological surface. Frozen owners, the mutable tail and its fixed
physical reading runway share the same OpenTUI ScrollBox; semantic publication changes ownership,
not screen position. A separate fixed-height **transcript** panel or a second internal scroll area is
not valid. Transient Lead phase is deliberately not transcript content: one composer-owned activity
band immediately above the input shows `LeadActivityLine` as `thinking`, `working` or settled
`ready`; during a run it also owns elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt. Slash
autocomplete replaces that complete activity band while open. The canonical footer separately keeps
Context plus cumulative Session token totals, cache-hit percentage and cost before and after
settlement, without `Running` or iteration. Neither band can scroll, publish or resize history. The
runway is three rows in the normal height band and one row at 28 rows or below; live state cannot
change it. The transcript surface is Lead-only by default.
Detailed sub-agent semantics remain retained but have no owner
in the main flow; each delegation contributes only one friendly frozen `spawned` marker and one later
friendly frozen `completed`/`failed` marker there. Explicit Sidebar selection replaces the projection
with one child's isolated transcript. The first child opens the responsive Agents surface once per
run without changing that Lead selection; explicit close is sticky until the run context changes.
Workflow progress has no transcript owner in either projection and stays in the footer activity
strip or Sidebar; its first leader may reveal that surface once for its execution. Running and
settled assistant prose share one static bullet; spinner animation remains in the activity line and
running tool rows.

## 2. Surface

Publication and physical markers are internal Code contracts, not public workspace-package APIs.

| Surface                                                              | Responsibility                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRANSCRIPT_EVENT_POLICY`                                            | compile-time-exhaustive disposition of every `RunEvent["type"]`                                                                                           |
| `TranscriptPublisher`                                                | turns terminal semantic candidates into ordered immutable publication batches                                                                             |
| `snapshotTranscriptNode`                                             | deep-freezes the bounded inline projection; raw/live payload fields do not cross the boundary                                                             |
| `TranscriptPublicationBatch`                                         | frozen semantic nodes, folds, groups, sub-agent headers and monotonic publication phase; retention does not imply main-transcript visibility              |
| `TranscriptRunSink.complete`                                         | host signal that stored reconciliation finished or definitively degraded                                                                                  |
| `TranscriptStore.publicationBatches`                                 | resident semantic batches; independent from renderer residency                                                                                            |
| `TranscriptStore.frontierNodes`                                      | mutable semantic nodes whose keys are not committed                                                                                                       |
| `TranscriptPhysicalMarker`                                           | measured `{ batchId, layoutEpoch, columns, foldRevision, rows }` fact                                                                                     |
| `TranscriptPhysicalWindow`                                           | contiguous measured batch range plus exact before/after spacers and unknown boundaries                                                                    |
| `createPhysicalWindowController`                                     | observes viewport rows/scroll position, serializes measurement and preserves anchors                                                                      |
| `CommittedHistoryPublicationStore`                                   | narrow history port exposing frozen batches only                                                                                                          |
| `CommittedHistory`                                                   | direct-child OpenTUI `ScrollBox` owner and physical-window adapter                                                                                        |
| `SyntaxPublicationBoundary`                                          | waits for descendant syntax work and confirming renderer frames; recovery can retain the same semantic renderers while no longer waiting for highlighting |
| `TRANSCRIPT_MEASUREMENT_LEASE_MS` / `TRANSCRIPT_MEASUREMENT_RETRIES` | bound one candidate to a 2-second lease and one fresh syntax subtree                                                                                      |
| `TRANSCRIPT_SCROLLBAR_COLUMNS`                                       | reserves one vertical-scrollbar column in every history layout                                                                                            |
| `transcript.syntax.*` / `transcript.measurement.*` diagnostics       | explain registration, frame, dimension, lease, fallback and marker-acceptance timing in debug sessions                                                    |
| `LiveTranscriptTail`                                                 | content-height mutable tail and view-local live-to-committed handoff rendered as the final child of the history ScrollBox                                 |
| `transcriptReadingRunwayRows`                                        | chooses the fixed three-row normal or one-row compact physical runway from terminal height only                                                           |
| `LeadActivityLine`                                                   | persistent one-row `thinking`/`working`/`ready` owner immediately above the composer and outside history                                                  |
| `TranscriptScrollBoxRenderable`                                      | native OpenTUI ScrollBox extension that preserves ordinary wheel/trackpad scrolling and reports edge intent for lazy admission                            |

`App` builds view state from committed semantic nodes with `preserveOrder: true`, then chooses the
Lead-only main projection or one selected child's projection before physical residency is decided by
`CommittedHistory`. Explicit detail separately reads `store.nodes`. A detail overlay may hydrate
current persisted data while the inline committed snapshot remains frozen.

## 3. Data and formats

### 3.1 Event policy

`TranscriptEventPolicy` contains three closed fields:

```ts
interface TranscriptEventPolicy {
  surface: "frontier" | "status";
  authority: "incremental" | "terminal" | "none";
  commit:
    | "delegation_terminal"
    | "iteration_terminal"
    | "never"
    | "point"
    | "run_terminal"
    | "tool_terminal";
}
```

`TRANSCRIPT_EVENT_POLICY satisfies Record<RunEvent["type"], TranscriptEventPolicy>`. A protocol
variant cannot be added without choosing its mutable owner, authority and publication trigger.

### 3.2 Publication batches

One `TranscriptPublicationBatch` has:

- a stable `id`, optional `executionId` and semantic `kind`;
- a frozen ordered `nodes` array;
- frozen `defaultFolded`, `toolGroups`, `sectionHeaders`, `sectionAnchors` and
  `sectionFoldedKeys` projections;
- compatibility fields `phase: "committed"` and `ready: true`.

Semantic members never change. A batch is semantically sealed as soon as it is appended; physical
measurement is not a store transition and cannot delay later semantic batches. The compatibility
fields remain until their consumers are removed, but no production path uses them as a physical
readiness signal. Tool snapshots contain the bounded result of
`projectTranscriptToolDisplay`, not raw arguments/results. `liveOutput`, `inputChars`, `dehydrated`
and `hydrationNotice` are absent rather than present with `undefined`. Sub-agent terminal artifacts
are reserved before mutable hydration retention can discard them.

### 3.3 Physical markers and layout epochs

One marker is a fact about one frozen batch in one layout:

```ts
interface TranscriptPhysicalMarker {
  readonly batchId: string;
  readonly layoutEpoch: number;
  readonly columns: number;
  readonly foldRevision: number;
  readonly rows: number;
}
```

`rows` is the positive integer height read from the batch's actual OpenTUI owner after:

1. every Markdown/diff/code descendant has settled or chosen its one stable fallback;
2. a renderer frame has applied the resulting Yoga layout;
3. a confirming frame observes the same owner width and height.

No production path constructs `rows` from source lines, character length, node kind, historical
averages or a renderable estimate. Marker order plus row sums derive local `startRow`/`endRow`; an
absolute terminal coordinate is not persisted because scrolling translates the content.

A layout epoch includes the actual content width and glyph regime. `CommittedHistory` permanently
reserves the ScrollBox's one-column vertical-bar gutter; overflow changes only the bar's opacity and
cannot change content width. A terminal-width/sidebar/ASCII change starts a new epoch and drops the
old marker index. Terminal-height-only changes retain markers and change the row window. A
fold/expand change invalidates only the affected batch through `foldRevision`. Theme colour changes
do not invalidate geometry.

Only the current epoch is indexed. This keeps marker metadata linear in resident semantic batches,
not in the number of terminal resizes seen during the process.

### 3.4 Monotonic lifecycle

```text
mutable semantic candidate
          |
          v
frozen and semantically committed batch
          |
          | viewport admission
          v
hidden physical candidate -- syntax + two equal observations --> physical marker
                                                               |
                                                               v
                                                visible direct child
                                                               |
                                    explicit viewport exit only v
                                                 disposed owner + retained marker
```

Thinking placeholders, retry countdowns, composing arguments, pending elicitation and live
plan/workflow progress never enter a publication batch. There is no semantic transition out of
`committed`; only renderer residency changes.

### 3.5 Physical bounds

| Bound                        |                             Current value | Production symbol                                                                   |
| ---------------------------- | ----------------------------------------: | ----------------------------------------------------------------------------------- |
| same-tool staging latency    |                                     80 ms | `TRANSCRIPT_TOOL_GROUP_LATENCY_MS`                                                  |
| same-tool staging pressure   |                          8 terminal calls | `TRANSCRIPT_TOOL_GROUP_MAX_ENTRIES`                                                 |
| directional prepared runway  |   two current viewports ahead, one behind | `TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS = 2`, `TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS = 1` |
| measurement concurrency      |                           one batch owner | `TRANSCRIPT_MEASURE_CONCURRENCY = 1`                                                |
| syntax measurement lease     |                                 2 seconds | `TRANSCRIPT_MEASUREMENT_LEASE_MS = 2_000`                                           |
| syntax subtree retries       | one, then syntax-frozen semantic renderer | `TRANSCRIPT_MEASUREMENT_RETRIES = 1`                                                |
| reserved vertical-bar gutter |                                one column | `TRANSCRIPT_SCROLLBAR_COLUMNS = 1`                                                  |
| semantic resident history    |    20 turns plus one folded-prefix notice | `RESIDENT_TRANSCRIPT_TURN_LIMIT`                                                    |

With viewport height `V = max(1, scrollbox.viewport.height)`, an ordinary mounted target covers the
visible interval plus `2V` measured rows in the last scroll direction and `V` behind it. Whole-batch
selection may overhang either runway edge by its boundary batch; existing per-node display ceilings
remain the abuse bound. Unknown ranges and exact spacers each cost one lightweight direct child.
During a transition, only the current window and one serial measurement candidate may coexist.

### 3.6 OpenTUI component choice

Clarvis stays in OpenTUI's `alternate-screen` mode. Its history supports application-owned folding,
focus, click-to-open detail, selection, sidebar composition and full-region overlays. The upstream
`split-footer` plus `ScrollbackSurface` path is appropriate when output becomes non-interactive
terminal scrollback; revising those rows requires a destructive clear/replay and they are no longer
application renderables. Moving the primary transcript there would change the product contract, not
merely optimize it.

The full-screen implementation follows the supported components instead:

- Settled `ScrollBox` history keeps `viewportCulling: true`, and each resident publication batch is
  one **direct content child**. OpenTUI culls direct children; a catch-all `history-page` child
  defeats that granularity. While the sole transparent measurement candidate is preparing, Clarvis
  temporarily disables culling because OpenTUI does not execute render hooks for culled children;
  the marker commit restores culling immediately. Physical-window disposal, not that temporary paint
  mode, remains the allocation bound.
- OpenTUI's `ScrollBarRenderable.visible` manual-control path pins the vertical bar to one layout
  column. Its opacity is zero without overflow and one with overflow. The indicator may therefore
  change, but adding a runway owner cannot create a 120-to-119-column epoch feedback loop.
- Clarvis owns disposal because OpenTUI culling skips offscreen render calls but does not unmount
  Solid owners. There is no owner-disposing virtual-list component in the pinned OpenTUI 0.5.9 API.
- Mutable assistant Markdown uses OpenTUI `MarkdownRenderable` with `streaming: true` and
  `internalBlockMode: "top-level"`. Final frozen snapshots use `streaming: false` and the default
  coalesced block mode, as recommended for non-streaming Markdown.
- Diffs and code continue to use OpenTUI's native syntax renderables; Clarvis does not introduce a
  second Markdown or diff parser.

## 4. Behavior

### 4.1 Exhaustive event disposition

| Event type(s)                                                                                                              | Mutable/status behavior                                                                                                    | Publication trigger                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `run_started`                                                                                                              | initialize live run identity                                                                                               | none                                                                                                                             |
| `iteration_started`                                                                                                        | fixed Lead activity line becomes `thinking`; proves preceding unphased answer was commentary                               | preceding answer becomes an iteration batch                                                                                      |
| `text_delta`                                                                                                               | patch assistant frontier candidate                                                                                         | never directly                                                                                                                   |
| `reasoning`                                                                                                                | patch settled iteration reasoning candidate                                                                                | with `iteration_completed`                                                                                                       |
| `iteration_completed`                                                                                                      | replace streamed text with authoritative `response`                                                                        | commentary now; final/unphased answer follows §4.2                                                                               |
| `model_retry`                                                                                                              | retry status/countdown in the frontier                                                                                     | never                                                                                                                            |
| `model_error`                                                                                                              | terminal iteration error candidate                                                                                         | with iteration or final sweep                                                                                                    |
| `tool_input_delta`, `tool_call_started`, `tool_output_delta` for an admitted ordinary tool                                 | one mutable tool candidate/tail                                                                                            | never directly                                                                                                                   |
| `tool_call` for an admitted ordinary tool                                                                                  | reserve bounded terminal snapshot immediately                                                                              | after group closure                                                                                                              |
| any composing/started/output/terminal tool event for a Lead-owned supervision or workflow-orchestration identity           | suppress before frontier creation/staging                                                                                  | none; no transient or terminal Lead row                                                                                          |
| `delegation_created`                                                                                                       | register child semantics and Sidebar/footer state; the first delegation may open/reveal Agents once for this execution     | append one friendly frozen Lead-owned `spawned` marker                                                                           |
| `delegation_started`                                                                                                       | update child/Sidebar/footer running state                                                                                  | none; it cannot create or mutate a Lead marker                                                                                   |
| `delegation_completed`, `delegation_failed`                                                                                | close child activity and retain its terminal semantics                                                                     | append one separate friendly frozen Lead-owned `completed`/`failed` marker; freeze the child section for its isolated transcript |
| `workflow_run_started`, `workflow_title_updated`, `workflow_run_progress`, `workflow_run_completed`, `workflow_run_failed` | Sidebar or compact footer activity strip; the first projected leader may open/reveal Parallel work once for this execution | no history row                                                                                                                   |
| `plan_created`, `plan_updated`, `plan_removed`, `plan_review_requested`, `plan_review_resolved`                            | Sidebar, `Ctrl+P` and pending review; the first live Plan may open/reveal Plan once for this execution; no footer summary   | no mutable plan singleton in either transcript flow                                                                              |
| `soft_limit_check`                                                                                                         | terminal annotation candidate                                                                                              | append once                                                                                                                      |
| `compaction_started`                                                                                                       | status/frontier progress                                                                                                   | none                                                                                                                             |
| `compaction`, `compaction_skipped`, `vision_analysis`                                                                      | terminal annotation candidate                                                                                              | append once                                                                                                                      |
| `elicitation_requested`                                                                                                    | pending interaction in `LiveTranscriptTail`                                                                                | none                                                                                                                             |
| `elicitation_resolved`                                                                                                     | terminal question/outcome fact                                                                                             | append once when projected                                                                                                       |
| `steering_applied`                                                                                                         | settle pending steer                                                                                                       | append delivered outcome once                                                                                                    |
| `memory_ingest`                                                                                                            | status/footer only                                                                                                         | none                                                                                                                             |
| `capability_event`, `events_dropped`, `mcp_degraded`                                                                       | bounded immutable point/warning, except generic delegation/workflow capability mirrors, which are suppressed               | append once when eligible; no publication for either orchestration mirror                                                        |
| `run_ended`                                                                                                                | close frontier and start reconciliation holdback                                                                           | terminal batch only after `TranscriptRunSink.complete`                                                                           |

This policy does not redefine durability. `RUN_EVENT_POLICY` in the kernel still decides whether an
event is streamed, persisted or both.

The event table's `status/footer` wording does not put run lifecycle beside stable session figures.
During a run, `LeadActivityLine` owns phase, elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt; the
footer keeps Context plus cumulative Session token totals, cache-hit percentage and cost during the
run and retains them after settlement. The cache percentage is scoped to the same Run or Session
owner as its token totals and divides cached tokens by gross input, not by the already-net `In`
display.
Slash autocomplete replaces the activity line while its popup owns that band. Production:
`packages/code/src/views/App.tsx` (`leadActivityPhase`, `leadActivityDetail`, `inputPopupOpen`,
`footerRunStrip`) and `packages/code/src/features/run/status-presenter.ts` (`runStripText`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` (active-run metadata, autocomplete
replacement and Plan-free footer cases) and `packages/code/tests/unit/run-status.test.ts` (session
tokens, owner-scoped cache percentage and settlement continuity).

The tool-row exception is identity-closed: `spawn_subagent`, `delegate_task`, `agent_list`,
`agent_poll`, `agent_stop`, `agent_steer`, `await_agents`, `run_leader`, `run_workflow`, `run_round`,
`run_work_items`. It applies to every provider tool phase, including the quiet composing placeholder
that otherwise renders copy such as `Wait for agents starting…`. Suppression is presentation policy,
not loss of lifecycle: typed delegation events still append exactly the two frozen markers, workflow
events still update Sidebar/footer, ordinary Lead `thinking`/`working` remains visible in the fixed
composer-adjacent activity line, and
child-attributed tool/content nodes remain available only in the selected child's projection.

### 4.2 Ordering, answers and grouping

A lead `iteration_completed` with `response_phase: commentary` publishes with that iteration's
reasoning/error entries. A `final_answer` is held. An answer without phase remains undecided until a
following lead `iteration_started` proves it intermediate or `run_ended` proves it final.

After stored reconciliation (or definitive degradation), `completeRun` appends
`[held final answer, run outcome]` as one semantic batch. This is chronological and preserves the
already-painted answer row: the outcome appears after it. When admitted physically, both nodes share
one owner. No post-render movement touches committed history.

Grouping-eligible calls with the same exact `(mcpName, toolName)` pair wait at most 80 ms from the
first candidate and at most eight terminal entries. A different server, different tool, mutation,
non-tool boundary, sub-agent terminal event or run close flushes staging. The same pair comparison
governs live staging, terminal sweep and frozen sub-agent batch metadata; a leaf-only renderer lookup
identity never groups calls across MCP servers. Frozen `solo`/`head`/`member` metadata never changes.
Semantic sub-agent sections append in terminal completion order and are visible only in the matching
isolated transcript; spawn-order navigation remains a Sidebar concern.

### 4.3 Syntax settlement and physical measurement

A newly admitted batch mounts as the one hidden measurement candidate at the current content width.
It is outside ordinary flow and parked one row beyond the ScrollBox's clipped viewport, so neither
the owner nor a descendant enters OpenTUI's hit grid. Candidate admission temporarily suspends
`viewportCulling`: OpenTUI explicitly skips render hooks for culled children, while syntax settlement
depends on those hooks even when the candidate is outside the viewport or part of a tall batch
extends beyond it. `SyntaxPublicationBoundary` waits for every native syntax descendant and then
confirms equal physical dimensions across two completed frames. The accepted marker removes the
candidate and re-enables culling in the same physical publication cycle. A handoff prepaint may use
the live tail's chronological row for its confirming frame, but every `BlockView` action remains
disabled and the owner consumes residual pointer bubbling until physical admission makes it active.

Every awaited frame is self-scheduled. OpenTUI's one-shot `CliRenderer` releases its
`updateScheduled` latch in the async continuation after emitting `frame`; a promise resumed by that
event runs first. Clarvis therefore defers the following `requestRender()` by one microtask, after
the renderer releases the latch. Syntax and equal-dimension confirmation must settle without input,
animation, heartbeat or the recovery lease producing an unrelated invalidation.

Each syntax preparation owns a 2-second lease. One expiry remounts one fresh hidden syntax subtree.
On the next expiry, a never-published candidate remounts the same `BlockView`/Markdown/diff/code
presentation, disables parser work through the native renderers' public `filetype` setters and stops
waiting for highlighting. The ordinary equal-dimension measurement then commits it. This recovery
never substitutes a text dump or warning for tool arguments, so a `write_memory`/`write_file` body
and a diff remain present even when Tree-sitter does not settle. An owner that has already painted
takes the stricter path: it retains the exact owner and syntax-renderable identities, waits for the
public `highlightingDone` contract and then observes two equal positive dimensions. If highlighting
stays pending, the already-visible owner stays unchanged and visible; it is not remounted or
replaced to advance measurement.

That recovery choice is monotonic per publication batch. `CommittedHistory` retains `rich` or
`plain-semantic` by batch id across physical eviction/remount, so a parser-independent publication
cannot later return highlighted and alternate styles. The policy map is purged whenever its batch
leaves `publicationBatches`; virtualization therefore does not turn this identity rule into
turn-count memory growth.

Measurement revisions have an explicit observed-state bit. `number -> undefined -> number` is a
normal candidate lifecycle, not an uninitialized sentinel cycle; the second number always resets a
completed boundary and starts a new measurement. No parser promise, inactive gap or recovery lease
can therefore leave a later layout epoch waiting on a boundary that still considers itself complete.

The controller records the marker before making the owner visible. The same successful owner then
enters the resident relative flow; first publication does not construct a second visible
Markdown/diff tree. A parser failure chooses one readable fallback and never alternates it later.

A geometry-epoch replacement is deliberately different from first publication. The already-visible
owner and its syntax descendants remain the sole painted tree at their recorded presentation width.
At most one transparent, non-interactive geometry clone measures one resident batch at the target
width. Its marker is staged outside the painted ledger, the clone is discarded after that observation
or cancellation, and the next resident is measured serially. The visible owner never receives the
replacement measurement token and therefore cannot restart Markdown, diff or code parsing merely
because a Sidebar or terminal resize changed the available columns.

A batch remounted after explicit virtualization repeats hidden settlement because native owners were
disposed. The frozen semantic object and batch id remain identical; a current-epoch marker may size
its exact spacer, but cannot make the new owner visible before syntax settlement.

Intersecting one frozen source publication with the semantic projection is identity-stable. A weak,
two-entry LRU cache per source batch keys the projected owner by the exact included node-key
sequence. The bound corresponds to the permanently retained Lead plus at most one retained child.
An unrelated semantic append whose intersection is unchanged therefore returns the same projected
batch object and Solid cannot remount its physical owner; selecting a different child evicts the
previous child projection instead of extending the cache.

### 4.4 Direct-child physical window

The ScrollBox's flow geometry has only this ordered shape:

```text
earlier unknown boundary?     one passive row above history; no estimated height
exact before spacer?          sum of painted physical markers
resident relative owners      one direct child per active marker, in chronological flow
exact after spacer?           sum of painted physical markers
mutable transcript tail?      content-height final child in chronological flow
```

An unmeasured newer range is never inserted as a row below the active history. If the user has
explicitly left the tail, its count may appear only as a non-interactive overlay at the **top** of
the viewport; downward scroll admits it. While tail-following is active, each append is admitted
serially until `laterUnknown === 0`, independent of a transient pre-layout `scrollHeight` sample.
The normal followed-tail state therefore has no newer-range label at all.

Every resident publication owner is a direct, relative content child in chronological order between
the exact before and after spacers. Its observed marker height is the corresponding contribution to
that native flow; there is no synthetic active-extent placeholder. The ordinary serial measurement
candidate and the geometry-only replacement clone are absolute direct children parked just beyond
the clipped viewport, never participants in flow or hit testing. Marker order remains authoritative
for spacer sums and virtualization boundaries, while OpenTUI's relative layout owns the resident
sequence without hand-maintained absolute row coordinates.

There is no `history-page` wrapper. With no candidate pending, `viewportCulling` therefore skips paint
for offscreen batch children, while `createPhysicalWindowController` removes owners outside the
directional runway.
During the one-candidate preparation interval culling is suspended, but mounted ownership remains the
same bounded resident window plus that one candidate. Grouping metadata belongs to publication
batches, so cutting the renderer window cannot create a dangling group head or sub-agent section
anchor.

Only ranges with current-epoch markers participate in continuous scroll geometry. Reaching an
unknown boundary serially measures adjacent batches and replaces the one-row boundary with exact
rows. `TranscriptScrollBoxRenderable`, registered through OpenTUI Solid's supported component
catalogue extension, lets OpenTUI process vertical wheel and trackpad packets normally, then reports
every vertical intent so the controller reverses and replenishes the `2V` forward runway before the
reader reaches an edge. It never cancels native
scroll, converts a wheel gesture into a page jump or requires pointer activation of boundary copy.
Keyboard Page Up/Down uses the same admission ledger. Fast repeated input coalesces while another
candidate settles and cannot expose an empty or partially prepared owner.

### 4.5 Scrolling, anchors and append behavior

The controller samples `scrollTop`, `scrollHeight` and `viewport.height` after successful renderer
frames, coalescing unchanged observations. The vertical gutter is already reserved, so scrollbar
overflow cannot alter the sampled content width. A directional-runway shortage schedules at most one
measurement globally; it does not rebuild the publication graph on every wheel packet. Explicit navigation
changes the viewport only after that candidate owns an accepted marker; repeated requests retain the
current prepared cells and one pending direction.

The directional runway is half-open. A measured spacer batch whose trailing or leading edge merely
touches its `2V`-ahead or `V`-behind boundary is not remounted. Trimming and admission therefore use
the same strict edge rule:
one unchanged viewport observation reaches a fixed point and cannot alternate a known owner between
mounted and spacer form. Background frame observations after settlement perform no physical work.

The anchor is the first visible batch id plus the physical row offset inside it. Prepending or
evicting exact measured rows registers the equal integer `scrollTop` correction on
`TranscriptScrollBoxRenderable` **before** publishing the changed children. Its supported
`onUpdate` lifecycle consumes the part admitted by the current range; the chained public
`content.onSizeChange` callback consumes any oversized remainder after OpenTUI recalculates the new
scroll range. The physical ledger advances by that same accepted delta, so the following observation
cannot misclassify the internal correction as reversed user intent. The first frame containing the
new owner therefore already has the old anchor on the same terminal row, column and styled cells.

Width, Sidebar and glyph changes start a replacement epoch without publishing it. Resident owners
retain their painted markers and effective widths while one hidden geometry clone at a time builds a
complete target-width marker ledger. Only after every resident marker exists does one publication
replace the ledger and owner widths together and queue the exact reader-anchor correction before
paint. Every intermediate frame therefore retains the old row, column, colors and attributes; the
final frame exposes the new geometry with the same anchored cells. The original owners and syntax
descendants retain identity throughout. The measurement clone limit is one, the previous clone is
disposed before the next can accumulate, and deactivating the full projection cancels only that
clone; reactivation resumes the same staged epoch. Height-only resize retains the current ledger.

Tail-following is an explicit user-intent state, not an inference from one stale `scrollHeight`
sample. It begins enabled, is disabled by upward wheel/trackpad, Page Up or an explicit older reveal,
and re-enables only when downward navigation reaches the newest edge. While enabled, every new
committed batch is measured and appended and the ScrollBox remains at bottom. While the user reads
older history, newer batches may accumulate semantically without pulling the anchor; downward scroll
loads them in order and restores tail-following at the newest edge.

The first upward wheel/trackpad intent changes the runway direction and begins adjacent earlier
admission whenever less than `2V` is prepared, rather than waiting for the prepared start to become
visible. After an admitted owner's exact height is known, the controller prepends it and applies the equal positive
`scrollTop` delta, keeping the old first visible cell fixed; the user's next native scroll naturally
enters those rows. Downward input follows the symmetric path. Boundary copy is passive status, not a
button, and scrolling remains the complete interaction on macOS, Linux and Windows.

Session reconstruction may append its retained turns in several synchronous publication batches
before the first hidden owner can finish a frame. While the initial range is still empty and no
explicit reveal/navigation is pending, each append replaces that pending initial target with the
newest batch. The first accepted marker therefore anchors the reconstructed tail; obsolete initial
candidates are never measured serially from the oldest retained turn. Once any owner commits, normal
sticky-tail and reader-anchor rules above apply.

### 4.6 Continuous mutable tail and ownership handoff

`TranscriptRegion` owns:

```text
CommittedHistory ScrollBox
  frozen measured owners in chronological order
  LiveTranscriptTail as its content-height final child
    fixed physical reading runway as the tail's final child
composer activity band outside history
  LeadActivityLine, or slash autocomplete while its popup is open
InputDock/footer below the activity band
```

There is no nested live scrollbox, fixed **transcript-panel** reservation or top border. In the main
view, Lead streaming text, composing admitted ordinary Lead tools, retries, pending steer/elicitation
and memory pressure occupy only their natural content height after the last frozen owner. Lead
`thinking` is filtered from that tail; `LeadActivityLine` is the only physical owner of transient
Lead phase and reuses its one row through `thinking`, `working` and settled `ready`. While the run is
active, elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt share that row. Slash autocomplete removes
the line and exclusively occupies the same band instead of stacking another status row. Plan nodes
are also filtered: the Sidebar and `Ctrl+P` surface own plan activity, with no Plan footer summary.
Child frontier nodes are filtered out there; selecting a child instead gives that isolated
projection its own matching mutable tail. Provider tool phases for Lead-owned
supervision/delegation/workflow orchestration are filtered before this tail; workflow leaders never
enter either tail.
When one frontier artifact in the active projection commits, `LiveTranscriptTail` retains its frozen
handoff snapshot until the measured committed owner is visible at the same flow offset; the swap
cannot create an empty frame, duplicate row or vertical jump. Later mutable content in that same
projection remains after the handoff throughout the swap.

The tail always ends with `transcript-reading-runway`: three physical rows normally and one row only
at terminal height ≤28. Its height depends solely on the height band, never on streaming or activity,
so new content remains visibly separated from the composer without being pushed upward when phase
changes. Loading or activity affordances added later must remain content-height children before that
runway, live in Sidebar/footer, or reuse the fixed activity line; they cannot insert above an already
rendered transcript row, create another independently scrolling transcript surface or resize a lower
Plan pane. In-progress sub-agent state and every workflow lifecycle indicator belong to the footer
strip/Sidebar. Delegation lifecycle has only the two frozen Lead markers defined above; it has no live
marker in the Lead tail.

A streaming assistant tail may change its native Markdown height when OpenTUI recognizes and
conceals a trailing delimiter. `StableMarkdown` therefore retains a row-height high-water mark for
the current `geometryEpoch`: the tail may grow but cannot give rows back and pull an earlier reader
anchor downward. A new epoch clears the floor. Parsing, concealment and native formatting remain
enabled, including bold attributes. Production: `StableMarkdown` (`liveHeightFloor`) and
`AssistantMarkdown` (`geometryEpoch`). Test:
`packages/code/tests/integration/transcript-scrollbox-render.test.tsx` ("bottom-following streaming
Markdown never gives rows back when parsing conceals syntax").

The Sidebar is outside this flow. Its first live Plan, first workflow leader and first delegation
establish three independent execution-scoped automatic intents. Each opens the same responsive
surface and reveals its own `Plan`, `Parallel work` or `Agents` section while
`createLayoutController.secondaryMode` chooses a wide split or compact drawer. The Agents intent
keeps `Lead transcript` selected and `ActivityDetail` closed. Escape or scrim close is sticky for the
intent that most recently opened the surface, so repeated updates of that kind cannot reopen or
renarrow history; the first event for a different section remains eligible and may reopen/reorient
the Sidebar. That stickiness applies only to automatic reveals: `/activity`, `/activity plan`,
`/activity workflow` and `/activity agents` explicitly reopen available sections. A new execution
resets each intent independently. The outer Sidebar ScrollBox reveals
the whole section owner with `scrollChildIntoView`, so a long Plan cannot leave a later workflow or
Agents section clipped below the viewport. A typed delegation create/settle event may also append its
new frozen marker at the chronological tail; it cannot patch an earlier marker. Clicking the footer
strip remains an explicit reopen route when agent/workflow activity makes that strip present; Plan
has no footer pointer and uses `/activity plan` or `Ctrl+P`. Production:
`packages/code/src/views/App.tsx` (`visiblePlanContext`, `visibleSubagentContext`, `requestAutomaticSidebar`,
`closeActivitySidebar`, `openActivitySidebar`, the `activity.open` command,
`compactActivityStrip`, `Footer.onRunStripMouseDown`,
`dismissTopOverlay`), `packages/code/src/views/Sidebar.tsx` (`SidebarRevealIntent`, `Sidebar`) and
`packages/code/src/app/layout.ts` (`createLayoutController`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` (independent Plan/workflow/Agents
auto-reveals, `/activity` reopening, long-Plan section reveal, sticky per-intent close, Lead
preservation, isolated child selection and narrow drawer Escape) and
`packages/code/tests/unit/layout.test.ts` (responsive intent cases).

### 4.7 Reconciliation, replay and degradation

Live and replay events pass through `TranscriptPublisher.observe`. A live-reserved key is never
reopened; trace-only keys use the same trigger and batch builder. Replay reconstructs iteration
boundaries, tool groups and sub-agent completion order rather than applying a generic end sweep.
This preserves child semantics for explicit isolated selection; it does not make them eligible for
the Lead projection.

`runManaged` releases interactive ownership, reads the stored run, reconciles the semantic sink and
then calls `TranscriptRunSink.complete`. A read/settlement failure adds one explicit degraded
annotation. Session resume brackets stored events with `beginReconcile`/`endReconcile` and calls
`complete`. Physical markers are never persisted or replayed; they are remeasured for the current
terminal.

### 4.8 Retention and detail hydration

Mutable raw tool bodies may dehydrate/rehydrate for detail. Publication reserves its bounded snapshot
at terminal `tool_call`, before hydration retention runs, so detail reads cannot patch history.

At the explicit 20-turn host boundary, `foldPrefixBefore` removes complete semantic publication
batches and prepends one frozen notice. The physical controller removes their markers and owners in
the same update while preserving the current anchor when it survives. `/export` reconstructs evicted
turns from persistence, never from renderer owners or physical markers.

The publisher's `knownKeys` set is a resident identity ledger, not a process-lifetime tombstone
list. `foldPrefixBefore` first retains every publication that still owns a non-discarded node and
replaces any older folded-prefix publication with one new frozen
`transcript:folded-prefix` batch. It then calls `TranscriptPublisher.forgetDiscarded` only for
removed keys no retained publication still references. That release rechecks semantic residency,
cancels discarded tool staging and clears discarded held-answer/sub-agent reservations before it
deletes a key. A later scheduler flush therefore cannot resurrect folded content, and repeated
20-turn folds keep semantic nodes, publication batches and `knownKeys` at a plateau. Production:
`packages/code/src/adapters/store.ts` (`foldPrefixBefore`) and
`packages/code/src/adapters/transcript-publication.ts` (`forgetDiscarded`, `knownKeyCount`). Tests:
`packages/code/tests/unit/transcript-publication.test.ts` ("discard release keeps resident
identities and forgets only removed publication keys" and "retention cancels discarded staging and
cannot resurrect it on a later scheduler flush") and
`packages/code/tests/unit/store-status.test.ts` ("repeated 20-turn retention folds keep semantic and
publication ledgers at a plateau").

## 5. Invariants

**INV-TP01.** During ordinary live/replay processing, every previous committed-node array is an
identity-preserving prefix of the next, independent of physical measurement. Production:
`TranscriptPublisher` (`#knownKeys`, `#reserve`, `#appendReserved`) and `createTranscriptStore`
(`committedNodes`). Test:
`transcript-publication.test.ts` (identity-prefix cases, including generated mixed streams).

**INV-TP02.** Event disposition is compile-time exhaustive over `RunEvent["type"]`. Production:
`TRANSCRIPT_EVENT_POLICY`. Test: `@clarvis/code` typecheck through its
`satisfies Record<...>` assignment.

**INV-TP03.** A reserved node and retained nested display values are frozen and cannot be patched by
replay, semantic dehydration or detail hydration. Production: `snapshotTranscriptNode`,
`TranscriptPublisher.#reserve`. Test: `transcript-publication.test.ts` (replay, dehydration,
sub-agent, hydration and bounded-projection cases).

**INV-TP04.** A batch is never visible before syntax settlement and two equal physical observations;
its marker height equals its real owner height in that frame. An ordinary hidden candidate is outside
the clipped hit grid, and no inactive handoff owner can invoke a block action. Production:
`SyntaxPublicationBoundary`, `PhysicalPublicationOwner`, `BlockView`. Tests:
`transcript-publication-render.test.tsx` (Markdown, diff and memory tool first-publication frames) and
`transcript-window-render.test.tsx` (candidate hit-test and pointer-input exclusion).

**INV-TP05.** Ordinary live activity cannot alter cells, owner identity, physical marker or
chronological content row of any visible committed batch. Following a growing tail may translate the
whole native viewport upward, exactly like ordinary transcript scroll, but cannot reflow an earlier
owner. Production: `CommittedHistory`, `LiveTranscriptTail`. Test:
`transcript-publication-render.test.tsx` (settled write-memory, diff and ordinary-write owners while
later Lead tools/text stream and child lifecycle changes remain outside those owners).

**INV-TP06.** Held final answer and run outcome commit atomically and in that order. The answer may
already be visible in the mutable handoff; its row cannot move, and no frame may show the terminal
outcome without it.
Production: `TranscriptPublisher.completeRun`, one terminal publication batch. Tests:
`transcript-publication.test.ts` and `transcript-publication-render.test.tsx`.

**INV-TP07.** Live plus reconciliation, replay-only reconstruction and session resume produce equal
semantic batches, including degradation and omission of live-only plan/workflow state. Production:
`TranscriptPublisher.observe`, `completeRun`, `loadSessionMeta`. Test:
`transcript-publication.test.ts` (replay equivalence).

**INV-TP08.** Normal window selection uses only current-epoch measured rows. Node count, characters,
turn count and `transcriptNodeRenderCost` cannot change a window when physical markers and viewport
are equal. Production: `createPhysicalWindowController`. Test:
`transcript-physical-window.test.ts` (metamorphic equal-marker cases).

**INV-TP09.** ScrollBox publication owners are direct content children; viewport culling is enabled
after settlement, suspended only while the single transparent candidate needs native render hooks,
and owners beyond the physical directional runway are disposed rather than merely hidden. Production:
`CommittedHistory`. Tests: `transcript-publication-render.test.tsx` (tree shape, candidate culling
transition, long terminal tail, lifecycle balance and bounded owners across scrolling).

**INV-TP10.** Prepending/evicting measured history preserves the first visible batch and row offset by
an exact `scrollTop` delta registered before child publication and fully consumed before the first
new frame, including a remainder that exceeds the old scroll range. Unknown earlier history is
represented by one passive boundary row, never an estimated spacer. Native wheel/trackpad scrolling
is not cancelled; its direction immediately prepares two viewports ahead while retaining one behind.
Production: `createPhysicalWindowController`, `CommittedHistory.scrollBy`,
`TranscriptScrollBoxRenderable`. Tests: `transcript-scrollbox-render.test.tsx`,
`transcript-physical-window.test.ts`, `transcript-window-render.test.tsx` and
`transcript-publication-render.test.tsx` (anchor cells, rapid Page Up, fractional wheel packets and
edge admission).

**INV-TP11.** A width/sidebar/ASCII change starts a replacement epoch while the painted marker ledger,
resident owner widths and syntax identities remain unchanged. At most one non-interactive hidden
geometry clone serially stages target markers; no target marker participates in geometry until the
complete ledger, owner widths and exact reader-anchor delta publish atomically. Every clone is
discarded after observation or cancellation and cannot accumulate. A fold change invalidates the
affected marker; height-only resize and scrollbar overflow retain markers. Production:
`PhysicalTranscriptWindowController.sync`, `PhysicalTranscriptWindowController.commitMeasurement`,
`TRANSCRIPT_GEOMETRY_MEASUREMENT_OWNER_LIMIT`, `CommittedHistory`. Tests:
`transcript-physical-window.test.ts` (80-to-81 deterministic anchor/epoch swap),
`transcript-window-render.test.tsx` (real cells, owner identity and clone bound) and
`transcript-publication-render.test.tsx` (`write_memory` syntax identity across Sidebar reflow).

**INV-TP12.** Committed history cannot import the mutable semantic store, activity/workflow
projections, clocks, spinners, run host or live views. Its store port contains frozen publication
only. Production: `CommittedHistoryPublicationStore`. Test:
`architecture-boundary.test.ts` (committed-history boundary).

**INV-TP13.** Same-pair staging closes after 80 ms, eight terminal calls or a semantic barrier;
`mcpName` and `toolName` are compared separately in live staging, terminal sweep and sub-agent batch
metadata, and frozen group metadata never changes. Production: `publicationToolIdentity`,
`samePublicationToolIdentity`, `publicationToolGroups`, `TranscriptPublisher.#publishTool` and
`TranscriptPublisher.#publishRemainingLead`. Test: `transcript-publication.test.ts` (group bounds,
barriers and equal leaf names from different MCP servers in all three publication paths).

**INV-TP14.** Each delegation has exactly two Lead-owned lifecycle publications: a friendly frozen
spawned marker at `delegation_created`, then a separate friendly frozen completed/failed marker at its
terminal typed event. Publication is idempotent per delegation and phase; the terminal event cannot
patch the first marker, `delegation_started` cannot publish one, and the generic delegation
`capability_event` mirror is suppressed. The closed provider supervision/orchestration tool set
cannot supplement those two markers with composing, started, output or terminal rows. Detailed
sub-agent batches still append to the retained semantic ledger in terminal completion order with one
frozen section header, becoming physically eligible only for that explicitly selected child
transcript. Production: `TranscriptPublisher`
(delegation event publication), `#rememberSubagentCompletion`, `#publishSubagent`,
`publicationSection`, and `createTranscriptState` (`visibleNodes`). Tests:
`transcript-publication.test.ts` (lifecycle idempotence, immutability and child completion order) and
`transcript-window-state.test.ts` (Lead markers/child-content filter).

**INV-TP15.** Definitive run settlement closes publication only after stored reconciliation; session
restore closes every replayed run. Production: `runManaged`, `loadSessionMeta`. Tests:
`run-host.test.ts` reconciliation/resume cases and publication replay equivalence.

**INV-TP16.** After settlement, native owners are bounded by visible rows plus two directional
viewports ahead, one behind, whole boundary-batch overhang and one measurement candidate, plus
constant sentinels/spacers, independent of completed-turn count. Every renderer lifecycle pass
retained across repeated eviction/remount cycles remains
reachable from the live OpenTUI root; a destroyed or detached pass is a leak. Production:
`createPhysicalWindowController`, `CommittedHistory`. Tests: `transcript-publication-render.test.tsx`
physical-row/navigation soak and lifecycle reachability, plus the real-run memory soak required by
[code-performance.md](code-performance.md).

**INV-TP17.** Streaming Markdown alone uses top-level internal blocks; final snapshots use OpenTUI's
default coalesced mode. Production: `AssistantMarkdown`, `StableMarkdown`. Tests:
`markdown-render-contract.test.tsx` and `architecture-boundary.test.ts` (settled-prop audit).

**INV-TP18.** A syntax candidate cannot retain measurement ownership indefinitely. It receives one
2-second lease and one fresh syntax retry. A never-published candidate then keeps the same semantic
`BlockView`/Markdown/diff/code renderer while disabling and bypassing only unfinished highlighting;
an already painted owner retains its exact tree, waits for public syntax completion and commits only
after two equal positive physical observations. A parser that remains pending may delay that new
marker, but it cannot remount or replace the visible owner. Neither path may replace visible content
with a warning or omit a tool argument body. The chosen `rich` or `plain-semantic` policy persists by
batch id across physical eviction/remount and is purged with the corresponding publication.
Production: `PhysicalPublicationOwner`, `SyntaxPublicationBoundary`, `freezeUnsettledSyntax`,
`StableMarkdown`, `StableDiff`. Tests: `transcript-publication-render.test.tsx` (painted
`write_memory` handoff across more than two forced lease intervals and a resize, short-lease semantic
recovery, zero unmeasured newer entries and bounded frame listeners).

**INV-TP19.** Physical observation reaches a fixed point at exact directional-runway edges: a batch
trimmed to an exact spacer is not immediately prefetched again without scroll, reversed intent or
layout change. Before the
first marker, an append-only resume burst coalesces its pending initial candidate to the newest batch
unless explicit user navigation/reveal has taken ownership. Production:
`PhysicalTranscriptWindowController.sync`, `observe`, `#trimOutsideRunway`. Tests:
`transcript-physical-window.test.ts` (exact-edge fixed point and initial-tail coalescing) and
`transcript-window-render.test.tsx` (incremental reconstructed-tail admission and settled lifecycle).

**INV-TP20.** Syntax publication schedules every required renderer frame itself. Consecutive waits
cannot rely on a timer, user input, animation or an externally driven test frame, and the confirming
measurement must complete before the recovery lease for an ordinary settled Markdown batch.
Production: `stable-syntax.tsx` (`nextFrame`, `waitForSyntaxFrame`,
`waitForStableDimensions`). A completed boundary tracks initialization separately from its optional
revision value, so an inactive `number -> undefined -> number` cycle re-arms measurement. Test:
`transcript-publication-render.test.tsx` (one-shot renderer self-scheduling and inactive revision
re-arm).

**INV-TP21.** Frozen history, handoff artifacts and the mutable frontier for the active projection
form one chronological ScrollBox flow. A Lead frontier artifact's final visible row before semantic
commitment equals its first visible row as a committed owner; a following Lead response/tool remains
below it in both frames. Child tools, reasoning and answers cannot enter this main flow; only the two
typed, append-only delegation lifecycle markers may add chronological Lead rows. Provider composing,
started, output and terminal tool plumbing for supervision/delegation/workflow orchestration cannot
enter it either. There is no fixed-height live **transcript panel** or idle status row inside history;
the fixed reading runway and composer-adjacent Lead activity line remain outside semantic
publication. Production: `CommittedHistory`, `LiveTranscriptTail`, `TranscriptRegion`,
`LeadActivityLine`. Test:
`packages/code/tests/integration/transcript-publication-render.test.tsx` ("production
TranscriptRegion keeps committed memory, diff, and write syntax owners stable": the tail is a direct
history child, child content remains absent from the main capture, lifecycle markers append without
moving earlier owners, and later Lead output preserves the chronological flow).

**INV-TP22.** While explicit tail-following is active, append-only publication drains to
`laterUnknown === 0` without consulting a pre-layout bottom sample. Upward input disables following;
downward input loads newer ranges in order and re-enables it only at the newest edge. A newer-range
count, when present, is a non-interactive top overlay and never a row below history. Production:
`PhysicalTranscriptWindowController`, `CommittedHistory`. Tests:
`transcript-physical-window.test.ts` and `transcript-window-render.test.tsx` (multi-append tail,
reader anchor and return-to-tail cases).

**INV-TP23.** Release-ready TUI validation includes raster captures from the distributable in a real
PTY for: empty first paint; first Lead streaming response; terminal Lead tool; the Lead transcript
while a sub-agent spawns, runs and completes with exactly its friendly spawned and settled markers
and no child-content or provider supervision/orchestration tool row at any phase; later Lead output
continuing that clean main history; the explicitly selected child's isolated transcript with its own
tools/output;
return to `Lead transcript`; workflow activity present only in the footer strip/Sidebar; settled run;
wide Sidebar open/closed; and compact terminal. The reviewer checks physical ordering, the intended
fixed runway/activity band and absence of any other reserved blank panel, live-to-committed
continuity, native-scroll loading and the absence of parser-state flicker. Production:
`bun run smoke` plus the installed release launcher. Test: the
documented `tui-driver` capture matrix retained in the release handoff; character-frame or hash
assertions alone do not satisfy this visual gate.

**INV-TP24.** Semantic-prefix folding cannot accumulate publisher identity tombstones or resurrect
discarded staging. A removed key leaves `knownKeys` only after it is absent from both current
semantic nodes and every retained publication; the previous folded-prefix publication is replaced,
not accumulated. Production: `TranscriptPublisher.forgetDiscarded` and
`createTranscriptStore.foldPrefixBefore`. Tests:
`packages/code/tests/unit/transcript-publication.test.ts` (discard-release and staged-flush
retention cases) and `packages/code/tests/unit/store-status.test.ts` (repeated 20-turn plateau).

**INV-TP25.** The default physical transcript is Lead-only: committed selection and the mutable tail
both exclude every child-content node carrying `subagentId`, while semantic storage/publication retain
those nodes. The Lead projection includes exactly the two friendly immutable lifecycle markers owned
by each delegation's typed events. Selecting one child admits only nodes with that exact id; selecting
`Lead transcript` restores the default. Workflow projection state is never converted into a
transcript node. Lead-owned provider supervision/delegation/workflow-orchestration rows are excluded
at every tool phase. Plan, workflow and delegation own independent first-event Sidebar reveals; the
Agents reveal keeps Lead selected and cannot open `ActivityDetail`. A later explicit agent click
changes selection only and expands that child's foldable section once, including when selection
precedes body arrival. Manual collapse then survives Lead/reselection, a sibling consumes its own
first-selection expansion, and Lead/global fold preference is unchanged. Production:
`createTranscriptState` (`visibleNodes`, `toggleSubagent`, first-selection expansion),
`LiveTranscriptTail` (`belongsToSelection`), `TranscriptRegion` (Sidebar selection), `Sidebar`
(section reveal) and `App` (`requestAutomaticSidebar`, `compactActivityStrip`). Tests:
`packages/code/tests/unit/transcript-window-state.test.ts` (Lead/child projection),
`packages/code/tests/unit/transcript-state.test.ts` (first selection, late body, sticky manual
collapse, independent sibling and anchor pruning),
`packages/code/tests/integration/transcript-region-render.test.tsx` (main-hidden, isolated sibling
filter, workflow exclusion and Sidebar click),
`packages/code/tests/integration/sidebar-render.test.tsx` (settled-row selection without
`ActivityDetail`) and `packages/code/tests/integration/app-shell-render.test.tsx` (three independent
auto-reveals, readable first child selection, sticky manual fold/reselection and completed-agent
isolation without a modal).

**INV-TP26.** Recomputing semantic keys without changing one publication's included key sequence
preserves the projected batch object, native owner and physical marker. Projection memoization retains
at most the latest derived object per weakly held source batch, so identity stability cannot become an
unbounded projection ledger. Production: `projectPublicationBatch`. Test:
`packages/code/tests/integration/transcript-window-render.test.tsx` (unchanged semantic projection
owner identity).

**INV-TP27.** Lead-owned provider tool plumbing for supervision, spawn/delegation and workflow
orchestration is transcript-silent at every event phase. The exact identities are `spawn_subagent`,
`delegate_task`, `agent_list`, `agent_poll`, `agent_stop`, `agent_steer`, `await_agents`, `run_leader`,
`run_workflow`, `run_round`, `run_work_items`; composing, started, output and terminal events create
neither frontier candidates nor publication batches. This cannot remove ordinary Lead
`thinking`/`working` in the fixed activity line, either typed delegation marker, Sidebar/footer
state, or child-attributed tools
from that child's isolated transcript. Production: `isTranscriptExternalOrchestrationTool`,
`createTranscriptStore` (`openRun`), `TranscriptPublisher.#publishTool` and `createTranscriptState`
(`visibleNodes`). Test: `packages/code/tests/unit/streaming-delta.test.ts` ("Lead-owned orchestration
tools never create composing, started, or terminal nodes"), plus publication and real-view
Lead/isolated-child projection cases.

**INV-TP28.** The main ScrollBox ends in one fixed physical reading runway: three rows normally and
one row only at terminal height ≤28. Lead `thinking` never enters `LiveTranscriptTail`; one persistent
`LeadActivityLine` immediately above `InputDock` reuses the same native row for `thinking`,
`working` and settled `ready`. Plan nodes likewise have no live-tail owner. These exclusions and the
runway height cannot vary with streaming phase, so neither activity nor plan churn can move already
rendered transcript content. Production: `LiveTranscriptTail`, `LeadActivityLine`, `App`
(`leadActivityPhase`) and `TranscriptRegion` (`transcriptReadingRunwayRows`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` (fixed activity-row identity and physical
adjacency) and `packages/code/tests/integration/transcript-region-render.test.tsx` (live Plan
exclusion and normal/compact runway heights).

**INV-TP29.** The Lead projection remains physically mounted for the life of the transcript region,
and at most one explicitly selected child projection is retained beside it. Each projection owns a
separate `CommittedHistory`, physical-window controller, ScrollBox, `scrollTop` and follow-tail
state. Visiting a child or any full-region Workflow/configuration/Plan/Diff page hides and pauses the
inactive projection without rebuilding it; returning reveals the same Lead owner at the same reader
position. Selecting child B destroys retained child A before retaining B. Inactive projections
cannot measure, consume mouse actions, resolve elicitation or trigger memory recovery, and the weak
publication-projection cache retains at most the Lead plus one child entry. Production:
`TranscriptRegion` (`TranscriptProjection`, `retainedChildId`), `CommittedHistory` (`active`,
`TRANSCRIPT_PROJECTION_CACHE_LIMIT`), `LiveTranscriptTail` (`active`) and `OverlayRegion`
(`overlayFallbackActive`). Tests: `packages/code/tests/integration/transcript-region-render.test.tsx`
(full-region pause/identity and repeated Lead/A/B plateau) and
`packages/code/tests/integration/overlay-region-render.test.tsx` (fallback owner and Yoga geometry
survive repeated full-region visits).

**INV-TP30.** An explicit model submission from the composer is also an explicit navigation request:
normal submit, steer, model-backed prompt and skill execution first select Lead and synchronously
request its newest physical edge before dispatching the request. If that tail was virtualized, the
current reader frame remains visible while one hidden tail candidate settles, then the controller
atomically replaces the old window and applies its navigation delta; a stale marker alone never
authorizes a transparent remount. The same helper applies when the reader is at the oldest loaded
range or viewing a child. Background transcript, workflow, plan and delegation events never invoke
that navigation and therefore preserve an older reader anchor. Production: `App`
(`submitFromLeadTail`), `CommittedHistoryHandle.returnToTail` and
`PhysicalTranscriptWindowController.returnToTail`. Tests:
`packages/code/tests/unit/transcript-physical-window.test.ts` (unknown-middle and stale-candidate
return), `packages/code/tests/integration/transcript-window-render.test.tsx` (explicit tail return)
and `packages/code/tests/integration/app-shell-render.test.tsx` (normal submit/steer and model-backed
prompt/skill routes while background append remains anchored).

**INV-TP31.** A running assistant uses the same static bullet as its settled transcript block. It
does not subscribe an ornamental marker inside Markdown history to the shared spinner clock. Live
activity remains visible in a running tool row and in `LeadActivityLine`. That composer-adjacent line
owns phase plus active-run elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt; slash autocomplete
replaces it while open. The footer instead preserves Context plus cumulative Session token totals,
cache-hit percentage and cost before and after settlement, without `Running` or iteration. Plan
state remains exclusive to the Sidebar and `Ctrl+P` surface and contributes no footer summary.
Production: `BlockView`, `App`
(`leadActivityDetail`, `inputPopupOpen`, `footerRunStrip`, `compactActivityStrip`), `runStripText` and
`LeadActivityLine`. Tests:
`packages/code/tests/integration/markdown-render-contract.test.tsx` (static streaming marker) and
`packages/code/tests/integration/app-shell-render.test.tsx` (active-run detail ownership,
autocomplete replacement, Plan staying absent from the footer across terminal and later run state,
and a second active turn retaining exactly the same cumulative usage at settlement), plus
`packages/code/tests/unit/run-status.test.ts` (Session tokens and scope-proportional cache percentage
before and after settle).

**INV-TP32.** Within one running assistant `geometryEpoch`, `StableMarkdown` retains the greatest
visible row height it has observed. OpenTUI may later parse and conceal an unfinished delimiter, but
the mutable tail cannot give those rows back, reduce bottom-following `scrollTop` or pull an earlier
transcript anchor downward. A changed epoch resets the floor. The reservation cannot replace native
Markdown, disable `conceal` or flatten parsed attributes; strong text remains bold and its source
delimiters remain hidden. Production: `StableMarkdown` (`liveHeightFloor`) and `AssistantMarkdown`
(`geometryEpoch`). Test:
`packages/code/tests/integration/transcript-scrollbox-render.test.tsx` ("bottom-following streaming
Markdown never gives rows back when parsing conceals syntax").

## 6. Failure modes and degradation

| Failure or pressure                                                               | Required behavior                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stored-run read throws                                                            | settle available semantics, append one degraded annotation, then publish terminal batch                                                                                                                                                                                                                                                                                                                                                                         |
| incremental events drop                                                           | publish `events_dropped`; admitted terminal tool/iteration events remain authoritative, while classified supervision/orchestration tools remain suppressed                                                                                                                                                                                                                                                                                                      |
| syntax highlighting rejects or does not settle within two leases                  | remount a never-published candidate once; then disable parser work through the same semantic renderers while bypassing only unfinished highlighting and retain that `plain-semantic` policy across eviction/remount. If an owner already painted, retain its identities, wait on public syntax completion and then require two equal positive dimensions; while pending, leave it visible and unchanged rather than replacing its body with a warning/text dump |
| owner dimensions differ on confirming frame                                       | keep candidate hidden and observe again; never record the unstable height                                                                                                                                                                                                                                                                                                                                                                                       |
| viewport culling would skip candidate render hooks                                | suspend culling for the one transparent candidate; restore it as soon as the physical marker commits                                                                                                                                                                                                                                                                                                                                                            |
| layout epoch changes during measurement                                           | discard candidate marker and restart once in the new epoch                                                                                                                                                                                                                                                                                                                                                                                                      |
| one batch exceeds physical row target                                             | admit that batch alone; existing semantic display ceilings still apply                                                                                                                                                                                                                                                                                                                                                                                          |
| user reaches unmeasured history faster than preparation                           | keep current frame and passive boundary; coalesce input and continue loading without requiring a click                                                                                                                                                                                                                                                                                                                                                          |
| user reads older history while events append                                      | retain exact anchor; show any newer count only in the top overlay and admit it through downward scroll                                                                                                                                                                                                                                                                                                                                                          |
| user submits while reading older history or a child                               | select Lead and synchronously request its newest edge before dispatch; retain the current frame until a virtualized tail candidate settles, then swap atomically rather than waiting for a later model event to move the viewport                                                                                                                                                                                                                                |
| current-epoch measured range is evicted                                           | replace it with exact summed spacer rows and dispose native owners                                                                                                                                                                                                                                                                                                                                                                                              |
| range has no current-epoch markers                                                | show one passive earlier-history boundary above content; never synthesize spacer height                                                                                                                                                                                                                                                                                                                                                                         |
| terminal width/sidebar/ASCII changes                                              | create new epoch, prepare current target hidden, then replace; old markers are dropped                                                                                                                                                                                                                                                                                                                                                                          |
| terminal height alone changes                                                     | retain markers and recompute the visible/directional-runway interval from new viewport rows                                                                                                                                                                                                                                                                                                                                                                     |
| vertical scrollbar gains or loses overflow                                        | retain the permanently reserved column and markers; change indicator opacity only                                                                                                                                                                                                                                                                                                                                                                               |
| 20-turn semantic limit is crossed                                                 | evict complete batches and their markers, install one frozen export notice                                                                                                                                                                                                                                                                                                                                                                                      |
| child activity changes while Lead is selected                                     | retain child content for isolated selection and update footer/Sidebar; append only the delegation's frozen spawned/settled Lead markers, never child content, a live marker or provider supervision/orchestration tool plumbing                                                                                                                                                                                                                                 |
| child or full-region page is opened and closed                                    | pause the hidden projection and reveal the same retained Lead ScrollBox/controller on return; retain at most one child and destroy the previous child when another is selected                                                                                                                                                                                                                                                                                  |
| workflow activity changes                                                         | update the footer strip/Sidebar only; mount no workflow row in either transcript projection                                                                                                                                                                                                                                                                                                                                                                     |
| a provider emits only a composing or started supervision/orchestration tool phase | suppress it immediately; typed delegation events or Sidebar/footer workflow state remain authoritative                                                                                                                                                                                                                                                                                                                                                          |
| future loader/progress feature is added                                           | keep transcript content before the fixed runway, place operational state in Sidebar/footer, or reuse the fixed Lead activity line; it cannot reserve a second transcript panel or move committed rows                                                                                                                                                                                                                                                           |

The stable fallback priority is readable content without repeated visual transition. A parser failure
may lose highlighting for one artifact; it cannot make a published artifact alternate between parsed,
raw and transparent frames.

## 7. Coupling

| Concern                                        | Owner                                             | Constraint here                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `RunEvent` vocabulary and durability           | [kernel-runs.md](kernel-runs.md)                  | publication classifies the closed union but cannot change persistence policy                                     |
| live handle, stored read and session ownership | [code-run-host.md](code-run-host.md)              | host calls `complete` only after reconciliation or definitive degradation                                        |
| node presentation and display caps             | [code-transcript.md](code-transcript.md)          | publisher freezes existing bounded projections; physical window does not estimate them                           |
| session reconstruction                         | [sessions.md](sessions.md)                        | restored trace order rebuilds semantic batches; terminal markers are remeasured                                  |
| elicitation                                    | [elicitation.md](../cross-cutting/elicitation.md) | pending controls stay live; only terminal outcomes may publish                                                   |
| plan/workflow capabilities                     | capability specs, footer strip and Sidebar        | workflow state never enters either transcript; mutable plan singleton/progress state never enters frozen history |
| renderer version and memory                    | [code-performance.md](code-performance.md)        | OpenTUI packages move in lockstep; row/owner soak validates the physical window                                  |

Code's protocol-isolation rule remains unchanged: the publisher consumes `@clarvis/protocol` events
through the run host and does not import loop or kernel implementation. Adapters do not import views;
the view receives frozen types through a narrow publication port.

## 8. Open questions

There is no open architectural choice between estimated pages and physical markers: physical rows are
the viewport authority. `TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS = 2`,
`TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS = 1`, serial measurement and current-epoch-only marker retention
are current product constants. Changing them requires renderer/soak evidence and a spec update; it
cannot reintroduce estimated ordinary paging or an unbounded mounted owner list.

OpenTUI core/keymap/Solid are pinned together at 0.5.9. An upgrade must rerun tree-shape, marker,
recorded-frame, resize, owner-balance, full `@clarvis/code` and built PTY gates. A PTY validates real
terminal integration; deterministic recorder tests remain authoritative for frame identity, direct
children and exact cells that human observation cannot count reliably.
