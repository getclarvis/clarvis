# Transcript publication, native viewport and visual stability

> Implemented by `packages/code/src/adapters/{store,transcript-publication}.ts`,
> `packages/code/src/run-host.ts`,
> `packages/code/src/views/history/CommittedHistory.tsx`,
> `packages/code/src/views/history/visible-slice.ts`,
> `packages/code/src/views/live/LiveTranscriptTail.tsx`,
> `packages/code/src/views/app/TranscriptRegion.tsx` and
> `packages/code/src/ui/patterns/stable-syntax.tsx`. Production-shaped renderer regressions live in
> `packages/code/tests/integration/transcript-publication-render.test.tsx`; pure publication and
> index-window contracts live in
> `packages/code/tests/unit/{transcript-publication,transcript-visible-slice}.test.ts`; native
> sticky-bottom streaming is covered by
> `packages/code/tests/integration/transcript-scrollbox-render.test.tsx`.

---

## 1. Purpose

This document owns the transcript's **publication lifecycle and physical viewport**: which state may
still change, when one semantic artifact becomes immutable, and which owners may remain mounted.
Clarvis separates an immutable committed history from
a mutable live frontier. Background work may append after history, but cannot patch, move, hide,
reparse or remount a committed artifact that remains in the current physical window.

The mounted history window is index-driven. Sessions at or below
`TRANSCRIPT_FULL_MOUNT_CEILING` committed batches mount every frozen owner. Longer sessions keep a
sliding slice of `TRANSCRIPT_MOUNTED_BATCH_COUNT` batches plus the live tail. Hint spacers are a
fixed one-row affordance, never a sum of measured Yoga rows. Native OpenTUI sticky scrolling is the
only authority for following the end of the transcript.

Explicit presentation actions remain distinct from background mutation. Scrolling across a lazy-load
boundary, folding, opening detail, selecting a sub-agent, changing ASCII mode, opening/closing the
Sidebar and resizing the terminal may change which immutable owners are mounted or invalidate their
geometry. The first live Plan, first workflow state/leader and first delegation each own one independent,
execution-scoped automatic Sidebar reveal with the same anchor requirement. Repeated events for the
same section cannot flap the layout after an explicit close; the first event for another section may
still reopen and reorient the combined Sidebar. Escape makes only that repeated automatic intent
sticky: `/activity [plan|workflow|agents]` can explicitly reopen any available section. The bounded
footer pointer remains for agent/workflow activity, while Plan never contributes footer text. Those
actions may change the active frozen-owner slice or native reader position; ordinary later run,
tool, workflow and memory updates do neither. Typed delegation creation and
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

Publication and viewport selection are internal Code contracts, not public workspace-package APIs.

| Surface | Responsibility |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRANSCRIPT_EVENT_POLICY` | compile-time-exhaustive disposition of every `RunEvent["type"]` |
| `TranscriptPublisher` | turns terminal semantic candidates into ordered immutable publication batches |
| `snapshotTranscriptNode` | deep-freezes the bounded inline projection; raw/live payload fields do not cross the boundary |
| `TranscriptPublicationBatch` | frozen semantic nodes, folds, groups, sub-agent headers and monotonic publication phase; retention does not imply main-transcript visibility |
| `TranscriptRunSink.complete` | host signal that stored reconciliation finished or definitively degraded |
| `TranscriptStore.publicationBatches` | resident semantic batches; independent from renderer residency |
| `TranscriptStore.frontierNodes` | mutable semantic nodes whose keys are not committed |
| `TranscriptVisibleSlice` | index window `{ start, end, activeBatchIds, earlierUnknown, laterUnknown, followingTail }` |
| `createVisibleSliceController` | slides a bounded batch slice and mirrors native follow-the-tail |
| `CommittedHistoryPublicationStore` | narrow history port exposing frozen batches only |
| `CommittedHistory` | one native OpenTUI `ScrollBox` owner for Lead and child projections |
| `TRANSCRIPT_SCROLLBAR_COLUMNS` | reserves one vertical-scrollbar column in every history layout |
| `LiveTranscriptTail` | content-height mutable tail that keeps presented Solid owners through terminal publication until the suffix is released |
| `transcriptReadingRunwayRows` | chooses the fixed three-row normal or one-row compact physical runway from terminal height only |
| `LeadActivityLine` | persistent one-row `thinking`/`working`/`ready` owner immediately above the composer and outside history |
| native `<scrollbox>` | OpenTUI ScrollBox with `stickyStart="bottom"` and `viewportCulling` always on |

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
`projectTranscriptToolDisplay`, not raw arguments/results. `liveOutput`, `inputChars`,
`inputComplete`, `dehydrated` and `hydrationNotice` are absent rather than present with `undefined`. Sub-agent terminal artifacts
are reserved before mutable hydration retention can discard them.

### 3.3 Visible slice and native geometry

`TranscriptVisibleSlice` records the immutable batch-id list, half-open `[start, end)` mounted
interval, hidden counts on both sides, native follow/navigation flags and the most recently observed
viewport metrics. Sessions at or below `TRANSCRIPT_FULL_MOUNT_CEILING` use the full interval.
Longer sessions use `TRANSCRIPT_MOUNTED_BATCH_COUNT`; revealing older/newer history moves the
interval by `TRANSCRIPT_REVEAL_BATCH_COUNT`, while focus navigation recentres it around the target.

The controller never stores or estimates batch row heights. OpenTUI owns layout, folding reflow and
the numeric `scrollTop`. Hidden prefixes and suffixes each render as at most one fixed-height passive
hint. The permanently reserved one-column scrollbar gutter prevents overflow visibility from
changing content width.

### 3.4 Monotonic lifecycle

```text
mutable semantic candidate
          |
          v
frozen and semantically committed batch
          |
          | viewport admission
          v
mounted when its id is inside the visible slice
          |
          v
native ScrollBox lays out and culls the direct child
          |
          v
unmounted when the index slice moves past it
```

Thinking placeholders, retry countdowns, composing arguments, pending elicitation and live
plan/workflow progress never enter a publication batch. There is no semantic transition out of
`committed`; only renderer residency changes.

### 3.5 Physical bounds

| Bound | Current value | Production symbol |
| ---------------------------- | ----------------------------------------: | ----------------------------------------------------------------------------------- |
| full-mount ceiling | 80 committed batches | `TRANSCRIPT_FULL_MOUNT_CEILING = 80` |
| long-session mounted slice | 40 committed batches | `TRANSCRIPT_MOUNTED_BATCH_COUNT = 40` |
| one edge reveal | 20 committed batches | `TRANSCRIPT_REVEAL_BATCH_COUNT = 20` |
| hidden-range hint | one row per non-empty side | `TRANSCRIPT_HIDDEN_HINT_ROWS = 1` |
| reserved vertical-bar gutter | one column | `TRANSCRIPT_SCROLLBAR_COLUMNS = 1` |
| semantic resident history | 20 turns plus one folded-prefix notice | `RESIDENT_TRANSCRIPT_TURN_LIMIT` |

The bound counts immutable batches rather than Yoga rows. A single batch may be tall, so the existing
per-node text and tool display ceilings remain the abuse bound. The live tail and at most two passive
boundary rows sit outside the mounted committed-batch count.

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
  defeats that granularity. Moving the index slice disposes owners outside the current interval.
- OpenTUI's `ScrollBarRenderable.visible` manual-control path pins the vertical bar to one layout
  column. Its opacity is zero without overflow and one with overflow. The indicator may therefore
  change, but adding a runway owner cannot create a 120-to-119-column epoch feedback loop.
- Clarvis owns index-slice disposal because OpenTUI culling skips offscreen render calls but does not
  unmount Solid owners. There is no owner-disposing virtual-list component in the pinned OpenTUI
  0.5.9 API.
- Mutable assistant Markdown uses OpenTUI `MarkdownRenderable` with `streaming: true` and
  `internalBlockMode: "top-level"`. Final frozen snapshots use `streaming: false` and the default
  coalesced block mode, as recommended for non-streaming Markdown.
- Diffs and code continue to use OpenTUI's native syntax renderables; Clarvis does not introduce a
  second Markdown or diff parser.

## 4. Behavior

### 4.1 Exhaustive event disposition

| Event type(s) | Mutable/status behavior | Publication trigger |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `run_started` | initialize live run identity | none |
| `iteration_started` | fixed Lead activity line becomes `thinking`; proves preceding unphased answer was commentary | preceding answer becomes an iteration batch |
| `text_delta` | patch assistant frontier candidate | never directly |
| `reasoning` | patch settled iteration reasoning candidate | with `iteration_completed` |
| `iteration_completed` | replace streamed text with authoritative `response` | commentary now; final/unphased answer follows §4.2 |
| `model_retry` | settle named composing tools as error (drop only nameless placeholders), then show retry status/countdown in the frontier | never |
| `model_error` | terminal iteration error candidate | with iteration or final sweep |
| `tool_input_delta`, `tool_call_started`, `tool_output_delta` for an admitted ordinary tool | one mutable tool candidate/tail; cumulative input stays composing until explicit `complete: true`, then pending until actual start | never directly |
| `tool_call` for an admitted ordinary tool | reserve bounded terminal snapshot immediately | append one frozen one-node batch immediately |
| any composing/started/output/terminal tool event for a Lead-owned supervision or workflow-orchestration identity | suppress before frontier creation/staging | none; no transient or terminal Lead row |
| `delegation_created` | register child semantics and Sidebar/footer state; the first delegation may open/reveal Agents once for this execution | append one friendly frozen Lead-owned `spawned` marker |
| `delegation_started` | update child/Sidebar/footer running state | none; it cannot create or mutate a Lead marker |
| `delegation_completed`, `delegation_failed` | close child activity and retain its terminal semantics | append one separate friendly frozen Lead-owned `completed`/`failed` marker; freeze the child section for its isolated transcript |
| `workflow_run_started`, `workflow_title_updated`, `workflow_sequence_state`, `workflow_run_progress`, `workflow_run_completed`, `workflow_run_failed` | Sidebar or compact footer activity strip; the first projected state/leader may open/reveal Parallel work once for this execution | no history row |
| `plan_created`, `plan_updated`, `plan_removed`, `plan_review_requested`, `plan_review_resolved` | Sidebar, `Ctrl+P` and pending review; the first live Plan may open/reveal Plan once for this execution; no footer summary | no mutable plan singleton in either transcript flow |
| `soft_limit_check` | terminal annotation candidate | append once |
| `compaction_started` | status/frontier progress | none |
| `compaction`, `compaction_skipped`, `vision_analysis` | terminal annotation candidate | append once |
| `elicitation_requested` | pending interaction in `LiveTranscriptTail` | none |
| `elicitation_resolved` | terminal question/outcome fact | append once when projected |
| `steering_applied` | settle pending steer | append delivered outcome once |
| `memory_ingest` | status/footer only | none |
| `capability_event`, `events_dropped` | bounded immutable point/warning, except generic delegation/workflow capability mirrors, which are suppressed | append once when eligible; no publication for either orchestration mirror |
| `mcp_degraded` | one transient live TUI warning per newly observed `{ server, reason }`; replay is silent | none; persisted telemetry never becomes conversation history |
| `run_ended` | close frontier and start reconciliation holdback | terminal batch only after `TranscriptRunSink.complete` |

This policy does not redefine durability. `RUN_EVENT_POLICY` in the kernel still decides whether an
event is streamed, persisted or both.

`RunHost.mcpStartupNotice` deduplicates live degradation by server and sanitized reason for the
process session. `App` projects the latest sequence through its self-clearing hint surface, outside
the transcript store and immutable publication ledger. Production: `packages/code/src/run-host.ts`
(`onEvent`, `mcpStartupNotice`), `packages/code/src/views/App.tsx` (MCP notice effect),
`packages/code/src/adapters/store.ts`, and
`packages/code/src/adapters/transcript-publication.ts`. Tests:
`packages/code/tests/component/run-host.test.ts`,
`packages/code/tests/unit/store-status.test.ts`, and
`packages/code/tests/integration/app-shell-render.test.tsx`.

The event table's `status/footer` wording does not put run lifecycle beside stable session figures.
During a run, `LeadActivityLine` owns phase, elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt; the
footer keeps Context plus cumulative Session token totals, cache-hit percentage and cost during the
run and retains them after settlement. The cache percentage is scoped to the same Run or Session
owner as its token totals and divides cached tokens by gross input, not by the already-net `In`
display. During a run the Session owner is one frozen full-session baseline plus only the current
live run delta; resident transcript replays are never an accounting source. A numeric cached zero is
measured, while any missing positive-input split makes the complete scope unknown: the footer keeps
gross `In` and omits the percentage during the run and after settlement.
Slash autocomplete replaces the activity line while its popup owns that band. Production:
`packages/code/src/run-host.ts` (`sessionUsageBaseline`, `runManaged`),
`packages/code/src/adapters/activity-store.ts` (`currentUsage`),
`packages/code/src/views/App.tsx` (`activeSessionUsage`, `leadActivityPhase`, `leadActivityDetail`,
`inputPopupOpen`, `footerRunStrip`) and `packages/code/src/features/run/status-presenter.ts`
(`runStripText`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` (active-run metadata, autocomplete
replacement, Plan-free footer, baseline/delta ownership and missing-cache cases) and
`packages/code/tests/unit/run-status.test.ts` (session tokens, owner-scoped cache percentage and
settlement continuity).

The tool-row exception is identity-closed: `spawn_subagent`, `delegate_task`, `agent_list`,
`agent_poll`, `agent_stop`, `agent_steer`, `await_agents`, `run_leader`, `run_workflow`, `run_round`,
`run_work_items`, `workflow_status`, `workflow_decide`. It applies to every provider tool phase, including the quiet composing placeholder
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

Each Lead `tool_call` publishes immediately as its own frozen one-node batch. Visual grouping of
consecutive exploration tools is a paint-time wrapper over those keys: identity is
`(mcpName, toolName, subagentId)`, mutations stay `solo`, and a compact header must not unmount the
head's `ToolLine`. Frozen per-batch `toolGroups` on a one-node publication are `solo`; consecutive
mounted keys may still compact without rewriting reserved snapshots. A leaf-only renderer lookup
identity never groups calls across MCP servers. Semantic sub-agent sections append in terminal
completion order and are visible only in the matching isolated transcript; spawn-order navigation
remains a Sidebar concern.

### 4.3 Direct-child index window

The ScrollBox's flow geometry has only this ordered shape:

```text
earlier hidden boundary?      one passive row
mounted publication owners   one direct child per active batch
later hidden boundary?        one passive row
mutable transcript tail       content-height final child
```

There is no `history-page` wrapper, hidden measurement clone, measured spacer or hand-maintained row
ledger. `createVisibleSliceController` selects immutable batch ids; `CommittedHistory` renders those
batches directly and OpenTUI owns their width, height, folding reflow and viewport culling. Grouping
and section metadata live on each frozen batch, so moving the slice cannot create a dangling group
head or section anchor.

Intersecting one frozen source publication with the semantic projection is identity-stable. A weak,
two-entry LRU cache per source batch keys the projected owner by the exact included node-key
sequence. The bound corresponds to Lead plus the most recently selected child. An unrelated semantic
append whose intersection is unchanged therefore returns the same projected batch object.

### 4.4 Scrolling and append behavior

Native OpenTUI wheel and trackpad handling remains authoritative. `CommittedHistory` observes
`scrollTop`, viewport height and whether the reader is at the bottom after frames. Upward movement
pauses follow-the-tail. A newly reached top with hidden earlier batches slides the index window
older once; a newly reached bottom with hidden later batches slides it newer once. Remaining at
that edge, or a frame whose content does not yet overflow the viewport, must not keep sliding the
window or treat a vacuous bottom as follow-the-tail — otherwise a remount that resets `scrollTop`
rewinds residency to the first message, or a non-overflowing layout frame jumps back to the newest
slice and fights every later downward scroll. Page Up/Down and wheel gestures at those edges still request
another window explicitly through the same handle, and focus navigation recentres the slice around
the target batch before calling `scrollChildIntoView`. `pauseFollowing` only clears follow-the-tail;
it must not cancel an in-flight `ensureBatch` navigation. Production: `observeFrame` and
`pauseFollowing` in `packages/code/src/views/history/CommittedHistory.tsx` and
`packages/code/src/views/history/visible-slice.ts`. Test: `resting at the top of a long window
does not rewind to the first message` in
`packages/code/tests/integration/transcript-window-render.test.tsx`.

While following, newly appended batches keep the slice fitted to its newest edge and the native
ScrollBox stays sticky at the bottom. While the reader is away, frozen or mutable additions do not
force the reader back; a non-interactive top overlay reports newer entries. Returning to the newest
edge mounts the newest slice, scrolls to the real content bottom and resumes sticky following.

Leaving the tail never removes its final flow owner. Removing it would shrink `scrollHeight` and
allow native clamping to move the reader. Width, height, Sidebar, ASCII and fold changes are ordinary
OpenTUI layout changes; Clarvis neither starts a geometry epoch nor queues compensating scroll
deltas.

### 4.6 Continuous mutable tail and ownership handoff

`TranscriptRegion` owns:

```text
CommittedHistory ScrollBox
  frozen owners from the active index slice in chronological order
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
When one frontier artifact in the active projection commits, publication freezes the snapshot but
does not transfer the Solid owner. `selectTailOwnedKeys` keeps a chronological suffix of already
presented keys in `LiveTranscriptTail` and `PublicationOwner` omits those keys, so a tool's
`BlockView` is updated in place from composing through terminal settle. A newer committed key the
tail never presented, or a key that leaves the mounted index slice, releases the suffix to history.
Two `BlockView`s with the same `id={key}` must not exist in the ScrollBox. Later
mutable content in that same projection remains after it throughout the update.
For streaming Markdown, the mutable tree's row-height high-water mark remains active only until the
final syntax tree is ready. The preparing final tree keeps its intrinsic height and must not inherit
the streaming overlay's row count. Its atomic publication swap releases that floor with the tree
change, so a shorter final rendering cannot leave the old streaming height as blank transcript rows
before the run outcome or a later message. Production: `StableMarkdown` in
`packages/code/src/ui/patterns/stable-syntax.tsx`. Test:
`packages/code/tests/integration/markdown-render-contract.test.tsx` (`settlement releases a streaming
height floor after the final tree is ready` and `a tall streaming reply does not leave blank rows
above the run outcome`).

History ownership extends through every committed publication before the active slice's end while
following the tail, except keys still presented by the live tail. If several
stages seal while a full-region view is active, those snapshots remain owned by history navigation;
retaining them after a newer outcome in the live tail would reverse chronology. Revealing an earlier
checkpoint or scrolling back loads its original publication without changing the semantic ledger.
Production: `selectTailOwnedKeys` in
[`tail-ownership.ts`](../../packages/code/src/views/history/tail-ownership.ts), used by
[`CommittedHistory`](../../packages/code/src/views/history/CommittedHistory.tsx) and
[`LiveTranscriptTail`](../../packages/code/src/views/live/LiveTranscriptTail.tsx).
Test: `a tool keeps one live owner from composing through terminal settle` and
`keeps fast checkpoint stages in chronological flow after an inactive goal view` in
[`transcript-publication-render.test.tsx`](../../packages/code/tests/integration/transcript-publication-render.test.tsx)
cover in-place settle identity, short and virtualized stages, retained checkpoint navigation and
return to the final tail.

The same handoff remains bounded while the reader is away. Committed suffix keys the tail still owns
stay in the tail; other committed artifacts enter the frozen batch list and the active index slice
decides whether their native owners are mounted. No handoff spacer or retained offscreen syntax tree
is created.

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
`packages/code/tests/integration/transcript-scrollbox-render.test.tsx` ("native sticky bottom
follows streaming Markdown without a queued delta").

The Sidebar is outside this flow. Its first live Plan, first workflow state/leader and first delegation
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
`complete`. The visible index slice and native scroll position are renderer state; they are not
persisted or replayed.

Conversation `/loop` occurrences use the same immutable run publication path and additionally wait
for physical closure before the next automatic turn. Live scheduling notices append only to the
matching conversation generation; job status updates belong to the separate loop view. They never
patch an older prompt/publication or invoke the explicit human-submit scroll-to-tail action.
Production: `submitScheduledTurn` in [run-host.ts](../../packages/code/src/run-host.ts), the loop
notice callback in [runtime.tsx](../../packages/code/src/runtime.tsx), and `LoopView` in
[view.tsx](../../packages/code/src/features/loop/view.tsx).
Test: scheduled closure/reconciliation and stale-conversation cases in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts), and in-place loop controls
in [app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx).
Registration lifetime is owned by [loop-scheduling.md](loop-scheduling.md).

### 4.8 Retention and detail hydration

Mutable raw tool bodies may dehydrate/rehydrate for detail. Publication reserves its bounded snapshot
at terminal `tool_call`, before hydration retention runs, so detail reads cannot patch history.

At the explicit 20-turn host boundary, `foldPrefixBefore` removes complete semantic publication
batches and prepends one frozen notice. The visible-slice controller reconciles the changed batch-id
list in the same update. `/export` reconstructs evicted turns from persistence, never from renderer
owners.

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
identity-preserving prefix of the next, independent of viewport residency. Production:
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

**INV-TP04.** Frozen publication owners are direct ScrollBox children. Native viewport culling stays
enabled; Clarvis does not mount a hidden absolute measurement clone. Production:
`CommittedHistory`, `BlockView`. Tests:
`transcript-publication-render.test.tsx` (Markdown, diff and memory tool first-publication frames) and
`transcript-window-render.test.tsx` (direct children and `viewportCulling`).

**INV-TP05.** Ordinary live activity cannot alter cells, owner identity or chronological order of
any visible committed batch. Following a growing tail may translate the
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

**INV-TP08.** Normal window selection is an index slice of committed batches. Sessions at or below
`TRANSCRIPT_FULL_MOUNT_CEILING` mount every owner; longer sessions keep
`TRANSCRIPT_MOUNTED_BATCH_COUNT` plus the live tail. Production: `createVisibleSliceController`.
Test: `transcript-visible-slice.test.ts`.

**INV-TP09.** ScrollBox publication owners are direct content children; viewport culling stays
enabled. Owners outside the index slice are unmounted rather than hidden. The live tail remains
mounted whether or not native stick is following the end. Production: `CommittedHistory`,
`LiveTranscriptTail`. Tests: `transcript-publication-render.test.tsx` and
`transcript-window-render.test.tsx`.

**INV-TP10.** Hidden earlier or later history is represented by one passive boundary row, never a
measured spacer sum. Native wheel/trackpad scrolling is not cancelled; leaving the bottom pauses
follow-the-tail and returning to the bottom resumes native sticky scrolling.
Production: `createVisibleSliceController`, `CommittedHistory.scrollBy`. Tests:
`transcript-scrollbox-render.test.tsx`, `transcript-visible-slice.test.ts`,
`transcript-window-render.test.tsx` and `transcript-publication-render.test.tsx`.

**INV-TP11.** Native OpenTUI layout owns width and fold reflow. Clarvis does not clone hidden
geometry owners or queue pre-paint `scrollTop` deltas. Production: `CommittedHistory`. Tests:
`transcript-window-render.test.tsx` and `transcript-publication-render.test.tsx`
(`write_memory` syntax identity while later Lead output streams).

**INV-TP12.** Committed history cannot import the mutable semantic store, activity/workflow
projections, clocks, spinners, run host or live views. Its store port contains frozen publication
only. Production: `CommittedHistoryPublicationStore`. Test:
`architecture-boundary.test.ts` (committed-history boundary).

**INV-TP13.** Each Lead tool publishes immediately as its own frozen one-node batch. Visual grouping
uses `(mcpName, toolName, subagentId)` over consecutive keys and must not unmount the head
`ToolLine`; frozen per-batch `toolGroups` on a one-node publication are `solo`. A leaf-only name
never groups calls across MCP servers. Production: `computeToolGroups`, `publicationToolGroups`,
`TranscriptPublisher.#publishTool`, `BlockView`. Tests: `transcript-publication.test.ts` (immediate
one-node batches and equal leaf names from different MCP servers), `tool-groups.test.ts`
(`subagentId` identity) and `transcript-publication-render.test.tsx` (second grouping-eligible tool
does not remount the first live owner).

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

**INV-TP16.** After settlement, native committed owners are bounded by the 80-batch full-mount
ceiling or the 40-batch long-session slice, plus constant boundary hints and the live tail,
independent of completed-turn count. Every renderer lifecycle pass retained across repeated
slice changes remains
reachable from the live OpenTUI root; a destroyed or detached pass is a leak. Production:
`createVisibleSliceController`, `CommittedHistory`. Tests: `transcript-publication-render.test.tsx`
navigation/lifecycle reachability, plus the real-run memory soak required by
[code-performance.md](code-performance.md).

**INV-TP17.** Streaming Markdown alone uses top-level internal blocks; final snapshots use OpenTUI's
default coalesced mode. Production: `AssistantMarkdown`, `StableMarkdown`. Tests:
`markdown-render-contract.test.tsx` and `architecture-boundary.test.ts` (settled-prop audit).

**INV-TP18.** Frozen publications use the same `BlockView`/Markdown/diff/code renderers as ordinary
content. Index-slice admission does not replace tool bodies with geometry placeholders or a syntax
fallback. Production: `PublicationOwner`, `StableMarkdown`, `StableDiff`. Tests:
`transcript-publication-render.test.tsx` (stable Markdown, diff and `write_memory` owners).

**INV-TP19.** Synchronizing an unchanged batch-id list and viewport observation reaches a fixed
point. Slice movement requires a changed publication list, an edge reveal, focus navigation or an
explicit return to tail. Production: `TranscriptVisibleSliceController.sync`, `observe`,
`revealOlder`, `revealNewer`, `ensureBatch`, `returnToTail`. Test:
`transcript-visible-slice.test.ts`.

**INV-TP20.** OpenTUI owns the renderer frames and geometry for committed publications. Clarvis does
not schedule syntax-measurement frames or gate publication on equal dimensions. Production:
`CommittedHistory`, `PublicationOwner`. Tests: `architecture-boundary.test.ts` and
`transcript-window-render.test.tsx`.

**INV-TP21.** Frozen history, handoff artifacts and the mutable frontier for the active projection
form one chronological ScrollBox flow. The tail remains the final flow child after upward input so
OpenTUI can preserve manual-scroll geometry. A Lead frontier artifact's Solid owner survives terminal publication: the tail updates the presented
node with the frozen snapshot and history omits that key until the suffix is released or the index
slice no longer includes it. A following Lead response/tool remains below it in both frames. No
measured handoff spacer is retained. Two `BlockView`s must not share `id={key}` in the same
ScrollBox. Child tools, reasoning and answers cannot enter
this main flow; only the two typed, append-only delegation lifecycle markers may add chronological
Lead rows. Provider composing, started, output and terminal tool plumbing for
supervision/delegation/workflow orchestration cannot enter it either. There is no fixed-height live
**transcript panel** or idle status row inside history; the fixed reading runway and
composer-adjacent Lead activity line remain outside semantic publication. Production:
`CommittedHistory`, `LiveTranscriptTail`, `TranscriptRegion`, `LeadActivityLine`. Test:
`packages/code/tests/integration/transcript-publication-render.test.tsx` (the tail is a direct
history child, child content remains absent from the main capture and later Lead output preserves
chronological flow; scrolling away keeps the live tail mounted and pauses native stick).

**INV-TP22.** While explicit tail-following is active, append-only publication fits the slice to its
newest edge without consulting a pre-layout bottom sample. Upward input disables following;
downward input loads newer slices and re-enables it only at the real content bottom after
the newest frozen owner and mounted live tail. A newer-range
count, when present, is a non-interactive top overlay and never a row below history. It includes both
hidden committed batches and mutable frontier artifacts; repeated deltas for one artifact do not
increase it. Production: `TranscriptVisibleSliceController`, `CommittedHistory`,
`LiveTranscriptTail`. Tests: `transcript-visible-slice.test.ts`,
`transcript-window-render.test.tsx` (multi-append tail, reader anchor, explicit return-to-tail and
keyboard downward-navigation-to-live-tail cases), and
`transcript-publication-render.test.tsx` (off-tail live-frontier indicator and mounted-tail contract).

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
preserves the projected batch object and native owner. Projection memoization retains
at most the latest derived object per weakly held source batch, so identity stability cannot become an
unbounded projection ledger. Production: `projectPublicationBatch`. Test:
`packages/code/tests/integration/transcript-window-render.test.tsx` (unchanged semantic projection
owner identity).

**INV-TP27.** Lead-owned provider tool plumbing for supervision, spawn/delegation and workflow
orchestration is transcript-silent at every event phase. The exact identities are `spawn_subagent`,
`delegate_task`, `agent_list`, `agent_poll`, `agent_stop`, `agent_steer`, `await_agents`, `run_leader`,
`run_workflow`, `run_round`, `run_work_items`, `workflow_status`, `workflow_decide`; composing, started, output and terminal events create
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

**INV-TP29.** One native ScrollBox serves Lead and child projections. Visiting a child swaps the
frozen children of that ScrollBox; returning to Lead restores a numeric `scrollTop` when it still
maps, otherwise it follows the tail. Full-region Workflow/configuration/Plan/Diff pages hide and
pause the transcript without rebuilding it. The weak publication-projection cache retains at most
the Lead plus one child entry. Production: `TranscriptRegion`, `CommittedHistory` (`active`,
`TRANSCRIPT_PROJECTION_CACHE_LIMIT`), `LiveTranscriptTail` (`active`) and `OverlayRegion`
(`overlayFallbackActive`). Tests: `packages/code/tests/integration/transcript-region-render.test.tsx`
(full-region pause/identity and repeated Lead/A/B plateau) and
`packages/code/tests/integration/overlay-region-render.test.tsx` (fallback owner and Yoga geometry
survive repeated full-region visits).

**INV-TP30.** An explicit model submission from the composer is also an explicit navigation request:
normal submit, steer, model-backed prompt and skill execution first select Lead and synchronously
request its newest slice before dispatching the request. The controller mounts the newest index
window and scrolls the native ScrollBox to its real content bottom. The same helper applies when the reader is at the oldest loaded
range or viewing a child. Background transcript, workflow, plan and delegation events never invoke
that navigation and therefore preserve an older reader anchor. Production: `App`
(`submitFromLeadTail`), `CommittedHistoryHandle.returnToTail` and
`TranscriptVisibleSliceController.returnToTail`. Tests:
`packages/code/tests/unit/transcript-visible-slice.test.ts` (explicit tail return),
`packages/code/tests/integration/transcript-window-render.test.tsx` (explicit tail return)
and `packages/code/tests/integration/app-shell-render.test.tsx` (normal submit/steer and model-backed
prompt/skill routes while background append remains anchored).

**INV-TP31.** A running assistant uses the same static bullet as its settled transcript block. It
does not subscribe an ornamental marker inside Markdown history to the shared spinner clock. Live
activity remains visible in a running tool row and in `LeadActivityLine`. That composer-adjacent line
owns phase plus active-run elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt; slash autocomplete
replaces it while open. The footer instead preserves Context plus cumulative Session token totals,
cache-hit percentage and cost before and after settlement, without `Running` or iteration. Plan
state remains exclusive to the Sidebar and `Ctrl+P` surface and contributes no footer summary. The
active total is the full pre-run Session snapshot plus the current live delta, never the resident
transcript aggregate; missing cache detail remains missing across that sum and settlement, while a
reported zero remains visible as `0%`.
Production: `BlockView`, `App`
(`activeSessionUsage`, `leadActivityDetail`, `inputPopupOpen`, `footerRunStrip`,
`compactActivityStrip`), `RunHost.sessionUsageBaseline`, `ActivityStore.currentUsage`, `runStripText` and
`LeadActivityLine`. Tests:
`packages/code/tests/integration/markdown-render-contract.test.tsx` (static streaming marker) and
`packages/code/tests/integration/app-shell-render.test.tsx` (active-run detail ownership,
autocomplete replacement, Plan staying absent from the footer across terminal and later run state,
and the baseline/delta plus known/unknown cache cases retaining exactly the same honest cumulative
usage at settlement), plus
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

**INV-TP33.** Tool-argument progress remains a single mutable frontier node and never enters a
publication batch. Frozen tool snapshots strip both `inputChars` and `inputComplete`; retry removes
the failed attempt's placeholder. Production: `snapshotTranscriptNode` and `TRANSCRIPT_EVENT_POLICY`
in `packages/code/src/adapters/transcript-publication.ts`, plus `openRun` in
`packages/code/src/adapters/store.ts`. Tests:
`packages/code/tests/unit/transcript-publication.test.ts` and
`packages/code/tests/unit/streaming-delta.test.ts`.

**INV-TP34.** A pending elicitation cannot be hidden below an older physical-history reader. When
the request becomes live, `App` explicitly asks the active `CommittedHistoryHandle` to return to its
tail before the composer is hidden. The old composer stays painted but keyboard-inert until the
`active-elicitation` block owns a visible transcript row; `App` then requests the tail again before
hiding that bridge.
If a dirty full-page editor covers the transcript, `App` pauses the transition and restarts it only
when overlay state changes rather than polling renderer frames. `CommittedHistory.returnToTail`
mounts the newest slice and scrolls to the native bottom. When the request clears, the composer
returns and the same native tail request absorbs the card's removal, so no frame loses both
interaction surfaces.
Ordinary background events still retain an older reader anchor; this forced navigation belongs only
to the user interaction that has blocked the run. Production: `packages/code/src/views/App.tsx`
(`elicitComposerHidden`, `revealHistoryTail`, elicitation effect),
`packages/code/src/views/ElicitBlock.tsx` (`active-elicitation`) and
`packages/code/src/views/history/CommittedHistory.tsx` (`CommittedHistoryHandle.returnToTail`). Test:
`packages/code/tests/integration/app-shell-render.test.tsx` ("an elicitation returns an old reader to
the live tail before hiding the composer" and "a pending elicitation does not discard an in-progress
config edit"), which records the transition, proves a covered dirty view stays idle, and requires
each transition frame to contain either the bridge composer or the pending question.

## 6. Failure modes and degradation

| Failure or pressure | Required behavior |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stored-run read throws | settle available semantics, append one degraded annotation, then publish terminal batch |
| incremental events drop | publish `events_dropped`; admitted terminal tool/iteration events remain authoritative, while classified supervision/orchestration tools remain suppressed |
| syntax highlighting rejects | keep the native semantic renderer's readable degradation; slice admission does not introduce another parser or fallback |
| one batch is taller than the viewport | keep it as one direct child; existing semantic display ceilings still apply |
| user reaches hidden history | keep the passive boundary row and slide the index slice without requiring a click |
| user reads older history while events append | retain exact anchor; show any newer count only in the top overlay and admit it through downward scroll |
| user submits while reading older history or a child | select Lead, mount its newest slice and synchronously request the native bottom before dispatch |
| elicitation arrives while the user reads older history | explicitly return the active reader to the live tail and reveal the pending controls after layout; never hide the composer while leaving the blocking question outside the mounted tail |
| index slice moves | unmount owners outside the half-open slice and show at most one passive boundary row on each hidden side |
| terminal width/sidebar/ASCII/height changes | let OpenTUI reflow the mounted direct children; do not start a geometry epoch or queue a scroll correction |
| vertical scrollbar gains or loses overflow | retain the permanently reserved column; change indicator opacity only |
| 20-turn semantic limit is crossed | evict complete batches, reconcile the batch-id slice and install one frozen export notice |
| child activity changes while Lead is selected | retain child content for isolated selection and update footer/Sidebar; append only the delegation's frozen spawned/settled Lead markers, never child content, a live marker or provider supervision/orchestration tool plumbing |
| child or full-region page is opened and closed | pause the hidden projection and reveal the same retained Lead ScrollBox/controller on return; retain at most one child and destroy the previous child when another is selected |
| workflow activity changes | update the footer strip/Sidebar only; mount no workflow row in either transcript projection |
| a provider emits only a composing or started supervision/orchestration tool phase | suppress it immediately; typed delegation events or Sidebar/footer workflow state remain authoritative |
| future loader/progress feature is added | keep transcript content before the fixed runway, place operational state in Sidebar/footer, or reuse the fixed Lead activity line; it cannot reserve a second transcript panel or move committed rows |

The stable fallback priority is readable content without repeated visual transition. A parser failure
may lose highlighting for one artifact; it cannot make a published artifact alternate between parsed,
raw and transparent frames.

## 7. Coupling

| Concern | Owner | Constraint here |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `RunEvent` vocabulary and durability | [kernel-runs.md](kernel-runs.md) | publication classifies the closed union but cannot change persistence policy |
| live handle, stored read and session ownership | [code-run-host.md](code-run-host.md) | host calls `complete` only after reconciliation or definitive degradation |
| node presentation and display caps | [code-transcript.md](code-transcript.md) | publisher freezes existing bounded projections; the index window does not estimate them |
| session reconstruction | [sessions.md](sessions.md) | restored trace order rebuilds semantic batches; the visible slice starts at the newest edge |
| elicitation | [elicitation.md](../cross-cutting/elicitation.md) | pending controls stay live; only terminal outcomes may publish |
| plan/workflow capabilities | capability specs, footer strip and Sidebar | workflow state never enters either transcript; mutable plan singleton/progress state never enters frozen history |
| renderer version and memory | [code-performance.md](code-performance.md) | OpenTUI packages move in lockstep; owner soak validates the bounded index window |

Code's protocol-isolation rule remains unchanged: the publisher consumes `@clarvis/protocol` events
through the run host and does not import loop or kernel implementation. Adapters do not import views;
the view receives frozen types through a narrow publication port.

## 8. Open questions

The full-mount ceiling, long-session slice size and edge-reveal step are current product constants.
Changing them requires renderer/soak evidence and a spec update; it cannot reintroduce estimated
ordinary paging or an unbounded mounted owner list.

OpenTUI core/keymap/Solid are pinned together at 0.5.9. An upgrade must rerun tree-shape,
recorded-frame, resize, owner-balance, full `@clarvis/code` and built PTY gates. A PTY validates real
terminal integration; deterministic recorder tests remain authoritative for frame identity, direct
children and exact cells that human observation cannot count reliably.
