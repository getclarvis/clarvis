# Transcript segmentation, blocks, tool-call rendering and identity

> Implemented at `packages/code/src/core/transcript/**`, `packages/code/src/views/**` and
> `packages/code/src/adapters/{tool-identity,tool-parsers,plan-projection,workflow-projection,message-content,event-span}.ts`.
> Every claim below is anchored to a file and a named symbol or test. Open questions are collected in the final
> section.

---

## 1. Purpose

This subsystem turns an already-reduced array of semantic transcript nodes into what the terminal
actually paints, and it does so under hard resource ceilings. It owns **how one current snapshot
renders**. It no longer owns the cross-event question of when a snapshot becomes historical,
whether background work may move/remount it, or where mutable loaders live. The current
committed-history/live-frontier contract for those questions is isolated in
[code-transcript-stability.md](code-transcript-stability.md). Semantic filtering, grouping and
legacy reordering remain described here as rendering inputs. Physical residency is delegated to a
bounded index slice of publication batches. Committed history consumes grouping/section metadata already frozen
by the publisher; the mutable tail still derives those projections live.

Within that scope it owns four concerns that are visible in the code as four separate layers:

1. **Framework-free projection** (`src/core/transcript/**`) — the node type union
   (`packages/code/src/core/transcript/types.ts`), the presenter strings a node renders as
   (`packages/code/src/core/transcript/presenters.ts`), the bounded display projection of a tool call's payload
   (`packages/code/src/core/transcript/tool-display.ts`), and prefix-stable Markdown segmentation of a streaming assistant reply
   (`packages/code/src/core/transcript/segment.ts`, `packages/code/src/core/transcript/segment.ts`). Nothing here imports Solid or OpenTUI — an architecture test
   enforces that (`packages/code/tests/architecture/architecture-boundary.test.ts`).
2. **View-state derivation** (`src/views/transcript-{state,completion}.ts`, `tool-groups.ts`,
   `subagent-sections.ts`, `block-focus.ts`) — choosing the Lead-only main projection or one
   explicitly selected sub-agent's isolated projection, regrouping that current projection
   (`packages/code/src/views/subagent-sections.ts`), collapsing runs of identical tool calls
   (`packages/code/src/views/tool-groups.ts`), and tracking fold overrides and keyboard focus
   (`packages/code/src/views/block-focus.ts`, `packages/code/src/views/block-focus.ts`).
3. **Rendering** (`src/views/blocks.tsx`, `src/views/tools/**`, `Prose.tsx`, `spinner.ts`,
   `truncate.ts`) — one Solid component per node kind (`packages/code/src/views/blocks.tsx`), a per-tool renderer
   registry (`packages/code/src/views/tools/registry.tsx`), a one-line argument signature (`packages/code/src/views/tools/signature.ts`), and a
   line-count gate that collapses an oversized delegated mutation behind a `+N −M` chip while the
   run lead's mutations stay visible (`isLeadMutation` and `isOversizeMutation` in
   `packages/code/src/views/tools/mutation-gate.ts`).
4. **Identity** (`adapters/tool-identity.ts`) — the single rule for "which name is this call",
   used by the renderer registry, the signature table, the grouping pass and the mutation gate alike
   (`toolIdentity` in `packages/code/src/adapters/tool-identity.ts`).

Beside those four sits the transcript's persistent companion chrome — the responsive Sidebar, the
bounded agent/workflow footer strip and the composer-adjacent Lead activity band. Plan activity
lives only in the Sidebar or `Ctrl+P`; it contributes no footer text. Workflow activity remains in
the Sidebar/footer, never in the transcript. There is no lower Plan pane between history and the
composer. The sub-agent roster also lives in that chrome; selecting one row changes the transcript
to that child's isolated semantic projection. These surfaces are treated in section 4.19.

The recurring problem the code solves is cost: a long streaming reply re-parsed on every delta, a
100 KiB tool payload handed to a native text renderable, a 6,000-node session mounted at once. The
answers are, respectively, prefix-stable segmentation
(`packages/code/src/core/transcript/segment.ts`), a cached bounded payload projection
(`packages/code/src/core/transcript/tool-display.ts`), and the native ScrollBox index slice
owned by [code-transcript-stability.md](code-transcript-stability.md).

---

## 2. Surface

### 2.1 `src/core/transcript/index.ts` — the barrel

| Export | Kind | Source |
| --- | --- | --- |
| `NodeStatus`, `TranscriptMessageNode`, `TranscriptNode`, `TranscriptPlanTask` | types | `packages/code/src/core/transcript/types.ts` |
| `guardReviewLabel(node): string` | fn | `packages/code/src/core/transcript/guard-review.ts` |
| `transcriptDisplayText(node): string` | fn | `packages/code/src/core/transcript/presenters.ts` |
| `planMetaText(node): string` | fn | `packages/code/src/core/transcript/presenters.ts` |
| `compactionNoticeText`, `compactionSkippedNoticeText` | fn | `packages/code/src/core/transcript/presenters.ts` |
| `visionNoticeText`, `softLimitNoticeText` | fn | `packages/code/src/core/transcript/presenters.ts` |
| `steerNoticeText`, `steerQueuedNoticeText`, `steerUndeliveredNoticeText` | fn | `packages/code/src/core/transcript/presenters.ts` |
| `subagentFocusToast(title): string` | fn | `packages/code/src/core/transcript/presenters.ts` |
| `projectTranscriptToolDisplay`, `TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS`, `TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE`, `TranscriptToolDisplayProjection` | fn/const/type | `packages/code/src/core/transcript/tool-display.ts` |
| `IncrementalMarkdownSegmenter`, `IncrementalMarkdownSegments`, `StableMarkdownSegment`, `MarkdownSegments` | class/types | `packages/code/src/core/transcript/segment.ts` |

Exported from their modules but **not** re-exported through the barrel:
`TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS` (`packages/code/src/core/transcript/presenters.ts`), `TRANSCRIPT_PROSE_RELEASED_DISPLAY`
(`packages/code/src/core/transcript/presenters.ts`), `TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE` (`packages/code/src/core/transcript/presenters.ts`),
`transcriptDisplayTextChars` (`packages/code/src/core/transcript/presenters.ts`),
`segmentMarkdown` (`packages/code/src/core/transcript/segment.ts`) and the four segmentation constants
(`packages/code/src/core/transcript/segment.ts`).

### 2.2 `adapters/tool-identity.ts`

| Symbol | Signature | Declaration |
| --- | --- | --- |
| `toolIdentity` | `(mcpName?: string, toolName?: string) => string` | `toolIdentity` |
| `toolLabel` | `(mcpName?: string, toolName?: string) => string` | `toolLabel` |
| `isTranscriptExternalOrchestrationTool` | `(mcpName?: string, toolName?: string) => boolean` | `isTranscriptExternalOrchestrationTool` |
| `toolDisplayLabel` | `(mcpName?: string, toolName?: string) => string` | `toolDisplayLabel` |
| `MUTATION_TOOLS` | `Set<string>` | `MUTATION_TOOLS` |
| `isMutationTool` | `(mcpName?: string, toolName?: string) => boolean` | `isMutationTool` |

`MUTATION_TOOLS` is `FILE_MUTATING_TOOL_NAMES` (imported from `@clarvis/kernel/policy`,
`packages/code/src/adapters/tool-identity.ts`) unioned with the literal `["write_memory","edit_memory","delete_memory"]`
(`MEMORY_MUTATING_TOOL_NAMES` in `packages/code/src/adapters/tool-identity.ts`). `FILE_MUTATING_TOOL_NAMES` is itself derived —
`packages/kernel/src/policy.ts` re-exports
`packages/loop/src/runtime/tools/builtin/names.ts`'s `FILE_MUTATING_TOOL_NAMES`: every explicit file
mutation. Command runners, including per-call host escalation on `shell`, stay in the exec set.

`toolDisplayLabel` is distinct from `toolLabel`: when both `mcpName` and `toolName` are present it
returns the raw `server:tool` unchanged, otherwise it resolves `toolIdentity` through
the 11-entry `BUILTIN_TOOL_LABELS` table — `await_agents` → "Wait for agents",
`agent_poll` → "Check agent", `agent_steer` → "Steer agent", `agent_stop` → "Stop agent",
`delegate_task` → "Delegate task", `run_leader` → "Start workflow leader", `run_workflow` → "Run
workflow", `run_round` → "Run workflow rounds", `run_work_items` → "Run work items",
`workflow_status` → "Check workflow", `workflow_decide` → "Decide workflow" — falling back to
the bare identity for anything not in the table. This is what remaps the engine's internal
orchestration-tool names to product-facing labels while leaving a real MCP call's `server:tool`
identity untouched. Test: `packages/code/tests/unit/tool-identity.test.ts` ("toolDisplayLabel
translates orchestration internals but preserves MCP identity").

Those labels do not grant a Lead-owned orchestration call transcript visibility. The closed
supervision/orchestration set — `spawn_subagent`, `delegate_task`, `agent_list`, `agent_poll`,
`agent_stop`, `agent_steer`, `await_agents`, `run_leader`, `run_workflow`, `run_round`,
`run_work_items`, `workflow_status`, `workflow_decide` — is suppressed from the Lead projection before a composing, started,
streaming-output or terminal tool row can become a frontier candidate or publication batch. Thus
even temporary copy such as `Wait for agents starting…` is invalid in the Lead transcript. Ordinary
Lead `thinking`/`working` state is not a tool row and remains eligible for the fixed activity line
outside the transcript; a child-attributed tool remains available only in that child's explicitly
selected transcript. Production:
`isTranscriptExternalOrchestrationTool`, `createTranscriptStore` (`openRun`) and
`TranscriptPublisher.#publishTool`. Test: `streaming-delta.test.ts` ("Lead-owned orchestration tools
never create composing, started, or terminal nodes").

### 2.3 `views/tools/registry.tsx`

| Symbol | Signature |
| --- | --- |
| `ToolCallView` | interface: `mcpName, toolName, arguments, result, diff?, error, status, full?, ungatedMutationBody?, wrap?, mutation?` |
| `ToolRenderer` | `(call: ToolCallView) => JSX.Element` |
| `ClampedCode` | `(props: {content, filetype, full?, wrap?: "none"\|"char"\|"word"})` |
| `diffHeaderPath` | `(diff: string) => string \| undefined` |
| `resolveToolRenderer` | `(mcpName, toolName) => ToolRenderer` |
| `hiddenBodyLines` | `(mcpName, toolName, result) => number` |
| `resolveErrorRenderer` | `(mcpName, toolName) => ToolRenderer` |
| `renderToolPreview` | `(mcpName, toolName, args) => JSX.Element` |

### 2.4 `views/tools/mutation-gate.ts` and `views/tools/signature.ts`

| Symbol | Signature / value | File |
| --- | --- | --- |
| `MUTATION_GATE_LINES` | `40` | `packages/code/src/views/tools/mutation-gate.ts` |
| `DiffStats` | `{ added, removed, lines }` | `packages/code/src/views/tools/mutation-gate.ts` |
| `diffStats(diff)` | counts `+`/`-` rows, skips `+++`/`---` | `packages/code/src/views/tools/mutation-gate.ts` |
| `formatStatsChip(s)` | `{ added, removed, tail }` spans | `packages/code/src/views/tools/mutation-gate.ts` |
| `MutationNode` | `{ mcpName?, toolName?, subagentOrder?, diff?, args? }` | `packages/code/src/views/tools/mutation-gate.ts` |
| `isLeadMutation(node)` | mutation identity with no `subagentOrder` | `isLeadMutation` |
| `mutationBody(node)` | `string` (`""` when the identity has no gated body) | `packages/code/src/views/tools/mutation-gate.ts` |
| `mutationStats(node)` | `DiffStats \| null` | `packages/code/src/views/tools/mutation-gate.ts` |
| `isOversizeMutation(node)` | `boolean` | `packages/code/src/views/tools/mutation-gate.ts` |
| `formatToolCall(mcpName, toolName, args)` | `string`, always parenthesised | `packages/code/src/views/tools/signature.ts` |
| `resolveToolCallSignature(node, args?)` | resident `signature` or `formatToolCall` | `packages/code/src/views/tools/signature.ts` |
| `VALUE_MAX` / `SIGNATURE_MAX` | `56` / `72` | `packages/code/src/views/tools/signature.ts` |

### 2.5 `views/blocks.tsx` and `ui/patterns/stable-syntax.tsx`

| Symbol | Signature / value | File |
| --- | --- | --- |
| `MEASURE_MAX_COLS` | `110` | `ui/patterns/stable-syntax.tsx` |
| `capitalize(s)` | `string` | `ui/patterns/stable-syntax.tsx` |
| `taskTone(status)` | `ToneStyle` | `ui/patterns/stable-syntax.tsx` |
| `composingLabel(chars, complete?, streamChars?)` | zero-byte `"waiting for arguments…"`, cumulative `"receiving arguments… N chars"`, or final `"arguments ready · N chars"`, with a separate optional provider-stream count | `packages/code/src/views/blocks.tsx` |
| `railColor(node)` | `string` | `packages/code/src/views/blocks.tsx` |
| `agentGlyph(status)` | `string` | `packages/code/src/views/blocks.tsx` |
| `BlockView(props)` | the one transcript block component | `packages/code/src/views/blocks.tsx` |
| `StableMarkdown(props)` | retained streaming/final Markdown handoff plus per-geometry-epoch streaming row high-water | `packages/code/src/ui/patterns/stable-syntax.tsx` |
| `StableDiff(props)` | normalized diff with syntax-ready reveal | `packages/code/src/ui/patterns/stable-syntax.tsx` |
| `waitForSyntaxFrame(root, current, renderer)` | waits for descendant `CodeRenderable.highlightingDone` and a confirming paint | `packages/code/src/ui/patterns/stable-syntax.tsx` |

`BlockView`'s props: `node`, `maxWidth?`, `forceExpand?`, `folded?`, `group?`, `sectionHeader?`,
`overrideOf?`, `focused?`, `onToggle?`, `onOpenDetail?`, `defaultFolded?`, and
`fillAvailableWidth?` (`packages/code/src/views/blocks.tsx`, `BlockView`).

### 2.6 Semantic projection versus physical residency

`TranscriptState.semanticNodes` exposes the complete ordered semantic projection for the current
view: Lead-owned nodes when no sub-agent is selected — including the two bounded lifecycle markers
for each delegation — or nodes for exactly one selected child. It does not estimate rows, slice a
page or label hidden turns. The immutable publisher and backing store retain the complete resident
ledger, including child nodes hidden from the main view;
`CommittedHistory` later maps batches matching the active projection into the
bounded index window defined by
[code-transcript-stability.md](code-transcript-stability.md). This separation lets grouping, focus
and detail navigation retain the complete active projection while OpenTUI mounts only the selected
batch slice. Native wheel/trackpad input updates the ScrollBox normally; reaching an edge slides the
slice, and focus navigation includes its target batch before scrolling it into view. Projection
completeness therefore does not require estimated or measured spacer geometry.

### 2.7 `views/transcript-state.ts`

`TranscriptStateDeps` : `nodes()`, optional `detailNodes()`, optional `preserveOrder`,
`subagents()`, `notify(message)`, `defaultFolded?(key)`, `rehydrate?(key)`.

`TranscriptState` : `grouped`, `toolGroups`, `semanticNodes`, `expandAll`,
`selectedSubagent`, `focusedKey`, `folded(key)`, `overrideOf(key)`, `toggleAt(key)`, `reset()`,
`toggleSubagent(id)`, `cycleSubagent()`, `toggleExpandOrBlock()`, `focusBlock(delta)`,
`clearFocus()`, `pickDiffNode()`.

Also exported: `withRunMarkersLast(nodes)`.

### 2.8 Remaining modules

| Module | Exports | File |
| --- | --- | --- |
| `views/tool-groups.ts` | `MIN_GROUP = 2`, `ToolGroupInfo`, `computeToolGroups`, `aggregateStatus`, `failureCount` | — |
| `views/subagent-sections.ts` | `SectionHeader`, `GroupedTranscript` (incl. `anchors: Map<string,string>`), `computeGroupedNodes` | / |
| `views/block-focus.ts` | `BlockOverride`, `Overrides`, `isFoldedAway`, `computeFocusables`, `toggleOverride`, `nextFocus` | — |

| `views/transcript-markdown.ts` | `transcriptMarkdownHeader`, `renderTranscriptMarkdownChunks`, `renderTranscriptMarkdown` | — |
| `views/truncate.ts` | `truncateEnd`, `truncateStart`, `fmtCount`, `moreChip`, `padColumn` | — |
| `views/spinner.ts` | `SPINNER_FRAMES`, `SPINNER_ASCII`, `charForFrame`, `spinnerChar`, `thinkingDots`, `tickNow`, `formatElapsed` (re-export), `useSpinnerClock` | — |
| `views/Prose.tsx` | `Prose`, `stripDocChrome` | — |
| `views/Sidebar.tsx` | `PLAN_SIDEBAR_TASK_LIMIT`, `planTaskWindow`, `contextMeter`, `rosterSummary`, `subagentProgress`, `Sidebar` | source symbols |
| `views/activity-detail.ts` | `ActivityDetail`, `activityPreview` | source symbols |
| `views/overlays/ActivityDetail.tsx` | `ActivityDetail` | source symbol |
| `core/marks.ts` | `MarkForms`, `MarkName`, `GLYPHS`/`GlyphForms`/`GlyphName` aliases, `applyAsciiMode`, `asciiMode`, `mark`, `glyph` (`@deprecated`), `borderChars` | — |
| `core/format-elapsed.ts` | `formatElapsed` | — |
| `core/run-status.ts` | `StatusMark`, `StatusSegment`, `StatusLine`, `plainStatusLine`, `memoryNoticeStatus`, `progressStatus`, `LiveRunLineInput`, `liveRunStatus` | — |
| `core/attention.ts` | `AttentionRenderer`, `AttentionState`, `Attention`, `createAttention` | — |
| `adapters/message-content.ts` | `contentToText` | — |
| `adapters/event-span.ts` | re-exports `deriveEventSpan`/`EventSpan` from `@clarvis/kernel/policy`; declares `EventSource = "live" \| "replay"` | — |
| `adapters/plan-projection.ts` | `PlanTaskActivity`, `PlanActivity`, `isLivePlan`, `isExpectedPlanDiscard`, `isAvailablePlan`, `PlanProjectionEvent`, `reducePlanProjection`, `currentPlanTask` | source symbols |
| `adapters/workflow-projection.ts` | `WorkflowNodeStatus`, `WorkflowNodeActivity`, `WorkflowActivity`, `WorkflowProjectionEvent`, `reduceWorkflowProjection`, `workflowLeaderCounts` | — |
| `adapters/tool-parsers.ts` | `BashResult`, `parseBash`, `ReadFileParsed`, `parseReadFile`, `GrepGroup`, `parseGrepContent`, `parsePathList`, `Edit`, `editsFromArgs`, `synthesizeUnifiedDiff`, `parseJsonObject`, `ReadFilesSection`, `parseReadFiles`, `MonitorParsed`, `parseMonitor` | — |

---

## 3. Data and formats

Nothing in this subsystem is persisted. Everything is either in-memory projection or terminal
output. The formats that matter are the *node* shape, the *keys* it is addressed by, and the tool
result texts the parsers accept.

### 3.1 The transcript node union

`TranscriptNode` is a discriminated union on `kind` (`packages/code/src/core/transcript/types.ts`), sharing
`TranscriptNodeBase = { key, status, agentLabel?, subagentOrder?, subagentId?, model?, startedAt?,
elapsedMs? }` (`packages/code/src/core/transcript/types.ts`).

| `kind` | Extra fields | File |
| --- | --- | --- |
| `user` / `assistant` / `reasoning` / `thinking` | `text`, `assistantPhase?`, `sourceExecutionId?`, `sourceTextFingerprint?`, `textTruncated?`, `proseReleased?`, `textEpoch?` | `packages/code/src/core/transcript/types.ts` |
| `tool_call` | `text`, `mcpName?`, `toolName?`, `args?`, `result?`, `diff?`, `error?`, `warn?`, `guard?`, `liveOutput?`, `inputChars?`, `inputComplete?`, `dehydrated?`, `hydrationNotice?`, `signature?`, `mutation?` | `packages/code/src/core/transcript/types.ts` |
| `run` | `text`, `reason?`, `disposition?`, `toolCalls?`, `inputTokens?`, `outputTokens?` | `packages/code/src/core/transcript/types.ts` |
| `subagent` | `text`, `title?`, `reason?`, `toolCalls?`, `inputTokens?`, `outputTokens?` | `packages/code/src/core/transcript/types.ts` |
| `plan` | `text`, `planTitle?`, `planStatus?`, `planReview?`, `planRemoved?`, `planDiscarded?`, `tasks?`, `revision?` | `packages/code/src/core/transcript/types.ts` |
| `annotation` | `text`, `tone?: "info"\|"warn"\|"accent"` | `packages/code/src/core/transcript/types.ts` |
| `error` | `text`, `error?` | `packages/code/src/core/transcript/types.ts` |

`NodeStatus = "running" | "ok" | "error" | "pending"` (`packages/code/src/core/transcript/types.ts`).

Run separators retain the successful event's `disposition`. A checkpoint renders `Checkpoint saved`
in live, reconciled and restored history; ordinary success renders `Completed`. Failure/cancellation
status takes precedence over disposition. This marks a stage ending, not a goal completion or an
authorization to continue. The store preserves the run node's identity during reconciliation.
Production: run closure in [store.ts](../../packages/code/src/adapters/store.ts), `TranscriptRunNode`
in [types.ts](../../packages/code/src/core/transcript/types.ts), and `runOutcome` in
[blocks.tsx](../../packages/code/src/views/blocks.tsx).
Test: [checkpoint-render.test.tsx](../../packages/code/tests/integration/checkpoint-render.test.tsx)
exercises live/replay, reconciliation identity, ordinary completion and unsuccessful outcomes.

`packages/code/src/adapters/store.ts` re-derives `TranscriptNode` by replacing the plan variant's `tasks` with
`PlanTaskActivity[]`; every view module imports the node types from `adapters/store.ts`, not from
core (e.g. `packages/code/src/views/blocks.tsx`, `packages/code/src/views/tool-groups.ts`,
`packages/code/src/views/transcript-state.ts`).

### 3.2 Node key format

Keys are strings with meaning encoded as prefixes. Three consumers parse them:

| Pattern | Meaning | Read at |
| --- | --- | --- |
| `<execId>::<span_id>` | a node belonging to run `execId` | `packages/code/src/views/transcript-state.ts`, `packages/code/src/views/subagent-sections.ts` |
| `<execId>::run` | that run's terminal marker | `packages/code/src/views/transcript-state.ts` |
| `user:<n>` | a locally sequenced user message | produced by `packages/code/src/adapters/store.ts` (`addUser`) |
| `local:<n>` | a locally-appended `!bash` node | `packages/code/src/views/subagent-sections.ts`, produced at `packages/code/src/adapters/store.ts` |

The `<span_id>` half comes from `deriveRunEventSpan` in the kernel, re-exported through
`packages/code/src/adapters/event-span.ts`:
`"run"`, `lead:<n>`, `<subagentId>:<n>`, `subagent:<delegationId>`, `workflow:<runId>`, or a tool
`call_id` — with `tool_call` falling back to `` `${agent}:tool` `` when it carries no `call_id`
(the `tool_call` branch of `deriveRunEventSpan`, mirrored at
`packages/code/src/adapters/store.ts`).

### 3.3 The bounded tool-display projection

`TranscriptToolDisplayProjection` (`packages/code/src/core/transcript/tool-display.ts`) is the only payload shape a live tool
renderer may inspect. Its budgets:

| Constant | Value |
| --- | --- |
| `TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS` | `64 * 1024` per independent string field |
| `ARGUMENT_VALUE_CHARS_BUDGET` | `40 * 1024` across all argument values |
| `ARGUMENT_NODE_BUDGET` | `512` visited nodes |
| `ARGUMENT_DEPTH_BUDGET` | `16` |
| `ARGUMENT_KEY_CHARS_MAX` | `512` |

Sentinels written into the projection: `"... [shortened]"`,
`"[... omitted from live display...]"`, `"[circular value omitted]"`,
`"[accessor omitted]"`.

`argumentsText` is an internal `JSON.stringify(projected, null, 2)` capped at the field maximum; it supports bounded accounting and is **not** mounted as a standalone JSON panel.
The projected object is still passed to compact signatures and curated renderers. It is created with
`Object.create(null)`, so prototype-shaped keys such as `__proto__` land as inert own data —
pinned at `packages/code/tests/unit/tool-display.test.ts`.

`mountedTextChars` is a conservative estimate, not a measurement:
`min(512 KiB, argsText + min(argsText, 74) + result + diff + error + (truncated ? notice.length : 0))`
(`packages/code/src/core/transcript/tool-display.ts`). The second bounded argument term charges the
mounted header signature in addition to argument-derived curated output, without pretending the
removed raw JSON panel is mounted.

### 3.4 Markdown segmentation shapes

```
MarkdownSegments        = { sealed: string[]; tail: string }          packages/code/src/core/transcript/segment.ts
StableMarkdownSegment   = { id: number; kind: "markdown"|"plain"; text: string }   packages/code/src/core/transcript/segment.ts
IncrementalMarkdownSegments =
  { sealed: readonly StableMarkdownSegment[]; tail: string;
    tailKind: "markdown"|"plain"; simplified: boolean }               packages/code/src/core/transcript/segment.ts
```

Invariant declared in the type's own doc: `sealed.join("") + tail` is the input, exactly
(`packages/code/src/core/transcript/segment.ts`). Segment ids start at `1` and increment (`packages/code/src/core/transcript/segment.ts`).

Constants: `SEGMENT_MIN = 4096`, `TAIL_PLAIN_CAP = 24_576`,
`FINAL_MARKDOWN_CAP = 65_536`, `MAX_MARKDOWN_SEGMENTS = 64`,
`PLAIN_SEGMENT_SIZE = 16_384`.

### 3.5 Tool result texts the parsers accept

| Tool family | Accepted text | Recogniser |
| --- | --- | --- |
| `shell` | JSON object carrying at least one of `exit_code`, `stdout`, `stderr`, `signal`, `timed_out` | `packages/code/src/adapters/tool-parsers.ts` |
| `monitor_*` | JSON object carrying at least one of `monitors`, `id`, `command`, `running`, `ready`, `exit_code`, `stopped`, `output` | `packages/code/src/adapters/tool-parsers.ts` |
| `read_file` | `cat -n` style: `<spaces><digits>\t<content>`; any other non-blank line is a note | `packages/code/src/adapters/tool-parsers.ts` |
| `read_files` | `==> <path> <==` banners; a banner of the form `<path> — <code>: <message>` carries a per-file error; a line matching `/more file\(s\) not shown/` is the trailing note | `packages/code/src/adapters/tool-parsers.ts` |
| `grep` (content mode) | `path:line:text` (match) and `path-line-text` (context), `--` separates groups, an unmatched line appends to the previous row | `packages/code/src/adapters/tool-parsers.ts` |
| `glob` / `list_dir` / `list_memories` | newline-separated non-blank paths; `"(no matches)"` yields `[]` | `packages/code/src/adapters/tool-parsers.ts` |

Real examples in the tests: a `shell` envelope at
`packages/code/tests/unit/tool-parsers.test.ts`; a `read_files` document; a `grep`
content block; a guard denial `{"error":"denied","message":"…"}`.

`MonitorParsed` (`packages/code/src/adapters/tool-parsers.ts`) carries `hasExitCode: boolean` distinct from
`exitCode: number | null` — `hasExitCode` is `"exit_code" in j`, so it distinguishes "no
`exit_code` key present" from "an `exit_code` key present whose value did not parse as a number".
`renderMonitor` gates the exit-code chip on `m.hasExitCode && m.exitCode !== null`
(`packages/code/src/views/tools/registry.tsx`). Pinned at `packages/code/tests/unit/tool-parsers.test.ts`.

### 3.6 Synthesized unified diff

When an edit-family call carries no real `diff`, one is reconstructed from its arguments
(`packages/code/src/adapters/tool-parsers.ts`):

```
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,1 @@
-const a = 1
+const a = 2
```

The hunk header is explicitly documented as a display approximation — `@@ -1,N +1,M @@` per edit,
not a real diff computation (`packages/code/src/adapters/tool-parsers.ts`). Pinned at
`packages/code/tests/unit/tool-parsers.test.ts`. `path` falls back to the literal `"file"`
(`packages/code/src/adapters/tool-parsers.ts`).

---

## 4. Behavior

### 4.1 The pipeline, in the order it runs

`App` constructs the production `TranscriptState`; `TranscriptRegion` delegates one chronological
surface to `CommittedHistory`, whose ScrollBox owns both frozen history and `LiveTranscriptTail` as
its final content-height child. The committed chain is:

| Step | Function | File |
| --- | --- | --- |
| 1. read only frozen committed nodes | `store.committedNodes` with `preserveOrder: true` | `packages/code/src/views/App.tsx` (`createTranscriptState`) |
| 2. choose the Lead-only main projection or one child-only isolated projection | `visibleNodes` memo | `packages/code/src/views/transcript-state.ts` (`visibleNodes`) |
| 3. derive section/group/focus state over that complete current projection | `computeGroupedNodes`, `computeToolGroups`, `computeFocusables` | `packages/code/src/views/transcript-state.ts` |
| 4. select immutable publication batches intersecting that semantic projection | `semanticBatches` | `packages/code/src/views/history/CommittedHistory.tsx` |
| 5. admit an index slice of frozen batches around the current reader | `createVisibleSliceController` | `packages/code/src/views/history/visible-slice.ts` |
| 6. render each resident frozen batch's `BlockView` using its frozen group/header/default-fold metadata | `PublicationOwner` | `packages/code/src/views/history/CommittedHistory.tsx` |

Step 3 deliberately precedes physical residency. `computeToolGroups` assigns head/member by semantic
adjacency, `isFoldedAway` resolves a section anchor, and `computeFocusables` keeps keyboard navigation
complete even when its target owner is not mounted. `App` hands a selected key to
`CommittedHistoryHandle.revealKey`, which slides the index window to include the target batch and
pauses native stick until the reader returns to the tail. Page commands route through
`CommittedHistoryHandle.scrollBy`, which scrolls the native ScrollBox and reveals older or newer
batches at the edges. Wheel and trackpad packets stay on OpenTUI's native ScrollBox path;
`CommittedHistory` pauses follow-the-tail when the reader leaves the bottom. Committed
`BlockView` structure still reads frozen publication metadata rather than these dynamic maps.
`LiveTranscriptTail` independently applies the same
Lead-or-selected-child filter and derives grouping from `store.frontierNodes()` because mutation is
allowed there. Committed keys stay in `LiveTranscriptTail` until that suffix is released; history
omits the same keys so one Solid owner paints each tool. There is no second scroll area.
It has no fixed reservation or nested scrollbox; the complete placement and handoff contract are
normative in [code-transcript-stability.md](code-transcript-stability.md).

### 4.2 Semantic projection and index residency

`visibleNodes` starts from `deps.nodes()` and chooses exactly one of two projections:

- with `selectedSubagent() === null`, it retains only nodes whose `subagentId` is absent — the
  Lead-only main transcript;
- with a selected id, it retains only nodes whose `subagentId` equals that id — one isolated child
  transcript.

The main transcript renders zero child-content rows: no delegation card, brief, tool, reasoning,
answer or terminal result. It does render exactly two Lead-owned lifecycle markers for every
delegation. `delegation_created` appends a friendly immutable `spawned` marker;
`delegation_completed` or `delegation_failed` later appends a separate friendly immutable settled
marker. The second marker never patches or replaces the first, and `delegation_started` creates no
row. The generic delegation `capability_event` mirror is suppressed, so it cannot create a duplicate
third marker. Child nodes remain retained for explicit isolated selection without replay or copying.
Every composing/started/output/terminal tool row whose Lead-owned identity belongs to the closed
supervision/orchestration set is likewise suppressed. Workflow events still contribute zero
transcript rows and remain in the footer activity strip and Sidebar only.

With `preserveOrder: true`, the production committed path returns the chosen semantic order
directly; legacy callers may still apply `withRunMarkersLast`
(`packages/code/src/views/transcript-state.ts`, `visibleNodes`).

No node count, source-character total, estimated render cost or turn boundary slices this projection.
`semanticNodes` therefore remains suitable for grouping and focus inside the active view. Explicit
detail lookup may use `detailNodes()` to inspect the complete store independently. Physical
mounting is a later and independent concern: `CommittedHistory` intersects frozen publication
batches with the semantic key set, and the visible-slice controller admits a bounded batch interval.
Its exact bounds, native-scroll behavior, lazy boundaries and disposal contract are normative in
[code-transcript-stability.md](code-transcript-stability.md).

`reset()` clears focus and fold overrides without truncating the backing ledger. Changing sub-agent
selection changes only the semantic filter; the visible-slice controller then admits the matching
immutable batches. Tests in `packages/code/tests/unit/transcript-window-state.test.ts` ("the main
transcript excludes sub-agent work until that transcript is selected") and
`packages/code/tests/integration/transcript-region-render.test.tsx` ("the main transcript hides
sub-agent work until an isolated transcript is selected" and "one selected sub-agent transcript
excludes every sibling transcript") pin the projection independently from physical residency.
An override is retained only while its key remains in the complete semantic source; retention
eviction prunes it immediately, independently of which Lead/child projection is selected.

### 4.3 Legacy mutable-node ordering helpers and committed order

One ordering helper remains specified and unit-tested for callers that construct state without
`preserveOrder`, but the publisher now decides production committed order before first visibility.

`withRunMarkersLast` (`packages/code/src/views/transcript-state.ts`) moves each `<exec>::run` node **after** the last
node sharing its `<exec>::` prefix. It returns the input array unchanged when nothing moves, which `packages/code/tests/unit/run-marker-order.test.ts` pins with `toBe`. The reason is stated in
the code: events for work that had already finished can land after `run_ended`, most visibly on a
cancellation (`packages/code/src/views/transcript-state.ts`). It is a projection rather than a store mutation
because the store guarantees node identity across a reconcile.

Production `createTranscriptState` receives `preserveOrder: true`.
`TranscriptPublisher.completeRun` creates `[final answer, run outcome]` as one batch so the live
answer row is not moved when the terminal outcome appends.

### 4.4 Sub-agent sectioning inside an isolated transcript

The Lead-only main projection reaches this pass with no child nodes. When one child is explicitly
selected, `computeGroupedNodes` (`packages/code/src/views/subagent-sections.ts`) structures only
that child's card and body; sibling workers cannot enter the projection. Legacy callers may still
feed a mixed projection. The helper runs three passes.

**Pass 1 — lead bookkeeping** : for each non-`run` node with no `subagentOrder`, whose
kind is in `LEAD_KINDS = {assistant, reasoning, thinking, tool_call, error}` and whose key
does **not** start with `local:` : record the run's first lead key, count lead tool calls, mark
the run as "has work" on a `tool_call` or `reasoning`, and capture the first `model` seen. `run`
nodes only contribute their status.

**Pass 2 — layout slots** : a node with no `subagentOrder` becomes a `lead` slot; a node
with one is bucketed under `` `${runId}:${subagentOrder}` `` and the first such node emits a
`section` slot placeholder.

**Pass 3 — emission** : walking the slot list, a lead slot first `flush()`es any
pending sections, then emits itself, seeding a `lead: true` header when
`leadHasWork.has(rid) && leadFirst.get(rid) === node.key`. `flush` sorts pending
sections so **inactive sections come first** and then by `subagentOrder`.

`emitSection` (`packages/code/src/views/subagent-sections.ts`, `emitSection`) picks the selected section's
`card` (the `subagent`-kind node) and `body` (everything else). With no body it emits only the card
and its header. Otherwise the **anchor** is the card when present, else the first body node. Its
semantic default keeps a card-backed body folded behind the card. On the first explicit selection,
`createTranscriptState` supplies one expanded override for that exact anchor, so the isolated body is
immediately readable; selection before body arrival expands it when the section becomes foldable. A
manual header toggle consumes that automatic expansion and remains collapsed across Lead/reselection,
while each sibling owns an independent first-selection override. A degraded cardless isolated
transcript keeps its first body node visible as the identity anchor and folds any remaining entries.
Header
status first consults the live roster using the `subagentId` carried by any node in the bucket, then
falls back to the card or `"running"`.

The lead header carries `order: -1`, an empty `title`, `lead: true`, the run's status and its
tool-call count (`packages/code/src/views/subagent-sections.ts`); `SectionHead` renders it as
`model · N tool calls` (`packages/code/src/views/blocks.tsx`) — pinned at
`packages/code/tests/integration/lead-presentation.test.tsx`.

`SectionHead`'s folded-count label is deliberately different for the two branches: a lead's number is
tool calls, a sub-agent section's is hidden entries, and the code states they "must not share a word"
(`packages/code/src/views/blocks.tsx`).
The chevron on either branch is a real affordance: clicking the section header toggles its anchor;
an inactive history projection cannot run that callback.

`GroupedTranscript.anchors` (`packages/code/src/views/subagent-sections.ts`) is a `Map<string,string>`
from every folded body node's key to its section's anchor key — the data structure `isFoldedAway`
(`packages/code/src/views/block-focus.ts`) reads to resolve "which section anchor does this key fold behind" when computing
focusables and fold state.

### 4.5 Tool-call grouping

`computeToolGroups` (`packages/code/src/views/tool-groups.ts`) scans left to right:

| Condition on the head node | Result |
| --- | --- |
| not a `tool_call`, or `isMutationTool(head)` | `{ role: "solo", ordinal: 0, size: 1 }`, advance 1 |
| a run of ≥ `MIN_GROUP` (2) nodes with identical `mcpName`, `toolName` and `subagentOrder` | first gets `role: "head"` carrying `members`, the rest `role: "member"`, all sharing `headKey` |
| a run shorter than `MIN_GROUP` | `"solo"`, advance 1 |

The break conditions are exactly: a non-`tool_call` node, a different `mcpName`, a different
`toolName`, or a different `subagentOrder`. Each is pinned by a named case in
`tests/unit/tool-groups.test.ts` — a message between calls, reasoning, different
servers, different sub-agents.

Immutable publication applies the same full `(mcpName, toolName)` identity in live staging, the
terminal sweep and frozen sub-agent batch metadata. `toolIdentity` remains the renderer lookup key;
its leaf-name fallback is not a publication grouping identity. Production:
`packages/code/src/adapters/transcript-publication.ts` (`publicationToolIdentity`,
`samePublicationToolIdentity`, `publicationToolGroups`, `TranscriptPublisher.#publishTool`,
`TranscriptPublisher.#publishRemainingLead`). Test:
`packages/code/tests/unit/transcript-publication.test.ts` (same leaf name from different MCP servers
in live publication, terminal sweep and one sub-agent batch).

`aggregateStatus` is running → error → ok, in that precedence; `failureCount` tallies
`"error"`. Pinned at `packages/code/tests/unit/tool-groups.test.ts`.

**The grouping and sectioning passes read no streaming-hot field.**
`packages/code/tests/unit/transcript-grouping-fields.test.ts` wrap every fixture node in a Proxy and
assert that `computeGroupedNodes`, `computeToolGroups` and `computeFocusables` never read `text`,
`result`, `diff`, `args`, `liveOutput` or `dehydrated`. The test file itself calls the property
"currently accidental — nothing in the code says 'do not read `.text` here'"
(`packages/code/tests/unit/transcript-grouping-fields.test.ts`), and includes a self-check that the Proxy would in fact
catch a read.

### 4.6 Fold state and focus

Three inputs decide whether a block's body shows, resolved by `collapsed()` in
`BlockView` (`packages/code/src/views/blocks.tsx`):

1. an explicit per-key `BlockOverride` (`"expanded"` / `"collapsed"`) — wins outright;
2. a lead mutation remains expanded;
3. `forceExpand()` (the transcript-wide "expand all");
4. `defaultFolded()` supplied by the host, falling back to a `collapsed` field that is not part of
   `TranscriptNode` (`packages/code/src/views/blocks.tsx`).

`fullBody()` — whether ordinary arguments/results render unclamped — is deliberately **not** keyed on `forceExpand`
(`packages/code/src/views/blocks.tsx`): only an explicit per-block or per-head `"expanded"` override lifts the
ten-line cap. `packages/code/tests/integration/tool-clamp.test.tsx` mounts every fixture with
`forceExpand={() => true}` still expects the cap. Lead mutations use the separate
`ungatedMutationBody` flag, so their diff/content crosses the 40-line mutation gate without also
expanding a duplicative arguments panel.

`computeFocusables` (`packages/code/src/views/block-focus.ts`) yields, in transcript order: a folded section anchor (one
stop for the whole section), then — skipping nodes folded away — every `tool_call`
whose group role is `"solo"` or `"head"`. Messages, plan nodes and group members are
never focusable, pinned at `packages/code/tests/unit/block-focus.test.ts`.

`toggleOverride` (`packages/code/src/views/block-focus.ts`) state machine:

| Current state | Result | File |
| --- | --- | --- |
| key is a section anchor with `hiddenEntries > 0` and override `"expanded"` | delete the override (refold) | — |
| key is such an anchor otherwise | set `"expanded"` | — |
| `node` is undefined | no change | — |
| ordinary node: `defaultExpanded` = lead mutation **or** (`role !== "head"` and not `defaultFolded` and not an oversize mutation) | current expanded state flips to the opposite override | `toggleOverride` |

A group head therefore always starts collapsed, while a lead mutation starts expanded even if the
store's generic tool default says folded. Delegated oversize mutations retain the compact default.
Pinned at `packages/code/tests/unit/block-focus.test.ts` and
`packages/code/tests/integration/tool-mutation-diff.test.tsx`.

`nextFocus` clamps at both ends and starts from the **last** key when `current` is `null` or
unrecognised — pinned at `packages/code/tests/unit/block-focus.test.ts`.

`createTranscriptState` calls `deps.rehydrate?.(key)` on **every** toggle, expand or collapse
(`packages/code/src/views/transcript-state.ts`), and the doc states why: the store no-ops on a node that still has its
body, so deciding here would duplicate that check against a fold state being changed
(`packages/code/src/views/transcript-state.ts`).

Two self-healing effects: a `selectedSubagent` that vanished from the roster is cleared
(`packages/code/src/views/transcript-state.ts`), and a `focusedKey` no longer in `focusables()`
is cleared (`packages/code/src/views/transcript-state.ts`).

### 4.7 Sub-agent selection

| Action | Behaviour | File |
| --- | --- | --- |
| `toggleSubagent(id)` with `id` already selected | clear selection, return to Lead and notify `"showing Lead transcript"` | `packages/code/src/views/transcript-state.ts` |
| `toggleSubagent(id)` otherwise | select, notify `subagentFocusToast(title \|\| id)` | `packages/code/src/views/transcript-state.ts` |
| `cycleSubagent()` with an empty roster | clear, notify `"no sub-agents to focus"` | `packages/code/src/views/transcript-state.ts` |
| `cycleSubagent()` otherwise | advance through the roster sorted ascending by `order`, wrapping past the end to `null` | `packages/code/src/views/transcript-state.ts` |

Pinned at `packages/code/tests/unit/transcript-state.test.ts`.

Pointer selection follows the same path. A Sidebar agent row calls only `onSelectSubagent`, which
`TranscriptRegion` wires to `toggleSubagent`; it does not call `onOpenDetail`, even for a settled
worker with a result. The selected child's transcript is the detail surface in this action. Opening
the separate Markdown `ActivityDetail` requires an explicit affordance inside a transcript block or
another detail-owning surface. Production: `packages/code/src/views/Sidebar.tsx` (agent-row
`onMouseDown`), `packages/code/src/views/app/TranscriptRegion.tsx` (`onSelectSubagent`) and
`packages/code/src/views/transcript-state.ts` (`createTranscriptState`, first-selection anchor
override). Tests: `packages/code/tests/unit/transcript-state.test.ts` (immediate/late expansion,
sticky manual collapse, independent sibling and pruning),
`packages/code/tests/integration/sidebar-render.test.tsx` ("clicking a sub-agent row calls
onSelectSubagent with that instance's id" and "clicking a settled sub-agent selects its transcript
without opening ActivityDetail") and
`packages/code/tests/integration/app-shell-render.test.tsx` (readable first selection and manual
collapse across Lead/reselection).

`focusBlock(delta)` notifies `"nothing to focus"` and returns `null` when `nextFocus`
finds nothing (an empty `focusables()` list), else sets and returns the new focused key.
`clearFocus()` is a no-op returning `false` when nothing is focused, else clears focus
and returns `true`. Pinned at `packages/code/tests/unit/transcript-state.test.ts`.

`toggleExpandOrBlock()` toggles the focused block when one is focused, otherwise flips
`expandAll` and notifies `"blocks expanded"` or `""` — the empty string on the second flip
is asserted at `packages/code/tests/unit/transcript-state.test.ts`.

`pickDiffNode()` prefers the focused node when it is in
`DIFF_TOOLS = {apply_patch, edit_file, multi_edit, write_file, diff, replace}`
(`packages/code/src/views/transcript-state.ts`), otherwise scans `detailNodes()` or `deps.nodes()`
**backwards** — i.e. over the full semantic/detail source, not physical residency. A dehydrated pick
triggers `rehydrate` and is still
returned, so the overlay fills in rather than silently opening an older diff. Pinned
at `packages/code/tests/unit/transcript-state.test.ts` and
`packages/code/tests/unit/transcript-window-state.test.ts` (`pickDiffNode` case).

### 4.8 Assistant Markdown segmentation

`segmentMarkdown(text, min)` (`packages/code/src/core/transcript/segment.ts`) returns `{ sealed: [], tail: text }` immediately when
`text.length <= min`. Otherwise it walks lines, toggling a fence flag on any line whose
first non-space characters are ` ``` ` or `~~~`, and takes a cut only when **all** of:

| Condition |
| --- |
| not inside a fence |
| the line is blank (`line.trim().length === 0`) |
| the line is **terminated** (`br !== -1`) |
| the accumulated segment has reached `min` |
| it is not a blank line interior to an indented code block (`lastCode && continuesIndentedCode`) |

The terminated-line rule exists because an unterminated whitespace-only tail would take a cut that
the next delta withdraws. The indented-code lookahead exists because a blank line
between two indented lines is interior to one code block, not a paragraph break.

Prefix stability is asserted at **every single prefix**, not a sampled stride, at
`packages/code/tests/unit/segment-markdown.test.ts`; the test file states the case that broke it took a cut on
an unterminated whitespace-only last line and withdrew it one character later.
Exact reassembly across seven shapes × four `min` values is pinned.

`IncrementalMarkdownSegmenter.update(text, epoch, running)`
(`packages/code/src/core/transcript/segment.ts`):

| Condition | Action |
| --- | --- |
| `epoch !== #epoch`, `text.length < #length`, or a settled stream starts running again | `#rebuild` |
| an ordinary running reply settles | `#settle`; keep the sealed array and segment objects |
| `text.length > #length` | `#append(text.slice(#length))` |
| otherwise | snapshot only |

`#rebuild` resets everything; if `running` it re-appends the whole text; if settled and
`text.length > FINAL_MARKDOWN_CAP` it sets `simplified` and emits `PLAIN_SEGMENT_SIZE` plain chunks
through `#appendPlainDocument`; otherwise it re-segments as Markdown.

`#settle` appends any last delta and changes only the running state. It rebuilds only when the final
document exceeds `FINAL_MARKDOWN_CAP` or the live tail already crossed a simplification boundary.
This keeps every ordinary sealed prefix mounted across the running-to-settled transition.

`#append` has two bounded escapes: reaching `MAX_MARKDOWN_SEGMENTS` Markdown seals switches to
forced-plain and folds the remainder into the tail, and a tail exceeding `TAIL_PLAIN_CAP` does the
same. Both set `simplified = true`. `#forcedPlain` is a one-way latch while the reply is running:
once set it is checked first on every subsequent `#append`. Settlement rebuilds that document as
bounded final Markdown or plain text, and epoch/reset/restart rebuilds also clear the latch.

`#snapshot` returns the **same** `#sealed` array reference unless `#seal` published a new one. Tests
`packages/code/tests/unit/segment-markdown.test.ts` ("does not copy the sealed segment index for
tail-only stream updates" and "keeps sealed object identity while scanning only later appends") pin
both the array and the first segment object with `toBe`.

`#seal` copies the text through `ownString`, a `TextEncoder`/`TextDecoder` round-trip whose
stated purpose is to detach a sealed prefix from the ever-growing cumulative source string
(`packages/code/src/core/transcript/segment.ts`, `ownString`).

`AssistantMarkdown` drives it: one segmenter per mounted node, reset on cleanup; `epoch` is
`textEpoch ?? 0` for assistant nodes and `0` otherwise. Sealed Markdown segments render through
`StableMarkdown` with `streaming={false}`; only the tail passes the live running state. On ordinary
settlement, `StableMarkdown` keeps the already painted streaming tree visible while one transparent
final tree receives layout at its intrinsic height, starts Tree-sitter work, awaits every public descendant
`CodeRenderable.highlightingDone`, and completes one confirming paint. The preparing final tree must
not inherit the streaming overlay's row count. A single Solid batch then
reveals the final tree, resets its height to `auto`, and disposes the old one, so a shorter answer
cannot leave the old streaming height as blank transcript rows. No timer or renderer-wide pause participates, and
at most two Markdown trees exist during that bounded handoff. Every segment after the first carries
`marginTop={1}`, because
`MarkdownRenderable` applies its inter-block margin internally and that margin is exactly what a cut
discards.

While that tail is streaming, `StableMarkdown` samples the visible renderable height and retains its
maximum as `liveHeightFloor` for the current `geometryEpoch`. OpenTUI may parse an unfinished inline
delimiter and conceal its source characters, reducing the Markdown renderable's intrinsic height;
the containing box may grow but cannot return those rows within the same epoch. A changed epoch
clears the reservation. This is geometry-only: `conceal`, streaming parsing and native attributes
remain enabled. The production-shaped ScrollBox regression drives the intrinsic sequence
`2, 2, 2, 1, 2`, proves `scrollTop` and the earlier anchor never move backward, and confirms the
settled `bold` cells remain bold with delimiter characters concealed
(`packages/code/tests/integration/transcript-scrollbox-render.test.tsx`, "bottom-following streaming
Markdown never gives rows back when parsing conceals syntax"). A `simplified` settled reply prints
`"Formatting simplified to keep this large response responsive."`.

### 4.9 Tool block rendering

This section applies only after a tool call is admitted to the active transcript projection.
Lead-owned supervision/spawn/delegation/workflow-orchestration identities are rejected before this
renderer: no composing header, running row, live tail, grouped row or terminal block for them may
mount. Their absence cannot suppress ordinary Lead `thinking`/`working` state in the fixed
composer-adjacent activity line or the two typed delegation lifecycle markers.

`ToolLine` (`packages/code/src/views/blocks.tsx`) derives, in order:

| Derived | Rule | File |
| --- | --- | --- |
| `display()` | `projectTranscriptToolDisplay(node, rawToolArguments(node))` | — |
| `isCollapsed()` | `!showBody && status !== "running"` | — |
| `diffChip()` | `trueMutationStats(node)` when collapsed and not errored | — |
| `hiddenLines()` | `hiddenBodyLines(...)` only when collapsed, not errored, and there is no diff chip | — |
| `hasBody()` | `showBody && status !== "running"` | — |
| `tail()` | last 5 lines of `liveOutput`, only while running | — |
| `composing()` | `composingLabel(inputChars, inputComplete === true, inputStreamChars)` when `inputChars !== undefined`, else `""` | `packages/code/src/views/blocks.tsx` (`ToolLine`) |

The header renders as one truncated, non-wrapping row; its TSDoc states this is so a
collapsed call is always exactly one row whatever the terminal width. Its parts, in
order: status glyph, `toolDisplayLabel` in accent (suppressed when indented as a group member), then **either** the composing label **or** the signature — never both,
the signature preferring resident `node.signature` over live `formatToolCall`. Then
elapsed time while running, or elapsed time when settled and
`elapsedMs >= SLOW_TOOL_MS` (2000ms). Then either the mutation chip
 or the hidden-line chip.

Below the header, in order: the live tail, the hydration notice when expanded and
dehydrated, the curated result/error body card on `tokens.bgElev`,
and finally the `truncated` warning banner. No tool identity or expansion state
mounts a standalone `Arguments` label or raw argument JSON. Arguments remain available only to the
compact header signature and the resolved renderer, which can select paths, commands, diffs or other
useful fields without duplicating the complete envelope. Pinned for a curated shell renderer and the
generic fallback at `packages/code/tests/integration/tool-destripe-render.test.tsx`.

`trueMutationStats` (`packages/code/src/views/blocks.tsx`) prefers the resident `node.mutation` and only falls back to
computing `mutationStats` from the raw args/diff — never from `display()`, which is bounded. Pinned at `packages/code/tests/integration/transcript-region-render.test.tsx`: a 4,000-line
diff exceeding 64 KiB must still chip as `+4000`.

`hidden()` (`packages/code/src/views/blocks.tsx`) hides a group `member` unless the group is expanded **or** the member
carries `warn` — an errored member stays hidden, pinned at
`packages/code/tests/integration/tool-groups-render.test.tsx` (`expect(out).not.toContain("boom")`).

The group **head** row (`packages/code/src/views/blocks.tsx`, `BlockView`) shows the aggregate status
glyph, the display label, `×N`, one cumulative composing count while any quiet member still has
open arguments (or `arguments ready` when all composing members have closed), the maximum available
attempt-wide stream count rather than a duplicated sum, and `N failed` when
any member errored. It lists up to `MAX_GROUP_SIGNATURES = 6` member signatures with a `moreChip`
for the rest. Each listed signature is `resolveToolCallSignature(member, rawToolArguments(member))`:
the resident `node.signature` when present, otherwise a freshly formatted header from the member's
raw arguments. That is the same preference `ToolLine` and Markdown export use, so a dehydrated live
member — the usual case for a still-running sub-agent that has already moved on — still names its
path instead of rendering empty `()` / `list_dir`'s `(.)` placeholder. Denied guard members are
selected before ordinary members, preserving their original relative order, and remaining slots then
take ordinary members in order. A grouped shell signature
appends its own `guardReviewLabel`, so an individual denial and its answerer cannot disappear beyond
the cap or behind the group's folded error body. A `warn` head additionally renders its own indented `ToolLine`. Pinned by
`packages/code/tests/integration/tool-groups-render.test.tsx`.

Block chrome: a block defaults to the `MEASURE_MAX_COLS = 110` reading cap, but
`TranscriptRegion` fills its available pane in either layout: `maxWidth="100%"` uses the full viewport
when no inline sidebar exists, while `fillAvailableWidth()` reaches the fixed sidebar boundary in a
split without crossing it. The split gives the same rule to the inline `ElicitBlock`. Production:
`packages/code/src/views/blocks.tsx` (`BlockView`),
`packages/code/src/views/app/TranscriptRegion.tsx` (`TranscriptRegion`), and
`packages/code/src/views/ElicitBlock.tsx` (`ElicitBlock`). Tests:
`packages/code/tests/integration/measure-render.test.tsx`,
`packages/code/tests/integration/transcript-region-render.test.tsx`,
`packages/code/tests/integration/app-shell-render.test.tsx`, and
`packages/code/tests/integration/elicit-block-render.test.tsx`. A sub-agent node gets a left border in its sub-agent
color plus one column of padding; a focused block paints `focusBg()` and a `run` node
paints no background at all. The bordered box's `marginTop` (set to `1` only
when a `sectionHeader` is present) sits **outside** its `border={["left"]}`, so a folded sub-agent
section header's leading blank row is not painted with the rail glyph — pinned at
`packages/code/tests/integration/subagent-rail-render.test.tsx`.

Per-kind bodies (`packages/code/src/views/blocks.tsx`): `user` gets a `userBandBg()` band with a rail glyph; `reasoning` renders nothing at all when collapsed — pinned at
`packages/code/tests/integration/reasoning-hidden-render.test.tsx`; `thinking` is a spinner plus animated dots; `assistant` uses one static bullet plus segmented Markdown in both running and terminal
states, and preserves a provider-declared `commentary` phase without synthesizing a visible label or
changing its body; `subagent` is a bounded one-line plain-text
preview of the delegation brief with a click affordance for the full Markdown detail modal, hidden
when collapsed or blank; `plan` always shows a header
line (`plan <title>` plus `planMeta`), conditionally shows a ` review: <verdict>` line
when `planReview` is set, and, only when not collapsed, chooses among three guidance sentences:
`planDiscarded` says `"Plan was deleted after success, as configured"`; another
`planRemoved` says `"The backing record is unavailable; restore it or create a replacement plan"`;
an available plan says `"Open plan for the full objective, task list and review history"`
(`packages/code/src/views/blocks.tsx`). Thus retention cleanup remains neutral while an
unexpected loss stays actionable;
`annotation` colors by `tone`; `error` prints the agent label and the error text;
`run` prints the outcome word, elapsed time and — on a non-`ok` run — a `Next:` line naming only
affordances that exist. Pinned at
`packages/code/tests/integration/plan-block-render.test.tsx` (routes full detail to the overlay) (review verdict).

### 4.10 Tool renderer resolution

`resolveToolRenderer(mcpName, toolName)` looks up `byTool[toolIdentity(...)]` and falls back to
`renderGeneric` (`packages/code/src/views/tools/registry.tsx`). The full table (`packages/code/src/views/tools/registry.tsx`):

| Renderer | Tools |
| --- | --- |
| `renderBash` | `shell` |
| `renderReadFile` | `read_file` |
| `renderReadFiles` | `read_files` |
| `renderImage` | `read_image` |
| `renderGrep` | `grep` |
| `renderPathList` | `glob`, `list_dir`, `list_memories` |
| `renderWriteFile` | `write_file`, `write_memory` |
| `renderEdit` | `edit_file`, `multi_edit`, `edit_memory` |
| `renderApplyPatch` | `apply_patch` |
| `renderDiffTool` | `diff`, `replace` |
| `renderSummary` | `move`, `copy`, `mkdir`, `remove`, `delete_memory` |
| `renderTree` | `tree` |
| `renderJsonCard` | `file_stat` |
| `renderMonitor` | `monitor_start`, `monitor_poll`, `monitor_stop`, `monitor_list` |
| `renderMemoryRead` | `read_memory` |
| `renderMemoryGrep` | `grep_memories` |

**Non-mutation-gated renderers' own rules** (`registry.tsx`): `renderBash` colors the
status word by exit code (`add` for `0`, `del` otherwise) and distinguishes a settled `"failed"`
(unparsed result with an error present) from an ordinary `"done"`/`"exit N"`. `renderReadFile`
 prints a `path · lines N–M` header only when `parseReadFile` found line numbers; with
none, only the code body renders. `renderMonitor` renders a filled/hollow dot glyph per
monitor in list mode, and in single-monitor mode a `running`/`stopped`/`exited`/`monitor` status word
plus a `ready`/`not ready` chip and the exit-code chip gated on `hasExitCode` (see section 3.5).
`renderImage` is a fixed `[image]` tag plus the path, with no body at all.
`renderMemoryRead` forces `filetype="markdown"` syntax highlighting regardless of the
memory document's actual name. `renderMemoryGrep` delegates to `renderGrep` by
rewriting the call's `output_mode` argument to `"content"`, falling back to `renderGeneric` when
`parseGrepContent` finds zero groups. `renderJsonCard` renders with Solid's `Index`,
not `For` — an explicit remark in source states `Object.entries()` yields fresh `[k,
v]` tuples with no stable identity every render, so rows must key by position instead.

`resolveErrorRenderer` returns the *normal* renderer for a tool in
`ERROR_AWARE = {shell, monitor_start, monitor_poll, monitor_stop}`, and `renderErrorGeneric`
otherwise. `renderErrorGeneric` respects `full`/`wrap` so an error's stack trace can be
lifted out of the ten-line clamp.

`MAX_BODY_LINES = 10`; `clampLines` returns the whole text when `full` sets the max to
`Infinity`. The `+N more` footer is `moreChip` (`packages/code/src/views/truncate.ts`), which pluralises
on `hidden === 1`.

**The mutation gate.** `oversize(body, expanded)` is `!expanded && body.length > 0 && body.split("\n").length
> 40`. `mutationBodyExpanded(call)` treats either an explicit full expansion or
`ungatedMutationBody` as expanded. `BlockView` supplies the latter only for `isLeadMutation(node)`,
so lead mutation bodies remain inline while delegated calls retain the gate. `gateBody` calls `mutationBody` with the call's identity, diff and
arguments. `gateStats` prefers the host's `call.mutation` measurement over counting the
bounded body. Four renderers implement the gate: `renderWriteFile`,
`renderEdit`, `renderApplyPatch` and `renderDiffTool`.

**The "(reconstructed)" marker.** `renderEdit` (`packages/code/src/views/tools/registry.tsx`) prints a muted
`(call.result || "edited") + " " + glyph("separator") + " (reconstructed)"` label whenever the call
carries no real `diff` — in both the oversize-gated branch and the normal inline branch
 — so a synthesized unified diff (`synthesizeUnifiedDiff`, section 3.6) is always
visibly distinguished on screen from a real one. Pinned at
`packages/code/tests/integration/tool-diff-render.test.tsx` and
`packages/code/tests/integration/tool-registry-render.test.tsx`, and negatively at
`packages/code/tests/integration/mutation-gate.test.tsx`.

`mutationBody`'s table (`packages/code/src/views/tools/mutation-gate.ts`):

| Identity | Body |
| --- | --- |
| `write_file`, `write_memory` | `diff` if present, else `args.content` |
| `edit_file`, `multi_edit`, `edit_memory` | `diff` if present, else `synthesizeUnifiedDiff(args.path, editsFromArgs(args))` |
| `apply_patch` | `diff` if present, else `args.patch` |
| `replace` | `diff` with trailing newlines stripped |
| anything else | `""` |

`mutationStats` returns `null` for a non-mutation or an empty body, and for a `write_file` /
`write_memory` **without** a real diff it counts every content line as added rather than running
`diffStats` — pinned at `packages/code/tests/integration/mutation-gate.test.tsx`
(`{ added: 50, removed: 0, lines: 50 }`). The doc states the reason: the tool result is a one-line
summary, so counting its lines under-reports the change.

`isOversizeMutation` and the renderers' `oversize()` must agree; that agreement is pinned
case by case at `packages/code/tests/integration/mutation-gate.test.tsx`.

**Diffs.** Every diff renderer delegates to `StableDiff`, which collapses `\r\n` and drops bare
`\r` before the value reaches OpenTUI. A single bare CR otherwise desynchronises the line-number
gutter from the body and can cost added lines their `+` marker. The intrinsic remains mounted while
its immutable diff value is stable; it is transparent only during its initial descendant syntax
work, then becomes visible after the same `waitForSyntaxFrame` barrier used by Markdown.
`showLineNumbers` is `true` only for `renderWriteFile` with a real diff and for `renderEdit` when a
real diff exists; `renderApplyPatch` and `renderDiffTool` pass `false`. Every branch uses `"word"`
wrapping under `full` and `"none"` otherwise
(`packages/code/src/views/tools/registry.tsx`, those four renderers).

`renderDiffTool` splits a multi-file diff on `--- ` / `+++ ` header pairs, absorbing a preceding
`====` rule and an `Index: ` line into the section start (`splitDiffFiles`); the text
before the first section becomes a muted preamble. Each section's filetype comes from
`diffHeaderPath`, which prefers the `+++` path, strips a `a/`/`b/` prefix and skips
`/dev/null`; the fallback is `firstPathArg` over `path`/`from`/`to`/`source`/`file`.

`hiddenBodyLines` is identity-specific: `shell` counts parsed stdout + stderr lines,
`monitor_start`/`monitor_poll`/`monitor_stop` count parsed output lines, everything else counts the
raw result's lines. Blank-only text counts as `0`.

### 4.11 Signature formatting

`formatToolCall` (`packages/code/src/views/tools/signature.ts`) resolves `SIGNATURES[toolIdentity(mcpName, toolName)]`. With a spec: each present primary key renders **bare** in declared order, the
`placeholder` stands in when every primary is absent, and each present secondary renders as
`key=value`. Without a spec: every argument renders as `key=value`. The joined parts
are wrapped in parentheses and capped at `SIGNATURE_MAX = 72`.
Collapsed headers, group-member lists and Markdown export call `resolveToolCallSignature` in the
same file, which prefers a resident `node.signature` and only formats live args when that string is
absent. The store writes that resident string from `tool_call_started` arguments and refreshes it
on the terminal `tool_call`. Pinned by `packages/code/tests/unit/store-hydration.test.ts`.

Value formatting : strings collapse whitespace to single spaces and truncate at
`VALUE_MAX = 56` — from the **start** when the key is in
`PATH_KEYS = {path, paths, cwd, source, destination, from, to, file}` so the basename survives, from the end otherwise. Numbers and booleans stringify; a homogeneous string array
joins with `", "`; anything else goes through `JSON.stringify` inside a `try`.

The 37-entry `SIGNATURES` table is at `packages/code/src/views/tools/signature.ts`. Its behaviour is pinned across
`tests/unit/tool-signature.test.ts` — bare command, secondaries, non-whitelisted
argument suppression, start-truncation of a long path, `list_dir`'s `"."`
placeholder, the uncurated-MCP `key=value` fallback, mutation tools showing only
the path, `apply_patch` rendering as bare `()`, and `resolveToolCallSignature`
preferring a resident header over live args (including after args were dropped).

### 4.12 Projections consumed by, but not owned by, the transcript block

`reducePlanProjection` (`packages/code/src/adapters/plan-projection.ts`) folds the five plan events into one `PlanActivity`:

| Input | Result |
| --- | --- |
| same `id` and `event.revision < current.revision` | return `current` unchanged |
| `plan_removed` with no matching current | synthesize `{ title: "Plan unavailable", status: "failed", retention: "keep", tasks: [], removed: true }` from whatever the event carries |
| `plan_removed` matching current | merge the event's present fields onto current, set `removed: true` |
| `plan_review_resolved` | carry `event.outcome` as `reviewOutcome` |
| any other plan event on the same id | carry the existing `reviewOutcome` forward |
| any other plan event on a different id | drop `reviewOutcome` |

Pinned at `packages/code/tests/unit/plan-projection.test.ts` (stale revision) (orphan removal)
(review outcome persistence and reset on a new plan id).

`currentPlanTask` prefers `in_progress`, then `returned`, then `pending` — pinned at
`packages/code/tests/unit/plan-projection.test.ts`. `isLivePlan` is "not removed and status
is `active` or `awaiting_approval`"; `isAvailablePlan` is only "not removed" — pinned at
`packages/code/tests/unit/plan-projection.test.ts`.

`isExpectedPlanDiscard` is deliberately strict: `removed === true`, `status === "completed"`, and
`retention === "discard"` must all hold (`packages/code/src/adapters/plan-projection.ts`). This
matches the capability's only automatic deletion path and prevents an orphan tombstone from being
mistaken for policy cleanup.

`planMetaText` (`packages/code/src/core/transcript/presenters.ts`) turns the same data into the block's meta line: an expected
discard reports `"C/N completed · History discarded"`; another removed plan reports `"Removed"` when
its status is `completed` and `"Unavailable"` otherwise. A state word is appended for
an available plan's five known statuses, and `revision N` when revision exceeds 1. `store.ts` projects the strict predicate into `planDiscarded` alongside `planRemoved`
(`packages/code/src/adapters/store.ts`).

`reduceWorkflowProjection` in `packages/code/src/adapters/workflow-projection.ts`:

| Event | Behaviour | Reducer branch |
| --- | --- | --- |
| `workflow_title_updated` with `current === null` | return `null` — a metadata event must not invent a live tree | `workflow_title_updated` |
| `workflow_title_updated` otherwise | update the named node's title, preserving its lifecycle | `workflow_title_updated` |
| `workflow_sequence_state` | seed a manager-only activity if needed and replace its latest sequence checkpoint without touching nodes | `workflow_sequence_state` |
| `run_ended` with `current === null` or no root node | return `current` | `run_ended` |
| `run_ended` otherwise | close the root: `completed → ok`, `cancelled → cancelled`, else `error` | `run_ended` |
| `workflow_run_started` | seed the manager root from `parent_run_id` if absent, add the leader with round/pass/item/replica context | `workflow_run_started` |
| `workflow_run_progress` | fold `iterations`, `input_tokens`, `output_tokens` onto the leader, keeping it running | `workflow_run_progress` |
| `workflow_run_completed` / `_failed` | close the leader (`ok` / `cancelled` / `error`), carrying `error` and `reason` for a failure | terminal workflow branch |

Pinned across `packages/code/tests/unit/workflow-projection.test.ts`: `seeds the manager root from
the first leader's parent and adds the leader`; `projects an awaiting-Admiral checkpoint even when no
leader is currently live`; the cancellation cases; `does not invent a running tree from a title
event alone`; and `ignores run_ended before any leader has seeded the tree`.

`WorkflowNodeActivity` in `packages/code/src/adapters/workflow-projection.ts` carries, beyond status and token counts,
the context fields that place one node in the larger workflow tree: `roundId`, `pass`, `itemIndex`,
`replica`, `replicaCount` (populated by `workflow_run_started`, above), plus `error` and `reason` on a
closed, non-`ok` leader. `WorkflowActivity`'s doc comment states that one reducer feeds three
surfaces — the dedicated Workflow view, the header chip, and the sidebar — carrying structure and
status only, never content.

`workflowLeaderCounts(activity)` counts the leaders under a workflow tree and how many
of them are still `running`, for the header chip.

### 4.13 Markdown export

`renderTranscriptMarkdownChunks` (`packages/code/src/views/transcript-markdown.ts`) is a generator, so export memory is
proportional to the largest node rather than the session. Per kind: `user` →
`## You`, `assistant` → `## Assistant`, `reasoning` → a `>` blockquote with every newline re-prefixed,
`tool_call` → `` - `label(signature)` — status `` plus its guard review label when present and a
fenced `Bounded arguments` projection when arguments exist, `run` → `_(reason)_` followed by `---`.
The projection uses the same bounded, renderer-safe display path as live rendering and labels shortening;
it never serializes the unbounded raw envelope. Every other kind yields nothing. The tool line uses
`toolLabel` (not `toolDisplayLabel`) and prefers the resident `node.signature`. Pinned at
`packages/code/tests/unit/transcript-markdown.test.ts`.

For a settled shell node, `guardReviewLabel` renders the durable verdict as
`auto-guard approved|denied · <answerer>` in auto mode (or `guard ...` in on
mode). `ToolLine` appends that label to the header, and Markdown export reuses
the same pure presenter. Production: `packages/code/src/core/transcript/guard-review.ts`,
`ToolLine` in `packages/code/src/views/blocks.tsx`, and
`renderTranscriptMarkdownChunks`. Tests: `"shell headers state whether the
auto-guard judge approved or denied"` in
`packages/code/tests/integration/tool-destripe-render.test.tsx` and the guard
case in `packages/code/tests/unit/transcript-markdown.test.ts`.

### 4.14 Spinner clock

One module-level Solid signal drives every spinner and every elapsed-time read
(`packages/code/src/views/spinner.ts`). `useSpinnerClock(active, clock)` starts a `TICK_MS = 200` interval only while
`active()` is true and tears it down on cleanup; the frame counter wraps at
`FRAME_CAP = 1_000_000`. `tickNow()` reads the frame signal purely for its dependency
and returns `Date.now()`, which is how a running tool's elapsed chip re-renders
(`packages/code/src/views/blocks.tsx`). `charForFrame` and `thinkingDots` index with a double-modulo so a negative index
still resolves.

Assistant prose deliberately does not subscribe its transcript marker to that clock. A running and a
settled assistant both use the same static bullet; live activity remains visible in the fixed
`LeadActivityLine` and in any running tool row. This prevents an otherwise immutable Markdown owner
from repainting merely because an ornamental glyph advanced. Production:
`packages/code/src/views/blocks.tsx` (`BlockView`). Test:
`packages/code/tests/integration/markdown-render-contract.test.tsx` ("a streaming assistant keeps a
static transcript marker").

### 4.15 `core/run-status.ts` — framework-free status lines

Three builders return a `StatusLine` (a `readonly StatusSegment[]`, each segment a literal string or a
`{ mark: StatusMark }` glyph placeholder, `packages/code/src/core/run-status.ts`), which `plainStatusLine`
turns into the historical headless Unicode string and `@clarvis/code`'s presentation layer turns into
the themed one (`features/run/status-presenter.ts`, outside this document's scope, wraps all three).

`memoryNoticeStatus(notice)` has five distinct phases with distinct text: `started` →
`"memory: learning…"`; `queued` → `"memory: queued"`; `blocked` → `"memory: blocked"` plus an optional
`" (note)"` suffix; `failed` → `"memory index failed — run not learned"` plus an optional
`" (indexer_run_id)"` suffix; and, past all four phase checks, `notice.skipped` → `"memory: nothing to
record"`, else `"+N -M"` from `written`/`deleted` counts or `"memory: nothing new"` when both are zero.
A code comment states why the last three are kept apart: "'the pass declined to run' and
'the pass ran and judged there was nothing durable here' are different outcomes and used to read
identically. So did 'the learning died', until the failed branch above started naming its run."

`progressStatus(progress)` special-cases a `run_ended` event whose `reason` is set and is
not `"completed"`: it renders `"ended — <reason with underscores replaced by spaces>"` instead of the
progress label. Otherwise it renders `progress.label`, falling back to `"iteration <n>"`.

`liveRunStatus(input)` builds the footer line from up to three optional segments — the
status string, an elapsed-time segment via `formatElapsed` when `startedAt` is set, and a token-usage
segment (`"<input>→<output> tok"`) when `usage` is set — joining every segment after the first with a
`" · "` separator built from `StatusMark`s rather than a literal.

Test `tests/unit/run-status.test.ts` pins all three, through the themed wrapper
`features/run/status-presenter.ts` that composes `presentStatusLine` over each builder.

The application shell does not put that live lifecycle line in the canonical footer.
`App.leadActivityDetail` seats elapsed time, the current iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt beside
the `thinking`/`working` phase in `LeadActivityLine`. `runStripText` separately keeps gross `Context`
plus cumulative `Session` input/output, prompt-cache hit percentage and cost before and after
settlement, prefixing a terminal outcome only after settlement; it never adds `Running`, elapsed
time or iteration. Wide terminals show the Session token totals and cache percentage. `In`
subtracts the reported cache hit, while
`Cache hit` divides cached tokens by gross input before that subtraction; the same projection helper
uses one run's values when its owner is `Run` and cumulative values when its owner is `Session`.
While active, cumulative Session usage is the frozen full-session baseline captured by `runManaged`
plus only `ActivityStore.currentUsage`; the mounted resident-window aggregate is never substituted,
so a folded turn cannot disappear from the number and a prior turn cannot be counted twice. Both
operands must carry a cache split for the sum to carry one. A numeric zero is measured; if either
operand is unknown, `In` remains gross and `Cache hit` is omitted before and after settlement.
Production:
`packages/code/src/run-host.ts` (`sessionUsageBaseline`, `runManaged`),
`packages/code/src/adapters/activity-store.ts` (`currentUsage`),
`packages/code/src/views/App.tsx` (`activeSessionUsage`, `leadActivityDetail`, `footerRunStrip`) and
`packages/code/src/features/run/status-presenter.ts` (`runStripText`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` (full baseline plus current delta,
measured zero, and missing-detail continuity) and
`packages/code/tests/unit/run-status.test.ts` (scope-proportional cache percentage and "the run strip
keeps cumulative session tokens before and after a run settles").

### 4.16 `core/attention.ts` — terminal focus and notification cues

`createAttention(renderer)` (`packages/code/src/core/attention.ts`) tracks a local `focused` boolean from the
renderer's `"focus"`/`"blur"` events. `notify(message, title = "clarvis")`
is a no-op unless `renderer.capabilities?.notifications === true`. `setTitle(state)`
is a no-op when the renderer reports no `capabilities` at all, and otherwise sets the terminal title to
`"clarvis — <state>"` when `state` is set, else the bare `"clarvis"`. `away()` returns
`true` — meaning the terminal itself decides whether a settle notification carries signal — whenever
`focus_tracking` is not exactly `true`, and otherwise returns the negation of the tracked `focused`
flag. Test: `packages/code/tests/unit/attention.test.ts`.

### 4.17 `core/format-elapsed.ts` and `views/Prose.tsx`

`formatElapsed(ms)` (`packages/code/src/core/format-elapsed.ts`) clamps a negative duration to `0`, renders
`"<seconds>s"` under a minute, and above a minute renders `"<minutes>m<seconds>s"` with the seconds
component zero-padded to two digits.

`Prose` (`packages/code/src/views/Prose.tsx`) is the `<markdown>` configuration shared by the plan overlay and the
memory wiki reader. Its `block` prop switches the layout: unset, the markdown flex-grows to fill the
remaining row (the plan overlay's rail idiom); `true` sizes it to its content instead, because a
flex-grown markdown collapses inside a scrollbox. `stripDocChrome(content)`
 strips a leading YAML frontmatter block via the `FRONTMATTER` regex and drops any line
matching the `<!-- reindex:begin/end -->` marker regex, while leaving the navigation links inside that
managed block untouched.

### 4.18 `presenters.ts`'s notice/toast formatters

Eight of the barrel's exports (section 2.1) carry real formatting rules beyond their bare signatures.
`compactionNoticeText(operation, freedChars, opts)` (`packages/code/src/core/transcript/presenters.ts`) rounds `freedChars` to
the nearest thousand for its `−Nk chars` segment and appends a user-contribution count when
`opts.userContributionCount` is set. `compactionSkippedNoticeText(reason)` reports an
explicit compaction request that could not be applied, replacing the reason's underscores with spaces.
`visionNoticeText(model, imageCount, status)` names the model rather than an agent
because the vision pre-pass is one completion with no run-tree child a reader could go looking for.
`softLimitNoticeText` is a plain `used/limit → outcome` line.

`steerNoticeText`, `steerQueuedNoticeText` and
`steerUndeliveredNoticeText` all quote the steer message through the internal
`steerPreview` helper, which normalizes whitespace and truncates to 160 characters.
`steerUndeliveredNoticeText` exists to correct a specific defect, stated in its own TSDoc remark
: "The queued notice is written optimistically on acceptance and only promoted by a
later `steering_applied`. A run that completes, fails or is cancelled in between leaves nothing to
promote it, so the node has to be settled explicitly or it reads 'Steer queued' for the rest of the
session — a message the user is entitled to read as delivered when it never was." `subagentFocusToast`
 is a plain `"focused sub-agent: <title>"` string, also used by `toggleSubagent`
(section 4.7).

### 4.19 The Sidebar, plan access and the roster

`views/Sidebar.tsx` is the optional inspector column beside the transcript. It holds no run state of
its own — only a scroll handle and a per-mount handle table: everything it paints comes from the two
projections of section 4.12, `PlanActivity` and `WorkflowActivity`, plus `ActivityStore.subagents`.
Its own TSDoc states the scope rule (`Sidebar` in `packages/code/src/views/Sidebar.tsx`): it is a
*summary-only* inspector. Complete child tools and answers live in the explicitly selected isolated
transcript; workflow activity remains structure/status in the footer strip and Sidebar and never
becomes transcript content.

**Two mounts, one component.** `TranscriptRegion` mounts `Sidebar` twice from identical props — as a
split column when `layout.secondaryMode()` is `"split"`
(`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`) and inside a scrim-backed
absolute drawer when it is `"drawer"`. No `PlanStrip` or other live pane is mounted below history:
the Sidebar owns compact plan detail, `Ctrl+P` owns the full plan, and Plan contributes nothing to
`compactActivityStrip` (`packages/code/src/views/App.tsx`). App owns three
independent execution-scoped automatic intents: the first live Plan, first workflow state/leader and first
typed delegation open the same combined Sidebar and reveal `Plan`, `Parallel work` or `Agents`.
`/activity plan`, `/activity workflow` and `/activity agents` may explicitly reopen a chosen section;
bare `/activity` chooses the first available one. A pointer intent remains available later when the
footer contains agent or workflow activity. `createLayoutController.secondaryMode` projects either
explicit source of intent as split or drawer.

The effective secondary mode also owns roster placement. A split or drawer is the sole detailed
roster surface. Each of the three first-event intents is consumed independently. Explicitly closing
an automatic reveal is sticky for later updates of that same section/execution, but does not consume
the first event for another section; the latter may reopen and reorient the Sidebar. The Agents
intent does not change the Lead selection or open `ActivityDetail`. The outer Sidebar ScrollBox
reveals the whole section owner with native `scrollChildIntoView`, so a long Plan cannot hide later
workflow or Agents content below the viewport. When closed, the Lead transcript
mounts no replacement roster; `App`'s clickable footer activity strip
preserves agent waiting/running/done/failed counts and workflow leader count without consuming
transcript height, and composes them after canonical Context/Session state rather than replacing it.
Plan never contributes to that strip. Clicking it is the explicit intent that opens a split at
eligible widths or a drawer otherwise; `/activity` remains the keyboard-accessible route for every
section after Escape. Plain Tab never changes Lead/child selection: at shell level it clears
transcript block focus and returns to the composer, while a focused screen may own Tab for its local
focus order. Shift+Tab opens the agent picker. Clicking any sidebar agent, including a settled
summary row, selects only that agent's isolated transcript; it does not open `ActivityDetail`. While both
secondary surfaces are closed, the selection is represented by a single `Viewing A<n> <title>`
context row. Opening either secondary surface removes that row, so the same identity is never
presented in two adjacent regions.

**Frame.** The `Sidebar` root is `props.width?.()` wide or 44 columns, never shrinks, carries a left
border whose colour is `tokens.accent` while `props.focused()` and `tokens.muted` otherwise, and
sits at `zIndex={1}`. The body is a single ScrollBox holding up to three section-owner boxes — Plan,
Parallel work, Agents — each introduced by `SectionHeader`. `SidebarRevealIntent` identifies the
section and execution context; after layout, `Sidebar` asks the native ScrollBox to reveal that whole
owner. When `hasContent()` — a plan, at least one leader, a sequence checkpoint or at least one sub-agent — is false, the
entire body is the one line `No run activity to inspect`.

**Plan section.** `PlanSummary` (`packages/code/src/views/Sidebar.tsx`, `PlanSummary`) renders a bold
accent title, a lifecycle/progress line in its semantic status colour, the windowed task list, a
distinct `Last result` section, and a footer hint. For an expected discard,
the muted meta is `Completed · C/N completed · history discarded` and the muted footer is
`Plan deleted after success`; only another removed plan gets `Unavailable · plan file
unavailable` plus the red `Restore the plan file or create a replacement` recovery action
(`PlanSummary` in `packages/code/src/views/Sidebar.tsx`). `planProgress` otherwise reports
`N task(s) proposed` while `awaiting_approval`, and `C/N completed`. Each task row takes its glyph and colour
from `taskTone` (`packages/code/src/views/blocks.tsx`), called from
`packages/code/src/views/Sidebar.tsx` — except the current one, which is drawn with the accent
chevron and selection background instead — but only while the plan is neither removed nor terminal.
Every row also prints a lifecycle label (`Done`, `Running`, `Failed`, `Skipped`, `Returned`, `Next`,
or `Recorded`), so task state never depends on colour alone. The
source states the defect that rule fixes in `PlanSummary`'s one surviving line comment: "A
completed plan has no active task. Retaining the chevron on its final task made a finished plan look
like it was still executing." `PlanSummary` appends a task's `assignee` to its title when present and
shows the `Exit: …` condition for the active task alone;
`lastOutcome` scans the task list **backwards** for the newest
`done`/`failed`/`returned`/`abandoned` task and prints its `error`, else `result`, else `reason`,
else its lifecycle word. `Last result` renders only a bounded `activityPreview`; clicking it opens the
unabridged result/error/reason as Markdown in the shared activity-detail modal. The footer is
the styled `Ctrl+P full plan` affordance, replaced by neutral retention confirmation for an expected discard
or by the red restore action for an unexpected removal (`packages/code/src/views/Sidebar.tsx`,
`PlanSummary`). Visual hierarchy is pinned by
`packages/code/tests/integration/sidebar-render.test.tsx`.

**`planTaskWindow` — a bounded slice that always contains the active task.**
`PLAN_SIDEBAR_TASK_LIMIT` is 12 (`packages/code/src/views/Sidebar.tsx`). The window centres on
`currentPlanTask(plan)`, falling back to the last task when the plan has no current one, then clamps
`start` so the window never runs past either end. It
returns entries carrying their **absolute** index — which is what makes the row ids
`sidebar-plan-<index>` stable — plus `hiddenBefore`/`hiddenAfter`, rendered as `↑ N earlier tasks`
and `↓ N later tasks`, and `currentIndex`. `PlanSummary` keeps the current row on screen through
`followSelection(scrollEl, "sidebar-plan-", currentIndex)`, a mount microtask, and the scrollbox's
`onSizeChange`; the scrollbox itself is height-clamped to 4–16 rows.

**Plan access outside the Sidebar.** The first live Plan may reveal the Sidebar once for its
execution. After that surface is explicitly closed, later Plan updates cannot reopen it
automatically, but `/activity plan` can reveal it again. Plan contributes no footer summary.
`Ctrl+P` opens the complete plan surface. No plan task, title, loading row or live Plan pane mounts
between the transcript and composer; plan churn therefore cannot resize the history region or move
its newest row. Pinned by
`packages/code/tests/integration/transcript-region-render.test.tsx` ("a current plan stays out of
the transcript tail when the sidebar is closed") and
`packages/code/tests/integration/app-shell-render.test.tsx` (independent Plan/workflow/Agents reveal
intent).

**Parallel work.** Leaders come straight from the workflow projection: every node with `kind ===
"leader"`, ordered by `startedAt` (the workflow block in `Sidebar`). Each row
prints a synthetic `L1`, `L2`, … handle, `cleanTitle(node.title)` — first non-blank line, whitespace
collapsed — and a muted `status · elapsed · N iterations` line, where each of the last two segments
is omitted when it has no value. The header meta counts and singularizes the leaders. Leader handles
are derived directly from the current sorted projection; there is no retained id ledger across runs.

The same section may exist with no leader row when `WorkflowActivity.sequence` is present. An
`awaiting_manager` sequence changes the header meta to `awaiting Admiral` and renders
`Checkpoint r<revision>: next <round>` above the roster; other statuses render their current
round/session. This intentionally survives the last leader settling at a semantic checkpoint.
Production: `Sidebar` (`hasContent`, workflow `Show`, sequence line). Test:
`packages/code/tests/integration/sidebar-render.test.tsx` (`an idle round checkpoint remains visible
as awaiting the Admiral`).

**Agents.** The header meta starts with `subagentProgress(...).label` and appends `· N failed` when
needed. `subagentProgress` counts `done` and `error` as *settled*, `running` separately, `error` as
*failed*, and formats `S/T finished`, appending ` · N running` only while something is running.
The first row is the one-line main target `Lead transcript`, with its cursor drawn on the
**negation** of `props.focused()`; clicking it calls `onShowAllAgents`, which `TranscriptRegion`
wires to clearing the selection and restoring the Lead-only view. Progress belongs to the section
header and is not repeated on this row. Then one row per sub-agent in store order: cursor, handle and `cleanTitle`, followed by one
`status · elapsed` line. A live agent has no second `Activity: working` or waiting line because its
lifecycle already communicates that state. A settled agent adds the bounded `Failed: <summary>` /
`Result: <summary>` outcome, degrading to bare `Failed` / `Completed` when there is no summary; the
selected row may additionally show `Profile <name> · <model>`. Clicking either a live or settled
row performs the same selection-only action; the child's retained tool/answer nodes then render in
its isolated transcript. Sub-agent handles use the separate `A<n>` namespace derived from canonical
zero-based spawn `order`, so a workflow leader cannot renumber an agent and a later run cannot inherit
an earlier run's id allocation.

The `focused` prop is worth reading twice. `TranscriptRegion` passes `() => ts.selectedSubagent()
!== null` (`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`), so it means "an
individual agent is selected", and the sidebar uses it in two opposite directions at once: it
accents the panel border while it *removes* the cursor from the `Lead transcript` row
(`packages/code/src/views/Sidebar.tsx`, `Sidebar`). The main row is current exactly when no
individual agent is.

**`activityPreview` / `rosterSummary` — one plain line, deliberately.**
`activityPreview` owns Markdown stripping, whitespace collapse and bounded ellipsis; `rosterSummary`
delegates to it for compatibility. An absent input, or one that strips to nothing, yields
`undefined`. `rosterSummary`'s TSDoc gives the reason: the sidebar is "a navigation and status
surface, not a second Markdown reader", and
keeping this to one stripped line prevents a worker's table, code fence or long final answer from
competing with the selected isolated transcript where that result can be read in context.

Within a selected isolated transcript, `computeGroupedNodes` receives the live roster status map. A
terminal roster status found through any section node's `subagentId` overrides a stale
delegation-card status for its header. The lookup is deliberately not card-only because retention or
an incomplete replay can retain body nodes without their delegation card; neither case may leave a
finished selected agent labelled `Running`. Pinned by
`packages/code/tests/unit/block-focus.test.ts` and
`packages/code/tests/integration/transcript-region-render.test.tsx`.

**Elapsed times are bounded.** `displayElapsed` in `packages/code/src/views/Sidebar.tsx` defers to
`formatElapsed`, but returns the empty string for a negative span or one over
`MAX_DISPLAY_ELAPSED_MS = 7 days` — a clock skew or a bogus `startedAt` shows nothing rather than an
absurd duration. The `Sidebar` component shows a sub-agent's elapsed time **only while running** and
a leader's live or frozen at `endedAt`. Both read `tickNow()` (section 4.14), which is what
re-renders them.

**`contextMeter` is exported, tested, and mounted nowhere.** It computes `frac` — clamped to 1, and
0 when the window is 0 — `filled` over `CONTEXT_WIDTH = 16`, a three-band colour (`tokens.del` at ≥
0.9, `tokens.warn` at ≥ 0.7, else `tokens.add`), a rounded `pct`, and a `used/window · pct%` label
built from `compactTokens`, which switches to `k` at a thousand and `M` at a million.
No module under `packages/code/src` calls it, and the `contextWindow` accessor the component
declares and `TranscriptRegion` supplies (`packages/code/src/views/Sidebar.tsx`, `Sidebar`;
`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`) is never read in the body. Its only
exercise is `packages/code/tests/unit/budget.test.ts`.

---

## 5. Invariants

Each is stated as a rule, the production site it is about, and the test that pins it.

**INV-260.** `toolIdentity(mcpName, toolName)` resolves to whichever slot holds the name — the
`toolName` slot for a namespaced call, the `mcpName` slot for a builtin, `""` when both are absent.
Production: `toolIdentity` in `packages/code/src/adapters/tool-identity.ts`. Test
`packages/code/tests/unit/tool-identity.test.ts`.

**INV-261.** `toolLabel` renders `server:tool` for a namespaced call and the bare name for a builtin,
never a dangling colon and never a literal `undefined:name` — including the transitional case where a
streaming placeholder knows the tool name but not yet its server. Production: `toolLabel` in
`packages/code/src/adapters/tool-identity.ts`. Tests
`packages/code/tests/unit/tool-identity.test.ts`.

**INV-262.** `isMutationTool` resolves through the same identity rule as `toolIdentity`, and treats
`write_memory`/`edit_memory`/`delete_memory` as mutations while treating
`read_memory`/`list_memories`/`grep_memories` as non-mutations. Production: `isMutationTool` and
`MUTATION_TOOLS` in `packages/code/src/adapters/tool-identity.ts`. Tests
`packages/code/tests/unit/tool-identity.test.ts`. The consequence this protects is the
grouping pass: a memory write must not fold into a run of reads —
`packages/code/tests/unit/tool-groups.test.ts`.

**INV-263.** `MUTATION_TOOLS` has an exact, exhaustive membership: `write_file`, `edit_file`,
`multi_edit`, `apply_patch`, `replace`, `move`, `copy`, `mkdir`, `remove`, `write_memory`,
`edit_memory`, `delete_memory`. Because the file half is derived from
`@clarvis/loop`'s registry (`packages/loop/src/runtime/tools/builtin/names.ts`), a registry change
alters this set — and must therefore be a visible diff to the pinning test. Production:
`MUTATION_TOOLS` in `packages/code/src/adapters/tool-identity.ts`. Test
`packages/code/tests/unit/tool-identity.test.ts`.

**INV-T01.** `sealed.join("") + tail` reconstructs the segmenter's input exactly, for every input
shape and every `min`. Production `packages/code/src/core/transcript/segment.ts` (declared). Test `packages/code/tests/unit/segment-markdown.test.ts`.

**INV-T02.** Segmentation is prefix-stable at **every** prefix: appending characters never moves,
withdraws or rewrites a cut already taken. Production
`packages/code/src/core/transcript/segment.ts`, enforced by the terminated-blank-line condition. Test `packages/code/tests/unit/segment-markdown.test.ts` (character-by-character, not a
stride).

**INV-T03.** A cut never lands inside a fenced or indented code block; an unterminated fence simply
means no further cut is available and the whole remainder stays in `tail`. Production
`packages/code/src/core/transcript/segment.ts`. Tests
`packages/code/tests/unit/segment-markdown.test.ts`.

**INV-T04.** A tail-only stream update and ordinary running-to-settled transition publish the
**same** `sealed` array and segment-object references, so a long response neither copies thousands
of references per delta nor remounts completed prefixes at settlement. Production
`packages/code/src/core/transcript/segment.ts` (`IncrementalMarkdownSegmenter.#snapshot`, `#settle`,
and `#seal`). Tests `packages/code/tests/unit/segment-markdown.test.ts` ("does not copy the sealed
segment index for tail-only stream updates", "keeps sealed object identity while scanning only later
appends", and "settling preserves stable Markdown prefixes and large replies stay plain").

**INV-T05.** Segmentation degrades in exactly two bounded ways and both set `simplified`: more than
`MAX_MARKDOWN_SEGMENTS` (64) markdown seals, or an unsealed tail past `TAIL_PLAIN_CAP` (24 KiB); a
settled reply larger than `FINAL_MARKDOWN_CAP` (64 KiB) is emitted entirely as plain chunks.
Production `packages/code/src/core/transcript/segment.ts`. Tests
`packages/code/tests/unit/segment-markdown.test.ts`.

**INV-T06.** A tool node's `args`, `result`, `diff` and `error` reach a renderer only through
`projectTranscriptToolDisplay`; each independent string is capped at 64 KiB and the persisted node is
left complete. Production `packages/code/src/core/transcript/tool-display.ts`, called at
`packages/code/src/views/blocks.tsx`. Test
`packages/code/tests/unit/tool-display.test.ts` (asserts `node.result` is untouched).

**INV-T07.** Argument projection never invokes an accessor: every value is read through
`Object.getOwnPropertyDescriptor` and a non-data descriptor becomes the literal
`"[accessor omitted]"`. Production
`packages/code/src/core/transcript/tool-display.ts`. Test
`packages/code/tests/unit/tool-display.test.ts` (asserts zero getter invocations).

**INV-T08.** The cycle guard tracks the current **path**, not every object visited: a value shared by
two keys is projected twice and does not raise the "display shortened" banner, while a genuine cycle
is still caught. Production `packages/code/src/core/transcript/tool-display.ts`.
Tests `packages/code/tests/unit/tool-display.test.ts`.

**INV-T09.** The projection is memoised per node by the identities of `args`, `result`, `diff` and
`error`, so immutable publication and block rendering share one computation. Production
`packages/code/src/core/transcript/tool-display.ts`. Test
`packages/code/tests/unit/tool-display.test.ts` (`toBe` on a repeated call).

**INV-T10.** `semanticNodes` exposes exactly one complete ordered projection: nodes without a
`subagentId` for the Lead-only main transcript — including typed delegation lifecycle markers — or
nodes matching one explicitly selected child id. Child nodes remain in the backing store and
publication ledger; physical residency cannot alter either semantic filter. Production:
`createTranscriptState` (`visibleNodes`, `semanticNodes`). Tests:
`packages/code/tests/unit/transcript-window-state.test.ts` ("the main transcript excludes sub-agent
work until that transcript is selected") and
`packages/code/tests/integration/transcript-region-render.test.tsx` (main-hidden and sibling-isolation
cases).

**INV-T11.** Section grouping, tool grouping and focus derive from the same complete current
Lead-or-child projection; a focused non-resident key in that projection is handed to physical
`revealKey` rather than omitted. Production:
`createTranscriptState` (`grouped`, `toolGroups`, `focusables`) and `packages/code/src/views/App.tsx`
(`focusBlock`). Tests: `packages/code/tests/unit/transcript-window-state.test.ts` and
`packages/code/tests/integration/transcript-window-render.test.tsx` (physical navigation).

**INV-T12.** `reset()` clears focus and fold overrides but never slices, replaces or reorders the
semantic projection. Production: `createTranscriptState` (`reset`). Test:
`packages/code/tests/unit/transcript-window-state.test.ts` (reset case).

**INV-T13.** No estimated node-cost, character-cost or turn-count selector may decide ordinary
physical residency. Production: `CommittedHistory` and `createVisibleSliceController`. Tests:
`packages/code/tests/architecture/architecture-boundary.test.ts` (estimated-paging exclusion) and
`packages/code/tests/unit/transcript-visible-slice.test.ts` (equal-marker metamorphic case).

**INV-T14.** Committed block structure reads frozen publication group/header/default-fold metadata;
live grouping maps may drive navigation or the same-selection `LiveTranscriptTail`, but cannot
reshape an already committed owner. Production: `PublicationOwner` and
`LiveTranscriptTail`. Test:
`packages/code/tests/integration/transcript-publication-render.test.tsx` (stable memory, diff and
write owners while later activity changes).

**INV-T15.** `pickDiffNode` deliberately ignores physical residency: it scans the full detail source
or semantic node source, so a currently unmounted diff remains reachable. Production:
`createTranscriptState` (`pickDiffNode`). Tests:
`packages/code/tests/unit/transcript-window-state.test.ts` and
`packages/code/tests/unit/transcript-state.test.ts` (diff selection and hydration).

**INV-T16.** `withRunMarkersLast` returns its input array untouched when no marker moves, and
otherwise emits every node exactly once. Production
`packages/code/src/views/transcript-state.ts`. Tests
`packages/code/tests/unit/run-marker-order.test.ts` (`toBe`).

**INV-T17.** `computeGroupedNodes`, `computeToolGroups` and `computeFocusables` read none of `text`,
`result`, `diff`, `args`, `liveOutput`, `dehydrated` — so a streamed token and a dehydrated block are
free for the grouping memos. Production `packages/code/src/views/subagent-sections.ts`,
`packages/code/src/views/tool-groups.ts`, `packages/code/src/views/block-focus.ts`. Tests
`packages/code/tests/unit/transcript-grouping-fields.test.ts`, with a self-check
and a dehydration-equivalence check.

**INV-T18.** A mutation tool never folds into a group: each call stays `"solo"` regardless of how
many identical calls are adjacent. Production `packages/code/src/views/tool-groups.ts`. Tests
`packages/code/tests/unit/tool-groups.test.ts`.

**INV-T19.** A group breaks on any of: a non-`tool_call` node, a different `mcpName`, a different
`toolName`, a different `subagentOrder`. Both current-projection grouping and immutable publication
preserve the server and tool slots separately; a leaf-only renderer identity cannot merge calls from
different MCP servers. Production: `packages/code/src/views/tool-groups.ts` (`computeToolGroups`)
and `packages/code/src/adapters/transcript-publication.ts` (`publicationToolGroups`,
`samePublicationToolIdentity`, `TranscriptPublisher.#publishTool`,
`TranscriptPublisher.#publishRemainingLead`). Tests:
`packages/code/tests/unit/tool-groups.test.ts` (all break conditions) and
`packages/code/tests/unit/transcript-publication.test.ts` (different MCP servers across live,
terminal-sweep and sub-agent publication paths).

**INV-T20.** Only tool calls that are `"solo"` or `"head"` — plus a folded section's single anchor —
are keyboard-focusable. Production `packages/code/src/views/block-focus.ts`. Test
`packages/code/tests/unit/block-focus.test.ts`.

**INV-T21.** "Expand all" unfolds blocks but does **not** lift a body's ten-line clamp; only an
explicit per-block or per-head `"expanded"` override does. Production
`packages/code/src/views/blocks.tsx` (rule stated). Test
`packages/code/tests/integration/tool-clamp.test.tsx`, which mounts every fixture with
`forceExpand={() => true}`, while still expects the ten-line cap and its `… +N lines` footer.

**INV-T22.** A mutation's chip counts the call's **real** payload, never the 64 KiB display
projection. Production `packages/code/src/views/blocks.tsx` (prefers `node.mutation`) and
`packages/code/src/views/tools/registry.tsx` (`gateStats` prefers `call.mutation`). Test
`packages/code/tests/integration/transcript-region-render.test.tsx` (a >64 KiB diff must chip as
`+4000`).

**INV-T23.** A collapsed mutation's stats come from the diff/content the body would render, not from
the tool's one-line result — and for `write_file`/`write_memory` without a real diff, every content
line counts as added. Production `packages/code/src/views/tools/mutation-gate.ts`. Tests
`packages/code/tests/integration/mutation-gate.test.tsx` and
`packages/code/tests/integration/tool-destripe-render.test.tsx`.

**INV-T24.** `isOversizeMutation` and the renderers' own `oversize()` agree on every gated identity,
including the synthesized-diff fallback and `apply_patch`'s diff-else-`patch` rule. Production
`packages/code/src/views/tools/mutation-gate.ts` against `packages/code/src/views/tools/registry.tsx`. Tests
`packages/code/tests/integration/mutation-gate.test.tsx`.

**INV-T25.** A mutation diff is never clamped to `MAX_BODY_LINES`; it is either rendered through the
bounded display projection or collapsed behind the chip. A lead mutation always takes the rendered
branch regardless of its line count; delegated mutations keep the ordinary gate, and an explicit
user fold still hides either one. Production: `isLeadMutation` in
`packages/code/src/views/tools/mutation-gate.ts`, `BlockView` in
`packages/code/src/views/blocks.tsx`, `toggleOverride` in
`packages/code/src/views/block-focus.ts`, and the mutation renderers pass their diff straight to `<diff>`
(`packages/code/src/views/tools/registry.tsx`) and never through `ClampedText`/`ClampedCode`. Test
`packages/code/tests/integration/tool-clamp.test.tsx`, whose title states the reason: "clamping
breaks the unified-diff parser", plus the lead/delegated/manual-fold matrix in
`packages/code/tests/integration/tool-mutation-diff.test.tsx`.

**INV-T26.** Being JSON is not being an envelope: a `shell` result is parsed as an envelope only if it
carries at least one of `exit_code`, `stdout`, `stderr`, `signal`, `timed_out`; a monitor payload only
if it carries at least one of its eight keys. Production
`packages/code/src/adapters/tool-parsers.ts`. Tests
`packages/code/tests/unit/tool-parsers.test.ts`.

**INV-T27.** A `shell` call that never reached a shell reports its message exactly once, in `stderr`,
and its status word is `failed` rather than `done`. Production
`packages/code/src/adapters/tool-parsers.ts` (drops `stdout` when it is the error again) and
`packages/code/src/views/tools/registry.tsx`. Tests
`packages/code/tests/unit/tool-parsers.test.ts` and
`packages/code/tests/integration/tool-registry-render.test.tsx`.

**INV-T28.** Genuine partial output alongside a *different* error text is preserved on both streams.
Production `packages/code/src/adapters/tool-parsers.ts`. Test
`packages/code/tests/unit/tool-parsers.test.ts`.

**INV-T29.** Every rendered diff passes through `StableDiff`'s CR normalization before reaching the
OpenTUI renderable. Production: `StableDiff` in
`packages/code/src/ui/patterns/stable-syntax.tsx`, used by every mutation and explicit diff branch
in `packages/code/src/views/tools/registry.tsx`. Test
`packages/code/tests/integration/tool-diff-render.test.tsx` ("every diff normalizes CRLF and bare CR
before it reaches OpenTUI").

**INV-T30.** A tool node with `inputChars` set renders the composing stand-in **instead of** a
signature, never both. At zero argument bytes it says `waiting for arguments` rather than claiming
argument progress; optional `inputStreamChars` exposes a separately labelled cumulative provider
stream count that may advance while arguments stay at zero. After the first argument byte the same
row exposes both counts without conflating them. Explicit
input end changes it to `arguments ready` without claiming the tool ran. Production: `composingLabel` and
`ToolLine` in `packages/code/src/views/blocks.tsx`. Tests:
`packages/code/tests/unit/composing-label.test.ts` and
`packages/code/tests/integration/tool-destripe-render.test.tsx`.

**INV-T31.** A running tool's live tail shows at most the last 5 lines, truncates rather than wraps,
and disappears the instant the call closes. Production
`packages/code/src/views/blocks.tsx`. Tests
`packages/code/tests/integration/tool-live-tail-render.test.tsx`.

**INV-T32.** A group `member` stays hidden while the group is collapsed unless it carries `warn` — an
errored member is hidden too. Production `packages/code/src/views/blocks.tsx`. Test
`packages/code/tests/integration/tool-groups-render.test.tsx`.

**INV-T33.** A collapsed group head lists at most 6 member signatures, then a `moreChip`. Each shown
signature prefers the member's resident `signature` over live `args`, so a dehydrated grouped
`read_file` still names its path. Each shown shell signature retains its own guard verdict and
answerer; guarded failures remain identifiable even though their error body stays folded. Production:
`packages/code/src/views/blocks.tsx` (`signatureMembers`, grouped signature render) and
`packages/code/src/views/tools/signature.ts` (`resolveToolCallSignature`). Tests:
`packages/code/tests/integration/tool-groups-render.test.tsx`,
`packages/code/tests/unit/tool-signature.test.ts`, and
`packages/code/tests/unit/store-hydration.test.ts`.

**INV-T34.** A finished tool shows an elapsed chip only at or above `SLOW_TOOL_MS` (2000 ms).
Production `packages/code/src/views/blocks.tsx`. Tests
`packages/code/tests/integration/tool-destripe-render.test.tsx`.

**INV-T35.** A transcript block is capped at 110 columns by default. The transcript shell explicitly
fills the available width: without a sidebar it passes `maxWidth="100%"`; in a split it opts into
`fillAvailableWidth`, where blocks and inline elicitation cards stop at the fixed sidebar boundary.
Production: `packages/code/src/views/blocks.tsx` (`BlockView`),
`packages/code/src/views/app/TranscriptRegion.tsx` (`TranscriptRegion`), and
`packages/code/src/views/ElicitBlock.tsx` (`ElicitBlock`). Tests:
`packages/code/tests/integration/measure-render.test.tsx`,
`packages/code/tests/integration/transcript-region-render.test.tsx`,
`packages/code/tests/integration/app-shell-render.test.tsx`, and
`packages/code/tests/integration/elicit-block-render.test.tsx`.

**INV-T36.** Released prose wins over truncation: a node carrying `proseReleased` renders the
`/export` recovery sentence rather than its retained text, even when `textTruncated` is also set.
Production `packages/code/src/core/transcript/presenters.ts` (documented).
Test `packages/code/tests/integration/markdown-render-contract.test.tsx`.

**INV-T37.** One prose node's mounted text is bounded at 512 KiB, and every tool display projection
reports mounted text within the same aggregate ceiling before OpenTUI receives it. Physical row
admission does not bypass either per-artifact cap. Production:
`packages/code/src/core/transcript/presenters.ts` (`transcriptDisplayTextChars`,
`transcriptDisplayText`) and `packages/code/src/core/transcript/tool-display.ts`
(`projectTranscriptToolDisplay`). Tests: `packages/code/tests/unit/presentation.test.ts`,
`packages/code/tests/unit/tool-display.test.ts` and
`packages/code/tests/unit/transcript-publication.test.ts` (pathological bounded snapshots).

**INV-T38.** A plan projection with an older `revision` for the same plan id is discarded, returning
the current projection by identity. Production
`packages/code/src/adapters/plan-projection.ts`. Test
`packages/code/tests/unit/plan-projection.test.ts` (`toBe`).

**INV-T39.** A `workflow_title_updated` arriving with no existing tree returns `null` rather than
seeding a manager node that nothing will ever close. Production: the `workflow_title_updated`
branch of `reduceWorkflowProjection`. Test: `packages/code/tests/unit/workflow-projection.test.ts`
(`does not invent a running tree from a title event alone`).

**INV-T40.** A cancelled workflow node is reported as `cancelled`, never folded into `error` — for
both a leader and the manager root. Production: the `run_ended` and terminal workflow branches of
`reduceWorkflowProjection`. Tests: `packages/code/tests/unit/workflow-projection.test.ts`
(`preserves cancellation instead of presenting a stopped leader as failed`; `run_ended preserves a
cancelled manager root`).

**INV-T41.** This document's slice of `src/core/**` (`core/transcript/**`, `core/marks.ts`,
`core/run-status.ts`, `core/attention.ts`, `core/format-elapsed.ts`, `core/terminal-text.ts`) complies with the whole-package
`src/core/**` import boundary (INV-243) — full statement owned by
[hosts/code-bootstrap.md](code-bootstrap.md) §5. Production example:
`packages/code/src/core/transcript/presenters.ts` imports `../marks.ts` only.

**INV-T42.** This document's slice of `src/adapters/**` (`tool-identity.ts`, `tool-parsers.ts`,
`plan-projection.ts`, `workflow-projection.ts`, `message-content.ts`, `event-span.ts`) complies with
the whole-package `src/adapters/**` import boundary (INV-244) — full statement owned by
[hosts/code-bootstrap.md](code-bootstrap.md) §5. Production example:
`packages/code/src/adapters/tool-identity.ts` reaches `@clarvis/kernel/policy`, which is permitted
for this layer.

**INV-T43.** `code`'s `contentToText` is a deliberate duplicate of `@clarvis/capability`'s, kept
apart because `@clarvis/code` may not depend on `@clarvis/capability` even for a type; the drift
check is that each package's own suite asserts the same behavioural cases. Production
`packages/code/src/adapters/message-content.ts`. Test
`packages/code/tests/unit/message-content.test.ts`, a six-case table whose own header states the
same rule from the test side.

**INV-T44.** The sidebar's plan section mounts a **bounded** slice of the task list that always
contains the current task: at most `PLAN_SIDEBAR_TASK_LIMIT = 12` rows, centred on
`currentPlanTask`, with the remainder reported as `↑ N earlier tasks` / `↓ N later tasks` rather
than mounted. Production: `PLAN_SIDEBAR_TASK_LIMIT`, `planTaskWindow`, and `PlanSummary` in
`packages/code/src/views/Sidebar.tsx`. Test
`packages/code/tests/integration/sidebar-render.test.tsx`, which asserts both the window's own
shape and that a 50-task plan paints `Task 30` with the first task absent from the frame.

**INV-T45.** The sidebar carries no run totals. A sub-agent's `input`/`output` token counts and the
run's context and usage figures are held by the same `ActivityStore` the sidebar reads
(`packages/code/src/adapters/activity-store.ts`) and are rendered by none of
its rows — `contextMeter` exists in `packages/code/src/views/Sidebar.tsx` but no `src` module calls
it. Test `packages/code/tests/integration/sidebar-render.test.tsx`, which mounts a store carrying
both and asserts the frame contains neither "context" nor "tokens".

**INV-T46.** A removed plan is neutral retention history iff its last projection says all three of
`removed`, `status: completed`, and `retention: discard`; no weaker combination suppresses the
unavailable/recovery state. Sidebar and transcript block consume that distinction; the footer never
projects Plan state.
Production: `packages/code/src/adapters/plan-projection.ts`,
`packages/code/src/adapters/store.ts`, `PlanSummary` in
`packages/code/src/views/Sidebar.tsx`, and `packages/code/src/views/blocks.tsx`. Tests:
`packages/code/tests/unit/plan-projection.test.ts`,
`packages/code/tests/unit/store-status.test.ts`,
`packages/code/tests/integration/sidebar-render.test.tsx`, and
`packages/code/tests/integration/plan-block-render.test.tsx`.

**INV-T47.** Expanded tool calls never mount a generic `Arguments` label or raw argument JSON.
Projected arguments feed the bounded one-line signature and the identity-specific result renderer;
Markdown export adds the complete bounded, renderer-safe projection plus an explicit shortening marker,
so auditability does not require mounting raw JSON in the live transcript. Production
`packages/code/src/views/blocks.tsx`, with the only mounted sections after the header. Tests `packages/code/tests/integration/tool-destripe-render.test.tsx` cover both a
curated shell renderer and the generic fallback, asserting useful output and signatures remain while
JSON key/value presentation is absent.

**INV-T48.** Detailed Plan, Parallel work and Agents state has exactly one responsive owner. In
`split` and `drawer` modes it is the combined `Sidebar`; a closed secondary surface mounts no roster
or Plan/workflow pane in the Lead transcript. The footer retains bounded agent/workflow activity
beside canonical Context/Session state and reopens the surface on click, while Plan contributes no
footer text. `/activity [plan|workflow|agents]` explicitly reopens any available section after
Escape. The first live Plan, first workflow state/leader and first delegation own independent
once-per-execution automatic intents that
open/reveal their whole section. Closing one is sticky only for repeated events of that intent; the
first event for another section may reopen and reorient the Sidebar. The Agents intent keeps `Lead
transcript` selected and opens no `ActivityDetail`. Repeated updates cannot flap the layout, and a
long Plan cannot clip a later revealed section. An individually focused agent mounts only one compact
context row. Tab remains the keyboard route through the roster in both split and drawer modes. Any
agent-row activation only selects that child's isolated transcript; it never opens `ActivityDetail`
automatically. Production:
`packages/code/src/views/app/TranscriptRegion.tsx` (`secondaryMode`, focused-agent context and the two
`Sidebar` mounts), `packages/code/src/views/Sidebar.tsx` (`SidebarRevealIntent`, `Sidebar` section
owners and native reveal), and `packages/code/src/views/App.tsx` (`visiblePlanContext`,
`visibleSubagentContext`, `requestAutomaticSidebar`, `closeActivitySidebar`,
`openActivitySidebar`, the `activity.open` command and `compactActivityStrip`). Tests:
`packages/code/tests/integration/transcript-region-render.test.tsx`,
`packages/code/tests/integration/sidebar-render.test.tsx` (including the settled-row negative
`ActivityDetail` case), and
`packages/code/tests/integration/app-shell-render.test.tsx` (the independent Plan/workflow/Agents
auto-reveal contract, per-intent sticky close, `/activity` reopening, long-Plan reveal and
completed-agent selection).

**INV-T49.** Every delegation mounts exactly two friendly, Lead-owned, append-only lifecycle markers:
one `spawned` marker from `delegation_created`, then one `completed` or `failed` marker from the
terminal typed event. `delegation_started` and the generic delegation `capability_event` mirror mount
no Lead row. Neither marker contains the child brief, tools, reasoning, answer or result, and the
terminal marker cannot mutate the already frozen spawned marker. Selecting one child mounts only
that child's retained content nodes; every sibling remains absent. A card-backed isolated body has a
folded semantic default, but its first explicit selection installs a one-time expanded override for
that section anchor so the body opens readable, including when the body commits after selection.
Manual collapse remains folded across Lead/reselection; a sibling expands independently; Lead/global
fold preference is unchanged. A degraded cardless isolated transcript keeps its first body node as
the identity anchor. Terminal roster status is resolved through any retained node carrying the
selected child's id, so a missing card cannot leave that isolated section at `Running` after
completion. Production:
`createTranscriptState` (`visibleNodes`, first-selection anchor expansion), `LiveTranscriptTail`
(`belongsToSelection`) and
`packages/code/src/views/subagent-sections.ts` (`computeGroupedNodes`, `rosterStatus`, `emitSection`).
Tests: `packages/code/tests/unit/transcript-window-state.test.ts` (Lead/child filter),
`packages/code/tests/unit/transcript-state.test.ts` (first/late selection, manual collapse,
independent sibling and pruning), and `packages/code/tests/integration/app-shell-render.test.tsx`
(readable first selection and collapsed reselection).

**INV-T50.** Settling assistant Markdown never exposes the final OpenTUI tree before its syntax
descendants and one confirming frame are complete. The already painted streaming tree remains the
visible owner during preparation, and at most two Markdown trees exist during the handoff. The
preparing final tree keeps its intrinsic height; after the atomic swap its height is `auto`, so a
shorter final rendering cannot leave the streaming overlay's row count as blank space above the run
outcome. Production: `packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`,
`waitForSyntaxFrame`) and `packages/code/src/views/blocks.tsx` (`AssistantMarkdown`). Test:
`packages/code/tests/integration/markdown-render-contract.test.tsx` ("settlement keeps the painted
streaming markdown visible until its final tree is ready", "settlement releases a streaming height
floor after the final tree is ready" and "a tall streaming reply does not leave blank rows above the
run outcome").

**INV-T51.** Within one continuously mounted `BlockView`, a finalized diff retains the same
`DiffRenderable` while an unrelated sibling outside that block updates, and a newly mounted diff
becomes visible only after its syntax-ready frame. Production composition additionally freezes group
metadata and keeps that owner independent from the mutable tail; the end-to-end identity invariant is
owned by [code-transcript-stability.md](code-transcript-stability.md). Production:
`packages/code/src/ui/patterns/stable-syntax.tsx` (`StableDiff`, `waitForSyntaxFrame`). Test:
`packages/code/tests/integration/tool-diff-render.test.tsx` ("a finalized diff keeps one renderable
while an active sibling updates").

**INV-T52.** Fold overrides contain no tombstone for a key evicted from the complete semantic
source. Lead/child selection alone does not prune the other projection's still-retained overrides.
Production: `createTranscriptState` (override-pruning effect). Test:
`packages/code/tests/unit/transcript-state.test.ts` (100-cycle semantic-retention plateau).

**INV-T53.** Sidebar handles are stateless projections with disjoint namespaces: workflow leaders
are `L1`, `L2`, … in current start order, while sub-agents are `A<order + 1>`. A new run reuses its
own local handles without retaining native ids or allowing leaders to shift agent numbering.
Production: `Sidebar` (`leaders`, both roster loops). Test:
`packages/code/tests/integration/sidebar-render.test.tsx` (combined workflow/agent run replacement).

**INV-T54.** The Lead transcript suppresses provider tool rows for the closed supervision and
orchestration identity set `spawn_subagent`, `delegate_task`, `agent_list`, `agent_poll`, `agent_stop`,
`agent_steer`, `await_agents`, `run_leader`, `run_workflow`, `run_round`, `run_work_items`,
`workflow_status`, `workflow_decide`.
Suppression covers `tool_input_delta`, `tool_call_started`, `tool_output_delta` and terminal
`tool_call`, so no composing placeholder, running row, output tail, group or settled block can flash
before disappearing. Exactly two typed delegation markers remain; workflow state remains outside
the transcript; ordinary Lead `thinking`/`working` remains eligible only in the fixed activity line
outside the ScrollBox. A tool carrying a child id
belongs only to that child's isolated transcript. Production:
`isTranscriptExternalOrchestrationTool`, `createTranscriptStore` (`openRun`),
`TranscriptPublisher.#publishTool` and `createTranscriptState` (`visibleNodes`). Test:
`streaming-delta.test.ts` ("Lead-owned orchestration tools never create composing, started, or
terminal nodes"), plus production-shaped Lead/child rendering cases.

**INV-T55.** Transient Lead activity has exactly one physical owner: `LeadActivityLine`, a one-row
sibling immediately above `InputDock`. It reuses the same band for `thinking`, `working` and settled
`ready`; while a run is active, elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt share that line.
Slash autocomplete replaces the activity line instead of stacking above or below it. The line is
never a live or committed transcript node and cannot scroll or change transcript height. The history
ScrollBox ends with a fixed reading runway of three rows,
reduced to one row only when terminal height is at most 28; streaming state cannot change that
height. No Plan pane mounts between transcript and composer. Production:
`packages/code/src/views/App.tsx` (`leadActivityPhase`, `leadActivityDetail`, `inputPopupOpen` and
bottom composition),
`packages/code/src/views/Footer.tsx` (`LeadActivityLine`),
`packages/code/src/views/live/LiveTranscriptTail.tsx` (Lead-thinking exclusion and runway), and
`packages/code/src/views/app/TranscriptRegion.tsx` (`transcriptReadingRunwayRows`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` ("an active run seats its live metadata
beside working and keeps the session footer stable", "Lead thinking and working reuse one fixed line
immediately above the composer", and "autocomplete replaces the Lead activity row instead of
stacking ready or working above it") and
`packages/code/tests/integration/transcript-region-render.test.tsx` (plan exclusion and normal versus
compact runway bands).

**INV-T56.** Index-slice admission cannot reduce the semantic quality of a transcript artifact.
Frozen Markdown, diff and code bodies render through the same `BlockView`, `MarkdownRenderable`,
`DiffRenderable` and `CodeRenderable` presentation used elsewhere; history does not introduce a
geometry placeholder or plain-text fallback. Production:
`packages/code/src/views/history/CommittedHistory.tsx` (`PublicationOwner`) and
`packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`, `StableDiff`). Tests:
`packages/code/tests/integration/transcript-publication-render.test.tsx` (stable Markdown, diff and
`write_memory` owners).

**INV-T57.** Within one running assistant `geometryEpoch`, `StableMarkdown` retains the greatest
visible row height it has observed as a layout floor. OpenTUI may later parse and conceal an
unfinished Markdown delimiter, but the tail cannot give those rows back, reduce sticky `scrollTop`
or pull an earlier transcript anchor downward. A changed epoch clears the floor. The reservation
does not replace native Markdown, disable `conceal` or flatten attributes: parsed strong text remains
bold and its delimiter characters remain hidden. Production:
`packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`, `liveHeightFloor`) and
`packages/code/src/views/blocks.tsx` (`AssistantMarkdown`, `geometryEpoch`). Test:
`packages/code/tests/integration/transcript-scrollbox-render.test.tsx` ("bottom-following streaming
Markdown never gives rows back when parsing conceals syntax").

**INV-T58.** Tool-input progress is cumulative and call-id scoped. Only an explicit
`tool_input_delta.complete: true` moves a composing node to pending `arguments ready`; another
call's start cannot close it because provider tool calls may be composed in parallel.
The optional `stream_chars` value is physical-attempt liveness and remains separately labelled from
the call's argument count.
`tool_call_started` clears composition state and begins actual execution, while `model_retry`
removes every composing placeholder from the failed attempt before rendering retry status.
Production: `openRun` in `packages/code/src/adapters/store.ts`. Test:
`packages/code/tests/unit/streaming-delta.test.ts` (`tool-input end marks arguments ready until the
real tool call starts` and `a retry drops composing placeholders from the failed provider attempt`).

**INV-T59.** Untrusted process output cannot carry terminal cursor, device or line-editing controls
into an OpenTUI text renderable. `terminalPlainText` removes CSI and string-control families, drops
remaining C0/C1 controls except newline and tab, recognizes C1 `ST` as a string terminator without
consuming the printable suffix, projects bare carriage return as replacement of the current line,
and applies backspace within that line. Running tool tails and settled plain result
cards use this same projection, and their text begins at the same physical column; the trace and raw
tool-result ownership stay outside this presentation boundary. Local `!bash` capture also applies
the projection before constructing its observation. Production:
`packages/code/src/core/terminal-text.ts` (`stripAnsi`, `terminalPlainText`),
`packages/code/src/views/blocks.tsx` (`liveTailLines`, live-tail inset),
`packages/code/src/views/tools/registry.tsx` (`ClampedText`) and
`packages/code/src/adapters/local-shell.ts` (`runLocalBash`). Tests:
`packages/code/tests/unit/terminal-text.test.ts`,
`packages/code/tests/integration/local-shell.test.ts` ("strips ANSI escapes from captured output")
and `packages/code/tests/integration/tool-live-tail-render.test.tsx` ("Prisma cursor controls stay
inert and live output keeps its settled text column").

---

## 6. Failure modes and degradation

| Situation | Handling | Cite |
| --- | --- | --- |
| Tool result is not JSON, or is JSON but not the tool's envelope | `parseBash` returns `parsed: false`; `parseMonitor` returns `undefined` and `renderMonitor` falls through to `renderGeneric` | `packages/code/src/adapters/tool-parsers.ts`; `packages/code/src/views/tools/registry.tsx` |
| A `ToolError` payload (`{error, message}`) reaches `parseBash` | `errorText` composes `"code: message"`, or whichever of the two is present, and puts it in `stderr` alone | `packages/code/src/adapters/tool-parsers.ts` |
| `result` and `error` are the same string | `stdout` is dropped so the sentence is printed once | `packages/code/src/adapters/tool-parsers.ts` |
| `read_files` output has no `==> path <==` banner | falls back to `renderGeneric` | `packages/code/src/views/tools/registry.tsx` |
| `grep_memories` output parses to zero groups | falls back to `renderGeneric` | `packages/code/src/views/tools/registry.tsx` |
| `file_stat` / generic result is not a JSON object | `renderJsonCard` falls back to `renderGeneric`; `renderGeneric` itself upgrades to the JSON card only when `parseJsonObject` succeeds | `packages/code/src/views/tools/registry.tsx` |
| `diff`/`replace` with an empty body | falls back to `renderGeneric` | `packages/code/src/views/tools/registry.tsx` |
| Any tool with no registry entry | `renderGeneric` | `packages/code/src/views/tools/registry.tsx` |
| Empty result | a muted placeholder — `"(no output)"`, `"(no matches)"`, `"(no monitors)"`, `"(empty)"`, `"(done)"` | `packages/code/src/views/tools/registry.tsx` |
| A tool call errored | `resolveErrorRenderer` — the tool's own renderer for the four `ERROR_AWARE` tools, plain error text otherwise | `packages/code/src/views/tools/registry.tsx` |
| An error body would exceed the clamp | `renderErrorGeneric` honours `full`, so the clamp can be lifted; the code states clamping "truncates the stack trace that explains the failure" | `packages/code/src/views/tools/registry.tsx` |
| `JSON.stringify` throws while formatting a signature value | caught, falls back to `String(v)` | `packages/code/src/views/tools/signature.ts` |
| A truncate target is `null`/`undefined` | treated as `""` — "a config field the user has cleared cannot throw out of a render pass" | `packages/code/src/views/truncate.ts` |
| `max <= ellipsis.length` in a truncate | returns a truncated ellipsis rather than throwing | `packages/code/src/views/truncate.ts` |
| Argument payload needed by a curated renderer exceeds a budget (chars / nodes / depth) | `truncated: true` plus a sentinel in the bounded projection; the block paints `TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE` without mounting raw JSON | `packages/code/src/core/transcript/tool-display.ts`; `packages/code/src/views/blocks.tsx` |
| Duplicate projected keys after key truncation | disambiguated with `#2`, `#3`, … and flagged `truncated` | `packages/code/src/core/transcript/tool-display.ts` |
| Non-finite number in arguments | projected as `null` | `packages/code/src/core/transcript/tool-display.ts` |
| A single node's text exceeds 512 KiB | truncated with `TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE` appended | `packages/code/src/core/transcript/presenters.ts` |
| A streamed reply outgrows the segmenter's bounds | forced plain, `simplified: true`, with an explanatory line above a settled reply | `packages/code/src/core/transcript/segment.ts`; `packages/code/src/views/blocks.tsx` |
| A tool block's body was dropped by the retention window | `dehydrated` is set; expanding calls `deps.rehydrate` and, if the refill fails, `hydrationNotice` is shown | `packages/code/src/views/blocks.tsx`; `packages/code/src/views/transcript-state.ts` |
| A dehydrated node still needs a header | the resident `signature` and `mutation` fields carry the collapsed header, group-member list and chip; the type docs state this is "tens of bytes against the tens of kilobytes" | `packages/code/src/core/transcript/types.ts`; `packages/code/src/views/blocks.tsx`; `packages/code/src/views/tools/signature.ts` (`resolveToolCallSignature`) |
| A stale plan event arrives after a newer one | dropped by the revision guard | `packages/code/src/adapters/plan-projection.ts` |
| A plan removal arrives for a plan never seen | an explicit "Plan unavailable / failed / removed" projection is synthesized rather than nothing | `packages/code/src/adapters/plan-projection.ts` |
| Retention deletes a completed `discard` plan | projected history stays completed and muted; the UI confirms configured cleanup rather than requesting recovery | `packages/code/src/adapters/plan-projection.ts`; `PlanSummary` in `packages/code/src/views/Sidebar.tsx` |
| A workflow terminal event arrives before any leader seeded the tree | `run_ended` returns `current` unchanged; `workflow_title_updated` returns `null` | the matching branches of `reduceWorkflowProjection` |
| A workflow progress/terminal event names an unknown leader | a minimal leader node is synthesized in place | the matching branches of `reduceWorkflowProjection` |
| A selected sub-agent transcript has a body but no `subagent` card | the first body node stays visible as the isolated identity anchor and later entries fold behind it. Live roster status is resolved through any body node carrying `subagentId`; only an absent live status falls back to `"running"` | `packages/code/src/views/subagent-sections.ts` (`rosterStatus`, `emitSection`) |
| A run produced only delegated work and no Lead answer/tool | the Lead transcript contains only each delegation's frozen spawned and settled markers; selecting one worker reveals only that worker's retained body and expands its card-backed section on first explicit selection | `packages/code/src/views/transcript-state.ts` (`visibleNodes`, first-selection anchor expansion), `packages/code/src/views/subagent-sections.ts` (`emitSection`) |
| The terminal reports no capabilities (headless / test renderer) | every attention cue no-ops; `away()` returns `true` so the terminal decides | `packages/code/src/core/attention.ts` |
| A `RunEvent` type is added without a span mapping | compile-time exhaustiveness error, not a runtime path | the exhaustive default in `deriveRunEventSpan` |

Degradation that is **silent by design**: a tool whose result the parser cannot read still renders
(as generic text), and grouping/focus keep working on a dehydrated node because they read only
`key`/`kind`/`status`/identity (`packages/code/src/core/transcript/types.ts`, pinned at
`packages/code/tests/unit/transcript-grouping-fields.test.ts`).

---

## 7. Coupling

### 7.1 What forces the layering

| Edge | Direction | What forces it |
| --- | --- | --- |
| `views/**` → `core/transcript/**` | runtime | value imports at `packages/code/src/views/blocks.tsx` and `packages/code/src/views/transcript-state.ts` |
| `core/transcript/**` → `core/marks.ts` | runtime | `packages/code/src/core/transcript/presenters.ts` — the only import in the whole core-transcript tree |
| `core/**` ↛ `solid-js` / `@opentui/*` / `adapters` / `theme` / `ui` / `views` | forbidden | `packages/code/tests/architecture/architecture-boundary.test.ts` |
| `adapters/**` ↛ `ui` / `views` | forbidden | `packages/code/tests/architecture/architecture-boundary.test.ts` |
| `adapters/tool-identity.ts` → `@clarvis/kernel/policy` | runtime, value | `packages/code/src/adapters/tool-identity.ts`; the kernel entrypoint is one of the six sanctioned ones (INV-251) |
| `adapters/event-span.ts` → `@clarvis/kernel/policy` | runtime re-export + type | `packages/code/src/adapters/event-span.ts` |
| `adapters/{plan,workflow}-projection.ts` → `@clarvis/protocol` | **type-only** | `packages/code/src/adapters/plan-projection.ts`, `packages/code/src/adapters/workflow-projection.ts` (`import type`) |
| `adapters/message-content.ts` → `@clarvis/protocol` | **type-only** | `packages/code/src/adapters/message-content.ts` |
| `views/**` → `adapters/store.ts` | mostly type-only; one value import | `packages/code/src/views/blocks.tsx` (types) and `packages/code/src/views/blocks.tsx` (`rawToolArguments`) |
| `views/**` → `theme/{tokens,glyphs,tone,syntax,surfaces}` | runtime | `packages/code/src/views/blocks.tsx`, `packages/code/src/views/tools/registry.tsx`, `packages/code/src/views/tools/mutation-gate.ts`, `packages/code/src/views/truncate.ts`, `packages/code/src/views/spinner.ts` |
| `theme/glyphs.ts` → `core/marks.ts` | runtime | `packages/code/src/theme/glyphs.ts`; the theme wraps the core table in a Solid signal so an ascii toggle re-renders (`packages/code/src/theme/glyphs.ts`) |
| `views/tools/**` → `adapters/{tool-identity,tool-parsers}` | runtime | `packages/code/src/views/tools/registry.tsx`; `packages/code/src/views/tools/mutation-gate.ts`; `packages/code/src/views/tools/signature.ts` |
| `adapters/store.ts` → `views/**` | **forbidden** | why `describeToolCall` is injected at the composition root instead of imported (`packages/code/src/adapters/store.ts`, wired in `packages/code/src/runtime.tsx`, `describeToolCall`) |

### 7.2 The store seam

`adapters/store.ts` is the *producer* of everything this subsystem reads, and belongs to a sibling
document. Four concrete couplings matter here:

1. **Node types.** Views import `TranscriptNode` from `packages/code/src/adapters/store.ts`, which re-derives the
   core union with a concrete `PlanTaskActivity[]` for the plan variant.
2. **`rawToolArguments`** (`packages/code/src/adapters/store.ts`) unwraps Solid's `$RAW` before the display
   projector sees the arguments, because a store proxy exposes every field as an accessor and the
   projector deliberately refuses accessors (`packages/code/src/adapters/store.ts`, and INV-T07 above).
3. **`describeToolCall`** (`packages/code/src/adapters/store.ts`, implemented in
   `packages/code/src/runtime.tsx`) is the injection that
   lets the store keep a resident `signature` and `mutation` on each tool node without importing
   `views/`. It is called on `tool_call_started` (signature only) and on `tool_call` close
   (signature and mutation) (`packages/code/src/adapters/store.ts`).
4. **`defaultFolded`** (backed by `foldDefaults`) supplies `toggleOverride` and is captured into each
   immutable publication batch before history renders it. It is set on tool close from the call's
   success and on local shell close.

### 7.3 Downstream consumers inside `code`

| Consumer | What it uses |
| --- | --- |
| `packages/code/src/views/history/CommittedHistory.tsx` | `BlockView` and the user-driven semantic subset of `TranscriptState`; group/section metadata comes from frozen publication batches, while passive boundary labels come from hidden batch counts |
| `packages/code/src/views/live/LiveTranscriptTail.tsx` | `BlockView`, `computeGroupedNodes` and `computeToolGroups` over mutable frontier nodes, plus the frozen live-to-committed handoff |
| `views/overlays/DiffViewer.tsx` | `resolveToolRenderer` with `full`/`wrap` set (`packages/code/src/views/tools/registry.tsx`) |
| `views/config/McpBrowser.tsx` | `renderToolPreview` (`packages/code/src/views/tools/registry.tsx`, `renderToolPreview`) |
| `packages/code/src/views/ElicitBlock.tsx` | `MEASURE_MAX_COLS` |
| `views/Sidebar.tsx`, `views/overlays/PlanOverlay.tsx` | `taskTone` (`packages/code/src/views/blocks.tsx`) |
| `packages/code/src/views/app/TranscriptRegion.tsx` | `Sidebar` (the split column and drawer mounts), the focused-agent identity row and the fixed physical reading runway |
| `packages/code/src/views/App.tsx` | `LeadActivityLine` immediately above `InputDock`; the footer carries only bounded activity summaries |
| `packages/code/src/runtime.tsx` (`describeToolCall`) | `formatToolCall` + `mutationStats` composed into `describeToolCall` |
| `src/run-host.ts`, `src/cli-mode.ts`, `src/features/run/status-presenter.ts` | `core/run-status.ts`'s `plainStatusLine`/`memoryNoticeStatus`/`progressStatus`/`liveRunStatus` |

### 7.4 Delegated

- The **events themselves** and their reduction into nodes — [hosts/kernel-runs.md](kernel-runs.md) and
  [hosts/code-run-host.md](code-run-host.md).
- **Publication lifecycle, passive visual immutability, the committed/live boundary and placement of
  moving state** — [hosts/code-transcript-stability.md](code-transcript-stability.md).
- **Theme tokens, glyph table policy and ascii mode** — [hosts/code-theme.md](code-theme.md). This document touches
  `core/marks.ts` only as the framework-free source the theme wraps.
- **Input handling, overlays, the diff viewer and slash commands** —
  [hosts/code-input-and-overlays.md](code-input-and-overlays.md).
- **Plan document semantics** (revisions, CAS triple, retention) — the plan capability documents. Only
  the *UI projection* of plan events is in scope here.

---

## 8. Open questions

**Constants without stated derivation.** Several tuning numbers carry no measurement or reason in
source or test: `MAX_BODY_LINES = 10` (`packages/code/src/views/tools/registry.tsx`), `MUTATION_GATE_LINES = 40`
(`packages/code/src/views/tools/mutation-gate.ts`), `MEASURE_MAX_COLS = 110` (`packages/code/src/views/blocks.tsx`), `MAX_GROUP_SIGNATURES = 6`
(`packages/code/src/views/blocks.tsx`), `LIVE_TAIL_LINES = 5` (`packages/code/src/views/blocks.tsx`), `SLOW_TOOL_MS = 2000` (`packages/code/src/views/blocks.tsx`),
and `MIN_GROUP = 2` (`packages/code/src/views/tool-groups.ts`). By contrast, `segment.ts` does
state numbers — ~50 ms per
flush at 60 KB against a 33 ms frame (`packages/code/src/views/blocks.tsx`), and
~0.5 ms plain versus ~50 ms parsed (`packages/code/src/core/transcript/segment.ts`) — so the absence elsewhere is an absence,
not a convention.

**The `collapsed` fixture-fallback claim is overstated.** Both `packages/code/src/views/blocks.tsx` and
`packages/code/src/views/block-focus.ts` state that "`showcase.test.ts` guards that a real store-derived node never
carries" a `collapsed` field. The only occurrence in that file is
`packages/code/tests/component/showcase.test.ts`, a single assertion about one `subagent` node in
one error scenario. It is not a general guard, so the production fallbacks at `packages/code/src/views/blocks.tsx` and
`packages/code/src/views/block-focus.ts` are protected by a comment rather than by a test.

~~**`hiddenBodyLines` does not special-case `monitor_list`.**~~ **Resolved:** it does now.
`monitor_list` joins the other three in the branch, which returns `m.monitors.length` on an `isList`
payload and `lines(m.output)` otherwise (`packages/code/src/views/tools/registry.tsx`) —
so a collapsed list reports one hidden row per monitor, which is exactly what `renderMonitor`'s
`isList` branch paints (routed). It was a missing special case rather than a
choice between two readings: the tool's handler returns `JSON.stringify({ monitors })` with no
indentation (`packages/tools/src/tools/monitor.ts`), so the generic `lines(result)` always
answered exactly `1` whatever the list size, and `lines(m.output)` — the reading the three
single-monitor tools use — would always have answered `0`, since `MonitorParsed.output` is hard-coded
to `""` for `isList: true` (`packages/code/src/adapters/tool-parsers.ts`). An empty list
now reports `0` rather than `1`: there is nothing behind the `(no monitors)` placeholder to reveal.
Pinned at `packages/code/tests/integration/tool-registry-render.test.tsx`.

~~**Diff CR normalization was unpinned.**~~ **Resolved:** `StableDiff` now owns the normalization for
every registry caller, and `packages/code/tests/integration/tool-diff-render.test.tsx` ("every diff
normalizes CRLF and bare CR before it reaches OpenTUI") feeds both line-ending forms through the
real component and inspects the resulting `DiffRenderable`.

**`mark()` has no callers.** `packages/code/src/core/marks.ts` exports `mark` and the deprecated
`glyph` alias — yet `glyph` (via the theme wrapper at `packages/code/src/theme/glyphs.ts`) is what
every rendering site uses. No migration is in progress in the source.

**Symbols exported but used only within their own module.** `railColor` (`packages/code/src/views/blocks.tsx`),
`agentGlyph`, `capitalize` (also used by `views/App.tsx`), `diffHeaderPath`
(`packages/code/src/views/tools/registry.tsx`), `segmentMarkdown` (`packages/code/src/core/transcript/segment.ts`). Whether these are exported for testing,
for a planned consumer, or by accident is not stated. `knip.json` sets
`ignoreExportsUsedInFile` only for `interface` and `type`, so functions in this position survive Knip
only because test files count as entries.

**`TranscriptMessageNode`'s persistence fields.** `sourceExecutionId`, `sourceTextFingerprint`,
`textTruncated` and `proseReleased` (`packages/code/src/core/transcript/types.ts`) are declared here but produced and consumed
by the store and the export path. The doc says presenters "must prefer" `proseReleased` over
`textTruncated` (`packages/code/src/core/transcript/types.ts`), which `packages/code/src/core/transcript/presenters.ts` does — but what *writes* either field,
and when, belongs to [hosts/code-run-host.md](code-run-host.md).

**A truncated sentence in `AssistantMarkdown`'s TSDoc.** `packages/code/src/views/blocks.tsx`
ends mid-clause — "The sealed prefixes are" — begins a new sentence, so one clause of the
rationale is missing from the source. What it was going to say is not recoverable from the code.

**`EventSource`** (`packages/code/src/adapters/event-span.ts`) is declared in this document's scope but is a store/run-host
concept; its consumers are outside this document.

**The `subagent` node's `toolCalls`/`inputTokens`/`outputTokens`** (`packages/code/src/core/transcript/types.ts`) and the
`run` node's equivalents (`packages/code/src/core/transcript/types.ts`) are never read by any renderer in
`blocks.tsx` — the run block prints only the outcome word and elapsed time, and the
subagent block prints only its brief. Nor does the sidebar render them: it holds the same
figures through `ActivityStore` and paints none of them (INV-T45). A leader row's `N iterations`
(the workflow block in `Sidebar`) is the one counter any of these surfaces prints, and it
comes from the workflow projection rather than from a transcript node. Whether the node fields have
any renderer at all is still not determinable: nothing this document or the sidebar reads consumes them.

**No test covers `renderTranscriptMarkdown`'s omission of `subagent`, `plan`, `annotation` and
`error` nodes.** `packages/code/src/views/transcript-markdown.ts` silently yields nothing for those four kinds;
`packages/code/tests/unit/transcript-markdown.test.ts` exercises only the five kinds that do render. Whether the
omission is intended is not stated.
