# Transcript segmentation, blocks, tool-call rendering and identity

> Implemented at `packages/code/src/core/transcript/**`, `packages/code/src/views/**` and
> `packages/code/src/adapters/{tool-identity,tool-parsers,plan-projection,workflow-projection,message-content,event-span}.ts`.
> Every claim below is anchored to a file and line. Open questions are collected in the final
> section.

---

## 1. Purpose

This subsystem turns an already-reduced array of semantic transcript nodes into what the terminal
actually paints, and it does so under hard resource ceilings. It owns four concerns that are visible
in the code as four separate layers:

1. **Framework-free projection** (`src/core/transcript/**`) — the node type union
   (`packages/code/src/core/transcript/types.ts:151`), the presenter strings a node renders as
   (`packages/code/src/core/transcript/presenters.ts:34`), the bounded display projection of a tool call's payload
   (`packages/code/src/core/transcript/tool-display.ts:200`), and prefix-stable Markdown segmentation of a streaming assistant reply
   (`packages/code/src/core/transcript/segment.ts:129`, `packages/code/src/core/transcript/segment.ts:178`). Nothing here imports Solid or OpenTUI — an architecture test
   enforces that (`packages/code/tests/architecture/architecture-boundary.test.ts:72`).
2. **View-state derivation** (`src/views/transcript-{state,window,completion}.ts`,
   `tool-groups.ts`, `subagent-sections.ts`, `block-focus.ts`) — windowing the transcript to a
   bounded page (`packages/code/src/views/transcript-window.ts:175`), regrouping it into lead nodes and per-sub-agent
   sections (`packages/code/src/views/subagent-sections.ts:52`), collapsing runs of identical tool calls
   (`packages/code/src/views/tool-groups.ts:37`), and tracking fold overrides and keyboard focus (`packages/code/src/views/block-focus.ts:36`,
   `packages/code/src/views/block-focus.ts:73`).
3. **Rendering** (`src/views/blocks.tsx`, `src/views/tools/**`, `Prose.tsx`, `spinner.ts`,
   `truncate.ts`) — one Solid component per node kind (`packages/code/src/views/blocks.tsx:563`), a per-tool renderer
   registry (`packages/code/src/views/tools/registry.tsx:727`), a one-line argument signature (`packages/code/src/views/tools/signature.ts:86`), and a
   line-count gate that collapses an oversized delegated mutation behind a `+N −M` chip while the
   run lead's mutations stay visible (`isLeadMutation` and `isOversizeMutation` in
   `packages/code/src/views/tools/mutation-gate.ts`).
4. **Identity** (`adapters/tool-identity.ts`) — the single rule for "which name is this call",
   used by the renderer registry, the signature table, the grouping pass and the mutation gate alike
   (`packages/code/src/adapters/tool-identity.ts:11`).

Beside those four sits the transcript's persistent companion chrome — the sidebar and its compact
`PlanStrip` substitute (`packages/code/src/views/Sidebar.tsx:279`, `:228`), which paint the plan,
workflow and sub-agent projections this document already owns rather than any transcript node. They are
treated in section 4.19.

The recurring problem the code solves is cost: a long streaming reply re-parsed on every delta, a
100 KiB tool payload handed to a native text renderable, a 6,000-node session mounted at once. The
answers are, respectively, prefix-stable segmentation (`packages/code/src/core/transcript/segment.ts:129`), a cached bounded payload
projection (`packages/code/src/core/transcript/tool-display.ts:200`), and a render-budget pager (`packages/code/src/views/transcript-window.ts:175`).

---

## 2. Surface

### 2.1 `src/core/transcript/index.ts` — the barrel

| Export | Kind | Source |
|---|---|---|
| `NodeStatus`, `TranscriptMessageNode`, `TranscriptNode`, `TranscriptPlanTask` | types | `packages/code/src/core/transcript/types.ts` |
| `guardReviewLabel(node): string` | fn | `packages/code/src/core/transcript/guard-review.ts` |
| `transcriptDisplayText(node): string` | fn | `packages/code/src/core/transcript/presenters.ts:34` |
| `planMetaText(node): string` | fn | `packages/code/src/core/transcript/presenters.ts:45` |
| `compactionNoticeText`, `compactionSkippedNoticeText` | fn | `packages/code/src/core/transcript/presenters.ts:71`, `:87` |
| `visionNoticeText`, `softLimitNoticeText` | fn | `packages/code/src/core/transcript/presenters.ts:97`, `:109` |
| `steerNoticeText`, `steerQueuedNoticeText`, `steerUndeliveredNoticeText` | fn | `packages/code/src/core/transcript/presenters.ts:119`, `:135`, `:148` |
| `subagentFocusToast(title): string` | fn | `packages/code/src/core/transcript/presenters.ts:153` |
| `projectTranscriptToolDisplay`, `TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS`, `TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE`, `TranscriptToolDisplayProjection` | fn/const/type | `packages/code/src/core/transcript/tool-display.ts:200`, `:5`, `:8`, `:26` |
| `IncrementalMarkdownSegmenter`, `IncrementalMarkdownSegments`, `StableMarkdownSegment`, `MarkdownSegments` | class/types | `packages/code/src/core/transcript/segment.ts:178`, `:53`, `:46`, `:34` |

Exported from their modules but **not** re-exported through the barrel:
`TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS` (`packages/code/src/core/transcript/presenters.ts:5`), `TRANSCRIPT_PROSE_RELEASED_DISPLAY`
(`packages/code/src/core/transcript/presenters.ts:8`), `TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE` (`packages/code/src/core/transcript/presenters.ts:12`),
`transcriptDisplayTextChars` (`packages/code/src/core/transcript/presenters.ts:20`), `transcriptToolMountedTextChars`
(`packages/code/src/core/transcript/tool-display.ts:250`), `segmentMarkdown` (`packages/code/src/core/transcript/segment.ts:129`) and the four segmentation constants
(`packages/code/src/core/transcript/segment.ts:9`, `:22`, `:25`, `:28`).

### 2.2 `adapters/tool-identity.ts`

| Symbol | Signature | Line |
|---|---|---|
| `toolIdentity` | `(mcpName?: string, toolName?: string) => string` | `:11` |
| `toolLabel` | `(mcpName?: string, toolName?: string) => string` | `:29` |
| `toolDisplayLabel` | `(mcpName?: string, toolName?: string) => string` | `:47` |
| `MUTATION_TOOLS` | `Set<string>` | `:63` |
| `isMutationTool` | `(mcpName?: string, toolName?: string) => boolean` | `:75` |

`MUTATION_TOOLS` is `FILE_MUTATING_TOOL_NAMES` (imported from `@clarvis/kernel/policy`,
`packages/code/src/adapters/tool-identity.ts:1`) unioned with the literal `["write_memory","edit_memory","delete_memory"]`
(`packages/code/src/adapters/tool-identity.ts:56`). `FILE_MUTATING_TOOL_NAMES` is itself derived —
`packages/kernel/src/policy.ts:44` re-exports
`packages/loop/src/runtime/tools/builtin/names.ts`'s `FILE_MUTATING_TOOL_NAMES`: every explicit file
mutation plus `host_vcs`. The host fallback deliberately remains mutation-presented even though the
exec ceiling independently classifies and filters it as a command runner.

`toolDisplayLabel` (`:47`–`:54`) is distinct from `toolLabel`: when both `mcpName` and `toolName` are
present it returns the raw `server:tool` unchanged (`:51`), otherwise it resolves `toolIdentity` through
the 9-entry `BUILTIN_TOOL_LABELS` table (`:34`–`:44`) — `await_agents` → "Wait for agents",
`agent_poll` → "Check agent", `agent_steer` → "Steer agent", `agent_stop` → "Stop agent",
`delegate_task` → "Delegate task", `run_leader` → "Start workflow leader", `run_workflow` → "Run
workflow", `run_round` → "Run workflow rounds", `run_work_items` → "Run work items" — falling back to
the bare identity for anything not in the table. This is what remaps the engine's internal
orchestration-tool names to product-facing labels while leaving a real MCP call's `server:tool`
identity untouched. Test `packages/code/tests/unit/tool-identity.test.ts:16`–`:23`.

### 2.3 `views/tools/registry.tsx`

| Symbol | Signature | Line |
|---|---|---|
| `ToolCallView` | interface: `mcpName, toolName, arguments, result, diff?, error, status, full?, ungatedMutationBody?, wrap?, mutation?` | `:27` |
| `ToolRenderer` | `(call: ToolCallView) => JSX.Element` | `:62` |
| `ClampedCode` | `(props: {content, filetype, full?, wrap?: "none"\|"char"\|"word"})` | `:123` |
| `diffHeaderPath` | `(diff: string) => string \| undefined` | `:464` |
| `resolveToolRenderer` | `(mcpName, toolName) => ToolRenderer` | `:748` |
| `hiddenBodyLines` | `(mcpName, toolName, result) => number` | `:756` |
| `resolveErrorRenderer` | `(mcpName, toolName) => ToolRenderer` | `:798` |
| `renderToolPreview` | `(mcpName, toolName, args) => JSX.Element` | `:805` |

### 2.4 `views/tools/mutation-gate.ts` and `views/tools/signature.ts`

| Symbol | Signature / value | Line |
|---|---|---|
| `MUTATION_GATE_LINES` | `40` | `packages/code/src/views/tools/mutation-gate.ts:17` |
| `DiffStats` | `{ added, removed, lines }` | `:10` |
| `diffStats(diff)` | counts `+`/`-` rows, skips `+++`/`---` | `:17` |
| `formatStatsChip(s)` | `{ added, removed, tail }` spans | `:30` |
| `MutationNode` | `{ mcpName?, toolName?, subagentOrder?, diff?, args? }` | `:39` |
| `isLeadMutation(node)` | mutation identity with no `subagentOrder` | `isLeadMutation` |
| `mutationBody(node)` | `string` (`""` when the identity has no gated body) | `:69` |
| `mutationStats(node)` | `DiffStats \| null` | `:76` |
| `isOversizeMutation(node)` | `boolean` | `:89` |
| `formatToolCall(mcpName, toolName, args)` | `string`, always parenthesised | `packages/code/src/views/tools/signature.ts:86` |
| `VALUE_MAX` / `SIGNATURE_MAX` | `56` / `72` | `packages/code/src/views/tools/signature.ts:4`, `:5` |

### 2.5 `views/blocks.tsx` and `ui/patterns/stable-syntax.tsx`

| Symbol | Signature / value | Line |
|---|---|---|
| `MEASURE_MAX_COLS` | `110` | `:54` |
| `capitalize(s)` | `string` | `:74` |
| `taskTone(status)` | `ToneStyle` | `:79` |
| `composingLabel(_chars)` | always `"starting" + ellipsis` | `:151` |
| `railColor(node)` | `string` | `:163` |
| `agentGlyph(status)` | `string` | `:239` |
| `BlockView(props)` | the one transcript block component | `:563` |
| `StableMarkdown(props)` | retained streaming/final Markdown handoff | `packages/code/src/ui/patterns/stable-syntax.tsx` |
| `StableDiff(props)` | normalized diff with syntax-ready reveal | `packages/code/src/ui/patterns/stable-syntax.tsx` |
| `waitForSyntaxFrame(root, current, renderer)` | waits for descendant `CodeRenderable.highlightingDone` and a confirming paint | `packages/code/src/ui/patterns/stable-syntax.tsx` |

`BlockView`'s props: `node`, `maxWidth?`, `forceExpand?`, `folded?`, `group?`, `sectionHeader?`,
`overrideOf?`, `focused?`, `onToggle?`, `onOpenDetail?`, `defaultFolded?`, and
`fillAvailableWidth?` (`packages/code/src/views/blocks.tsx`, `BlockView`).

### 2.6 `views/transcript-window.ts`

| Symbol | Value / signature | Line |
|---|---|---|
| `WINDOW_MIN_BLOCKS` | `80` | `:9` |
| `WINDOW_MAX_BLOCKS` | `400` | `:12` |
| `WINDOW_RENDER_BUDGET` | `900` | `:15` |
| `WINDOW_TEXT_CHARS_BUDGET` | `= TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS` = `512 * 1024` | `:18`, `packages/code/src/core/transcript/presenters.ts:5` |
| `TranscriptTurnCounter` | `{ count(nodes, start, end): number }` | `:26` |
| `createTranscriptTurnIndex()` | append-aware turn index | `:40` |
| `NO_TRANSCRIPT_TURNS` | counter that always returns `0` | `:90` |
| `transcriptNodeRenderCost(node)` | `number` | `:103` |
| `transcriptNodeMountedTextChars(node)` | `number` | `:124` |
| `TranscriptWindow` | `{ nodes, hiddenTurns, hiddenBlocks, laterTurns, laterBlocks, atStart, atEnd, start, end, renderCost, mountedTextChars }` | `:131` |
| `windowTranscriptIndexed(...)` | caller-owned index — "This is the production path" | `:200` |
| `earlierLabel` / `laterLabel` | `string` | `:212` / `:219` |

### 2.7 `views/transcript-state.ts`

`TranscriptStateDeps` (`:35`): `nodes()`, `subagents()`, `notify(message)`, `defaultFolded?(key)`,
`rehydrate?(key)`.

`TranscriptState` (`:55`): `grouped`, `toolGroups`, `window`, `loadEarlier()`, `loadLater()`,
`expandAll`, `selectedSubagent`, `focusedKey`, `folded(key)`, `overrideOf(key)`, `toggleAt(key)`,
`reset()`, `toggleSubagent(id)`, `cycleSubagent()`, `toggleExpandOrBlock()`, `focusBlock(delta)`,
`clearFocus()`, `pickDiffNode()`.

Also exported: `withRunMarkersLast(nodes)` (`:114`).

### 2.8 Remaining modules

| Module | Exports | Line |
|---|---|---|
| `views/tool-groups.ts` | `MIN_GROUP = 2`, `ToolGroupInfo`, `computeToolGroups`, `aggregateStatus`, `failureCount` | `:5`, `:10`, `:28`, `:71`, `:78` |
| `views/subagent-sections.ts` | `SectionHeader`, `GroupedTranscript` (incl. `anchors: Map<string,string>`), `computeGroupedNodes` | `:4`, `:23`/`:27`, `:52` |
| `views/block-focus.ts` | `BlockOverride`, `Overrides`, `isFoldedAway`, `computeFocusables`, `toggleOverride`, `nextFocus` | `:7`, `:10`, `:17`, `:36`, `:73`, `:111` |
| `views/transcript-completion.ts` | `completionBeforeFinalAnswer` | `:14` |
| `views/transcript-markdown.ts` | `transcriptMarkdownHeader`, `renderTranscriptMarkdownChunks`, `renderTranscriptMarkdown` | `:6`, `:14`, `:36` |
| `views/truncate.ts` | `truncateEnd`, `truncateStart`, `fmtCount`, `moreChip`, `padColumn` | `:14`, `:34`, `:52`, `:63`, `:80` |
| `views/spinner.ts` | `SPINNER_FRAMES`, `SPINNER_ASCII`, `charForFrame`, `spinnerChar`, `thinkingDots`, `tickNow`, `formatElapsed` (re-export), `useSpinnerClock` | `:5`, `:8`, `:33`, `:39`, `:44`, `:55`, `:59`, `:67` |
| `views/Prose.tsx` | `Prose`, `stripDocChrome` | `:9`, `:31` |
| `views/Sidebar.tsx` | `PLAN_SIDEBAR_TASK_LIMIT`, `planTaskWindow`, `contextMeter`, `rosterSummary`, `subagentProgress`, `PlanStrip`, `Sidebar` | source symbols |
| `views/activity-detail.ts` | `ActivityDetail`, `activityPreview` | source symbols |
| `views/overlays/ActivityDetail.tsx` | `ActivityDetail` | source symbol |
| `core/marks.ts` | `MarkForms`, `MarkName`, `GLYPHS`/`GlyphForms`/`GlyphName` aliases, `applyAsciiMode`, `asciiMode`, `mark`, `glyph` (`@deprecated`), `borderChars` | `:4`, `:81`, `:84`–`:86`, `:97`, `:102`, `:113`, `:119`, `:143` |
| `core/format-elapsed.ts` | `formatElapsed` | `:8` |
| `core/run-status.ts` | `StatusMark`, `StatusSegment`, `StatusLine`, `plainStatusLine`, `memoryNoticeStatus`, `progressStatus`, `LiveRunLineInput`, `liveRunStatus` | `:5`, `:8`, `:11`, `:14`, `:25`, `:48`, `:56`, `:64` |
| `core/attention.ts` | `AttentionRenderer`, `AttentionState`, `Attention`, `createAttention` | `:9`, `:16`, `:18`, `:37` |
| `adapters/message-content.ts` | `contentToText` | `:25` |
| `adapters/event-span.ts` | re-exports `deriveEventSpan`/`EventSpan` from `@clarvis/kernel/policy`; declares `EventSource = "live" \| "replay"` | `:1`, `:7` |
| `adapters/plan-projection.ts` | `PlanTaskActivity`, `PlanActivity`, `isLivePlan`, `isExpectedPlanDiscard`, `isAvailablePlan`, `PlanProjectionEvent`, `reducePlanProjection`, `currentPlanTask` | source symbols |
| `adapters/workflow-projection.ts` | `WorkflowNodeStatus`, `WorkflowNodeActivity`, `WorkflowActivity`, `WorkflowProjectionEvent`, `reduceWorkflowProjection`, `workflowLeaderCounts` | `:4`, `:7`, `:41`, `:50`, `:71`, `:170` |
| `adapters/tool-parsers.ts` | `BashResult`, `parseBash`, `ReadFileParsed`, `parseReadFile`, `GrepGroup`, `parseGrepContent`, `parsePathList`, `Edit`, `editsFromArgs`, `synthesizeUnifiedDiff`, `parseJsonObject`, `ReadFilesSection`, `parseReadFiles`, `MonitorParsed`, `parseMonitor` | `:2`, `:47`, `:109`, `:120`, `:143`, `:153`, `:189`, `:195`, `:205`, `:224`, `:238`, `:243`, `:253`, `:298`, `:319` |

---

## 3. Data and formats

Nothing in this subsystem is persisted. Everything is either in-memory projection or terminal
output. The formats that matter are the *node* shape, the *keys* it is addressed by, and the tool
result texts the parsers accept.

### 3.1 The transcript node union

`TranscriptNode` is a discriminated union on `kind` (`packages/code/src/core/transcript/types.ts:151`), sharing
`TranscriptNodeBase = { key, status, agentLabel?, subagentOrder?, subagentId?, model?, startedAt?,
elapsedMs? }` (`packages/code/src/core/transcript/types.ts:18`).

| `kind` | Extra fields | Line |
|---|---|---|
| `user` / `assistant` / `reasoning` / `thinking` | `text`, `assistantPhase?`, `sourceExecutionId?`, `sourceTextFingerprint?`, `textTruncated?`, `proseReleased?`, `textEpoch?` | `packages/code/src/core/transcript/types.ts` |
| `tool_call` | `text`, `mcpName?`, `toolName?`, `args?`, `result?`, `diff?`, `error?`, `warn?`, `guard?`, `liveOutput?`, `inputChars?`, `dehydrated?`, `hydrationNotice?`, `signature?`, `mutation?` | `packages/code/src/core/transcript/types.ts` |
| `run` | `text`, `reason?`, `toolCalls?`, `inputTokens?`, `outputTokens?` | `packages/code/src/core/transcript/types.ts:103` |
| `subagent` | `text`, `title?`, `reason?`, `toolCalls?`, `inputTokens?`, `outputTokens?` | `packages/code/src/core/transcript/types.ts:113` |
| `plan` | `text`, `planTitle?`, `planStatus?`, `planReview?`, `planRemoved?`, `planDiscarded?`, `tasks?`, `revision?` | `packages/code/src/core/transcript/types.ts:124` |
| `annotation` | `text`, `tone?: "info"\|"warn"\|"accent"` | `packages/code/src/core/transcript/types.ts:137` |
| `error` | `text`, `error?` | `packages/code/src/core/transcript/types.ts:144` |

`NodeStatus = "running" | "ok" | "error" | "pending"` (`packages/code/src/core/transcript/types.ts:15`).

`packages/code/src/adapters/store.ts:33` re-derives `TranscriptNode` by replacing the plan variant's `tasks` with
`PlanTaskActivity[]`; every view module imports the node types from `adapters/store.ts`, not from
core (e.g. `packages/code/src/views/blocks.tsx:8`, `packages/code/src/views/tool-groups.ts:1`, `packages/code/src/views/transcript-window.ts:1`).

### 3.2 Node key format

Keys are strings with meaning encoded as prefixes. Three consumers parse them:

| Pattern | Meaning | Read at |
|---|---|---|
| `<execId>::<span_id>` | a node belonging to run `execId` | `packages/code/src/views/transcript-state.ts:120`, `packages/code/src/views/transcript-completion.ts:4`, `packages/code/src/views/subagent-sections.ts:31` |
| `<execId>::run` | that run's terminal marker | `packages/code/src/views/transcript-state.ts:122` |
| `user:<n>` | a user turn boundary | `packages/code/src/views/transcript-window.ts:53` (`TURN_PREFIX`), produced at `packages/code/src/adapters/store.ts:768` |
| `local:<n>` | a locally-appended `!bash` node | `packages/code/src/views/subagent-sections.ts:68`, produced at `packages/code/src/adapters/store.ts:863` |

The `<span_id>` half comes from `deriveRunEventSpan` in the kernel
(`packages/kernel/src/runs/run-event-span.ts:49`), re-exported through `packages/code/src/adapters/event-span.ts:1`:
`"run"`, `lead:<n>`, `<subagentId>:<n>`, `subagent:<delegationId>`, `workflow:<runId>`, or a tool
`call_id` — with `tool_call` falling back to `` `${agent}:tool` `` when it carries no `call_id`
(`packages/kernel/src/runs/run-event-span.ts:93`, mirrored at `packages/code/src/adapters/store.ts:639`).

### 3.3 The bounded tool-display projection

`TranscriptToolDisplayProjection` (`packages/code/src/core/transcript/tool-display.ts:26`) is the only payload shape a live tool
renderer may inspect. Its budgets:

| Constant | Value | Line |
|---|---|---|
| `TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS` | `64 * 1024` per independent string field | `:5` |
| `ARGUMENT_VALUE_CHARS_BUDGET` | `40 * 1024` across all argument values | `:11` |
| `ARGUMENT_NODE_BUDGET` | `512` visited nodes | `:12` |
| `ARGUMENT_DEPTH_BUDGET` | `16` | `:13` |
| `ARGUMENT_KEY_CHARS_MAX` | `512` | `:14` |

Sentinels written into the projection: `"... [shortened]"` (`:15`),
`"[... omitted from live display ...]"` (`:16`), `"[circular value omitted]"` (`:106`),
`"[accessor omitted]"` (`:144`).

`argumentsText` is an internal `JSON.stringify(projected, null, 2)` capped at the field maximum
(`:178`–`:179`); it supports bounded accounting and is **not** mounted as a standalone JSON panel.
The projected object is still passed to compact signatures and curated renderers. It is created with
`Object.create(null)` (`:129`), so prototype-shaped keys such as `__proto__` land as inert own data —
pinned at `packages/code/tests/unit/tool-display.test.ts:81`.

`mountedTextChars` is a conservative estimate, not a measurement:
`min(512 KiB, argsText + min(argsText, 74) + result + diff + error + (truncated ? notice.length : 0))`
(`packages/code/src/core/transcript/tool-display.ts`). The second bounded argument term charges the
mounted header signature in addition to argument-derived curated output, without pretending the
removed raw JSON panel is mounted.

### 3.4 Markdown segmentation shapes

```
MarkdownSegments        = { sealed: string[]; tail: string }          packages/code/src/core/transcript/segment.ts:34
StableMarkdownSegment   = { id: number; kind: "markdown"|"plain"; text: string }   packages/code/src/core/transcript/segment.ts:46
IncrementalMarkdownSegments =
  { sealed: readonly StableMarkdownSegment[]; tail: string;
    tailKind: "markdown"|"plain"; simplified: boolean }               packages/code/src/core/transcript/segment.ts:53
```

Invariant declared in the type's own doc: `sealed.join("") + tail` is the input, exactly
(`packages/code/src/core/transcript/segment.ts:38`). Segment ids start at `1` and increment (`packages/code/src/core/transcript/segment.ts:185`, `:295`).

Constants: `SEGMENT_MIN = 4096` (`:9`), `TAIL_PLAIN_CAP = 24_576` (`:22`),
`FINAL_MARKDOWN_CAP = 65_536` (`:25`), `MAX_MARKDOWN_SEGMENTS = 64` (`:28`),
`PLAIN_SEGMENT_SIZE = 16_384` (`:31`).

### 3.5 Tool result texts the parsers accept

| Tool family | Accepted text | Recogniser |
|---|---|---|
| `shell` | JSON object carrying at least one of `exit_code`, `stdout`, `stderr`, `signal`, `timed_out` | `packages/code/src/adapters/tool-parsers.ts:80`, `:91` |
| `monitor_*` | JSON object carrying at least one of `monitors`, `id`, `command`, `running`, `ready`, `exit_code`, `stopped`, `output` | `packages/code/src/adapters/tool-parsers.ts:358`, `:380` |
| `read_file` | `cat -n` style: `<spaces><digits>\t<content>`; any other non-blank line is a note | `packages/code/src/adapters/tool-parsers.ts:120` |
| `read_files` | `==> <path> <==` banners; a banner of the form `<path> — <code>: <message>` carries a per-file error; a line matching `/more file\(s\) not shown/` is the trailing note | `packages/code/src/adapters/tool-parsers.ts:269`, `:273`, `:279` |
| `grep` (content mode) | `path:line:text` (match) and `path-line-text` (context), `--` separates groups, an unmatched line appends to the previous row | `packages/code/src/adapters/tool-parsers.ts:171`, `:176`, `:181` |
| `glob` / `list_dir` / `list_memories` | newline-separated non-blank paths; `"(no matches)"` yields `[]` | `packages/code/src/adapters/tool-parsers.ts:189` |

Real examples in the tests: a `shell` envelope at
`packages/code/tests/unit/tool-parsers.test.ts:16`; a `read_files` document at `:143`; a `grep`
content block at `:83`; a guard denial `{"error":"denied","message":"…"}` at `:202`.

`MonitorParsed` (`packages/code/src/adapters/tool-parsers.ts:298`–`:309`) carries `hasExitCode: boolean` distinct from
`exitCode: number | null` — `hasExitCode` is `"exit_code" in j` (`:351`), so it distinguishes "no
`exit_code` key present" from "an `exit_code` key present whose value did not parse as a number".
`renderMonitor` gates the exit-code chip on `m.hasExitCode && m.exitCode !== null`
(`packages/code/src/views/tools/registry.tsx:648`). Pinned at `packages/code/tests/unit/tool-parsers.test.ts:173`, `:180`.

### 3.6 Synthesized unified diff

When an edit-family call carries no real `diff`, one is reconstructed from its arguments
(`packages/code/src/adapters/tool-parsers.ts:224`):

```
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,1 @@
-const a = 1
+const a = 2
```

The hunk header is explicitly documented as a display approximation — `@@ -1,N +1,M @@` per edit,
not a real diff computation (`packages/code/src/adapters/tool-parsers.ts:222`). Pinned at
`packages/code/tests/unit/tool-parsers.test.ts:127`. `path` falls back to the literal `"file"`
(`packages/code/src/adapters/tool-parsers.ts:225`).

---

## 4. Behavior

### 4.1 The pipeline, in the order it runs

`TranscriptRegion` is the only production caller
(`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`).
The chain from raw store nodes to painted rows:

| Step | Function | Line |
|---|---|---|
| 1. sub-agent isolation filter | `visibleNodes` memo, filters on `subagentId` | `packages/code/src/views/transcript-state.ts:147` |
| 2. move each run's terminal marker last | `withRunMarkersLast` | `packages/code/src/views/transcript-state.ts:114` |
| 3. select one bounded page | `windowTranscriptIndexed` | `packages/code/src/views/transcript-state.ts:165` |
| 4. regroup into lead nodes + sub-agent sections | `computeGroupedNodes` | `packages/code/src/views/transcript-state.ts:172` |
| 5. collapse runs of identical tool calls | `computeToolGroups` | `packages/code/src/views/transcript-state.ts:173` |
| 6. compute keyboard-focusable keys | `computeFocusables` | `packages/code/src/views/transcript-state.ts:174` |
| 7. move the run marker before the final answer | `completionBeforeFinalAnswer` | `packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion` |
| 8. render one block per node | `BlockView` | `packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion` |

Step 3 happens **before** step 4, and the code states why: `computeToolGroups` assigns head/member by
adjacency, `isFoldedAway` resolves a section anchor, and `computeFocusables` would otherwise hand out
focus on unmounted keys (`packages/code/src/views/transcript-state.ts:153`–`:164`). The ordering is pinned by
`packages/code/tests/unit/transcript-window-state.test.ts:57`, which asserts every grouped node, every
focusable key and every `headKey` is inside the mounted window.

### 4.2 Windowing

`selectTranscriptWindow` (`packages/code/src/views/transcript-window.ts:175`) walks **backwards** from `end` (which is
`nodes.length` when `pageEnd` is `null`, `packages/code/src/views/transcript-window.ts:183`) and stops on the first of:

| Stop condition | Line |
|---|---|
| `end - start >= maxBlocks` (400) | `:177` |
| `renderCost + cost > renderBudget` (900), once at least one node is included | `:178` |
| `mountedTextChars + textChars > 512 KiB`, once at least one node is included | `:178` |
| `start === 0` | `:172` |
| the node just admitted is a `user:` turn boundary **and** `end - start >= minBlocks` (80) | `:184` |

`start < end` guards the two budget conditions, so a single pathological node is always admitted and
then presentation-clamped by `transcriptDisplayText`/`projectTranscriptToolDisplay` rather than
excluded — pinned at `packages/code/tests/unit/transcript-window.test.ts:81`, which asserts a page of
exactly one node whose `mountedTextChars` equals the budget.

`transcriptNodeRenderCost` (`:103`) is `base + ceil(mountedTextChars / 4096)` with per-kind bases:
`tool_call` 12, `assistant` 8, `subagent`/`plan`/`error` 6, `user`/`reasoning`/`run` 5, default 3
(`:105`–`:120`).

`createTranscriptTurnIndex` (`:40`) keeps `turnPositions` and answers a range count by binary search
(`:46`, `:84`). It **rebuilds** when the array identity changed, the array shrank, or the formerly
scanned tail key no longer matches (`:79`); it **extends** when only appended (`:81`). Pinned:
appended-suffix-only scanning at `packages/code/tests/unit/transcript-window.test.ts:165`, rebuild-on-replacement
at `:185`.

`NO_TRANSCRIPT_TURNS` (`:90`) is substituted whenever a sub-agent is selected
(`packages/code/src/views/transcript-state.ts:169`) — a filtered sub-agent transcript contains no `user:` keys.

**Paging state machine** (`packages/code/src/views/transcript-state.ts:143`, `:216`, `:223`):

| State | Event | Next state | Effect |
|---|---|---|---|
| `pageEnd = null` (following newest) | `loadEarlier()` and `!atStart` | `pageEnd = w.start` | push `w.end` onto `laterPageEnds`; return `true` |
| any | `loadEarlier()` and `atStart` | unchanged | return `false` |
| `pageEnd = k` | `loadLater()` and `!atEnd` | `pageEnd = popped end`, or `null` when the popped value is `undefined` or `>= visibleNodes().length` | pop `laterPageEnds`; return `true` |
| any | `loadLater()` and `atEnd` | unchanged | return `false` |
| any | `reset()` | `pageEnd = null`, `laterPageEnds = []` | also clears focus and overrides |
| any | `selectedSubagent` changes | `pageEnd = null`, `laterPageEnds = []` | deferred effect, `packages/code/src/views/transcript-state.ts:181` |

Round-tripping to both ends without the page ever growing is pinned at
`packages/code/tests/unit/transcript-window-state.test.ts:85`.

### 4.3 Run-marker reordering, twice

Two independent reorderings run on the same node array, at different points and for different
reasons.

`withRunMarkersLast` (`packages/code/src/views/transcript-state.ts:114`) moves each `<exec>::run` node **after** the last
node sharing its `<exec>::` prefix. It returns the input array unchanged when nothing moves
(`:125`), which `packages/code/tests/unit/run-marker-order.test.ts:19` pins with `toBe`. The reason is stated in
the code: events for work that had already finished can land after `run_ended`, most visibly on a
cancellation (`packages/code/src/views/transcript-state.ts:101`–`:106`). It is a projection rather than a store mutation
because the store guarantees node identity across a reconcile (`:108`–`:112`).

`completionBeforeFinalAnswer` (`packages/code/src/views/transcript-completion.ts:14`) then moves the run node **before** the
run's final lead assistant node — but only for runs where the answer currently sits *before* the
marker (`:28`), and only for lead answers (`subagentOrder === undefined`, `:21`). Runs without a lead
answer keep protocol order (`packages/code/tests/unit/transcript-completion.test.ts:19`). It always returns a fresh
array when anything moves (`:32`) and a shallow copy otherwise (`:30`).

### 4.4 Sub-agent sectioning

`computeGroupedNodes` (`packages/code/src/views/subagent-sections.ts:52`) runs three passes.

**Pass 1 — lead bookkeeping** (`:62`–`:77`): for each non-`run` node with no `subagentOrder`, whose
kind is in `LEAD_KINDS = {assistant, reasoning, thinking, tool_call, error}` (`:14`) and whose key
does **not** start with `local:` (`:68`): record the run's first lead key, count lead tool calls, mark
the run as "has work" on a `tool_call` or `reasoning`, and capture the first `model` seen. `run`
nodes only contribute their status (`:63`).

**Pass 2 — layout slots** (`:79`–`:92`): a node with no `subagentOrder` becomes a `lead` slot; a node
with one is bucketed under `` `${runId}:${subagentOrder}` `` and the first such node emits a
`section` slot placeholder.

**Pass 3 — emission** (`:157`–`:177`): walking the slot list, a lead slot first `flush()`es any
pending sections, then emits itself, seeding a `lead: true` header when
`leadHasWork.has(rid) && leadFirst.get(rid) === node.key` (`:162`). `flush` (`:146`) sorts pending
sections so **inactive sections come first** (`:150`) and then by `subagentOrder` (`:151`).

`emitSection` (`packages/code/src/views/subagent-sections.ts`, `emitSection`) picks the section's
`card` (the `subagent`-kind node) and `body` (everything else). With no body it emits only the card
and its header. Otherwise the **anchor** is the card when present, else the first body node. A
card-backed section folds its whole body even when the Lead recorded no visible transcript, so
spawning several workers cannot expand all of them into an initially empty surface. A degraded
cardless section in that no-Lead state keeps its first body node visible as the identity anchor and
folds any remaining entries; with visible Lead context, its whole body folds as before. Header
status first consults the live roster using the `subagentId` carried by any node in the bucket, then
falls back to the card or `"running"`.

The lead header carries `order: -1`, an empty `title`, `lead: true`, the run's status and its
tool-call count (`packages/code/src/views/subagent-sections.ts:163`–`:170`); `SectionHead` renders it as
`model · N tool calls` (`packages/code/src/views/blocks.tsx:520`, `:534`) — pinned at
`packages/code/tests/integration/lead-presentation.test.tsx:137`.

`SectionHead`'s folded-count label is deliberately different for the two branches: a lead's number is
tool calls, a sub-agent section's is hidden entries, and the code states they "must not share a word"
(`packages/code/src/views/blocks.tsx:488`–`:501`).

`GroupedTranscript.anchors` (`packages/code/src/views/subagent-sections.ts:27`, populated at `:122`) is a `Map<string,string>`
from every folded body node's key to its section's anchor key — the data structure `isFoldedAway`
(`packages/code/src/views/block-focus.ts:19`) reads to resolve "which section anchor does this key fold behind" when computing
focusables and fold state.

### 4.5 Tool-call grouping

`computeToolGroups` (`packages/code/src/views/tool-groups.ts:37`) scans left to right:

| Condition on the head node | Result |
|---|---|
| not a `tool_call`, or `isMutationTool(head)` | `{ role: "solo", ordinal: 0, size: 1 }`, advance 1 (`:33`) |
| a run of ≥ `MIN_GROUP` (2) nodes with identical `mcpName`, `toolName` and `subagentOrder` | first gets `role: "head"` carrying `members`, the rest `role: "member"`, all sharing `headKey` (`:57`–`:63`) |
| a run shorter than `MIN_GROUP` | `"solo"`, advance 1 (`:51`) |

The break conditions are exactly: a non-`tool_call` node, a different `mcpName`, a different
`toolName`, or a different `subagentOrder` (`:41`–`:47`). Each is pinned by a named case in
`tests/unit/tool-groups.test.ts` — a message between calls at `:37`, reasoning at `:42`, different
servers at `:52`, different sub-agents at `:57`.

`aggregateStatus` (`:71`) is running → error → ok, in that precedence; `failureCount` (`:78`) tallies
`"error"`. Pinned at `packages/code/tests/unit/tool-groups.test.ts:97`.

**The grouping and sectioning passes read no streaming-hot field.**
`packages/code/tests/unit/transcript-grouping-fields.test.ts:82` and `:91` wrap every fixture node in a Proxy and
assert that `computeGroupedNodes`, `computeToolGroups` and `computeFocusables` never read `text`,
`result`, `diff`, `args`, `liveOutput` or `dehydrated`. The test file itself calls the property
"currently accidental — nothing in the code says 'do not read `.text` here'"
(`packages/code/tests/unit/transcript-grouping-fields.test.ts:14`), and includes a self-check that the Proxy would in fact
catch a read (`:102`).

### 4.6 Fold state and focus

Three inputs decide whether a block's body shows, resolved by `collapsed()` in
`BlockView` (`packages/code/src/views/blocks.tsx:579-585`):

1. an explicit per-key `BlockOverride` (`"expanded"` / `"collapsed"`) — wins outright;
2. a lead mutation remains expanded;
3. `forceExpand()` (the transcript-wide "expand all");
4. `defaultFolded()` supplied by the host, falling back to a `collapsed` field that is not part of
   `TranscriptNode` (`packages/code/src/views/blocks.tsx:585`).

`fullBody()` — whether ordinary arguments/results render unclamped — is deliberately **not** keyed on `forceExpand`
(`packages/code/src/views/blocks.tsx:597`–`:607`): only an explicit per-block or per-head `"expanded"` override lifts the
ten-line cap. `packages/code/tests/integration/tool-clamp.test.tsx:26` mounts every fixture with
`forceExpand={() => true}` and `:37` still expects the cap. Lead mutations use the separate
`ungatedMutationBody` flag, so their diff/content crosses the 40-line mutation gate without also
expanding a duplicative arguments panel.

`computeFocusables` (`packages/code/src/views/block-focus.ts:36`) yields, in transcript order: a folded section anchor (one
stop for the whole section, `:43`), then — skipping nodes folded away (`:47`) — every `tool_call`
whose group role is `"solo"` or `"head"` (`:48`–`:51`). Messages, plan nodes and group members are
never focusable, pinned at `packages/code/tests/unit/block-focus.test.ts:24`.

`toggleOverride` (`packages/code/src/views/block-focus.ts:73`) state machine:

| Current state | Result | Line |
|---|---|---|
| key is a section anchor with `hiddenEntries > 0` and override `"expanded"` | delete the override (refold) | `:87` |
| key is such an anchor otherwise | set `"expanded"` | `:88` |
| `node` is undefined | no change | `:91` |
| ordinary node: `defaultExpanded` = lead mutation **or** (`role !== "head"` and not `defaultFolded` and not an oversize mutation) | current expanded state flips to the opposite override | `toggleOverride` |

A group head therefore always starts collapsed, while a lead mutation starts expanded even if the
store's generic tool default says folded. Delegated oversize mutations retain the compact default.
Pinned at `packages/code/tests/unit/block-focus.test.ts:59` and
`packages/code/tests/integration/tool-mutation-diff.test.tsx`.

`nextFocus` (`:111`) clamps at both ends and starts from the **last** key when `current` is `null` or
unrecognised (`:114`) — pinned at `packages/code/tests/unit/block-focus.test.ts:101`.

`createTranscriptState` calls `deps.rehydrate?.(key)` on **every** toggle, expand or collapse
(`packages/code/src/views/transcript-state.ts:198`), and the doc states why: the store no-ops on a node that still has its
body, so deciding here would duplicate that check against a fold state being changed
(`packages/code/src/views/transcript-state.ts:41`–`:47`).

Two self-healing effects: a `selectedSubagent` that vanished from the roster is cleared
(`packages/code/src/views/transcript-state.ts:176`), and a `focusedKey` no longer in `focusables()` is cleared (`:192`).

### 4.7 Sub-agent selection

| Action | Behaviour | Line |
|---|---|---|
| `toggleSubagent(id)` with `id` already selected | clear selection, notify `"showing all activity"` | `:248` |
| `toggleSubagent(id)` otherwise | select, notify `subagentFocusToast(title \|\| id)` | `:252` |
| `cycleSubagent()` with an empty roster | clear, notify `"no sub-agents to focus"` | `:259` |
| `cycleSubagent()` otherwise | advance through the roster sorted ascending by `order`, wrapping past the end to `null` | `:258`, `:266` |

Pinned at `packages/code/tests/unit/transcript-state.test.ts:37`, `:57`, `:113`, `:140`.

`focusBlock(delta)` (`:282`–`:289`) notifies `"nothing to focus"` and returns `null` when `nextFocus`
finds nothing (an empty `focusables()` list), else sets and returns the new focused key.
`clearFocus()` (`:291`–`:295`) is a no-op returning `false` when nothing is focused, else clears focus
and returns `true`. Pinned at `packages/code/tests/unit/transcript-state.test.ts:207`–`:227`.

`toggleExpandOrBlock()` (`:274`) toggles the focused block when one is focused, otherwise flips
`expandAll` and notifies `"blocks expanded"` or `""` (`:281`) — the empty string on the second flip
is asserted at `packages/code/tests/unit/transcript-state.test.ts:182`.

`pickDiffNode()` (`:297`) prefers the focused node when it is in
`DIFF_TOOLS = {apply_patch, edit_file, multi_edit, write_file, diff, replace}`
(`packages/code/src/views/transcript-state.ts:22`), otherwise scans `deps.nodes()` **backwards** — i.e. over the full
transcript, not the mounted page (`:313`). A dehydrated pick triggers `rehydrate` and is still
returned, so the overlay fills in rather than silently opening an older diff (`:300`–`:309`). Pinned
at `packages/code/tests/unit/transcript-state.test.ts:293` and
`packages/code/tests/unit/transcript-window-state.test.ts:134`.

### 4.8 Assistant Markdown segmentation

`segmentMarkdown(text, min)` (`packages/code/src/core/transcript/segment.ts:129`) returns `{ sealed: [], tail: text }` immediately when
`text.length <= min` (`:130`). Otherwise it walks lines, toggling a fence flag on any line whose
first non-space characters are ` ``` ` or `~~~` (`:77`, `:143`), and takes a cut only when **all** of:

| Condition | Line |
|---|---|
| not inside a fence | `:145` |
| the line is blank (`line.trim().length === 0`) | `:142`, `:146` |
| the line is **terminated** (`br !== -1`) | `:154` |
| the accumulated segment has reached `min` | `:155` |
| it is not a blank line interior to an indented code block (`lastCode && continuesIndentedCode`) | `:156` |

The terminated-line rule exists because an unterminated whitespace-only tail would take a cut that
the next delta withdraws (`:147`–`:153`). The indented-code lookahead exists because a blank line
between two indented lines is interior to one code block, not a paragraph break (`:87`–`:94`).

Prefix stability is asserted at **every single prefix**, not a sampled stride, at
`packages/code/tests/unit/segment-markdown.test.ts:92`; the test file states the case that broke it took a cut on
an unterminated whitespace-only last line and withdrew it one character later (`:93`–`:97`).
Exact reassembly across seven shapes × four `min` values is pinned at `:25`.

`IncrementalMarkdownSegmenter.update(text, epoch, running)`
(`packages/code/src/core/transcript/segment.ts`):

| Condition | Action |
|---|---|
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
final tree receives layout, starts Tree-sitter work, awaits every public descendant
`CodeRenderable.highlightingDone`, and completes one confirming paint. A single Solid batch then
reveals the final tree and disposes the old one. No timer or renderer-wide pause participates, and
at most two Markdown trees exist during that bounded handoff. Every segment after the first carries
`marginTop={1}`, because
`MarkdownRenderable` applies its inter-block margin internally and that margin is exactly what a cut
discards. A `simplified` settled reply prints
`"Formatting simplified to keep this large response responsive."`.

### 4.9 Tool block rendering

`ToolLine` (`packages/code/src/views/blocks.tsx:256`) derives, in order:

| Derived | Rule | Line |
|---|---|---|
| `display()` | `projectTranscriptToolDisplay(node, rawToolArguments(node))` | `:263` |
| `isCollapsed()` | `!showBody && status !== "running"` | `:266` |
| `diffChip()` | `trueMutationStats(node)` when collapsed and not errored | `:267` |
| `hiddenLines()` | `hiddenBodyLines(...)` only when collapsed, not errored, and there is no diff chip | `:270` |
| `hasBody()` | `showBody && status !== "running"` | `:274` |
| `tail()` | last 5 lines of `liveOutput`, only while running | `:282`, `:139` |
| `composing()` | `composingLabel(inputChars)` when `inputChars !== undefined`, else `""` | `:287` |

The header renders as one truncated, non-wrapping row (`:297`–`:348`); its TSDoc states this is so a
collapsed call is always exactly one row whatever the terminal width (`:250`–`:255`). Its parts, in
order: status glyph, `toolDisplayLabel` in accent (suppressed when indented as a group member,
`:304`–`:309`), then **either** the composing label **or** the signature — never both (`:310`–`:324`),
the signature preferring resident `node.signature` over live `formatToolCall` (`:313`–`:319`). Then
elapsed time while running (`:325`–`:329`), or elapsed time when settled and
`elapsedMs >= SLOW_TOOL_MS` (2000ms, `:129`, `:330`–`:334`). Then either the mutation chip
(`:335`–`:344`) or the hidden-line chip (`:345`–`:347`).

Below the header, in order: the live tail (`:350`–`:360`), the hydration notice when expanded and
dehydrated (`:361`–`:367`), the curated result/error body card on `tokens.bgElev` (`:368`–`:383`),
and finally the `truncated` warning banner (`:384`–`:395`). No tool identity or expansion state
mounts a standalone `Arguments` label or raw argument JSON. Arguments remain available only to the
compact header signature and the resolved renderer, which can select paths, commands, diffs or other
useful fields without duplicating the complete envelope. Pinned for a curated shell renderer and the
generic fallback at `packages/code/tests/integration/tool-destripe-render.test.tsx:112-159`.

`trueMutationStats` (`packages/code/src/views/blocks.tsx:175`) prefers the resident `node.mutation` and only falls back to
computing `mutationStats` from the raw args/diff — never from `display()`, which is bounded
(`:132`–`:138`). Pinned at `packages/code/tests/integration/transcript-region-render.test.tsx:236`: a 4,000-line
diff exceeding 64 KiB must still chip as `+4000`.

`hidden()` (`packages/code/src/views/blocks.tsx:625-628`) hides a group `member` unless the group is expanded **or** the member
carries `warn` — an errored member stays hidden, pinned at
`packages/code/tests/integration/tool-groups-render.test.tsx:78` (`expect(out).not.toContain("boom")`).

The group **head** row (`packages/code/src/views/blocks.tsx`, `BlockView`) shows the aggregate status
glyph, the display label, `×N`, a single `starting…` when any quiet member is still composing, and `N failed` when
any member errored. It lists up to `MAX_GROUP_SIGNATURES = 6` member signatures with a `moreChip`
for the rest. Denied guard members are selected before ordinary members, preserving their original
relative order, and remaining slots then take ordinary members in order. A grouped shell signature
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
paints no background at all (`:619`–`:621`). The bordered box's `marginTop` (`:618`, set to `1` only
when a `sectionHeader` is present) sits **outside** its `border={["left"]}`, so a folded sub-agent
section header's leading blank row is not painted with the rail glyph — pinned at
`packages/code/tests/integration/subagent-rail-render.test.tsx:47`–`:77`.

Per-kind bodies (`packages/code/src/views/blocks.tsx:662`–`:879`): `user` gets a `userBandBg()` band with a rail glyph
(`:630`); `reasoning` renders nothing at all when collapsed (`:650`) — pinned at
`packages/code/tests/integration/reasoning-hidden-render.test.tsx:32`; `thinking` is a spinner plus animated dots
(`:664`); `assistant` is the segmented Markdown and preserves a provider-declared `commentary` phase
without synthesizing a visible label or changing its body; `subagent` is a bounded one-line plain-text
preview of the delegation brief with a click affordance for the full Markdown detail modal, hidden
when collapsed or blank; `plan` (`:768`–`:786`) always shows a header
line (`plan <title>` plus `planMeta`, `:770`–`:773`), conditionally shows a `  review: <verdict>` line
when `planReview` is set, and, only when not collapsed, chooses among three guidance sentences:
`planDiscarded` says `"Plan was deleted after success, as configured"`; another
`planRemoved` says `"The backing record is unavailable; restore it or create a replacement plan"`;
an available plan says `"Open plan for the full objective, task list and review history"`
(`packages/code/src/views/blocks.tsx:805-823`). Thus retention cleanup remains neutral while an
unexpected loss stays actionable;
`annotation` colors by `tone` (`:790`); `error` prints the agent label and the error text (`:807`);
`run` prints the outcome word, elapsed time and — on a non-`ok` run — a `Next:` line naming only
affordances that exist (`:581`–`:586`, `:821`). Pinned at
`packages/code/tests/integration/plan-block-render.test.tsx:38`–`:48` (routes full detail to the overlay) and
`:56`–`:59` (review verdict).

### 4.10 Tool renderer resolution

`resolveToolRenderer(mcpName, toolName)` looks up `byTool[toolIdentity(...)]` and falls back to
`renderGeneric` (`packages/code/src/views/tools/registry.tsx:760`). The full table (`packages/code/src/views/tools/registry.tsx:727`–`:757`):

| Renderer | Tools |
|---|---|
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

**Non-mutation-gated renderers' own rules** (`registry.tsx`): `renderBash` (`:202`–`:217`) colors the
status word by exit code (`add` for `0`, `del` otherwise) and distinguishes a settled `"failed"`
(unparsed result with an error present) from an ordinary `"done"`/`"exit N"`. `renderReadFile`
(`:247`–`:262`) prints a `path  ·  lines N–M` header only when `parseReadFile` found line numbers; with
none, only the code body renders. `renderMonitor` (`:591`–`:644`) renders a filled/hollow dot glyph per
monitor in list mode, and in single-monitor mode a `running`/`stopped`/`exited`/`monitor` status word
plus a `ready`/`not ready` chip and the exit-code chip gated on `hasExitCode` (see section 3.5).
`renderImage` (`:309`–`:318`) is a fixed `[image]` tag plus the path, with no body at all.
`renderMemoryRead` (`:697`–`:707`) forces `filetype="markdown"` syntax highlighting regardless of the
memory document's actual name. `renderMemoryGrep` (`:710`–`:713`) delegates to `renderGrep` by
rewriting the call's `output_mode` argument to `"content"`, falling back to `renderGeneric` when
`parseGrepContent` finds zero groups. `renderJsonCard` (`:653`–`:681`) renders with Solid's `Index`,
not `For` — an explicit remark in source (`:658`–`:660`) states `Object.entries()` yields fresh `[k,
v]` tuples with no stable identity every render, so rows must key by position instead.

`resolveErrorRenderer` (`:798`) returns the *normal* renderer for a tool in
`ERROR_AWARE = {shell, monitor_start, monitor_poll, monitor_stop}` (`:773`), and `renderErrorGeneric`
otherwise (`:775`). `renderErrorGeneric` respects `full`/`wrap` so an error's stack trace can be
lifted out of the ten-line clamp (`:776`–`:786`).

`MAX_BODY_LINES = 10` (`:88`); `clampLines` (`:90`) returns the whole text when `full` sets the max to
`Infinity` (`:111`, `:145`). The `+N more` footer is `moreChip` (`packages/code/src/views/truncate.ts:63`), which pluralises
on `hidden === 1`.

**The mutation gate.** `oversize(body, expanded)` is `!expanded && body.length > 0 && body.split("\n").length
> 40`. `mutationBodyExpanded(call)` treats either an explicit full expansion or
`ungatedMutationBody` as expanded. `BlockView` supplies the latter only for `isLeadMutation(node)`,
so lead mutation bodies remain inline while delegated calls retain the gate. `gateBody` calls `mutationBody` with the call's identity, diff and
arguments (`:176`–`:183`). `gateStats` prefers the host's `call.mutation` measurement over counting the
bounded body (`:189`–`:191`). Four renderers implement the gate: `renderWriteFile` (`:377`),
`renderEdit` (`:421`), `renderApplyPatch` (`:512`) and `renderDiffTool` (`:548`).

**The "(reconstructed)" marker.** `renderEdit` (`packages/code/src/views/tools/registry.tsx:433`–`:461`) prints a muted
`(call.result || "edited") + "  " + glyph("separator") + " (reconstructed)"` label whenever the call
carries no real `diff` — in both the oversize-gated branch (`:427`–`:432`) and the normal inline branch
(`:438`–`:444`) — so a synthesized unified diff (`synthesizeUnifiedDiff`, section 3.6) is always
visibly distinguished on screen from a real one. Pinned at
`packages/code/tests/integration/tool-diff-render.test.tsx:46`–`:56`, `:110`–`:119` and
`packages/code/tests/integration/tool-registry-render.test.tsx:156`–`:167`, and negatively at
`packages/code/tests/integration/mutation-gate.test.tsx:92`.

`mutationBody`'s table (`packages/code/src/views/tools/mutation-gate.ts:64`):

| Identity | Body |
|---|---|
| `write_file`, `write_memory` | `diff` if present, else `args.content` |
| `edit_file`, `multi_edit`, `edit_memory` | `diff` if present, else `synthesizeUnifiedDiff(args.path, editsFromArgs(args))` |
| `apply_patch` | `diff` if present, else `args.patch` |
| `replace` | `diff` with trailing newlines stripped |
| anything else | `""` |

`mutationStats` (`:76`) returns `null` for a non-mutation or an empty body, and for a `write_file` /
`write_memory` **without** a real diff it counts every content line as added rather than running
`diffStats` (`:81`–`:84`) — pinned at `packages/code/tests/integration/mutation-gate.test.tsx:129`
(`{ added: 50, removed: 0, lines: 50 }`). The doc states the reason: the tool result is a one-line
summary, so counting its lines under-reports the change (`:73`–`:75`).

`isOversizeMutation` (`:89`) and the renderers' `oversize()` must agree; that agreement is pinned
case by case at `packages/code/tests/integration/mutation-gate.test.tsx:79`, `:86`, `:123`, `:150`.

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
`====` rule and an `Index: ` line into the section start (`splitDiffFiles`, `:485`–`:494`); the text
before the first section becomes a muted preamble (`:496`). Each section's filetype comes from
`diffHeaderPath` (`:464`), which prefers the `+++` path, strips a `a/`/`b/` prefix and skips
`/dev/null` (`:469`–`:475`); the fallback is `firstPathArg` over `path`/`from`/`to`/`source`/`file`
(`:504`).

`hiddenBodyLines` (`:756`) is identity-specific: `shell` counts parsed stdout + stderr lines,
`monitor_start`/`monitor_poll`/`monitor_stop` count parsed output lines, everything else counts the
raw result's lines (`:762`–`:770`). Blank-only text counts as `0` (`:759`).

### 4.11 Signature formatting

`formatToolCall` (`packages/code/src/views/tools/signature.ts:86`) resolves `SIGNATURES[toolIdentity(mcpName, toolName)]`
(`:91`). With a spec: each present primary key renders **bare** in declared order (`:94`), the
`placeholder` stands in when every primary is absent (`:95`), and each present secondary renders as
`key=value` (`:96`). Without a spec: every argument renders as `key=value` (`:99`). The joined parts
are wrapped in parentheses and capped at `SIGNATURE_MAX = 72` (`:101`).

Value formatting (`:63`): strings collapse whitespace to single spaces and truncate at
`VALUE_MAX = 56` — from the **start** when the key is in
`PATH_KEYS = {path, paths, cwd, source, destination, from, to, file}` so the basename survives
(`:7`, `:60`), from the end otherwise. Numbers and booleans stringify; a homogeneous string array
joins with `", "` (`:67`); anything else goes through `JSON.stringify` inside a `try` (`:69`).

The 37-entry `SIGNATURES` table is at `packages/code/src/views/tools/signature.ts:18`–`:56`. Its behaviour is pinned across
`tests/unit/tool-signature.test.ts` — bare command at `:6`, secondaries at `:10`, non-whitelisted
argument suppression at `:19`, start-truncation of a long path at `:29`, `list_dir`'s `"."`
placeholder at `:37`, the uncurated-MCP `key=value` fallback at `:46`, mutation tools showing only
the path at `:52`, and `apply_patch` rendering as bare `()` at `:57`.

### 4.12 Projections consumed by, but not owned by, the transcript block

`reducePlanProjection` (`packages/code/src/adapters/plan-projection.ts:87`) folds the five plan events into one `PlanActivity`:

| Input | Result | Line |
|---|---|---|
| same `id` and `event.revision < current.revision` | return `current` unchanged | `:94` |
| `plan_removed` with no matching current | synthesize `{ title: "Plan unavailable", status: "failed", retention: "keep", tasks: [], removed: true }` from whatever the event carries | `:97`–`:108` |
| `plan_removed` matching current | merge the event's present fields onto current, set `removed: true` | `:109`–`:118` |
| `plan_review_resolved` | carry `event.outcome` as `reviewOutcome` | `:122`–`:123` |
| any other plan event on the same id | carry the existing `reviewOutcome` forward | `:124`–`:125` |
| any other plan event on a different id | drop `reviewOutcome` | `:126` |

Pinned at `packages/code/tests/unit/plan-projection.test.ts:218` (stale revision), `:195` (orphan removal), `:109`
(review outcome persistence and reset on a new plan id).

`currentPlanTask` (`:144`) prefers `in_progress`, then `returned`, then `pending` — pinned at
`packages/code/tests/unit/plan-projection.test.ts:89`. `isLivePlan` (`:34`) is "not removed and status
is `active` or `awaiting_approval`"; `isAvailablePlan` (`:51`) is only "not removed" — pinned at
`packages/code/tests/unit/plan-projection.test.ts:36-53`.

`isExpectedPlanDiscard` is deliberately strict: `removed === true`, `status === "completed"`, and
`retention === "discard"` must all hold (`packages/code/src/adapters/plan-projection.ts:43-48`). This
matches the capability's only automatic deletion path and prevents an orphan tombstone from being
mistaken for policy cleanup.

`planMetaText` (`packages/code/src/core/transcript/presenters.ts:45`) turns the same data into the block's meta line: an expected
discard reports `"C/N completed · History discarded"`; another removed plan reports `"Removed"` when
its status is `completed` and `"Unavailable"` otherwise (`:51`–`:63`). A state word is appended for
an available plan's five known statuses (`:64`–`:70`), and `revision N` when revision exceeds 1
(`:71`). `store.ts` projects the strict predicate into `planDiscarded` alongside `planRemoved`
(`packages/code/src/adapters/store.ts:1198-1218`).

`reduceWorkflowProjection` (`packages/code/src/adapters/workflow-projection.ts:71`):

| Event | Behaviour | Line |
|---|---|---|
| `workflow_title_updated` with `current === null` | return `null` — a metadata event must not invent a live tree | `:80` |
| `workflow_title_updated` otherwise | update the named node's title, preserving its lifecycle | `:81`–`:87` |
| `run_ended` with `current === null` or no root node | return `current` | `:90`, `:92` |
| `run_ended` otherwise | close the root: `completed → ok`, `cancelled → cancelled`, else `error` | `:96`–`:98` |
| `workflow_run_started` | seed the manager root from `parent_run_id` if absent (`:103`), add the leader with round/pass/item/replica context | `:114`–`:128` |
| `workflow_run_progress` | fold `iterations`, `input_tokens`, `output_tokens` onto the leader, keeping it running | `:129`–`:142` |
| `workflow_run_completed` / `_failed` | close the leader (`ok` / `cancelled` / `error`), carrying `error` and `reason` for a failure | `:143`–`:163` |

Pinned across `tests/unit/workflow-projection.test.ts` — root seeding at `:30`, cancellation
preservation at `:102` and `:164`, the no-invented-tree rule at `:146`, and the ignore-early-`run_ended`
rule at `:170`.

`WorkflowNodeActivity` (`packages/code/src/adapters/workflow-projection.ts:7`–`:28`) carries, beyond status and token counts,
the context fields that place one node in the larger workflow tree: `roundId`, `pass`, `itemIndex`,
`replica`, `replicaCount` (populated by `workflow_run_started`, above), plus `error` and `reason` on a
closed, non-`ok` leader. The type's own doc comment (`:30`–`:36`) states one reducer feeds three
surfaces — the dedicated Workflow view, the header chip, and the sidebar — carrying "structure and
status only, never content".

`workflowLeaderCounts(activity)` (`:170`–`:181`) counts the leaders under a workflow tree and how many
of them are still `running`, for the header chip.

### 4.13 Markdown export

`renderTranscriptMarkdownChunks` (`packages/code/src/views/transcript-markdown.ts:14`) is a generator, so export memory is
proportional to the largest node rather than the session (`:11`–`:13`). Per kind: `user` →
`## You`, `assistant` → `## Assistant`, `reasoning` → a `>` blockquote with every newline re-prefixed,
`tool_call` → `` - `label(signature)` — status `` plus its guard review label when present and a
fenced `Bounded arguments` projection when arguments exist, `run` → `_(reason)_` followed by `---`.
The projection uses the same bounded, renderer-safe display path as live rendering and labels shortening;
it never serializes the unbounded raw envelope. Every other kind yields nothing. The tool line uses
`toolLabel` (not `toolDisplayLabel`) and prefers the resident `node.signature`. Pinned at
`packages/code/tests/unit/transcript-markdown.test.ts:9`.

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
(`packages/code/src/views/spinner.ts:15`). `useSpinnerClock(active, clock)` starts a `TICK_MS = 200` interval only while
`active()` is true and tears it down on cleanup (`:67`–`:75`); the frame counter wraps at
`FRAME_CAP = 1_000_000` (`:13`, `:73`). `tickNow()` reads the frame signal purely for its dependency
and returns `Date.now()` (`:55`), which is how a running tool's elapsed chip re-renders
(`packages/code/src/views/blocks.tsx:327`). `charForFrame` and `thinkingDots` index with a double-modulo so a negative index
still resolves (`:35`, `:46`).

### 4.15 `core/run-status.ts` — framework-free status lines

Three builders return a `StatusLine` (a `readonly StatusSegment[]`, each segment a literal string or a
`{ mark: StatusMark }` glyph placeholder, `packages/code/src/core/run-status.ts:5`–`:11`), which `plainStatusLine` (`:14`)
turns into the historical headless Unicode string and `@clarvis/code`'s presentation layer turns into
the themed one (`features/run/status-presenter.ts`, outside this document's scope, wraps all three).

`memoryNoticeStatus(notice)` (`:25`–`:45`) has five distinct phases with distinct text: `started` →
`"memory: learning…"`; `queued` → `"memory: queued"`; `blocked` → `"memory: blocked"` plus an optional
`" (note)"` suffix; `failed` → `"memory index failed — run not learned"` plus an optional
`" (indexer_run_id)"` suffix; and, past all four phase checks, `notice.skipped` → `"memory: nothing to
record"`, else `"+N -M"` from `written`/`deleted` counts or `"memory: nothing new"` when both are zero.
A code comment at `:37`–`:39` states why the last three are kept apart: "'the pass declined to run' and
'the pass ran and judged there was nothing durable here' are different outcomes and used to read
identically. So did 'the learning died', until the failed branch above started naming its run."

`progressStatus(progress)` (`:48`–`:53`) special-cases a `run_ended` event whose `reason` is set and is
not `"completed"`: it renders `"ended — <reason with underscores replaced by spaces>"` instead of the
progress label. Otherwise it renders `progress.label`, falling back to `"iteration <n>"`.

`liveRunStatus(input)` (`:64`–`:72`) builds the footer line from up to three optional segments — the
status string, an elapsed-time segment via `formatElapsed` when `startedAt` is set, and a token-usage
segment (`"<input>→<output> tok"`) when `usage` is set — joining every segment after the first with a
`"  · "` separator built from `StatusMark`s rather than a literal.

Test `tests/unit/run-status.test.ts` (174 lines) pins all three, through the themed wrapper
`features/run/status-presenter.ts` that composes `presentStatusLine` over each builder.

### 4.16 `core/attention.ts` — terminal focus and notification cues

`createAttention(renderer)` (`packages/code/src/core/attention.ts:37`–`:58`) tracks a local `focused` boolean from the
renderer's `"focus"`/`"blur"` events (`:38`–`:44`). `notify(message, title = "clarvis")` (`:46`–`:49`)
is a no-op unless `renderer.capabilities?.notifications === true`. `setTitle(state)` (`:50`–`:53`)
is a no-op when the renderer reports no `capabilities` at all, and otherwise sets the terminal title to
`"clarvis — <state>"` when `state` is set, else the bare `"clarvis"`. `away()` (`:54`–`:56`) returns
`true` — meaning the terminal itself decides whether a settle notification carries signal — whenever
`focus_tracking` is not exactly `true`, and otherwise returns the negation of the tracked `focused`
flag. Test `tests/unit/attention.test.ts` (81 lines).

### 4.17 `core/format-elapsed.ts` and `views/Prose.tsx`

`formatElapsed(ms)` (`packages/code/src/core/format-elapsed.ts:8`–`:13`) clamps a negative duration to `0`, renders
`"<seconds>s"` under a minute, and above a minute renders `"<minutes>m<seconds>s"` with the seconds
component zero-padded to two digits.

`Prose` (`packages/code/src/views/Prose.tsx:9`–`:23`) is the `<markdown>` configuration shared by the plan overlay and the
memory wiki reader. Its `block` prop switches the layout: unset, the markdown flex-grows to fill the
remaining row (the plan overlay's rail idiom); `true` sizes it to its content instead, because a
flex-grown markdown collapses inside a scrollbox (`:4`–`:8`, `:15`–`:19`). `stripDocChrome(content)`
(`:25`–`:37`) strips a leading YAML frontmatter block via the `FRONTMATTER` regex and drops any line
matching the `<!-- reindex:begin/end -->` marker regex, while leaving the navigation links inside that
managed block untouched (`:28`–`:30`).

### 4.18 `presenters.ts`'s notice/toast formatters

Eight of the barrel's exports (section 2.1) carry real formatting rules beyond their bare signatures.
`compactionNoticeText(operation, freedChars, opts)` (`packages/code/src/core/transcript/presenters.ts:71`–`:84`) rounds `freedChars` to
the nearest thousand for its `−Nk chars` segment and appends a user-contribution count when
`opts.userContributionCount` is set. `compactionSkippedNoticeText(reason)` (`:87`–`:89`) reports an
explicit compaction request that could not be applied, replacing the reason's underscores with spaces.
`visionNoticeText(model, imageCount, status)` (`:97`–`:105`) names the model rather than an agent
because the vision pre-pass is one completion with no run-tree child a reader could go looking for.
`softLimitNoticeText` (`:109`–`:115`) is a plain `used/limit → outcome` line.

`steerNoticeText` (`:119`–`:121`), `steerQueuedNoticeText` (`:135`–`:137`) and
`steerUndeliveredNoticeText` (`:148`–`:150`) all quote the steer message through the internal
`steerPreview` helper (`:124`–`:132`), which normalizes whitespace and truncates to 160 characters.
`steerUndeliveredNoticeText` exists to correct a specific defect, stated in its own TSDoc remark
(`:142`–`:146`): "The queued notice is written optimistically on acceptance and only promoted by a
later `steering_applied`. A run that completes, fails or is cancelled in between leaves nothing to
promote it, so the node has to be settled explicitly or it reads 'Steer queued' for the rest of the
session — a message the user is entitled to read as delivered when it never was." `subagentFocusToast`
(`:153`–`:156`) is a plain `"focused sub-agent: <title>"` string, also used by `toggleSubagent`
(section 4.7).

### 4.19 The sidebar, the plan strip and the roster

`views/Sidebar.tsx` is the persistent chrome column beside the transcript. It holds no run state of
its own — only a scroll handle and a per-mount handle table: everything it paints comes from the two
projections of section 4.12, `PlanActivity` and `WorkflowActivity`, plus `ActivityStore.subagents`.
Its own TSDoc states the scope rule (`packages/code/src/views/Sidebar.tsx:278`): it is a
*summary-only* inspector, and "complete prompts, plans, results and run totals live elsewhere".

**Two mounts, one component.** `TranscriptRegion` mounts `Sidebar` twice from identical props — as a
split column when `layout.secondaryMode()` is `"split"`
(`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`) and inside a scrim-backed
absolute drawer when it is `"drawer"`. `PlanStrip` is mounted instead by `App.tsx`, and only
while no overlay and no elicitation are up, a plan exists, and the secondary surface is **not**
split (`packages/code/src/views/App.tsx:1231`–`:1237`) — so the strip and the sidebar's Plan section
are mutually exclusive by construction. Whether the sidebar has anything to show at all is decided
one level up, by `sidebarHasContent` (`packages/code/src/views/App.tsx:247`), which feeds the layout
controller.

The effective secondary mode also owns roster placement. A split or drawer is the sole detailed
roster surface. When both are closed, the aggregate transcript mounts no replacement roster; `App`'s
clickable compact footer activity strip preserves waiting/running/done/failed counts without
consuming transcript height and composes them after the canonical run/context/usage strip rather
than replacing it. Clicking that strip opens the drawer. Tab cycles agent selection in split or
drawer mode, and clicking any sidebar agent, including a settled summary row, selects that agent's
transcript before opening detail. While both
secondary surfaces are closed, the selection is represented by a single `Viewing A<n> <title> ·
<outcome>` context row. Opening either secondary surface removes that row, so the same identity and
status are never presented in two adjacent regions.

**Frame.** The root box is `props.width?.()` wide or 44 columns
(`packages/code/src/views/Sidebar.tsx:311`), never shrinks, carries a left border whose colour is
`tokens.accent` while `props.focused()` and `tokens.muted` otherwise (`:320`), and sits at
`zIndex={1}` (`:316`). The body is a single scrollbox (`:322`) holding up to three sections — Plan
(`:323`), Parallel work (`:327`), Agents (`:351`) — each introduced by the local `SectionHeader`
(`:117`), which prints a bold accent label and an optional muted meta suffix. When `hasContent()` —
a plan, or at least one leader, or at least one sub-agent (`:305`) — is false, the entire body is
the one line `No run activity to inspect` (`:405`).

**Plan section.** `PlanSummary` (`packages/code/src/views/Sidebar.tsx`, `PlanSummary`) renders a bold
accent title, a lifecycle/progress line in its semantic status colour, the windowed task list, a
distinct `Last result` section, and a footer hint. For an expected discard,
the muted meta is `Completed · C/N completed · history discarded` and the muted footer is
`Plan deleted after success`; only another removed plan gets `Unavailable · plan file
unavailable` plus the red `Restore the plan file or create a replacement` recovery action
(`packages/code/src/views/Sidebar.tsx:128-166,216-230`). `planProgress` otherwise reports
`N task(s) proposed` while `awaiting_approval`, and `C/N completed`. Each task row takes its glyph and colour
from `taskTone` (`packages/code/src/views/blocks.tsx:79`), called from
`packages/code/src/views/Sidebar.tsx` — except the current one, which is drawn with the accent
chevron and selection background instead — but only while the plan is neither removed nor terminal.
Every row also prints a lifecycle label (`Done`, `Running`, `Failed`, `Skipped`, `Returned`, `Next`,
or `Recorded`), so task state never depends on colour alone. The
source states the defect that rule fixes in its one surviving line comment (`:179`–`:181`): "A
completed plan has no active task. Retaining the chevron on its final task made a finished plan look
like it was still executing." A task's `assignee` is appended to its title when present
(`:192`–`:196`), the `Exit: …` condition is shown for the active task alone (`:198`–`:202`),
`lastOutcome` scans the task list **backwards** for the newest
`done`/`failed`/`returned`/`abandoned` task and prints its `error`, else `result`, else `reason`,
else its lifecycle word. `Last result` renders only a bounded `activityPreview`; clicking it opens the
unabridged result/error/reason as Markdown in the shared activity-detail modal. The footer is
the styled `Ctrl+P full plan` affordance, replaced by neutral retention confirmation for an expected discard
or by the red restore action for an unexpected removal (`packages/code/src/views/Sidebar.tsx`,
`PlanSummary`). Visual hierarchy is pinned by
`packages/code/tests/integration/sidebar-render.test.tsx`.

**`planTaskWindow` — a bounded slice that always contains the active task.**
`PLAN_SIDEBAR_TASK_LIMIT` is 12 (`packages/code/src/views/Sidebar.tsx:17`). The window centres on
`currentPlanTask(plan)`, falling back to the last task when the plan has no current one
(`:30`–`:31`), then clamps `start` so the window never runs past either end (`:32`–`:36`). It
returns entries carrying their **absolute** index — which is what makes the row ids
`sidebar-plan-<index>` stable — plus `hiddenBefore`/`hiddenAfter`, rendered as `↑ N earlier tasks`
(`:165`–`:169`) and `↓ N later tasks` (`:208`–`:212`), and `currentIndex`. Three separate mechanisms
keep the current row on screen: `followSelection(scrollEl, "sidebar-plan-", currentIndex)` (`:153`,
over `packages/code/src/ui/patterns/list-navigation.ts:180`), a `queueMicrotask` on mount (`:154`),
and the scrollbox's `onSizeChange` (`:173`). The scrollbox itself is height-clamped to 4–16 rows
(`:172`).

**`PlanStrip`.** The compact one-row substitute (`packages/code/src/views/Sidebar.tsx:235`): a
leading accent word — `Plan ` while `isLivePlan`, `Latest plan ` once terminal, `Plan completed ` for
an expected discard, and red `Plan unavailable ` only for another removal (`:254`–`:266`) — then
progress or `history discarded`, then the task/title projection (`:267`–`:278`), then `Ctrl+P` only
while detail exists. A removed row cannot call `onOpen` (`:252`), regardless of whether the removal
was expected.

**Parallel work.** Leaders come straight from the workflow projection: every node with `kind ===
"leader"`, ordered by `startedAt` (`packages/code/src/views/Sidebar.tsx:309`–`:315`). Each row
prints a synthetic `A1`, `A2`, … handle, `cleanTitle(node.title)` — first non-blank line, whitespace
collapsed (`:70`) — and a muted `status · elapsed · N iterations` line, where each of the last two
segments is omitted when it has no value (`:343`–`:345`). The header meta counts the leaders and
singularizes (`:328`–`:332`). The synthetic handles come from `agentId` (`:291`–`:297`), a per-mount
`Map` from native id to `A<n>`: **one counter serves both leaders and sub-agents**, so the numbering
is assignment order within a mounted sidebar, not a run-tree address.

**Agents.** The header meta starts with `subagentProgress(...).label` and appends `· N failed` when
needed. `subagentProgress` counts `done` and `error` as *settled*, `running` separately, `error` as
*failed*, and formats `S/T finished`, appending ` · N running` only while something is running.
The first row is the one-line aggregate target `All transcripts`, with its cursor drawn on the
**negation** of `props.focused()`; clicking it calls `onShowAllAgents`, which `TranscriptRegion`
wires to clearing the selection. Progress belongs to the section header and is not repeated on this
row. Then one row per sub-agent in store order: cursor, handle and `cleanTitle`, followed by one
`status · elapsed` line. A live agent has no second `Activity: working` or waiting line because its
lifecycle already communicates that state. A settled agent adds the bounded `Failed: <summary>` /
`Result: <summary>` outcome, degrading to bare `Failed` / `Completed` when there is no summary; the
selected row may additionally show `Profile <name> · <model>`.
Clicking a settled row with a result opens the latest persisted assistant response for that sub-agent
in the shared Markdown detail modal; clicking a live row retains transcript-focus behavior.

The `focused` prop is worth reading twice. `TranscriptRegion` passes `() => ts.selectedSubagent()
!== null` (`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`), so it means "an
individual agent is selected", and the sidebar uses it in two opposite directions at once: it
accents the panel border while it *removes* the cursor from the `All transcripts` row
(`packages/code/src/views/Sidebar.tsx`, `Sidebar`). The aggregate row is current exactly when no
individual agent is.

**`activityPreview` / `rosterSummary` — one plain line, deliberately.**
`activityPreview` owns Markdown stripping, whitespace collapse and bounded ellipsis; `rosterSummary`
delegates to it for compatibility. An absent input, or one that strips to nothing, yields
`undefined`. Their TSDoc gives the reason
(`:75`–`:82`): the sidebar is "a navigation and status surface, not a second Markdown reader", and
keeping this to one stripped line "prevents a worker's table, code fence, or long final answer from
competing with the transcript where that result can be read in context". `TranscriptRegion` reuses
it at a 92-character limit for the focused-agent context row
(`packages/code/src/views/app/TranscriptRegion.tsx`, `agentOutcome`).

`computeGroupedNodes` receives the live roster status map. A terminal roster status found through
any section node's `subagentId` overrides a stale delegation-card status for headers and active
sorting. The lookup is deliberately not card-only because windowing or an incomplete replay can
retain body nodes without their delegation card; neither case may leave a finished agent labelled
`Running`. Pinned by `packages/code/tests/unit/block-focus.test.ts` and
`packages/code/tests/integration/app-shell-render.test.tsx`.

**Elapsed times are bounded.** `displayElapsed` (`packages/code/src/views/Sidebar.tsx:45`) defers to
`formatElapsed`, but returns the empty string for a negative span or one over
`MAX_DISPLAY_ELAPSED_MS = 7 days` (`:16`, `:48`) — a clock skew or a bogus `startedAt` shows nothing
rather than an absurd duration. A sub-agent row shows elapsed **only while running**
(`:369`–`:370`); a leader row shows it live or frozen at `endedAt` (`:335`–`:336`). Both read
`tickNow()` (section 4.14), which is what re-renders them.

**`contextMeter` is exported, tested, and mounted nowhere.**
(`packages/code/src/views/Sidebar.tsx:58`) It computes `frac` — clamped to 1, and 0 when the window
is 0 — `filled` over `CONTEXT_WIDTH = 16` (`:15`), a three-band colour (`tokens.del` at ≥ 0.9,
`tokens.warn` at ≥ 0.7, else `tokens.add`, `:65`), a rounded `pct`, and a `used/window · pct%` label
built from `compactTokens`, which switches to `k` at a thousand and `M` at a million (`:51`–`:55`).
No module under `packages/code/src` calls it, and the `contextWindow` accessor the component
declares and `TranscriptRegion` supplies (`packages/code/src/views/Sidebar.tsx`, `Sidebar`;
`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`) is never read in the body. Its only
exercise is `packages/code/tests/unit/budget.test.ts:14` and `:98`.

---

## 5. Invariants

Each is stated as a rule, the production site it is about, and the test that pins it.

**INV-260.** `toolIdentity(mcpName, toolName)` resolves to whichever slot holds the name — the
`toolName` slot for a namespaced call, the `mcpName` slot for a builtin, `""` when both are absent.
Production `packages/code/src/adapters/tool-identity.ts:11`. Test
`packages/code/tests/unit/tool-identity.test.ts:10`.

**INV-261.** `toolLabel` renders `server:tool` for a namespaced call and the bare name for a builtin,
never a dangling colon and never a literal `undefined:name` — including the transitional case where a
streaming placeholder knows the tool name but not yet its server. Production
`packages/code/src/adapters/tool-identity.ts:29` (both slots are guarded, `:30`). Tests
`packages/code/tests/unit/tool-identity.test.ts:25` and `:31`.

**INV-262.** `isMutationTool` resolves through the same identity rule as `toolIdentity`, and treats
`write_memory`/`edit_memory`/`delete_memory` as mutations while treating
`read_memory`/`list_memories`/`grep_memories` as non-mutations. Production
`packages/code/src/adapters/tool-identity.ts:75` over the set at `:63`. Tests
`packages/code/tests/unit/tool-identity.test.ts:38` and `:44`. The consequence this protects is the
grouping pass: a memory write must not fold into a run of reads —
`packages/code/tests/unit/tool-groups.test.ts:88`.

**INV-263.** `MUTATION_TOOLS` has an exact, exhaustive membership: `write_file`, `edit_file`,
`multi_edit`, `apply_patch`, `replace`, `move`, `copy`, `mkdir`, `remove`, `write_memory`,
`edit_memory`, `delete_memory`. Because the file half is derived from
`@clarvis/loop`'s registry (`packages/loop/src/runtime/tools/builtin/names.ts:50`), a registry change
alters this set — and must therefore be a visible diff to the pinning test. Production
`packages/code/src/adapters/tool-identity.ts:63`. Test
`packages/code/tests/unit/tool-identity.test.ts:53`.

**INV-T01.** `sealed.join("") + tail` reconstructs the segmenter's input exactly, for every input
shape and every `min`. Production `packages/code/src/core/transcript/segment.ts:129` (declared at
`:38`). Test `packages/code/tests/unit/segment-markdown.test.ts:25`.

**INV-T02.** Segmentation is prefix-stable at **every** prefix: appending characters never moves,
withdraws or rewrites a cut already taken. Production
`packages/code/src/core/transcript/segment.ts:129`, enforced by the terminated-blank-line condition at
`:154`. Test `packages/code/tests/unit/segment-markdown.test.ts:92` (character-by-character, not a
stride) and `:82`.

**INV-T03.** A cut never lands inside a fenced or indented code block; an unterminated fence simply
means no further cut is available and the whole remainder stays in `tail`. Production
`packages/code/src/core/transcript/segment.ts:143`, `:156`, `:95`. Tests
`packages/code/tests/unit/segment-markdown.test.ts:49`, `:59`, `:76`, `:123`, `:146`.

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
Production `packages/code/src/core/transcript/segment.ts:265`, `:275`, `:243`. Tests
`packages/code/tests/unit/segment-markdown.test.ts:215`, `:231`, `:242`.

**INV-T06.** A tool node's `args`, `result`, `diff` and `error` reach a renderer only through
`projectTranscriptToolDisplay`; each independent string is capped at 64 KiB and the persisted node is
left complete. Production `packages/code/src/core/transcript/tool-display.ts:200`, called at
`packages/code/src/views/blocks.tsx:263`. Test
`packages/code/tests/unit/tool-display.test.ts:30` (asserts `node.result` is untouched).

**INV-T07.** Argument projection never invokes an accessor: every value is read through
`Object.getOwnPropertyDescriptor` and a non-data descriptor becomes the literal
`"[accessor omitted]"`. Production
`packages/code/src/core/transcript/tool-display.ts:118` and `:140`. Test
`packages/code/tests/unit/tool-display.test.ts:64` (asserts zero getter invocations).

**INV-T08.** The cycle guard tracks the current **path**, not every object visited: a value shared by
two keys is projected twice and does not raise the "display shortened" banner, while a genuine cycle
is still caught. Production `packages/code/src/core/transcript/tool-display.ts:104`, `:125`, `:147`.
Tests `packages/code/tests/unit/tool-display.test.ts:94` and `:109`.

**INV-T09.** The projection is memoised per node by the identities of `args`, `result`, `diff` and
`error`, so transcript paging and block rendering share one computation. Production
`packages/code/src/core/transcript/tool-display.ts:204`–`:213`, `:239`. Test
`packages/code/tests/unit/tool-display.test.ts:39` (`toBe` on a repeated call).

**INV-T10.** One mounted transcript page can never exceed 400 semantic nodes, a render cost of 900,
or 512 KiB of semantic text — and a single pathological node cannot defeat any of the three, because
it is admitted and then presentation-clamped rather than excluded. Production
`packages/code/src/views/transcript-window.ts:192`–`:215`. Tests
`packages/code/tests/unit/transcript-window.test.ts:51`, `:70`, `:78`, `:118`; the reactive path at
`packages/code/tests/unit/transcript-window-state.test.ts:47`.

**INV-T11.** The window's own accounting closes on both sides:
`hiddenBlocks + nodes.length + laterBlocks === total`, and the same for turns. Production
`packages/code/src/views/transcript-window.ts:208`–`:220`. Test
`packages/code/tests/unit/transcript-window.test.ts:139`.

**INV-T12.** A short transcript is returned as the **same array**, not a copy. Production
`packages/code/src/views/transcript-window.ts:207`. Test
`packages/code/tests/unit/transcript-window.test.ts:43` (`toBe`).

**INV-T13.** The production turn index rescans only an appended suffix after its first page, and
rebuilds when the source array is replaced, shrinks or has a changed former tail. Production
`packages/code/src/views/transcript-window.ts:109`–`:112`. Tests
`packages/code/tests/unit/transcript-window.test.ts:165` (Proxy-counted key reads) and `:185`.

**INV-T14.** Windowing happens **before** grouping: every node in `grouped().ordered`, every
focusable key and every group `headKey` is inside the mounted window. Production
`packages/code/src/views/transcript-state.ts:165`–`:174`. Test
`packages/code/tests/unit/transcript-window-state.test.ts:57`.

**INV-T15.** `pickDiffNode` deliberately escapes the window: it scans the full node list, so a diff
older than the mounted page is still reachable. Production
`packages/code/src/views/transcript-state.ts:310`–`:316`. Test
`packages/code/tests/unit/transcript-window-state.test.ts:134`.

**INV-T16.** `withRunMarkersLast` returns its input array untouched when no marker moves, and
otherwise emits every node exactly once. Production
`packages/code/src/views/transcript-state.ts:125`, `:129`–`:135`. Tests
`packages/code/tests/unit/run-marker-order.test.ts:19` (`toBe`) and `:50`.

**INV-T17.** `computeGroupedNodes`, `computeToolGroups` and `computeFocusables` read none of `text`,
`result`, `diff`, `args`, `liveOutput`, `dehydrated` — so a streamed token and a dehydrated block are
free for the grouping memos. Production `packages/code/src/views/subagent-sections.ts:52`,
`packages/code/src/views/tool-groups.ts:37`, `packages/code/src/views/block-focus.ts:36`. Tests
`packages/code/tests/unit/transcript-grouping-fields.test.ts:82`, `:91`, with a self-check at `:102`
and a dehydration-equivalence check at `:111`.

**INV-T18.** A mutation tool never folds into a group: each call stays `"solo"` regardless of how
many identical calls are adjacent. Production `packages/code/src/views/tool-groups.ts:42`. Tests
`packages/code/tests/unit/tool-groups.test.ts:71` and `:88`.

**INV-T19.** A group breaks on any of: a non-`tool_call` node, a different `mcpName`, a different
`toolName`, a different `subagentOrder`. Production
`packages/code/src/views/tool-groups.ts:50`–`:56`. Tests
`packages/code/tests/unit/tool-groups.test.ts:37`, `:42`, `:47`, `:52`, `:57`.

**INV-T20.** Only tool calls that are `"solo"` or `"head"` — plus a folded section's single anchor —
are keyboard-focusable. Production `packages/code/src/views/block-focus.ts:43`, `:48`–`:51`. Test
`packages/code/tests/unit/block-focus.test.ts:24`, `:39`.

**INV-T21.** "Expand all" unfolds blocks but does **not** lift a body's ten-line clamp; only an
explicit per-block or per-head `"expanded"` override does. Production
`packages/code/src/views/blocks.tsx:605` (rule stated at `:595`–`:604`). Test
`packages/code/tests/integration/tool-clamp.test.tsx:26`, which mounts every fixture with
`forceExpand={() => true}`, while `:37` still expects the ten-line cap and its `… +N lines` footer.

**INV-T22.** A mutation's chip counts the call's **real** payload, never the 64 KiB display
projection. Production `packages/code/src/views/blocks.tsx:175` (prefers `node.mutation`) and
`packages/code/src/views/tools/registry.tsx:201`–`:203` (`gateStats` prefers `call.mutation`). Test
`packages/code/tests/integration/transcript-region-render.test.tsx:236` (a >64 KiB diff must chip as
`+4000`).

**INV-T23.** A collapsed mutation's stats come from the diff/content the body would render, not from
the tool's one-line result — and for `write_file`/`write_memory` without a real diff, every content
line counts as added. Production `packages/code/src/views/tools/mutation-gate.ts:86`–`:95`. Tests
`packages/code/tests/integration/mutation-gate.test.tsx:129` and
`packages/code/tests/integration/tool-destripe-render.test.tsx:47`.

**INV-T24.** `isOversizeMutation` and the renderers' own `oversize()` agree on every gated identity,
including the synthesized-diff fallback and `apply_patch`'s diff-else-`patch` rule. Production
`packages/code/src/views/tools/mutation-gate.ts:99` against `packages/code/src/views/tools/registry.tsx:184`–`:186`. Tests
`packages/code/tests/integration/mutation-gate.test.tsx:79`, `:86`, `:123`, `:150`.

**INV-T25.** A mutation diff is never clamped to `MAX_BODY_LINES`; it is either rendered through the
bounded display projection or collapsed behind the chip. A lead mutation always takes the rendered
branch regardless of its line count; delegated mutations keep the ordinary gate, and an explicit
user fold still hides either one. Production: `isLeadMutation` in
`packages/code/src/views/tools/mutation-gate.ts`, `BlockView` in
`packages/code/src/views/blocks.tsx`, `toggleOverride` in
`packages/code/src/views/block-focus.ts`, and the mutation renderers pass their diff straight to `<diff>`
(`packages/code/src/views/tools/registry.tsx:420`, `:456`, `:541`, `:589`) and never through `ClampedText`/`ClampedCode`. Test
`packages/code/tests/integration/tool-clamp.test.tsx:94`, whose title states the reason: "clamping
breaks the unified-diff parser", plus the lead/delegated/manual-fold matrix in
`packages/code/tests/integration/tool-mutation-diff.test.tsx`.

**INV-T26.** Being JSON is not being an envelope: a `shell` result is parsed as an envelope only if it
carries at least one of `exit_code`, `stdout`, `stderr`, `signal`, `timed_out`; a monitor payload only
if it carries at least one of its eight keys. Production
`packages/code/src/adapters/tool-parsers.ts:91` and `:380`. Tests
`packages/code/tests/unit/tool-parsers.test.ts:201`, `:211`, `:218`, `:224`, `:229`.

**INV-T27.** A `shell` call that never reached a shell reports its message exactly once, in `stderr`,
and its status word is `failed` rather than `done`. Production
`packages/code/src/adapters/tool-parsers.ts:71` (drops `stdout` when it is the error again) and
`packages/code/src/views/tools/registry.tsx:217`, `:226`–`:229`. Tests
`packages/code/tests/unit/tool-parsers.test.ts:56` and
`packages/code/tests/integration/tool-registry-render.test.tsx:457`.

**INV-T28.** Genuine partial output alongside a *different* error text is preserved on both streams.
Production `packages/code/src/adapters/tool-parsers.ts:71`. Test
`packages/code/tests/unit/tool-parsers.test.ts:64`.

**INV-T29.** Every rendered diff passes through `StableDiff`'s CR normalization before reaching the
OpenTUI renderable. Production `packages/code/src/ui/patterns/stable-syntax.tsx` (`StableDiff`), used
by every mutation and explicit diff branch in `packages/code/src/views/tools/registry.tsx`. Test
`packages/code/tests/integration/tool-diff-render.test.tsx` ("every diff normalizes CRLF and bare CR
before it reaches OpenTUI").

**INV-T30.** A tool node with `inputChars` set renders the composing stand-in **instead of** a
signature, never both, and the stand-in is a constant string that exposes no byte count. Production
`packages/code/src/views/blocks.tsx:151`, `:310`–`:324`. Tests
`packages/code/tests/unit/composing-label.test.ts:4` and `:11`;
`packages/code/tests/integration/tool-destripe-render.test.tsx:96` also pins the separating space
(`"transition_plan_task starting…"`, not `"taskstarting"`).

**INV-T31.** A running tool's live tail shows at most the last 5 lines, truncates rather than wraps,
and disappears the instant the call closes. Production
`packages/code/src/views/blocks.tsx:139`, `:155`–`:160`, `:350`–`:359`. Tests
`packages/code/tests/integration/tool-live-tail-render.test.tsx:29`, `:39`, `:45`.

**INV-T32.** A group `member` stays hidden while the group is collapsed unless it carries `warn` — an
errored member is hidden too. Production `packages/code/src/views/blocks.tsx:625`–`:628`. Test
`packages/code/tests/integration/tool-groups-render.test.tsx:78`.

**INV-T33.** A collapsed group head lists at most 6 member signatures, then a `moreChip`. Each shown
shell signature retains its own guard verdict and answerer; guarded failures remain identifiable even
though their error body stays folded. Production: `packages/code/src/views/blocks.tsx`
(`signatureMembers`, grouped signature render). Test:
`packages/code/tests/integration/tool-groups-render.test.tsx`.

**INV-T34.** A finished tool shows an elapsed chip only at or above `SLOW_TOOL_MS` (2000 ms).
Production `packages/code/src/views/blocks.tsx:129`, `:330`. Tests
`packages/code/tests/integration/tool-destripe-render.test.tsx:83` and `:89`.

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
Production `packages/code/src/core/transcript/presenters.ts:34`–`:35` (documented at `:25`–`:32`).
Test `packages/code/tests/integration/markdown-render-contract.test.tsx:80`.

**INV-T37.** One node's mounted text is bounded at 512 KiB, and the pager's accounting uses the same
ceiling, so the two layers cannot disagree about how much text OpenTUI receives. Production
`packages/code/src/core/transcript/presenters.ts:20`, `:36`–`:39`;
`packages/code/src/views/transcript-window.ts:48`, `:154`. Test
`packages/code/tests/unit/transcript-window.test.ts:81`.

**INV-T38.** A plan projection with an older `revision` for the same plan id is discarded, returning
the current projection by identity. Production
`packages/code/src/adapters/plan-projection.ts:94`. Test
`packages/code/tests/unit/plan-projection.test.ts:218` (`toBe`).

**INV-T39.** A `workflow_title_updated` arriving with no existing tree returns `null` rather than
seeding a manager node that nothing will ever close. Production
`packages/code/src/adapters/workflow-projection.ts:80`. Test
`packages/code/tests/unit/workflow-projection.test.ts:146`.

**INV-T40.** A cancelled workflow node is reported as `cancelled`, never folded into `error` — for
both a leader and the manager root. Production
`packages/code/src/adapters/workflow-projection.ts:97`, `:147`. Tests
`packages/code/tests/unit/workflow-projection.test.ts:102` and `:164`.

**INV-T41.** This document's slice of `src/core/**` (`core/transcript/**`, `core/marks.ts`,
`core/run-status.ts`, `core/attention.ts`, `core/format-elapsed.ts`) complies with the whole-package
`src/core/**` import boundary (INV-243) — full statement owned by
[hosts/code-bootstrap.md](code-bootstrap.md) §5. Production example:
`packages/code/src/core/transcript/presenters.ts:1` imports `../marks.ts` only.

**INV-T42.** This document's slice of `src/adapters/**` (`tool-identity.ts`, `tool-parsers.ts`,
`plan-projection.ts`, `workflow-projection.ts`, `message-content.ts`, `event-span.ts`) complies with
the whole-package `src/adapters/**` import boundary (INV-244) — full statement owned by
[hosts/code-bootstrap.md](code-bootstrap.md) §5. Production example:
`packages/code/src/adapters/tool-identity.ts:1` reaches `@clarvis/kernel/policy`, which is permitted
for this layer.

**INV-T43.** `code`'s `contentToText` is a deliberate duplicate of `@clarvis/capability`'s, kept
apart because `@clarvis/code` may not depend on `@clarvis/capability` even for a type; the drift
check is that each package's own suite asserts the same behavioural cases. Production
`packages/code/src/adapters/message-content.ts:25` (rationale at `:10`–`:24`). Test
`packages/code/tests/unit/message-content.test.ts:15`, a six-case table whose own header states the
same rule from the test side (`:5`–`:14`).

**INV-T44.** The sidebar's plan section mounts a **bounded** slice of the task list that always
contains the current task: at most `PLAN_SIDEBAR_TASK_LIMIT = 12` rows, centred on
`currentPlanTask`, with the remainder reported as `↑ N earlier tasks` / `↓ N later tasks` rather
than mounted. Production `packages/code/src/views/Sidebar.tsx:20` (limit at `:17`, clamp at
`:32`–`:36`, the two counts at `:165` and `:208`). Test
`packages/code/tests/integration/sidebar-render.test.tsx:525`, which asserts both the window's own
shape and that a 50-task plan paints `Task 30` with the first task absent from the frame.

**INV-T45.** The sidebar carries no run totals. A sub-agent's `input`/`output` token counts and the
run's context and usage figures are held by the same `ActivityStore` the sidebar reads
(`packages/code/src/adapters/activity-store.ts:33`–`:34`, `:76`–`:77`) and are rendered by none of
its rows — `contextMeter` exists (`packages/code/src/views/Sidebar.tsx:58`) but no `src` module calls
it. Test `packages/code/tests/integration/sidebar-render.test.tsx:264`, which mounts a store carrying
both and asserts the frame contains neither "context" nor "tokens".

**INV-T46.** A removed plan is neutral retention history iff its last projection says all three of
`removed`, `status: completed`, and `retention: discard`; no weaker combination suppresses the
unavailable/recovery state. Sidebar, compact strip, and transcript block all consume that distinction.
Production: `packages/code/src/adapters/plan-projection.ts:43-48`,
`packages/code/src/adapters/store.ts:1198-1218`, `packages/code/src/views/Sidebar.tsx:128-166,221-280`,
and `packages/code/src/views/blocks.tsx:817-823`. Tests:
`packages/code/tests/unit/plan-projection.test.ts:164-216`,
`packages/code/tests/unit/store-status.test.ts:391-430`,
`packages/code/tests/integration/sidebar-render.test.tsx:489-616`, and
`packages/code/tests/integration/plan-block-render.test.tsx:61-76`.

**INV-T47.** Expanded tool calls never mount a generic `Arguments` label or raw argument JSON.
Projected arguments feed the bounded one-line signature and the identity-specific result renderer;
Markdown export adds the complete bounded, renderer-safe projection plus an explicit shortening marker,
so auditability does not require mounting raw JSON in the live transcript. Production
`packages/code/src/views/blocks.tsx:263-395`, with the only mounted sections after the header at
`:350-395`. Tests `packages/code/tests/integration/tool-destripe-render.test.tsx:112-159` cover both a
curated shell renderer and the generic fallback, asserting useful output and signatures remain while
JSON key/value presentation is absent.

**INV-T48.** The detailed agent roster has exactly one responsive owner. In `split` and `drawer`
modes it is the `Sidebar`; a closed secondary surface mounts no aggregate roster in the transcript,
but the footer retains lifecycle counts beside canonical run/context/usage state and opens the
drawer on click. An individually focused agent mounts only one compact context row. Tab remains the
keyboard route through the roster in both split and drawer modes, and settled-row activation selects
the transcript before detail. Production:
`packages/code/src/views/app/TranscriptRegion.tsx` (`secondaryMode`, focused-agent context and the two
`Sidebar` mounts), `packages/code/src/views/Sidebar.tsx` (`Agents` section), and
`packages/code/src/views/App.tsx` (`compactActivityStrip`). Tests:
`packages/code/tests/integration/transcript-region-render.test.tsx`,
`packages/code/tests/integration/sidebar-render.test.tsx`, and
`packages/code/tests/integration/app-shell-render.test.tsx`.

**INV-T49.** An empty Lead transcript does not auto-expand parallel workers: every card-backed
sub-agent body starts folded behind its delegation card. In the same no-Lead state, a degraded
cardless section keeps only its first body node visible as the identity anchor and folds later
entries; with Lead context, its whole body folds. Terminal roster status is resolved through any
resident node carrying that sub-agent's id, so a missing card cannot leave the section at `Running`
after completion. Production:
`packages/code/src/views/subagent-sections.ts` (`computeGroupedNodes`, `rosterStatus`,
`emitSection`). Tests: `packages/code/tests/unit/block-focus.test.ts`,
`packages/code/tests/integration/transcript-region-render.test.tsx`, and
`packages/code/tests/integration/app-shell-render.test.tsx`.

**INV-T50.** Settling assistant Markdown never exposes the final OpenTUI tree before its syntax
descendants and one confirming frame are complete. The already painted streaming tree remains the
visible owner during preparation, and at most two Markdown trees exist during the handoff.
Production: `packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`,
`waitForSyntaxFrame`) and `packages/code/src/views/blocks.tsx` (`AssistantMarkdown`). Test:
`packages/code/tests/integration/markdown-render-contract.test.tsx` ("settlement keeps the painted
streaming markdown visible until its final tree is ready").

**INV-T51.** A finalized diff retains the same `DiffRenderable` while unrelated reactive siblings
update, and a newly mounted diff becomes visible only after its syntax-ready frame. Production:
`packages/code/src/ui/patterns/stable-syntax.tsx` (`StableDiff`, `waitForSyntaxFrame`). Test:
`packages/code/tests/integration/tool-diff-render.test.tsx` ("a finalized diff keeps one renderable
while an active sibling updates").

---

## 6. Failure modes and degradation

| Situation | Handling | Cite |
|---|---|---|
| Tool result is not JSON, or is JSON but not the tool's envelope | `parseBash` returns `parsed: false`; `parseMonitor` returns `undefined` and `renderMonitor` falls through to `renderGeneric` | `packages/code/src/adapters/tool-parsers.ts:59`, `:321`; `packages/code/src/views/tools/registry.tsx:605` |
| A `ToolError` payload (`{error, message}`) reaches `parseBash` | `errorText` composes `"code: message"`, or whichever of the two is present, and puts it in `stderr` alone | `packages/code/src/adapters/tool-parsers.ts:101`, `:59`–`:68` |
| `result` and `error` are the same string | `stdout` is dropped so the sentence is printed once | `packages/code/src/adapters/tool-parsers.ts:71` |
| `read_files` output has no `==> path <==` banner | falls back to `renderGeneric` | `packages/code/src/views/tools/registry.tsx:283` |
| `grep_memories` output parses to zero groups | falls back to `renderGeneric` | `packages/code/src/views/tools/registry.tsx:723` |
| `file_stat` / generic result is not a JSON object | `renderJsonCard` falls back to `renderGeneric`; `renderGeneric` itself upgrades to the JSON card only when `parseJsonObject` succeeds | `packages/code/src/views/tools/registry.tsx:676`, `:705` |
| `diff`/`replace` with an empty body | falls back to `renderGeneric` | `packages/code/src/views/tools/registry.tsx:566` |
| Any tool with no registry entry | `renderGeneric` | `packages/code/src/views/tools/registry.tsx:761` |
| Empty result | a muted placeholder — `"(no output)"`, `"(no matches)"`, `"(no monitors)"`, `"(empty)"`, `"(done)"` | `packages/code/src/views/tools/registry.tsx:704`, `:379`, `:607`, `:698`, `:662` |
| A tool call errored | `resolveErrorRenderer` — the tool's own renderer for the four `ERROR_AWARE` tools, plain error text otherwise | `packages/code/src/views/tools/registry.tsx:820` |
| An error body would exceed the clamp | `renderErrorGeneric` honours `full`, so the clamp can be lifted; the code states clamping "truncates the stack trace that explains the failure" | `packages/code/src/views/tools/registry.tsx:798`–`:808` |
| `JSON.stringify` throws while formatting a signature value | caught, falls back to `String(v)` | `packages/code/src/views/tools/signature.ts:69`–`:73` |
| A truncate target is `null`/`undefined` | treated as `""` — "a config field the user has cleared cannot throw out of a render pass" | `packages/code/src/views/truncate.ts:16`, `:7`–`:9` |
| `max <= ellipsis.length` in a truncate | returns a truncated ellipsis rather than throwing | `packages/code/src/views/truncate.ts:19`, `:39` |
| Argument payload needed by a curated renderer exceeds a budget (chars / nodes / depth) | `truncated: true` plus a sentinel in the bounded projection; the block paints `TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE` without mounting raw JSON | `packages/code/src/core/transcript/tool-display.ts:95`, `:113`, `:132`; `packages/code/src/views/blocks.tsx:384-395` |
| Duplicate projected keys after key truncation | disambiguated with `#2`, `#3`, … and flagged `truncated` | `packages/code/src/core/transcript/tool-display.ts:74`–`:77`, `:138` |
| Non-finite number in arguments | projected as `null` | `packages/code/src/core/transcript/tool-display.ts:101` |
| A single node's text exceeds 512 KiB | truncated with `TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE` appended | `packages/code/src/core/transcript/presenters.ts:36`–`:39` |
| A streamed reply outgrows the segmenter's bounds | forced plain, `simplified: true`, with an explanatory line above a settled reply | `packages/code/src/core/transcript/segment.ts:265`, `:275`; `packages/code/src/views/blocks.tsx:431` |
| A tool block's body was dropped by the retention window | `dehydrated` is set; expanding calls `deps.rehydrate` and, if the refill fails, `hydrationNotice` is shown | `packages/code/src/views/blocks.tsx:361-367`; `packages/code/src/views/transcript-state.ts:198` |
| A dehydrated node still needs a header | the resident `signature` and `mutation` fields carry the collapsed header and chip; the type docs state this is "tens of bytes against the tens of kilobytes" | `packages/code/src/core/transcript/types.ts:86`–`:99`; `packages/code/src/views/blocks.tsx:314`, `:177` |
| A stale plan event arrives after a newer one | dropped by the revision guard | `packages/code/src/adapters/plan-projection.ts:94` |
| A plan removal arrives for a plan never seen | an explicit "Plan unavailable / failed / removed" projection is synthesized rather than nothing | `packages/code/src/adapters/plan-projection.ts:97` |
| Retention deletes a completed `discard` plan | projected history stays completed and muted; the UI confirms configured cleanup rather than requesting recovery | `packages/code/src/adapters/plan-projection.ts:43-48`; `packages/code/src/views/Sidebar.tsx:161-166,221-230` |
| A workflow terminal event arrives before any leader seeded the tree | `run_ended` returns `current` unchanged; `workflow_title_updated` returns `null` | `packages/code/src/adapters/workflow-projection.ts:90`, `:80` |
| A workflow progress/terminal event names an unknown leader | a minimal leader node is synthesized in place | `packages/code/src/adapters/workflow-projection.ts:132`, `:152` |
| A sub-agent's section has a body but no `subagent` card | with no Lead context the first body node stays visible as the identity anchor and later entries fold behind it; with Lead context the whole body folds. Live roster status is resolved through any body node carrying `subagentId`; only an absent live status falls back to `"running"` | `packages/code/src/views/subagent-sections.ts` (`rosterStatus`, `emitSection`) |
| A run produced only sub-agent work (no Lead node) | each card-backed body remains folded behind its delegation card; the absence of Lead prose does not expand workers | `packages/code/src/views/subagent-sections.ts` (`emitSection`) |
| The terminal reports no capabilities (headless / test renderer) | every attention cue no-ops; `away()` returns `true` so the terminal decides | `packages/code/src/core/attention.ts:47`, `:51`, `:55` |
| A `RunEvent` type is added without a span mapping | compile-time exhaustiveness error, not a runtime path | `packages/kernel/src/runs/run-event-span.ts:133`–`:136` |

Degradation that is **silent by design**: a tool whose result the parser cannot read still renders
(as generic text), and grouping/focus keep working on a dehydrated node because they read only
`key`/`kind`/`status`/identity (`packages/code/src/core/transcript/types.ts:74`–`:82`, pinned at
`packages/code/tests/unit/transcript-grouping-fields.test.ts:111`).

---

## 7. Coupling

### 7.1 What forces the layering

| Edge | Direction | What forces it |
|---|---|---|
| `views/**` → `core/transcript/**` | runtime | value imports at `packages/code/src/views/blocks.tsx:17`, `packages/code/src/views/transcript-window.ts:2`, `packages/code/src/views/transcript-state.ts:4` |
| `core/transcript/**` → `core/marks.ts` | runtime | `packages/code/src/core/transcript/presenters.ts:1` — the only import in the whole core-transcript tree |
| `core/**` ↛ `solid-js` / `@opentui/*` / `adapters` / `theme` / `ui` / `views` | forbidden | `packages/code/tests/architecture/architecture-boundary.test.ts:72` |
| `adapters/**` ↛ `ui` / `views` | forbidden | `packages/code/tests/architecture/architecture-boundary.test.ts:91` |
| `adapters/tool-identity.ts` → `@clarvis/kernel/policy` | runtime, value | `packages/code/src/adapters/tool-identity.ts:1`; the kernel entrypoint is one of the five sanctioned ones (INV-251) |
| `adapters/event-span.ts` → `@clarvis/kernel/policy` | runtime re-export + type | `packages/code/src/adapters/event-span.ts:1` |
| `adapters/{plan,workflow}-projection.ts` → `@clarvis/protocol` | **type-only** | `packages/code/src/adapters/plan-projection.ts:1`, `packages/code/src/adapters/workflow-projection.ts:1` (`import type`) |
| `adapters/message-content.ts` → `@clarvis/protocol` | **type-only** | `packages/code/src/adapters/message-content.ts:1` |
| `views/**` → `adapters/store.ts` | mostly type-only; one value import | `packages/code/src/views/blocks.tsx:8` (types) and `packages/code/src/views/blocks.tsx:16` (`rawToolArguments`), `packages/code/src/views/transcript-window.ts:1` (`rawToolArguments`) |
| `views/**` → `theme/{tokens,glyphs,tone,syntax,surfaces}` | runtime | `packages/code/src/views/blocks.tsx:3`–`:7`, `packages/code/src/views/tools/registry.tsx:3`–`:5`, `packages/code/src/views/tools/mutation-gate.ts:3`, `packages/code/src/views/truncate.ts:1`, `packages/code/src/views/spinner.ts:2` |
| `theme/glyphs.ts` → `core/marks.ts` | runtime | `packages/code/src/theme/glyphs.ts:2`; the theme wraps the core table in a Solid signal so an ascii toggle re-renders (`packages/code/src/theme/glyphs.ts:16`–`:21`) |
| `views/tools/**` → `adapters/{tool-identity,tool-parsers}` | runtime | `packages/code/src/views/tools/registry.tsx:7`, `:23`; `packages/code/src/views/tools/mutation-gate.ts:1`, `:2`; `packages/code/src/views/tools/signature.ts:1` |
| `adapters/store.ts` → `views/**` | **forbidden** | why `describeToolCall` is injected at the composition root instead of imported (`packages/code/src/adapters/store.ts:274`–`:276`, wired at `packages/code/src/index.tsx:154`) |

### 7.2 The store seam

`adapters/store.ts` is the *producer* of everything this subsystem reads, and belongs to a sibling
document. Four concrete couplings matter here:

1. **Node types.** Views import `TranscriptNode` from `packages/code/src/adapters/store.ts:33`, which re-derives the
   core union with a concrete `PlanTaskActivity[]` for the plan variant.
2. **`rawToolArguments`** (`packages/code/src/adapters/store.ts:58`) unwraps Solid's `$RAW` before the display
   projector sees the arguments, because a store proxy exposes every field as an accessor and the
   projector deliberately refuses accessors (`packages/code/src/adapters/store.ts:48`–`:57`, and INV-T07 above).
3. **`describeToolCall`** (`packages/code/src/adapters/store.ts:278`, implemented at `packages/code/src/index.tsx:154`) is the injection that
   lets the store keep a resident `signature` and `mutation` on each tool node without importing
   `views/`. It is called on `tool_call` close (`packages/code/src/adapters/store.ts:1369`).
4. **`defaultFolded`** (`packages/code/src/adapters/store.ts:1521`, backed by `foldDefaults`) supplies `BlockView`'s and
   `toggleOverride`'s default fold state; it is set on tool close from the call's success
   (`packages/code/src/adapters/store.ts:1380`) and on local shell close (`packages/code/src/adapters/store.ts:888`).

### 7.3 Downstream consumers inside `code`

| Consumer | What it uses |
|---|---|
| `packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion` | `completionBeforeFinalAnswer`, `BlockView`, `earlierLabel`/`laterLabel`, the whole `TranscriptState` |
| `views/overlays/DiffViewer.tsx` | `resolveToolRenderer` with `full`/`wrap` set (`packages/code/src/views/tools/registry.tsx:36`, `:46`) |
| `views/config/McpBrowser.tsx` | `renderToolPreview` (`packages/code/src/views/tools/registry.tsx`, `renderToolPreview`) |
| `packages/code/src/views/ElicitBlock.tsx:13` | `MEASURE_MAX_COLS` |
| `views/Sidebar.tsx`, `views/overlays/PlanOverlay.tsx` | `taskTone` (`packages/code/src/views/blocks.tsx:79`) |
| `packages/code/src/views/app/TranscriptRegion.tsx` | `Sidebar` (the split column and drawer mounts), plus `rosterSummary` for the closed-surface focused-agent context row |
| `packages/code/src/views/App.tsx:1237` | `PlanStrip`, mounted only when the secondary surface is not split (`:1231`–`:1234`) |
| `packages/code/src/index.tsx:154` | `formatToolCall` + `mutationStats` composed into `describeToolCall` |
| `src/run-host.ts`, `src/cli-mode.ts`, `src/features/run/status-presenter.ts` | `core/run-status.ts`'s `plainStatusLine`/`memoryNoticeStatus`/`progressStatus`/`liveRunStatus` |

### 7.4 Delegated

- The **events themselves** and their reduction into nodes — [hosts/kernel-runs.md](kernel-runs.md) and
  [hosts/code-run-host.md](code-run-host.md).
- **Theme tokens, glyph table policy and ascii mode** — [hosts/code-theme.md](code-theme.md). This document touches
  `core/marks.ts` only as the framework-free source the theme wraps.
- **Input handling, overlays, the diff viewer and slash commands** —
  [hosts/code-input-and-overlays.md](code-input-and-overlays.md).
- **Plan document semantics** (revisions, CAS triple, retention) — the plan capability documents. Only
  the *UI projection* of plan events is in scope here.

---

## 8. Open questions

**Constants without stated derivation.** Several tuning numbers carry no measurement or reason in
source or test: `MAX_BODY_LINES = 10` (`packages/code/src/views/tools/registry.tsx:100`), `MUTATION_GATE_LINES = 40`
(`packages/code/src/views/tools/mutation-gate.ts:17`), `MEASURE_MAX_COLS = 110` (`packages/code/src/views/blocks.tsx:54`), `MAX_GROUP_SIGNATURES = 6`
(`packages/code/src/views/blocks.tsx:118`), `LIVE_TAIL_LINES = 5` (`packages/code/src/views/blocks.tsx:139`), `SLOW_TOOL_MS = 2000` (`packages/code/src/views/blocks.tsx:129`),
`MIN_GROUP = 2` (`packages/code/src/views/tool-groups.ts:14`), and all four `WINDOW_*` budgets
(`packages/code/src/views/transcript-window.ts:31`–`:48`). `packages/code/src/views/transcript-window.ts:129`–`:132` says the per-kind render costs "err
high for tools" but gives no measurement. By contrast, `segment.ts` does state numbers — ~50 ms per
flush at 60 KB against a 33 ms frame (`packages/code/src/views/blocks.tsx:415`–`:429`), and
~0.5 ms plain versus ~50 ms parsed (`packages/code/src/core/transcript/segment.ts:11`–`:21`) — so the absence elsewhere is an absence,
not a convention.

**The `collapsed` fixture-fallback claim is overstated.** Both `packages/code/src/views/blocks.tsx:555`–`:561` and
`packages/code/src/views/block-focus.ts:66`–`:71` state that "`showcase.test.ts` guards that a real store-derived node never
carries" a `collapsed` field. The only occurrence in that file is
`packages/code/tests/component/showcase.test.ts:528`, a single assertion about one `subagent` node in
one error scenario. It is not a general guard, so the production fallbacks at `packages/code/src/views/blocks.tsx:579` and
`packages/code/src/views/block-focus.ts:93` are protected by a comment rather than by a test.

~~**`hiddenBodyLines` does not special-case `monitor_list`.**~~ **Resolved:** it does now.
`monitor_list` joins the other three in the branch, which returns `m.monitors.length` on an `isList`
payload and `lines(m.output)` otherwise (`packages/code/src/views/tools/registry.tsx:783`–`:791`) —
so a collapsed list reports one hidden row per monitor, which is exactly what `renderMonitor`'s
`isList` branch paints (`:594`–`:606`, routed at `:738`). It was a missing special case rather than a
choice between two readings: the tool's handler returns `JSON.stringify({ monitors })` with no
indentation (`packages/tools/src/tools/monitor.ts:512`), so the generic `lines(result)` always
answered exactly `1` whatever the list size, and `lines(m.output)` — the reading the three
single-monitor tools use — would always have answered `0`, since `MonitorParsed.output` is hard-coded
to `""` for `isList: true` (`packages/code/src/adapters/tool-parsers.ts:330`–`:341`). An empty list
now reports `0` rather than `1`: there is nothing behind the `(no monitors)` placeholder to reveal.
Pinned at `packages/code/tests/integration/tool-registry-render.test.tsx:264`–`:277`.

~~**Diff CR normalization was unpinned.**~~ **Resolved:** `StableDiff` now owns the normalization for
every registry caller, and `packages/code/tests/integration/tool-diff-render.test.tsx` ("every diff
normalizes CRLF and bare CR before it reaches OpenTUI") feeds both line-ending forms through the
real component and inspects the resulting `DiffRenderable`.

**`mark()` has no callers.** `packages/code/src/core/marks.ts:113` exports `mark`, and `packages/code/src/core/marks.ts:119` exports
`glyph` marked `@deprecated` — yet `glyph` (via the theme wrapper at `packages/code/src/theme/glyphs.ts:34`) is what
every rendering site uses. No migration is in progress in the source.

**Symbols exported but used only within their own module.** `railColor` (`packages/code/src/views/blocks.tsx:163`),
`agentGlyph` (`:203`), `capitalize` (`:64` — also used by `views/App.tsx`), `diffHeaderPath`
(`packages/code/src/views/tools/registry.tsx:476`), `segmentMarkdown` (`packages/code/src/core/transcript/segment.ts:129`). Whether these are exported for testing,
for a planned consumer, or by accident is not stated. `knip.json` sets
`ignoreExportsUsedInFile` only for `interface` and `type`, so functions in this position survive Knip
only because test files count as entries.

**`TranscriptMessageNode`'s persistence fields.** `sourceExecutionId`, `sourceTextFingerprint`,
`textTruncated` and `proseReleased` (`packages/code/src/core/transcript/types.ts:33`–`:48`) are declared here but produced and consumed
by the store and the export path. The doc says presenters "must prefer" `proseReleased` over
`textTruncated` (`packages/code/src/core/transcript/types.ts:39`–`:45`), which `packages/code/src/core/transcript/presenters.ts:34` does — but what *writes* either field,
and when, belongs to [hosts/code-run-host.md](code-run-host.md).

**A truncated sentence in `AssistantMarkdown`'s TSDoc.** `packages/code/src/views/blocks.tsx:407`
ends mid-clause — "The sealed prefixes are" — and `:378` begins a new sentence, so one clause of the
rationale is missing from the source. What it was going to say is not recoverable from the code.

**`EventSource`** (`packages/code/src/adapters/event-span.ts:7`) is declared in this document's scope but is a store/run-host
concept; its consumers are outside this document.

**The `subagent` node's `toolCalls`/`inputTokens`/`outputTokens`** (`packages/code/src/core/transcript/types.ts:118`–`:120`) and the
`run` node's equivalents (`packages/code/src/core/transcript/types.ts:107`–`:109`) are never read by any renderer in
`blocks.tsx` — the run block prints only the outcome word and elapsed time (`:821`–`:844`), and the
subagent block prints only its brief (`:751`). Nor does the sidebar render them: it holds the same
figures through `ActivityStore` and paints none of them (INV-T45). A leader row's `N iterations`
(`packages/code/src/views/Sidebar.tsx:344`) is the one counter any of these surfaces prints, and it
comes from the workflow projection rather than from a transcript node. Whether the node fields have
any renderer at all is still not determinable: nothing this document or the sidebar reads consumes them.

**No test covers `renderTranscriptMarkdown`'s omission of `subagent`, `plan`, `annotation` and
`error` nodes.** `packages/code/src/views/transcript-markdown.ts:14`–`:26` silently yields nothing for those four kinds;
`packages/code/tests/unit/transcript-markdown.test.ts:9` exercises only the five kinds that do render. Whether the
omission is intended is not stated.
