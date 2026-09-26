# Transcript segmentation, blocks, tool-call rendering and identity

> Implemented at `packages/code/src/core/transcript/**`, `packages/code/src/views/**` and
> `packages/code/src/adapters/{tool-identity,tool-parsers,plan-projection,workflow-projection,message-content,event-span}.ts`.
> Every claim below is anchored to a file and a named symbol or test. Open questions are collected in the final
> section.

---

## 1. Purpose

This subsystem projects execution facts into one ordered list of row IDs per agent. Pure identity,
record snapshots, explicit exploration membership and bounded windows live in `core/transcript/`.
The store remains authoritative for execution; Solid adapters connect those facts to one native
viewport. Terminal content is sealed independently of rendering, and rows do not move between
live and historical owners. [code-transcript-stability.md](code-transcript-stability.md) owns
cross-event identity, semantic anchors and residence.

Within that scope it owns four concerns that are visible in the code as four separate layers:

1. **Framework-free projection** (`src/core/transcript/**`) — the node type union
   (`packages/code/src/core/transcript/types.ts`), the presenter strings a node renders as
   (`packages/code/src/core/transcript/presenters.ts`), the bounded display projection of a tool call's payload
   (`packages/code/src/core/transcript/tool-display.ts`), and prefix-stable Markdown segmentation of a streaming assistant reply
   (`packages/code/src/core/transcript/segment.ts`, `packages/code/src/core/transcript/segment.ts`). Nothing here imports Solid or OpenTUI — an architecture test
   enforces that (`packages/code/tests/architecture/architecture-boundary.test.ts`).
2. **View-state derivation** (`src/views/transcript-state.ts`, `block-focus.ts`) keeps expansion and
   focus by stable identity outside row owners. `adapters/transcript-projection.ts` connects the
   pure `TranscriptRows` model to the selected Lead or execution/child projection.

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
lives only in the Sidebar or `Ctrl+X P`; it contributes no footer text. Workflow activity remains in
the Sidebar/footer, never in the transcript. There is no lower Plan pane between history and the
composer. The sub-agent roster also lives in that chrome; selecting one row changes the transcript
to that child's isolated semantic projection. These surfaces are treated in section 4.19.

The recurring problem the code solves is cost: a long streaming reply re-parsed on every delta, a
100 KiB tool payload handed to a native text renderable, a 6,000-node session mounted at once. The
answers are, respectively, prefix-stable segmentation
(`packages/code/src/core/transcript/segment.ts`), a cached bounded payload projection
(`packages/code/src/core/transcript/tool-display.ts`), and the native ScrollBox index slice
owned by [code-transcript-stability.md](code-transcript-stability.md).

Interactive Code routes hidden child event detail outside the Lead's reactive node array.
`createChildTranscriptStore` retains bounded live tails and creates a detailed store only for the
selected child, loading complete history from the persisted run. `createTranscriptProjection`
therefore sees only the selected store; a hidden child delta does not rebuild Lead rows. Production:
`packages/code/src/adapters/child-transcript-store.ts` (`createChildTranscriptStore`),
`packages/code/src/runtime.tsx` (`runApp`). Test:
`packages/code/tests/unit/child-transcript-store.test.ts` (hidden children leave Lead nodes stable).

---

## 2. Surface

### 2.1 `src/core/transcript/index.ts` — the barrel

| Export | Kind | Source |
| --- | --- | --- |
| `NodeStatus`, `TranscriptMessageNode`, `TranscriptNode`, `TranscriptPlanTask` | types | `packages/code/src/core/transcript/types.ts` |
| `transcriptDisplayText(node): string`, `thinkingDisplayText(node): string`                                                                               | fn            | `packages/code/src/core/transcript/presenters.ts`   |
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
the 10-entry `BUILTIN_TOOL_LABELS` table — `agent_poll` → "Check agent", `agent_steer` → "Steer agent", `agent_stop` → "Stop agent",
`spawn_subagent` → "Spawn sub-agent", `run_leader` → "Start workflow leader", `run_workflow` → "Run
workflow", `run_round` → "Run workflow rounds", `run_work_items` → "Run work items",
`workflow_status` → "Check workflow", `workflow_decide` → "Decide workflow" — falling back to
the bare identity for anything not in the table. This is what remaps the engine's internal
orchestration-tool names to product-facing labels while leaving a real MCP call's `server:tool`
identity untouched. Test: `packages/code/tests/unit/tool-identity.test.ts` ("toolDisplayLabel
translates orchestration internals but preserves MCP identity").

Those labels do not grant a Lead-owned orchestration call transcript visibility. The closed
supervision/orchestration set — `spawn_subagent`, `agent_list`, `agent_poll`, `agent_stop`, `agent_steer`, `run_leader`, `run_workflow`, `run_round`,
`run_work_items`, `workflow_status`, `workflow_decide` — is suppressed from the Lead projection before a composing, started,
streaming-output or terminal tool record can be admitted to the visible row projection. Thus
even temporary copy such as `Check agent starting…` is invalid in the Lead transcript. Ordinary
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
| `waitForSyntaxFrame(root, current, renderer)` | waits for native layout and descendant highlighting, bounded to three 250 ms attempts; renderer destruction cancels pending frame waits | `packages/code/src/ui/patterns/stable-syntax.tsx` |

`BlockView`'s props: `node`, `maxWidth?`, `forceExpand?`, `folded?`,
`overrideOf?`, `focused?`, `onToggle?`, `onOpenDetail?`, `defaultFolded?`, and
`fillAvailableWidth?` (`packages/code/src/views/blocks.tsx`, `BlockView`).

### 2.6 Semantic projection versus physical residency

`createTranscriptProjection` exposes stable row IDs and resolves records independently.
`TranscriptRows` owns first-admission order and exploration membership; `TranscriptWindow`
owns row intervals without native geometry. `TranscriptViewport` mounts one selected projection.
See [code-transcript-stability.md](code-transcript-stability.md) for identity, native residence,
anchor transactions, selection limits and host completion.

### 2.7 `views/transcript-state.ts`

`createTranscriptState` owns external row-keyed expansion, focus, Lead/child selection and
explicit detail hydration. `bindRows` connects the selected projection's row/member IDs to
keyboard navigation. `semanticNodes` and `pickDiffNodes` retain semantic/detail access independently
of native residence. No section grouping, status-based ordering or rendering-batch API exists.

### 2.8 Remaining modules

| Module | Exports | File |
| --- | --- | --- |
| `views/block-focus.ts` | `BlockOverride`, `nextFocus` | — |

| `views/transcript-markdown.ts` | `transcriptMarkdownHeader`, `renderTranscriptMarkdownChunks`, `renderTranscriptMarkdown` | — |
| `views/truncate.ts` | `truncateEnd`, `truncateStart`, `fmtCount`, `moreChip`, `padColumn` | — |
| `views/spinner.ts` | `SPINNER_FRAMES`, `SPINNER_ASCII`, `charForFrame`, `spinnerChar`, `thinkingDots`, `tickNow`, `formatElapsed` (re-export), `useSpinnerClock` | — |
| `views/Prose.tsx` | `Prose`, `stripDocChrome` | — |
| `views/Sidebar.tsx` | `PLAN_SIDEBAR_TASK_LIMIT`, `AGENT_SIDEBAR_ROW_LIMIT`, `WORKFLOW_SIDEBAR_ROW_LIMIT`, `planTaskWindow`, `contextMeter`, `rosterSummary`, `subagentProgress`, `workflowProgress`, `Sidebar` | source symbols |
| `views/activity-summary.ts` | `ActivitySummarySection`, `ActivitySummaryTone`, `ActivitySummaryPriority`, `ActivitySummaryFact`, `ActivitySummaryInput`, `ACTIVITY_SUMMARY_MAX_ROWS`, `ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT`, `planDisplayLifecycle`, `activitySummaryFacts`, `activitySummaryRoute`, `activitySummaryRows`, `activitySummaryRowBudget`, `activitySummaryRowText` | source symbols |
| `views/ActivitySummaryStrip.tsx` | `ACTIVITY_SUMMARY_PADDING`, `ActivitySummaryStrip` | source symbols |
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
| `tool_call` | `text`, `mcpName?`, `toolName?`, `args?`, `result?`, `diff?`, `error?`, `warn?`, `guard?`, `control?`, `interruptRequest?`, `interruption?`, `liveOutput?`, `inputChars?`, `inputComplete?`, `dehydrated?`, `hydrationNotice?`, `signature?`, `mutation?` | `packages/code/src/core/transcript/types.ts` |
| `run` | `text`, `reason?`, `disposition?`, `toolCalls?`, `inputTokens?`, `outputTokens?` | `packages/code/src/core/transcript/types.ts` |
| `subagent` | `text`, `title?`, `reason?`, `toolCalls?`, `inputTokens?`, `outputTokens?` | `packages/code/src/core/transcript/types.ts` |
| `plan` | `text`, `planTitle?`, `planStatus?`, `planReview?`, `planRemoved?`, `planDiscarded?`, `tasks?`, `revision?` | `packages/code/src/core/transcript/types.ts` |
| `annotation` | `text`, `tone?: "info"\|"warn"\|"accent"` | `packages/code/src/core/transcript/types.ts` |
| `error` | `text`, `error?` | `packages/code/src/core/transcript/types.ts` |

`NodeStatus = "running" | "ok" | "limited" | "cancelled" | "error" | "pending"`
(`packages/code/src/core/transcript/types.ts`). `limited` and `cancelled` are terminal and
deliberately distinct from `error`: a stage that stopped at its own budget cap and a stage the run
took down with it are facts a reader has to be able to tell apart from a stage that broke, and the
delegation wire carries exactly that distinction in its terminal `status`
(`subagentOutcomeKind` in `packages/code/src/adapters/run-reducers.ts`). The settled delegation
marker renders the same four-way outcome — `completed`, `stopped at its limit`, `cancelled`,
`failed` — and the roster row keeps a matching lifecycle
(`packages/code/src/adapters/activity-store.ts`).

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
core (e.g. `packages/code/src/views/blocks.tsx`, `packages/code/src/core/transcript/rows.ts`,
`packages/code/src/views/transcript-state.ts`).

### 3.2 Node key format

Keys are strings with meaning encoded as prefixes. Three consumers parse them:

| Pattern | Meaning | Read at |
| --- | --- | --- |
| `<execId>::<span_id>` | a node belonging to run `execId` | `packages/code/src/adapters/transcript-projection.ts`, `packages/code/src/adapters/store.ts` |
| `<execId>::run` | that run's terminal marker | `packages/code/src/views/transcript-state.ts` |
| `user:<n>` | a locally sequenced user message | produced by `packages/code/src/adapters/store.ts` (`appendUserMessage`) |
| `local:<n>` | a locally-appended `!bash` node | `packages/code/src/core/transcript/rows.ts`, produced at `packages/code/src/adapters/store.ts` |

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
| `shell_session` | JSON object carrying `session_id`, `running`, `ready`, `exit_code`, `stdout`, `stderr`, or `sessions` | `packages/code/src/adapters/tool-parsers.ts` |
| `read_file` | `cat -n` style: `<spaces><digits>\t<content>`; any other non-blank line is a note | `packages/code/src/adapters/tool-parsers.ts` |
| `list_dir` / `list_memories` | newline-separated non-blank paths; `"(no matches)"` yields `[]` | `packages/code/src/adapters/tool-parsers.ts` |

Real examples in the tests: a `shell` envelope at
`packages/code/tests/unit/tool-parsers.test.ts`; a memory-search content block; a guard denial `{"error":"denied","message":"…"}`.

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

### 4.1 The pipeline

1. The adapter resolves execution/actor/call/attempt identity before admitting records.
2. The execution ledger applies live or stored facts; terminal content is bounded and sealed.
3. `createTranscriptProjection` produces ordered row IDs for Lead or the selected child.
4. `TranscriptWindow` selects bounded row residence; `TranscriptViewport` owns native scrolling.
5. A primitive-ID `For` mounts `TranscriptRowView`; its individual presenter is created once.
6. `ToolRow` and `ExplorationRow` reuse `BlockView`, the registry and existing syntax surfaces.

### 4.2 Ordering and reconciliation

Ordinary admission appends. Previously known rows retain identity and relative order. An authoritative
reconcile can insert unknown rows before known rows and revise a terminal record coherently, but
does not clear and rebuild the resident tree. Results replace incremental output. The final answer
keeps its provider phase without a synthetic label; the run outcome is admitted by the host's
`TranscriptRunSink.complete` boundary.

### 4.3 Explicit exploration

Only allowlisted observing identities form exploration groups. A group starts with one call;
eligible read/search names may differ. Shell, mutations and unknown/namespaced MCP calls remain
individual. Prose, notices, delegation and iteration changes close the execution/actor segment.
Late results update counts without reopening membership. Group IDs derive from the first member,
not a temporary painting role. Folded errors retain indication. A paginated group also exposes an
action showing the first failure without describing it as an external issue; a small group relies
on ordinary expansion because every member is already on its single bounded page.

### 4.4 Fold, focus and detail

Explicit row/member expansion overrides defaults across settlement, window disposal and child
navigation. Successful mutations start folded; native diff is available on demand. An expanded group
mounts one page of 20 members, with previous/next controls. Existing field, mounted-text and explicit
hydration limits still apply. Focus navigates row/member IDs, not batch positions. Retention prunes
discarded UI identities. Terminal shell warnings and errors start folded like other terminal tool
failures; their compact diagnostic remains visible below the header, and explicit expansion still
opens the bounded output body.

### 4.5 Lead and children

Lead retains the two immutable, navigable delegation markers. Children use the same reducer and
viewport; background events never select a child. Only the selected projection mounts a tree.
Per-projection semantic anchors restore reading independently of sidebar width. A child body does
not fold behind a synthesized section header. Child lifecycle and ongoing activity remain owned by
the host and existing Agents surface.

### 4.6 Reader intent

Native sticky bottom is the follow authority. Leaving the tail preserves a semantic row/offset;
return-to-tail is explicit. Prepend, resize and fold changes use token-scoped post-layout transactions.
The row window and member page limits are specified in
[code-transcript-stability.md](code-transcript-stability.md).

### 4.7 Provenance and interruption

Missing child attribution is isolated and linked through a provenance notice, never attached to Lead.
A call with no authoritative outcome after its execution scope closes is interrupted, not successful
and not a proven tool failure. Durable minimal announcements reconstruct named pre-start interruption
without storing partial arguments. Global host interactions remain independent of transcript selection.

`toolPhase: interrupted` alone never attributes operator intent. The node retains the terminal
event's explicit `interruption` separately; only `source: operator` produces the folded summary
`Interrupted by operator`. Scope closure, composition cleanup and accepted interrupt receipts do
not synthesize that cause. Reconciliation replaces it with the authoritative terminal's cause,
including clearing it when absent. Production: `TranscriptToolNode` in
[types.ts](../../packages/code/src/core/transcript/types.ts), `createTranscriptStore` terminal and
cleanup branches in [store.ts](../../packages/code/src/adapters/store.ts), and `ToolLine.failureSummary`
in [blocks.tsx](../../packages/code/src/views/blocks.tsx). Test:
[store-status.test.ts](../../packages/code/tests/unit/store-status.test.ts), `only authoritative
terminals attribute interruption across live, replay and reconciliation`, and
[block-focus-render.test.tsx](../../packages/code/tests/integration/block-focus-render.test.tsx),
`interrupted scope and composition rows do not blame the operator`.

The shell's stop target is separate from header folding. A compact `[X]` appears immediately after
the running elapsed time; while an interrupt request is pending it stays visible but muted and repeated
clicks issue no further request. The action reserves its four columns, including a leading space, at
narrow terminal widths; the identity truncates instead of clipping the action or adding a header row.
Terminal settlement removes the control. A yielded shell's tool result preserves it while the
session is live; `tool_control_released` removes it on physical completion, even during a continuing
run. The signal checks both call and control identity so a late release cannot affect another row.
Production: `ToolLine` and `BlockView` in [blocks.tsx](../../packages/code/src/views/blocks.tsx),
and `createTranscriptStore` in [store.ts](../../packages/code/src/adapters/store.ts). Test:
`narrow shell headers place the stable close target immediately after elapsed time` in
[block-focus-render.test.tsx](../../packages/code/tests/integration/block-focus-render.test.tsx)
and `physical completion removes a yielded shell's stop control` in
[store-status.test.ts](../../packages/code/tests/unit/store-status.test.ts).

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
| `hasDiagnostic()` | collapsed errors, plus a collapsed shell with `warn === true`                                                     | —                                                 |
| `diffChip()` | `trueMutationStats(node)` when collapsed and not errored | — |
| `hiddenLines()` | `hiddenBodyLines(...)` only when collapsed, not errored, and there is no diff chip | — |
| `hasBody()` | `showBody && status !== "running"` | — |
| `tail()` | last 5 lines of `liveOutput`, only while running | — |
| `composing()` | `composingLabel(inputChars, inputComplete === true, inputStreamChars)` when `inputChars !== undefined`, else `""` | `packages/code/src/views/blocks.tsx` (`ToolLine`) |

The header breaks by cell rather than being clipped, so tool identity survives a narrow terminal: a
call's path is what a reader matches against the filesystem, and the previous single truncated row
dropped its tail with no ellipsis and no way to recover it in that row. The identity's own
**argument preview** keeps its explicit character bound (`VALUE_MAX` and `SIGNATURE_MAX` in
`packages/code/src/views/tools/signature.ts`), which is a cost bound on the projected arguments and
not a width overflow: the preview still truncates a long value with an ellipsis, preferring the
basename of a path. A collapsed shell error or warning with an authoritative non-zero exit code
appends `exit <code>` inline immediately before the guard verdict. Other collapsed errors add their
own wrapped diagnostic row below the header instead of competing with its signature and metadata;
the diagnostic breaks by cell and is not abbreviated, so the cause, the location and the sentence
that says how to fix the failure all stay readable. Its header parts, in
order: status glyph, `toolDisplayLabel` in accent, then **either** the composing label **or** the signature — never both,
the signature preferring resident `node.signature` over live `formatToolCall`. Then
elapsed time while running, or elapsed time when settled and
`elapsedMs >= SLOW_TOOL_MS` (2000ms). A running interruptible shell places its compact `[X]`
immediately after that elapsed time, in a column that stays one row tall beside a wrapped identity.
Settled calls then show either the mutation chip
or the hidden-line chip. Production: `ToolLine` in `packages/code/src/views/blocks.tsx`,
`formatToolCall` in `packages/code/src/views/tools/signature.ts`, and `renderErrorGeneric` in
`packages/code/src/views/tools/registry.tsx`. Test:
`packages/code/tests/integration/block-focus-render.test.tsx` (the wrapped identity keeps the
interrupt column adjacent to the elapsed time) and
`packages/code/tests/integration/tool-clamp.test.tsx` (a collapsed error keeps its guidance).

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

Exploration chrome is owned by `ExplorationRow`, not by an individual tool's role.
Its folded header says `Exploring` while any member is pending or running, then `Explored` once every
member is terminal; it reports member and failure counts without a separate active count.
For a paginated group, showing the first failure selects its bounded member page; a single-page group
does not render that redundant shortcut. Shell calls remain individually visible because they
never group. Members retain their own header, bounded detail and explicit fold.
Production: [ExplorationRow.tsx](../../packages/code/src/views/transcript/ExplorationRow.tsx).
Test: [tool-groups-render.test.tsx](../../packages/code/tests/integration/tool-groups-render.test.tsx).

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
paints no background at all. Sub-agent content keeps its actor-colored left rail without synthesized section chrome.

Per-kind bodies (`packages/code/src/views/blocks.tsx`): `user` gets a `userBandBg()` band with a rail glyph; `reasoning` renders nothing at all when collapsed and, when visible beneath its `thinking` label, passes through `thinkingDisplayText`, which removes Markdown presentation delimiters without changing ordinary transcript prose.
`thinkingPreview` in `packages/code/src/views/truncate.ts` limits the body to three terminal-cell-aware
wrapped lines, appending `...` on the third line only when content is hidden. The preview recomputes
when text or available width changes; persisted reasoning remains complete. Production:
`BlockView` in `packages/code/src/views/blocks.tsx`. Test: the wrapping, resize and streaming cases in
[reasoning-hidden-render.test.tsx](../../packages/code/tests/integration/reasoning-hidden-render.test.tsx).
`thinking` is a spinner plus animated dots; `assistant` uses one static bullet plus segmented Markdown in both running and terminal
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
| `renderImage` | `read_image` |
| `renderPathList` | `list_dir`, `list_memories` |
| `renderWriteFile` | `write_file`, `write_memory` |
| `renderEdit` | `edit_file`, `edit_memory` |
| `renderApplyPatch` | `apply_patch` |
| `renderSummary` | `remove`, `delete_memory` |
| `renderShellSession` | `shell_session` |
| `renderMemoryRead` | `read_memory` |
| `renderMemoryGrep` | `grep_memories` |

**Non-mutation-gated renderers' own rules** (`registry.tsx`): `renderBash` colors the
status word by exit code (`add` for `0`, `del` otherwise) and distinguishes a settled `"failed"`
(unparsed result with an error present) from an ordinary `"done"`/`"exit N"`. `renderReadFile`
 prints a `path · lines N–M` header only when `parseReadFile` found line numbers; with
none, only the code body renders. `renderShellSession` presents session status and separate stdout/stderr windows; list mode contains IDs and status without command text. `renderImage` is a fixed `[image]` tag plus the path, with no body at all.
`renderMemoryRead` forces `filetype="markdown"` syntax highlighting regardless of the
memory document's actual name. `renderMemoryGrep` delegates to `renderGrep` by
rewriting the call's `output_mode` argument to `"content"`, falling back to `renderGeneric` when
`parseGrepContent` finds zero groups. `renderJsonCard` renders with Solid's `Index`,
not `For` — an explicit remark in source states `Object.entries()` yields fresh `[k,
v]` tuples with no stable identity every render, so rows must key by position instead.

Collapsed generic errors parse a serialized `{error, message}` envelope through
`toolErrorSummaryText`: the snake-case code becomes a sentence-case label followed by its message;
plain text remains plain text. Expanded error bodies retain the original full diagnostic.
`resolveErrorRenderer` returns the *normal* renderer for a tool in
`ERROR_AWARE = {shell, shell_session}`, and `renderErrorGeneric`
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
`renderEdit` and `renderApplyPatch`.

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
| `edit_file`, `edit_memory` | `diff` if present, else `synthesizeUnifiedDiff(args.path, editsFromArgs(args))` |
| `apply_patch` | `diff` if present, else `args.patch` |
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
`shell_session` counts parsed stdout and stderr lines, everything else counts the
raw result's lines. Blank-only text counts as `0`.

### 4.11 Signature formatting

`formatToolCall` (`packages/code/src/views/tools/signature.ts`) resolves `SIGNATURES[toolIdentity(mcpName, toolName)]`. With a spec: each present primary key renders **bare** in declared order, the
`placeholder` stands in when every primary is absent, and each present secondary renders as
`key=value`. Without a spec: every argument renders as `key=value`. The joined parts
are wrapped in parentheses and capped at `SIGNATURE_MAX = 72`.
The curated shell signature includes only its command; its execution `cwd` is deliberately omitted
from transcript chrome. Other curated tools retain their declared secondary fields.
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
`tool_call` → ``- `label(signature)` — status`` plus its guard review label when present and a
fenced `Bounded arguments` projection when arguments exist, `run` → `_(reason)_` followed by `---`.
The projection uses the same bounded, renderer-safe display path as live rendering and labels shortening;
it never serializes the unbounded raw envelope. Every other kind yields nothing. The tool line uses
`toolLabel` (not `toolDisplayLabel`) and prefers the resident `node.signature`. Pinned at
`packages/code/tests/unit/transcript-markdown.test.ts`.

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
and cost are cumulative across ordinary runs, Goal stages and Goal auxiliary work
after their host settlements. `In`
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
`compactionNoticeText(operation, freedChars, opts)` (`packages/code/src/core/transcript/presenters.ts`) presents
tool-result `truncation` as `tool output shortened`, distinct from context `compaction`; it rounds
`freedChars` to the nearest thousand for its `−Nk chars` segment and appends a user-contribution
count to context compaction when `opts.userContributionCount` is set. `compactionSkippedNoticeText(reason)` reports an
explicit compaction request that could not be applied, replacing the reason's underscores with spaces.
`softLimitNoticeText` is a plain `used/limit → outcome` line. For the `iterations` dimension its TUI
label is `iteration limit`; other dimensions retain their `soft <dimension>` label.

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
transcript; workflow activity remains structure/status in the Sidebar and never
becomes transcript content.

**One mount, one component.** `TranscriptRegion` mounts `Sidebar` once as its inline presentation
(`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`): a split column when
`layout.secondaryMode()` is `"split"`, and the whole content region when it is `"full"`. `"full"` adds
the fixed `Activity` header above it and mounts no scrim, no transcript column and no residual pane of
conversation beside it; there is no narrower drawer presentation. No `PlanStrip` or other
live pane is mounted below history:
the Sidebar owns compact plan detail and `Ctrl+X P` owns the full plan. App owns three
independent execution-scoped automatic intents: the first live Plan, first workflow state/leader and first
typed delegation open the same combined Sidebar and reveal `Plan`, `Parallel work` or `Agents`.
`Ctrl+X S` closes an open Sidebar or reopens the first available Agents, Parallel work or Plan
section. `createLayoutController.secondaryMode` projects that intent as split or full.

**Below the split, activity is summarised instead.** While `TranscriptRegion`'s `secondaryMode()` is
`"closed"` and the width cannot seat the split, it mounts `ActivitySummaryStrip` as `#activity-summary`
below the transcript instead of leaving the band empty: one row (two above
`ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT`) of canonical
Goal/Plan/Workflow/Agents facts with the effective `activity.toggle` binding last, wrapping whole facts
and shedding settled ones first. The strip is the only owner of activity state there; when the panel
or a full-region surface occupies the content it is not mounted, so nothing is stated twice. Its facts
come from `activitySummaryFacts`, never from a formatted title or a second query, and it is the pointer
route to the panel. The grammar, row budget and priority order are specified in
[bootstrap](code-bootstrap.md#4101-the-activity-summary-below-the-split).

The effective secondary mode also owns roster placement. A split or whole-region panel is the
sole detailed roster surface; below the split a closed secondary surface mounts no roster, and the
summary strip states the group facts instead. Each of the three first-event intents is consumed
independently. Explicitly closing
an automatic reveal is sticky for later updates of that same section/execution, but does not consume
the first event for another section; the latter may reopen and reorient the Sidebar. Below the split
an automatic intent never opens a surface: it is spent once into the summary, and its section
becomes the preference for the next explicit open (see
[bootstrap section 4.10](code-bootstrap.md#410-layout-breakpoints)). The Agents
intent does not change the Lead selection or open `ActivityDetail`. The outer Sidebar ScrollBox
reveals the whole section owner with native `scrollChildIntoView`, so a long Plan cannot hide later
workflow or Agents content below the viewport. When closed, the Lead transcript mounts no
replacement roster. The canonical footer retains only Context/Session state and never duplicates
agent, workflow or Plan counts. `Ctrl+X S` is the sole keyboard toggle and Escape leaves the
Sidebar unchanged. Plain Tab never changes Lead/child selection: at shell level it clears
transcript block focus and returns to the composer, while a focused screen may own Tab for its local
focus order. Shift+Tab opens the agent picker. Clicking any sidebar agent, including a settled
summary row, selects only that agent's isolated transcript; it does not open `ActivityDetail`. While both
secondary surfaces are closed, the selection is represented by a single `Viewing A<n> <title>`
context row. Opening either secondary surface removes that row, so the same identity is never
presented in two adjacent regions.

**Frame.** The `Sidebar` root is `props.width?.()` wide or 44 columns, never shrinks, carries a left
border whose colour is `tokens.accent` while `props.focused()` and `tokens.muted` otherwise, and
sits at `zIndex={1}`. A fixed footer inside the root names the registered `Ctrl+X S` toggle for opening
and closing the surface; opening the Sidebar does not filter or otherwise reproject the application
footer below the composer. The body is a single ScrollBox holding up to three section-owner boxes — Plan,
Parallel work, Agents — each introduced by `SectionHeader`. `SidebarRevealIntent` identifies the
section and execution context; after layout, `Sidebar` asks the native ScrollBox to reveal that whole
owner. When `hasContent()` — a plan, at least one leader, a sequence checkpoint or at least one sub-agent — is false, the
entire body is the one line `No run activity to inspect`.

**Plan section.** `PlanSummary` (`packages/code/src/views/Sidebar.tsx`, `PlanSummary`) renders a bold
accent title, a lifecycle/progress line in its semantic status colour, and the windowed task list.
For an available plan, the progress line appends the compact `[Ctrl+X P] full plan` affordance produced
from the real `Ctrl+X P` binding through `compactKey`; the Sidebar renders no separate result panel or
result preview. For an expected discard,
the muted meta is `Completed · C/N completed · history discarded` and the muted footer is
`Plan deleted after success`; only another removed plan gets `Unavailable · plan file
unavailable` plus the red `Restore the plan file or create a replacement` recovery action
(`PlanSummary` in `packages/code/src/views/Sidebar.tsx`). `planProgress` otherwise reports
`N task(s) proposed` while `awaiting_approval`, and `C/N completed`. The compact task list is sorted
by lifecycle before source position: `in_progress`, then actionable `pending`/`returned`, then
`done`, then unsuccessful `failed`/`abandoned`; source order remains stable inside each group. Each
task row takes its glyph and colour
from `taskTone` (`packages/code/src/views/blocks.tsx`), called from
`packages/code/src/views/Sidebar.tsx` — except the current one, which is drawn with the accent
chevron and selection background instead — but only while the plan is neither removed nor terminal.
The glyph is the row's only lifecycle marker: the Sidebar omits lifecycle words, task numbers,
assignees, and exit conditions so the title remains the sole task copy. Those details remain in the
complete `Ctrl+X P` plan surface. The
source states the defect that rule fixes in `PlanSummary`'s one surviving line comment: "A
completed plan has no active task. Retaining the chevron on its final task made a finished plan look
like it was still executing."
Removed plans omit the full-plan affordance; their footer is neutral retention confirmation for an
expected discard or the red restore action for an unexpected removal
(`packages/code/src/views/Sidebar.tsx`, `PlanSummary`). Visual hierarchy is pinned by
`packages/code/tests/integration/sidebar-render.test.tsx`.

**`planTaskWindow` — a bounded status-prioritized slice that always contains the active task.**
`PLAN_SIDEBAR_TASK_LIMIT` is 12 (`packages/code/src/views/Sidebar.tsx`). The function first applies
the same lifecycle priority as the visible list, with original index as the stable tie-breaker. The
window then centres on `currentPlanTask(plan)` in that ordered projection, falling back to the last
source task when the plan has no current one, and clamps `start` so it never runs past either end. It
returns entries carrying their **absolute** index — which is what makes the row ids
`sidebar-plan-<index>` stable — plus `hiddenBefore`/`hiddenAfter`, rendered as `↑ N earlier tasks`
and `↓ N later tasks`, and `currentIndex`. `PlanSummary` keeps the current row on screen through
`followSelection(scrollEl, "sidebar-plan-", currentIndex)`, a mount microtask, and the scrollbox's
`onSizeChange`; the scrollbox itself is height-clamped to 4–16 rows.

**Plan access outside the Sidebar.** The first live Plan may reveal the Sidebar once for its
execution. After that surface is explicitly closed, later Plan updates cannot reopen it
automatically, but `Ctrl+X S` can reveal it again when it is the first available section. Plan contributes no footer summary.
`Ctrl+X P` opens the complete plan surface. No plan task, title, loading row or live Plan pane mounts
between the transcript and composer; plan churn therefore cannot resize the history region or move
its newest row. Pinned by
`packages/code/tests/integration/transcript-region-render.test.tsx` ("a current plan stays out of
the transcript tail when the sidebar is closed") and
`packages/code/tests/integration/app-shell-render.test.tsx` (independent Plan/workflow/Agents reveal
intent).

**Parallel work.** Leaders come straight from the workflow projection: every node with `kind ===
"leader"`, ordered by `startedAt` (the workflow block in `Sidebar`). `workflowProgress` counts every
non-running leader as settled and formats `S/T finished`, appending ` · N running` only while work is
active. It adds no failure total. A bounded inner ScrollBox renders one row per leader: the Plan-tone
status glyph, a synthetic `L1`, `L2`, … handle and truncated `cleanTitle(node.title)` — first
non-blank line with whitespace collapsed. Lifecycle words, elapsed time and iteration counts do not
compete with the compact summary. Handles are assigned by the original `startedAt` order, then the
visible rows use the Plan priority: running, pending, done, failed. There is no retained id ledger
across runs, and reordering never renumbers a leader.

The same section may exist with no leader row when `WorkflowActivity.sequence` is present. An
`awaiting_manager` sequence renders `Checkpoint r<revision>: next <round>` above the roster; other
statuses render their current round/session. The header remains the common progress form, including
`0/0 finished` when the checkpoint exists without leaders. This intentionally survives the last
leader settling at a semantic checkpoint.
Production: `Sidebar` (`hasContent`, workflow `Show`, sequence line). Test:
`packages/code/tests/integration/sidebar-render.test.tsx` (`an idle round checkpoint remains visible
below compact workflow progress`).

**Agents.** The header meta is `subagentProgress(...).label`. `subagentProgress` counts `done` and
`error` as *settled*, `running` separately, and formats `S/T finished`, appending ` · N running`
only while something is running. It adds no aggregate failure count; each failed worker's glyph owns
that status.
The first row is the one-line main target `Lead transcript`, with its cursor drawn on the
**negation** of `props.focused()`; clicking it calls `onShowAllAgents`, which `TranscriptRegion`
wires to clearing the selection and restoring the Lead-only view. Progress belongs to the section
header and is not repeated on this row. Then a bounded inner ScrollBox renders one row per sub-agent
in Plan status priority—running, pending, done, failed—with spawn order as its stable tie-breaker:
cursor, status glyph, handle and truncated `cleanTitle`. The row contains no lifecycle
word, elapsed time, result summary, profile/model copy or read affordance; complete information
belongs to the selected isolated transcript. The list follows the selected worker without moving the
Plan or Parallel work owners in the outer Sidebar scroll. Clicking either a live or settled row
performs the same selection-only action. Sub-agent handles use the separate `A<n>` namespace derived from canonical
zero-based spawn `order`, so a workflow leader cannot renumber an agent and a later run cannot inherit
an earlier run's id allocation.

The `focused` prop is worth reading twice. `TranscriptRegion` passes `() => ts.selectedSubagent()
!== null` (`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`), so it means "an
individual agent is selected", and the sidebar uses it in two opposite directions at once: it
accents the panel border while it *removes* the cursor from the `Lead transcript` row
(`packages/code/src/views/Sidebar.tsx`, `Sidebar`). The main row is current exactly when no
individual agent is.

**`activityPreview` / `rosterSummary`.** `activityPreview` owns Markdown stripping, whitespace
collapse and bounded ellipsis; `rosterSummary` delegates to it for compatibility. The compact
Agents roster no longer renders that preview because results belong to the selected isolated
transcript.

A selected child uses the same row viewport as Lead, without a synthetic section header or
status-based reordering. Its continuous lifecycle remains in the Agents surface; immutable Lead
markers navigate by delegation identity. Production: `TranscriptViewport` and `TranscriptRowView`
in `packages/code/src/views/transcript/`. Test:
`packages/code/tests/integration/transcript-window-render.test.tsx`.

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
`apply_patch`, `remove`, `write_memory`,
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

**INV-T10.** The selected semantic projection contains Lead records or exactly one child, never a merged child transcript.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T11.** Focus and expansion use row/member IDs from the same selected projection, independently of native residence.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T12.** `reset()` clears focus and fold overrides but never slices, replaces or reorders the
semantic projection. Production: `createTranscriptState` (`reset`). Test:
`packages/code/tests/unit/transcript-state.test.ts` (reset case).

**INV-T13.** Native residence is a bounded row interval, never an estimated character-cost or turn-cost selector.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T14.** A row has one owner across live, terminal, next-message and reconciliation transitions; sealed content contains no render grouping metadata.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T15.** `pickDiffNodes` deliberately ignores physical residency: it scans the full detail source
or semantic node source and returns every diff-producing call in chronological order within the
active Lead or selected sub-agent transcript. Every dehydrated match requests rehydration, so
currently unmounted diffs remain reachable without collapsing the viewer to the newest mutation.
Production: `createTranscriptState` (`pickDiffNodes`). Test:
`packages/code/tests/unit/transcript-state.test.ts` (ordered scoped selection and hydration).

**INV-T16.** First admission fixes known relative order. Authoritative insertion of unknown rows preserves existing row objects.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T17.** Row grouping reads no streaming payload fields; body dehydration cannot alter row IDs or membership.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T18.** Mutations and shell calls never enter exploration groups.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T19.** An exploration segment is execution/actor/iteration scoped and closes at prose, notices, delegation or an individual tool.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T20.** Keyboard focus uses stable row IDs and the bounded visible member page, never head/member painting roles.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

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
`packages/code/src/views/blocks.tsx`, `toggleAt` in
`packages/code/src/views/transcript-state.ts`, and the mutation renderers pass their diff straight to `<diff>`
(`packages/code/src/views/tools/registry.tsx`) and never through `ClampedText`/`ClampedCode`. Test
`packages/code/tests/integration/tool-clamp.test.tsx`, whose title states the reason: "clamping
breaks the unified-diff parser", plus the lead/delegated/manual-fold matrix in
`packages/code/tests/integration/tool-mutation-diff.test.tsx`.

**INV-T26.** Being JSON is not being an envelope: a `shell` result is parsed as an envelope only if it
carries at least one of `exit_code`, `stdout`, `stderr`, `signal`, `timed_out`; a `shell_session` payload only if it carries session status, output, or a session list. Production
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

**INV-T32.** Folded exploration errors remain indicated and can open the first affected member's page.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T33.** An expanded exploration mounts at most 20 member owners per page, without loading unlimited detail.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

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
`packages/code/tests/unit/transcript-content.test.ts` (pathological bounded snapshots).

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

**INV-T44.** The sidebar's plan section mounts a **bounded**, lifecycle-prioritized slice of the task
list that always contains the current task: `in_progress`, actionable `pending`/`returned`, `done`,
then unsuccessful `failed`/`abandoned`, with original index breaking ties. At most
`PLAN_SIDEBAR_TASK_LIMIT = 12` rows are centred on `currentPlanTask` in that projection, with the
remainder reported as `↑ N earlier tasks` / `↓ N later tasks` rather than mounted. Production:
`PLAN_SIDEBAR_TASK_LIMIT`, `planTaskWindow`, and `PlanSummary` in
`packages/code/src/views/Sidebar.tsx`. Test
`packages/code/tests/integration/sidebar-render.test.tsx`, which asserts both the window's own
shape and priority and that a 50-task plan paints `Task 30` with the first task absent from the
frame.

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
`split` and `full` modes it is the combined `Sidebar`; below the split a closed
secondary surface mounts no roster or Plan/workflow pane in the Lead transcript and states the group
facts in the one summary strip instead (`ActivitySummaryStrip`,
`packages/code/src/views/ActivitySummaryStrip.tsx`). The application footer retains canonical
Context/Session state without a second agent/workflow/Plan roster or a hidden pointer route. The
Sidebar's own fixed footer names `Ctrl+X S` as the sole keyboard toggle. Escape does not close
the Sidebar, and no `/activity` command exists. The first live Plan, first workflow state/leader and first delegation own independent
once-per-execution automatic intents that
open/reveal their whole section. Closing one is sticky only for repeated events of that intent; the
first event for another section may reopen and reorient the Sidebar. The Agents intent keeps `Lead
transcript` selected and opens no `ActivityDetail`. Repeated updates cannot flap the layout, and a
long Plan cannot clip a later revealed section. An individually focused agent mounts only one compact
context row. Tab remains the keyboard route through the roster in both split and whole-region modes. Any
agent-row activation only selects that child's isolated transcript; it never opens `ActivityDetail`
automatically. The Agents and Parallel work headers report settled/total and only add a running
count while work is active; both bounded inner scrolls render each child as one plan-tone status
glyph, handle and title without failure totals, lifecycle or execution-detail copy. Their visible
order follows Plan status priority while their projected handles remain stable. Production:
`packages/code/src/views/app/TranscriptRegion.tsx` (`secondaryMode`, `summaryVisible`, `activityPanel`,
`splashInset`, focused-agent context and the two
`Sidebar` mounts), `packages/code/src/views/activity-summary.ts` (`activitySummaryFacts`) and
`packages/code/src/views/Sidebar.tsx` (`SidebarRevealIntent`, `Sidebar` section
owners and native reveal), and `packages/code/src/views/App.tsx` (`visiblePlanContext`,
`visibleSubagentContext`, `requestAutomaticSidebar`, `closeActivitySidebar`,
`openActivitySidebar`, the `activity.toggle` command and `footerRunStrip`). Tests:
`packages/code/tests/integration/transcript-region-render.test.tsx`,
`packages/code/tests/integration/sidebar-render.test.tsx` (including the settled-row negative
`ActivityDetail` case), and
`packages/code/tests/integration/app-shell-render.test.tsx` (the independent Plan/workflow/Agents
auto-reveal contract, per-intent sticky close, `Ctrl+X S` toggling, long-Plan reveal and
completed-agent selection).

**INV-T49.** Lead has exactly two navigable immutable delegation markers; the selected child uses the same row rules and viewport from an isolated store. No child section is automatically folded or reordered by status.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T50.** Assistant syntax settlement preserves the visible streaming body until bounded native highlight preparation completes. Superseded owners discard callbacks.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

**INV-T51.** Unrelated events do not recreate an already mounted individual tool presenter or its finalized diff/code renderable.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

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
orchestration identity set `spawn_subagent`, `agent_list`, `agent_poll`, `agent_stop`, `agent_steer`, `run_leader`, `run_workflow`, `run_round`, `run_work_items`,
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
sibling immediately above `InputDock`. It reuses the same band for `thinking`, `working` and live
`compacting context`, leaving it blank when settled without
actionable detail. Compaction replaces `working` or `thinking` on that line and is not repeated in
the footer. It never prints an idle `ready` label; while a run is active, elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt share that line.
Slash autocomplete replaces the activity line instead of stacking above or below it. The line is
never a live or committed transcript node and cannot scroll or change transcript height. The history
ScrollBox ends with a fixed reading runway of three rows,
reduced to one row only when terminal height is at most 28; streaming state cannot change that
height. No Plan pane mounts between transcript and composer. Production:
`packages/code/src/views/App.tsx` (`leadActivityPhase`, `leadActivityDetail`, `inputPopupOpen` and
bottom composition),
`packages/code/src/views/Footer.tsx` (`LeadActivityLine`),
`packages/code/src/views/transcript/TranscriptRowView.tsx` (Lead-thinking exclusion and runway), and
`packages/code/src/views/app/TranscriptRegion.tsx` (`transcriptReadingRunwayRows`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` ("Lead thinking and working reuse one fixed line
immediately above the composer", "live compaction replaces working on the Lead activity line", and "autocomplete replaces the Lead activity row instead of
stacking ready or working above it") and
`packages/code/tests/integration/transcript-region-render.test.tsx` (plan exclusion and normal versus
compact runway bands).

**INV-T56.** Window admission preserves content quality and snapshot bounds. Large bodies use existing bounded native or plain-text fallback rendering.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

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

**INV-T58.** Input progress is cumulative. Input completion means pending execution, not success or approval. A durable announcement preserves call/actor/physical-attempt identity without argument bytes.
Production: `TranscriptRows`, `TranscriptViewport`, `TranscriptContent` and the individual presenters,
listed in [code-transcript-stability.md](code-transcript-stability.md).
Test: [transcript-records.test.ts](../../packages/code/tests/unit/transcript-records.test.ts),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
[transcript-content-render.test.tsx](../../packages/code/tests/integration/transcript-content-render.test.tsx)
and [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx).

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

**INV-T60.** The compact activity summary states canonical facts and nothing else. Each present group
contributes at most its own progress or state fact plus its own unsuccessful-work counts, in Sidebar
order, and `Agents` counts sub-agents only — the Lead is never part of that group, so no work is
counted in two groups. Vocabulary is reused, not re-derived: Goal labels come from
`goalStatusPresentation`, Plan progress from `planDisplayLifecycle` with the lifecycle word appended
for a terminal outcome that is not completion, and a finished/total count is never presented as a
success count on its own. No title, path, task list or token metric enters the strip, and no fact is
abbreviated with an ellipsis. `activitySummaryRows` wraps whole facts into at most
`activitySummaryRowBudget(height)` rows — one at or below `ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT`,
two above it — and never splits a fact: when the budget cannot seat every fact it drops the least
load-bearing one and re-wraps, so settled work leaves before in-flight work, attention outranks both,
and the trailing `activity.toggle` affordance is dropped only when nothing else remains to drop.
Production: `packages/code/src/views/activity-summary.ts` (`activitySummaryFacts`,
`activitySummaryRows`, `activitySummaryRowBudget`, `activitySummaryRoute`, `planDisplayLifecycle`) and
`packages/code/src/views/ActivitySummaryStrip.tsx` (`ActivitySummaryStrip`). Tests:
`packages/code/tests/unit/activity-summary.test.ts` and
`packages/code/tests/integration/app-shell-render.test.tsx` ("the compact band summarises run activity
instead of covering the conversation").

---

## 6. Failure modes and degradation

| Situation | Handling | Cite |
| --- | --- | --- |
| Tool result is not JSON, or is JSON but not the tool's envelope | `parseBash` returns `parsed: false`; `parseMonitor` returns `undefined` and `renderMonitor` falls through to `renderGeneric` | `packages/code/src/adapters/tool-parsers.ts`; `packages/code/src/views/tools/registry.tsx` |
| A `ToolError` payload (`{error, message}`) reaches `parseBash` | `errorText` composes `"code: message"`, or whichever of the two is present, and puts it in `stderr` alone | `packages/code/src/adapters/tool-parsers.ts` |
| `result` and `error` are the same string | `stdout` is dropped so the sentence is printed once | `packages/code/src/adapters/tool-parsers.ts` |
| `grep_memories` output parses to zero groups | falls back to `renderGeneric` | `packages/code/src/views/tools/registry.tsx` |
| Any tool with no registry entry | `renderGeneric` | `packages/code/src/views/tools/registry.tsx` |
| Empty result | a muted placeholder — `"(no output)"`, `"(no matches)"`, `"(no sessions)"`, `"(empty)"`, `"(done)"` | `packages/code/src/views/tools/registry.tsx` |
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
| A selected child has body records but no delegation card | reconstructed body rows remain individually accessible; no synthesized section or guessed status | `packages/code/src/adapters/transcript-projection.ts` |
| A run produced only delegated work | Lead keeps immutable creation and settlement markers; selection reloads only that child's rows | `packages/code/src/adapters/child-transcript-store.ts`, `packages/code/src/views/transcript/TranscriptViewport.tsx` |
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
| `adapters/tool-identity.ts` → `@clarvis/kernel/policy` | runtime, value | `packages/code/src/adapters/tool-identity.ts`; the kernel entrypoint is one of the eight sanctioned ones (INV-251) |
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
4. **`defaultFolded`** supplies only the presentation default. Explicit user expansion is stored by
   row/member identity and wins when a tool settles, is evicted from the window, or is revisited.

### 7.3 Downstream consumers inside `code`

| Consumer | What it uses |
| --- | --- |
| `packages/code/src/views/transcript/TranscriptViewport.tsx` | primitive projection IDs, bounded row windows and post-layout anchor transactions |
| `packages/code/src/views/transcript/TranscriptRowView.tsx` | one retained wrapper and registry-backed presenter per row; record revisions do not replace owners |
| `views/overlays/DiffViewer.tsx` | `resolveToolRenderer` with `full`/`wrap` set (`packages/code/src/views/tools/registry.tsx`) |
| `views/config/McpBrowser.tsx` | `renderToolPreview` (`packages/code/src/views/tools/registry.tsx`, `renderToolPreview`) |
| `packages/code/src/views/ElicitBlock.tsx` | `MEASURE_MAX_COLS` |
| `views/Sidebar.tsx`, `views/overlays/PlanOverlay.tsx` | `taskTone` (`packages/code/src/views/blocks.tsx`) |
| `packages/code/src/views/app/TranscriptRegion.tsx` | `Sidebar` (the split column and whole-region panel mounts), the focused-agent identity row and the fixed physical reading runway |
| `packages/code/src/views/App.tsx` | `LeadActivityLine` immediately above `InputDock`; the footer carries only bounded activity summaries |
| `packages/code/src/runtime.tsx` (`describeToolCall`) | `formatToolCall` + `mutationStats` composed into `describeToolCall` |
| `src/run-host.ts`, `src/cli-mode.ts`, `src/features/run/status-presenter.ts` | `core/run-status.ts`'s `plainStatusLine`/`memoryNoticeStatus`/`progressStatus`/`liveRunStatus` |

### 7.4 Delegated

- The **events themselves** and their reduction into nodes — [hosts/kernel-runs.md](kernel-runs.md) and
  [hosts/code-run-host.md](code-run-host.md).
- **Record sealing, row identity, residence and semantic reading state** — [hosts/code-transcript-stability.md](code-transcript-stability.md).
- **Theme tokens, glyph table policy and ascii mode** — [hosts/code-theme.md](code-theme.md). This document touches
  `core/marks.ts` only as the framework-free source the theme wraps.
- **Input handling, overlays, the diff viewer and slash commands** —
  [hosts/code-input-and-overlays.md](code-input-and-overlays.md).
- **Plan document semantics** (revisions, CAS triple, retention) — the plan capability documents. Only
  the *UI projection* of plan events is in scope here.

---

## 8. Open questions

**Engineering budgets.** Window and member limits are explicit in
`packages/code/src/core/transcript/window.ts`; parser and tool payload bounds remain independently
owned. The performance contract distinguishes measured results from proposed targets.
`collapsed` is test-fixture data only: production expansion reads the external override map and
`defaultFolded`, never a field on an execution record.

`hiddenBodyLines` counts each `shell_session` list entry or parsed stdout/stderr line through `parseShellSession` in `packages/code/src/views/tools/registry.tsx`. Production: `hiddenBodyLines` and `renderShellSession` in that file. Test: `packages/code/tests/integration/tool-registry-render.test.tsx`.
