# Transcript records, row identity and native viewport stability

## 1. Purpose

The transcript has one ordered projection of row IDs. Live and terminal content use the same
resident row owner. Sealing a result, completing a run, receiving another message or reconciling
stored events must not move that row between component trees.

Stability means identity, semantic order, reader intent and bounded native residence, not constant
height. Streaming, expansion and wrapping may change height. The execution store owns facts;
the row projection is derived; focus, expansion and reading position are separate UI state.

Tool presentation and bounded payloads are owned by [code-transcript.md](code-transcript.md).
Host completion is owned by [code-run-host.md](code-run-host.md). Measurement discipline is owned
by [code-performance.md](code-performance.md). No persisted pixel, fold or window format is introduced.

## 2. Surface

- [identity.ts](../../packages/code/src/core/transcript/identity.ts):
  `TranscriptEventIdentity`, `TranscriptRowId`, `TranscriptRecordId`, `TranscriptProjectionId`.
- [records.ts](../../packages/code/src/core/transcript/records.ts): bounded terminal snapshots.
- [tool-lifecycle.ts](../../packages/code/src/core/transcript/tool-lifecycle.ts):
  pure phase transitions, cumulative composition counts and terminal absorption.
- [rows.ts](../../packages/code/src/core/transcript/rows.ts): explicit exploration eligibility,
  first admission, closed membership, retention and authoritative insertion.
- [window.ts](../../packages/code/src/core/transcript/window.ts): pure resident intervals and
  `ReaderPosition`, without native geometry or framework imports.
- [transcript-content.ts](../../packages/code/src/adapters/transcript-content.ts):
  terminal sealing and coherent authoritative corrections.
- [transcript-projection.ts](../../packages/code/src/adapters/transcript-projection.ts):
  reactive row IDs and independently resolved records.
- [TranscriptViewport.tsx](../../packages/code/src/views/transcript/TranscriptViewport.tsx):
  one native ScrollBox, cancellable post-layout anchor transactions and projection readers.
- [TranscriptRowView.tsx](../../packages/code/src/views/transcript/TranscriptRowView.tsx),
  [ToolRow.tsx](../../packages/code/src/views/transcript/ToolRow.tsx) and
  [ExplorationRow.tsx](../../packages/code/src/views/transcript/ExplorationRow.tsx):
  resident owners reusing the existing individual block and tool registry.

There is no live/history handoff, rendering publication batch, head/member painting role,
hidden per-child transcript or public migration flag.

## 3. Data and formats

Tool record identity includes execution, actor and call identity. Durable announcements add
iteration and physical attempt to distinguish provider retries that reuse a call ID. The
JSON-tuple tool span prevents delimiter collisions. A terminal without a call ID receives
a deterministic durable-terminal ordinal; it is not guessed to belong to an earlier started call.

Prose retains its execution/actor/iteration identity and provider `response_phase`. No visible
synthetic phase label is inserted. Delegation markers use delegation ID and marker kind; titles
are display data, never identity.

Rows contain references, not copied tool payloads. An exploration row ID derives from its first
member and survives that member's later retention eviction while other members remain.
A surviving record has exactly one destination. Ordinary first admission appends; reconciliation
may insert an unknown row before a known row without changing the relative order of known rows.

`ReaderPosition` is either `{ mode: "tail" }` or an anchor row ID with viewport-relative
`screenY`. Pixel offsets are native, local geometry, not cross-projection identity.

## 4. Behavior

### Content and lifecycle

The tool wrapper exists during composing, pending, running and terminal states. Cumulative input
counts are not parsed as valid arguments. Terminal output replaces the incremental buffer.
Late deltas and duplicate starts do not reopen a terminal call. Cancellation and interruption
remain distinguishable from an authoritative tool failure.

Terminal inline content is bounded and frozen before mutable detail retention can discard a body.
Unrelated updates keep the same sealed object. An authoritative replay correction is staged and
published at the reconciliation boundary with the same record ID. Detail hydration cannot silently
mutate the inline snapshot. `TranscriptRunSink.complete` remains the host's post-reconciliation
boundary for the run outcome; a received `run_ended` does not replace it.

### Exploration

Only explicitly allowlisted observing tools qualify. Shell, mutations, unknown tools and qualified
MCP names remain individual. A group exists with one member; no timer waits for a sibling.
Different eligible read/search names may share a contiguous execution/actor/iteration segment.
Prose, notices, delegation and a new iteration close membership. Late results update a member
without reopening the segment. Errors remain indicated in the folded header.

An open group mounts one page of 20 member IDs. Explicit expansion is retained outside the owner.
Opening a group never authorizes unlimited payload hydration or mounting all members.
The folded header exposes failure counts; “Open first issue” opens the corresponding bounded
member page and the failed member. Individual folded failures retain a short sanitized reason;
shell failures retain their parsed exit code instead of printing a serialized result envelope.

### Viewport and reader intent

Rows are direct ScrollBox children where possible. Native sticky bottom follows the tail; native
culling remains enabled and the scrollbar gutter is stable. The viewport is the sole programmatic
scroll owner. Data ingestion coalesces resident-list changes until a native frame, avoiding
intermediate native trees during event bursts.

Up to 80 rows mount in a short projection. Longer projections normally mount 40 rows, with
20-row paging and at most 80 rows during an anchor-preserving transition. Active off-window tools
continue as data, not hidden native owners.

Scrolling away from the tail pauses follow. New data does not move the anchor. Reaching a window
edge reveals adjacent retained rows; it is not the end of the conversation while newer rows are
hidden. End/return-to-tail explicitly selects the tail and restores native sticky behavior.
Repeated unchanged frames at the upper edge are not new wheel intent.

A transaction captures semantic intent, updates residence/content/width, then compensates the same
row after OpenTUI's native layout frame. The callback checks its projection and generation token.
User navigation or another projection invalidates obsolete work. Each transaction has at most
three missing-layout attempts and a deterministic surviving-row/empty-content fallback. No hidden
measurement tree, global height cache or per-paint scroll correction is used.

After rewrap, the same row remains the reference; its internal text position is approximate when
no stable internal marker exists. In unchanged geometry, the viewport-relative offset is preserved.
Selection can retain additional resident rows only within the 80-row ceiling; exceeding the ceiling
requires clearing selection and is reported instead of silently discarding selected content.

### Lead and child navigation

Lead and children use the same row store and viewport. Only the selected projection has a native
tree. Lead retains navigable creation and terminal delegation markers; continuing child activity
belongs in the existing Agents surface. An orchestration call returning a handle does not complete
the child scope. Unknown attribution is isolated with an explicit provenance notice, never
relabelled as Lead content.

First visits start at the tail. Returning restores that projection's semantic reader. Child
navigation remains available after restart even if the latest run's activity roster is empty:
the selected historical child's durable marker supplies its header, with a “Back to Lead” action.
Production: `TranscriptRegion` child navigation.
Test: `transcript-window-render.test.tsx`, restored child without current activity.

Rapid A-to-B-to-Lead navigation invalidates prior layout callbacks. Background events do not choose
the projection. Global host interactions remain accessible independently of transcript selection.
Clearing/replacing the session releases reader and expansion state.

## 5. Invariants

1. Resident row and individual presenter owners survive tool phase transitions and the next message.
   Production: `TranscriptRowView`, `ToolRow`.
   Test: [transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
   “one native row survives composition, pending, execution, terminal and next message”.
2. Group membership is explicit, ordered, actor-scoped and independent of completion timing.
   Production: `TranscriptRows`, `isExplorationTool`.
   Test: [tool-groups.test.ts](../../packages/code/tests/unit/tool-groups.test.ts) and
   [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts).
3. Sealed content stays immutable except for an explicit coherent authoritative revision.
   Production: `TranscriptContent`, `snapshotTranscriptNode`.
   Test: [transcript-content.test.ts](../../packages/code/tests/unit/transcript-content.test.ts).
4. Native residence is bounded at the short/long transition, for large groups and above 1,000 rows.
   Production: `TranscriptWindow`, `TranscriptViewport`, `ExplorationRow`.
   Test: [transcript-window.test.ts](../../packages/code/tests/unit/transcript-window.test.ts),
   [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx)
   and `transcript-rows-render.test.tsx`.
5. Concurrent append and prepend preserve the reader reference; idle upper-edge frames do not rewind.
   Production: `TranscriptViewport` anchor transactions and native input handling.
   Test: `transcript-window-render.test.tsx`, prepend/concurrent-append and wheel-intent cases.
6. Projection navigation restores independent readers and mounts no inactive child tree.
   Production: `TranscriptViewport`, `createTranscriptState`.
   Test: `transcript-window-render.test.tsx`, 100 Lead/child cycles.
7. Grouping does not read tool payload fields on the streaming hot path.
   Production: `createTranscriptProjection`, `TranscriptRows`.
   Test: [transcript-grouping-fields.test.ts](../../packages/code/tests/unit/transcript-grouping-fields.test.ts).
8. Terminal phases absorb later incremental lifecycle updates.
   Production: `reduceToolLifecycle` in `tool-lifecycle.ts` and the store's authoritative terminal path.
   Test: [tool-lifecycle.test.ts](../../packages/code/tests/unit/tool-lifecycle.test.ts).
9. Failure access does not require mounting an entire exploration group.
   Production: `ExplorationRow` and `ToolLine` in
   [blocks.tsx](../../packages/code/src/views/blocks.tsx).
   Test: [tool-groups-render.test.tsx](../../packages/code/tests/integration/tool-groups-render.test.tsx)
   and [tool-registry-render.test.tsx](../../packages/code/tests/integration/tool-registry-render.test.tsx).

## 6. Failure modes and degradation

Host retention is finite. A folded-prefix notice states that earlier content is no longer resident;
the viewport does not invent a backfill API. Explicit detail hydration keeps existing caps,
queue limits and recovery notices. Failure to fetch a result does not leave an infinite spinner.

An interrupted scope without authoritative tool outcome is not rendered as successful execution.
Missing attribution is visible as a provenance limitation. A missing anchor falls back within
the selected projection, never to another child's pixel offset.

Renderer tests establish deterministic native identity and geometry. They do not establish real
provider behavior, PTY interaction, cross-platform support or a stabilized RSS regression verdict.

## 7. Coupling

Protocol and kernel own transportable lifecycle and attribution. Loop/capability/trace own the
minimal durable announcement. These layers do not import UI state. The code adapter maps facts,
the pure transcript modules model references and bounds, and views own Solid/OpenTUI instances.
Tool execution, authorization, goals and workflow completion retain their existing owners.

Transcript content/projection modules do not import activity surfaces, run-host orchestration or
native presentation. Production: `TranscriptContent`, `createTranscriptProjection` and the pure
`core/transcript` modules. Test:
[architecture-boundary.test.ts](../../packages/code/tests/architecture/architecture-boundary.test.ts),
“keeps transcript content and projection independent from activity surfaces”. The assertion scans
the existing model modules and explicit adapter files, not a removed history directory.

OpenTUI core/keymap/solid remain pinned at 0.5.9. An upgrade needs separate evidence.

## 8. Open questions

The 33 ms p95 streaming target and 10% stabilized RSS/interaction regression budget require
comparable artifact, dimensions, warm-up and three samples. A failed historical benchmark is not
a numerical baseline. Native-platform and real-provider results must be reported separately from
deterministic fixtures, including any unverified platform.
