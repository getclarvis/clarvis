# Live context, volatile entries, compaction selection and rewrite

> Implemented at `packages/loop/src/runtime/context/**` and
> `packages/kernel/src/runs/compaction-queue.ts`. Every claim below is anchored to a file and line.
> Open questions are collected in the final section.

## 1. Purpose

This subsystem is the mutable message window one agent loop iteration appends to, plus the policy
that decides when and how to shed tokens from it once it grows too large for a model's context
window. It is exposed as a single factory, `createLiveContext`
(`packages/loop/src/runtime/context/live-context.ts:42`), which returns a `LiveContext`
(`packages/loop/src/runtime/context/compaction-contracts.ts:95`) — the object every iteration of
`packages/loop/src/runtime/loop/loop.ts` appends assistant/user/tool turns to, reads
`cacheBreakpoints()` and `messages` from to build the next model call, and periodically asks to
`compact()` or `selectSummarizableSpan()`/`replaceSpanWithSummary()`.

The problem it solves has two parts that are in tension. First, an agent's transcript keeps growing
and a model's context window does not, so something has to decide what to drop, truncate or fold
into a summary, and do so without breaking tool-call/tool-result pairing. Second — and this is the
part the module comments treat as the actual point — a provider's implicit prompt cache serves only
the longest byte-identical prefix of a request, so *how* an entry is mutated is as consequential as
*whether* it is: an append costs nothing, while a rewrite anywhere before the trailing volatile run
recharges every token behind it
(`packages/loop/src/runtime/context/live-entry-store.ts:136-159`, `packages/loop/src/runtime/context/compaction-contracts.ts:172-199`).
The pricing model itself — why appending is free and rewriting is not — is [cross-cutting/prompt-cache.md](../cross-cutting/prompt-cache.md)'s
territory; this document covers the mechanism that is built around that constraint: the durable/
volatile split, the eviction and summarization policies, the pairing-preserving rewrite, and the
`/compact` control-plane path that lets a user or a workspace hook ask for an off-schedule pass.

## 2. Surface

### Exported from the package (via `context-compaction.ts` and `index.ts`)

The facade `packages/loop/src/runtime/context/context-compaction.ts:1-7` re-exports, by identity:

| Export | Kind | Source | Line |
| --- | --- | --- | --- |
| `createLiveContext` | function | `live-context.ts` | `:42` |
| `deriveMaxResultChars` | function | `compaction-policy.ts` | `:59` |
| `derivePreserveRecentTokens` | function | `compaction-policy.ts` | `:89` |
| `DISABLED_COMPACTION` | const | `compaction-policy.ts` | `:6` |
| `SUMMARY_ANCHOR_PREFIX` | const | `compaction-policy.ts` | `:24` |
| `estimateTokensForChars` | function | `compaction-policy.ts` | `:28` |
| `willTruncateToolResult` | function | `compaction-policy.ts` | `:111` |
| `liveMessageChars` | function | `compaction-policy.ts` | `:125` |
| `MAX_TOOL_IMAGE_CHARS`, `MAX_TOOL_IMAGES_PER_RESULT`, `MAX_LIVE_TOOL_IMAGE_CHARS` | const | `compaction-policy.ts` | `:38,41,44` |
| every type in `compaction-contracts.ts` (`CompactionConfig`, `CompactionMode`, `CompactionScope`, `CompactionEvent`, `AppendToolResultOutcome`, `SummarizableSpan`, `LiveContext`, `LiveSeedEntry`) | `export *` | `compaction-contracts.ts` | whole file |

The package's `index.ts` (`packages/loop/src/runtime/context/index.ts:1-4`) additionally re-exports
everything from `llm-compaction.ts`, `compaction-prompt.ts` and `tool-spill.ts` — so
`summarizeContext`, `runCompaction`, `attemptCompaction`, `buildCompactionMessages`,
`applicableContributions`, `CONTRIBUTION_MAX_CHARS`, `CONTRIBUTIONS_BLOCK_MAX_CHARS`,
`compactionOutputTokens`, `CompactionAnchor`, `DEFAULT_COMPACTION_PROMPT`,
`COMPACTION_UPDATE_INSTRUCTION`, and `createToolSpill`/`ToolSpill` are all reachable from the
package's public surface, just not from the narrower `context-compaction.ts` facade.

**Deliberately not exported anywhere** (INV-071, INV-072): `createLiveEntryStore`
(`packages/loop/src/runtime/context/live-entry-store.ts:100`), `createCompactionSelector` (`packages/loop/src/runtime/context/compaction-selection.ts:27`) and
`rebuildDroppingTools` (`packages/loop/src/runtime/context/context-rewrite.ts:28`) — the mutable-store, selection-policy and
rewrite-mechanics internals stay unreachable from outside the package; no package-manifest
export-map entrypoint may match `compaction|live-context|live-entry`
(`packages/loop/tests/architecture/context-compaction-facade.test.ts:28-37`).

### `LiveContext` methods (`packages/loop/src/runtime/context/compaction-contracts.ts:95-288`)

| Method | Signature | Line |
| --- | --- | --- |
| `messages` | `readonly LiveMessage[]` (getter) | `:97` |
| `appendAssistant` | `(content: string, reasoning?: AssistantReasoningPart[]) => void` | `:99` |
| `appendAssistantToolCalls` | `(content, toolCalls: ToolCallRef[], reasoning?) => void` | `:104-108` |
| `appendUser` | `(content: MessageContent) => void` | `:110` |
| `appendNote` | `(content: string) => void` | `:112` |
| `appendRuntimeNote` | `(kind: string, content: string) => void` | `:114` |
| `appendToolMessage` | `(toolCallId, content, opts?) => AppendToolResultOutcome` | `:127-131` |
| `compact` | `(opts?: { mode?: CompactionMode }) => CompactionEvent \| undefined` | `:140` |
| `needsCompaction` | `() => boolean` | `:142` |
| `forceEvictOldest` | `() => CompactionEvent \| undefined` | `:151` |
| `setCanonicalState` | `(content: string) => void` | `:156` |
| `setStableBlock` | `(kind: string, content: string) => void` | `:201` |
| `cacheBreakpoints` | `() => { stable: number; prior: number }` | `:227` |
| `selectSummarizableSpan` | `(opts?: { mode?: CompactionMode }) => SummarizableSpan \| undefined` | `:233` |
| `summaryAnchor` | `() => string \| undefined` | `:243` |
| `replaceSpanWithSummary` | `(indices: number[], summary: string) => CompactionEvent` | `:269` |
| `estimateTokens` | `() => number` | `:274` |
| `observeUsage` | `(inputTokens: number) => void` | `:281` |
| `snapshot` | `() => ContextSnapshotEntry[]` | `:287` |

### `LLMProvider`-facing helpers (`llm-compaction.ts`)

| Symbol | Signature | Line |
| --- | --- | --- |
| `summarizeContext` | `(args: SummarizeContextArgs) => Promise<SummarizeContextResult>` | `:235` |
| `runCompaction` | `(args: RunCompactionArgs) => Promise<CompactionEvent \| undefined>` | `:480` |
| `attemptCompaction` | `(args: RunCompactionArgs & { mode, fallbackOnFailure }) => Promise<CompactionAttempt>` | `:394` |
| `buildCompactionMessages` | `(args) => LiveMessage[]` | `:188` |
| `applicableContributions` | `(contributions) => string[]` | `:131` |
| `compactionOutputTokens` | `(windowTokens: number) => number` | `:277` |
| `renderSpan` | `(span: LiveMessage[]) => string` | `:85` |
| `RunCompactionArgs` (interface) | inputs shared by scheduled and forced attempts | `:307-331` |
| `CompactionAttempt` (type) | `{ kind: "applied", event, appliedContributions } \| { kind: "skipped", reason }` | `:334-343` |
| `SummarizeContextArgs` (interface) | inputs to `summarizeContext` | `:27-56` |
| `SummarizeContextResult` (interface) | `{ text: string; usage: LLMUsage }` | `:59-62` |

### Model-facing surface

This subsystem defines no tool the model calls directly. Its only end-user-triggerable entry point
is the **`/compact`** slash command (`packages/code/src/app/commands.tsx:283-301`), which runs
`deps.onCompactRun(request)` — wired in `packages/code/src/views/App.tsx:689-690` to
`props.run.compact(request)`, the `RunHandle.compact(request?: string): Promise<void>` method
declared on the protocol (`packages/protocol/src/runs.ts:707-712`). The kernel's
`createManagedRunWithRuntime` implements it by pushing onto a `CompactionQueue`
(`packages/kernel/src/runs/managed-run.ts:331-335`, `packages/kernel/src/runs/compaction-queue.ts:14-35`).

The control-plane `RunService` also exposes settled-context operations that do not execute another
agent turn:

| Surface | Shape | Behavior / evidence |
| --- | --- | --- |
| `RunService.compact` | `(execution_id, request?, { mechanical_target_tokens? }?) => Promise<RunCompactionResult>` | queues an active run; for a settled run, either runs guided forced compaction or mechanically fits the persisted `final_context` to the requested model window (`packages/protocol/src/runs.ts:751-756`, `packages/kernel/src/runs/run-service.ts:167-263`) |
| `RunCompactionResult` | `queued`, `compacted { freed_chars, usage }`, or `skipped { reason }` | `packages/protocol/src/runs.ts:173-198` |
| `RunService.context` | `(execution_id, target_window_tokens?) => { estimated_tokens, has_context, high_water_tokens?, requires_compaction? }` | estimates the private persisted snapshot without returning its content (`packages/protocol/src/runs.ts:758-768`, `packages/kernel/src/runs/run-service.ts:264-290`) |

`mechanical_target_tokens` is allowed only for a settled run and must be a positive safe integer.
The fitting path performs no model call and reports zero usage; guided settled compaction reuses the
stored run request/profile and persists the replacement plus any summary usage
(`packages/kernel/src/runs/run-service.ts:172-262`).

### Wire/trace shapes

| Type | Definition | Line |
| --- | --- | --- |
| `CompactionRequest` | `{ request?: string }` | `packages/capability/src/api.ts:61` |
| `CompactionSource` | `{ drain(): CompactionRequest[]; close?(): void }` | `packages/capability/src/api.ts:66` |
| `CompactionContribution` | `{ source: string; text: string }` | `packages/capability/src/api.ts:577` |
| `PreCompactContext` | `{ agent, subagentInstanceId?, estimatedTokens }` | `packages/capability/src/api.ts:556` |
| `CompactionStartedDetail` | live-only pass start `{ agent, subagent_instance_id?, mode }` | `packages/capability/src/trace-kinds.ts` (`CompactionStartedDetail`) |
| `CompactionDetail` (= `CompactionEvent`) | trace payload for a completed pass | `packages/capability/src/trace-kinds.ts:294` |
| `CompactionSkippedDetail` | trace payload for a skipped explicit request | `packages/capability/src/trace-kinds.ts:324` |
| protocol `RunEvent` variant `"compaction_started"` | `Attributed & { type; mode: "scheduled" | "forced" }`, live-only | `packages/protocol/src/runs.ts` (`RunEvent`) |
| protocol `RunEvent` variant `"compaction"` | `Attributed & { type; operation; fallback_reason?; freed_chars?; contribution_count?; requested?; user_contribution_count? }` | `packages/protocol/src/runs.ts` (`RunEvent`) |
| protocol `RunEvent` variant `"compaction_skipped"` | `Attributed & { type; reason }` | `packages/protocol/src/runs.ts:541-549` |

### Settings / environment defaults consumed

Resolved outside this subsystem (in `packages/loop/src/runtime/subagents/subagent-profiles.ts`, a
sibling module — see §7) but shaping every `CompactionConfig` this subsystem receives:

| Env var | Default | Line |
| --- | --- | --- |
| `CLARVIS_DEFAULT_COMPACTION_ENABLED` | `true` | `packages/capability/src/env.ts:101` |
| `CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION` | `0.8` | `:87` |
| `CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION` | `0.5` | `:88` |
| `CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS` | optional (derived per-window when unset) | `:89` |
| `CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS` | optional (derived per-window when unset) | `:90` |
| `CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS` | `128000` | `:63` |
| `CLARVIS_COMPACTION_LLM_TIMEOUT_MS` | `120000` | `packages/capability/src/env.ts` (`envSchema`) |

Per-agent frontmatter override shape, `CompactionConfigInput`
(`packages/capability/src/api.ts:275-282`): `enabled?`, `context_fraction?`, `target_fraction?`,
`max_result_chars?`, `preserve_recent_tokens?`, `prompt?`, `prompt_mode?: "summarize" | "none"`.

## 3. Data and formats

### `CompactionConfig` (`packages/loop/src/runtime/context/compaction-contracts.ts:23-31`)

```
{
  enabled: boolean;
  windowTokens: number;
  fraction: number;            // high-water fraction of windowTokens
  targetFraction: number;      // low-water fraction of windowTokens
  maxResultChars: number;      // per-tool-result truncation cap
  preserveRecentTokens: number;// protected-tail token budget
  llmTimeoutMs?: number;
}
```

`DISABLED_COMPACTION` (`packages/loop/src/runtime/context/compaction-policy.ts:6-14`) is the frozen all-off instance:
`{ enabled: false, windowTokens: 0, fraction: 1, targetFraction: 1, maxResultChars:
Number.MAX_SAFE_INTEGER, preserveRecentTokens: 0, llmTimeoutMs: 120000 }`.

### `LiveEntry` (internal, `packages/loop/src/runtime/context/live-entry-store.ts:8-13`, extends `RewriteEntry` at `packages/loop/src/runtime/context/context-rewrite.ts:6-16`)

```
{
  message: LiveMessage;
  chars: number;
  evictable: boolean;
  canonical: boolean;
  summary: boolean;
  taskId?: string;
  noteKind?: string;
  blockKind?: string;
  superseded?: boolean;
}
```

### `LiveSeedEntry` (`packages/loop/src/runtime/context/compaction-contracts.ts:292`) — `LiveMessage | ContextSnapshotEntry`

A raw `LiveMessage` seeds as non-evictable with no task/note/block attribution
(`packages/loop/src/runtime/context/live-entry-store.ts:116-122`); a `ContextSnapshotEntry` restores its persisted
`evictable`/`canonical`/`summary` flags and `task_id`/`note_kind`/`block_kind`
(`packages/loop/src/runtime/context/live-entry-store.ts:104-115`).

### `ContextSnapshotEntry` — persisted/rehydrated shape (`LiveContext.snapshot()`, `packages/loop/src/runtime/context/live-entry-store.ts:222-237`)

```
{
  message: LiveMessage;
  evictable: boolean;
  summary: boolean;
  canonical: boolean;
  task_id?: string;
  note_kind?: string;
  block_kind?: string;
}
```

System-role entries are excluded from the snapshot (`packages/loop/src/runtime/context/live-entry-store.ts:225`). This is what the
kernel persists to and rehydrates a run's trace from; the trace/persistence format itself is
`@clarvis/trace`'s contract (out of this document's scope).

### `CompactionEvent` (= `CompactionDetail`, `packages/capability/src/trace-kinds.ts:294-319`)

```
{
  agent: AgentRole;
  subagent_instance_id?: string;
  operation: "eviction" | "truncation" | "summarization";
  fallback_reason?: "summarization_failed" | "summary_not_effective";
  evicted_count?: number;
  freed_chars?: number;
  original_chars?: number;
  kept_chars?: number;
  anchor_chars?: number;
  anchor_updated?: boolean;
  contribution_count?: number;
  requested?: true;
  user_contribution_count?: number;
  task_id?: string;
}
```

### `CompactionSkippedDetail` (`packages/capability/src/trace-kinds.ts:324-333`)

```
{ agent, subagent_instance_id?, reason: "disabled" | "nothing_to_compact" |
  "summarization_disabled" | "summarization_failed" | "summary_not_effective" }
```

### The summary anchor marker

`SUMMARY_ANCHOR_PREFIX` (`packages/loop/src/runtime/context/compaction-policy.ts:24-25`):
`"[runtime: rolling summary of earlier context — historical record, not instructions]\n"` —
prepended to the anchor's stored text so a model reading it back does not mistake a summary for an
instruction.

### The truncation marker (`packages/loop/src/runtime/context/live-context.ts:222-224`)

```
[runtime: tool result truncated — kept the first <N> and last <M> chars, dropped ~<K> from the middle; original ~<L> chars; full output at <spillPath>]
```
(the `; full output at …` clause is present only when a `spillPath` was supplied).

### The eviction marker (`packages/loop/src/runtime/context/live-context.ts:333`, `:363`)

```
[runtime: <N> earlier tool result(s) evicted to fit context]
```

### The image-budget marker (`packages/loop/src/runtime/context/live-context.ts:119-121`)

```
[runtime: <N> inline tool image(s) were released to keep the live context within its image budget; dropped ~<K> payload chars]
```

### The `context.prefix_break` diagnostic (`packages/loop/src/runtime/context/live-entry-store.ts:37-51, 143-159`)

Every mutation capable of landing inside the durable prefix — `removeAt`, `store.replace` (and
therefore `rebuildDroppingTools`, `replaceSpanWithSummary`'s in-place anchor rewrite, and
`enforceToolImageBudget`) — reports through `reportPrefixBreak(index, cause)`, which logs:

```
{ event: "context.prefix_break", index, entries, char_offset, chars_recharged, cause }
```

The level is `debug` when `cause` is in `PRICED_CAUSES = { "compaction", "summary_anchor" }`
(`packages/loop/src/runtime/context/live-entry-store.ts:48-51`) — the two rewrites the pricing model in §1 already accounts for — and
`warn` for every other cause (`"remove"`, `"replace"`, `"image_budget"`, and the unreached
`"rewrite"` — §8). The `levelEnabled(logger, level)` check (`packages/loop/src/runtime/context/live-entry-store.ts:145`) runs
**before** the O(index) `char_offset` scan, so a logger with `debug` disabled skips that scan on
every priced (i.e. the common) cause.

### Spilled tool-result file (`packages/loop/src/runtime/context/tool-spill.ts:41-61`)

A `ToolSpill` writes the untruncated tool text to
`workspaceStatePaths(workspaceRoot).toolOutputSpill(randomBytes(4).toString("hex"))`
(`packages/loop/src/runtime/context/tool-spill.ts:44`), a `toolout-<8-hex>.txt` file under the workspace's **state** tree (never the
working tree — `packages/loop/tests/integration/tool-spill.test.ts:47-51` asserts this), and returns the absolute path
POSIX-normalized (`.split(path.sep).join("/")`, `packages/loop/src/runtime/context/tool-spill.ts:48`). On any write failure it logs
`tool.spill_failed` and resolves `undefined` rather than throwing or rejecting (`packages/loop/src/runtime/context/tool-spill.ts:49-59`).

### The built-in prompt strings (`packages/loop/src/runtime/context/compaction-prompt.ts`)

`compaction-prompt.ts` is a dependency-free module holding two exported string constants and
nothing else; its own module doc comment states why it is split out rather than inlined into
`llm-compaction.ts`: "so a multi-kilobyte string does not sit in the middle of the live-context
mechanics, and so a host embedding `@clarvis/loop` can import it and extend rather than replace it"
(`packages/loop/src/runtime/context/compaction-prompt.ts:6-8`).

- **`DEFAULT_COMPACTION_PROMPT`** (`packages/loop/src/runtime/context/compaction-prompt.ts:10-28`) is
  the system-turn text `attemptCompaction` sends the summarizer (`prompt` in the two-message call
  below). It frames the summary as the agent's only remaining record of the transcript ("Your summary
  is the only record of it the agent will ever see again, so anything you leave out is lost for the
  rest of the run"), then lists what to preserve verbatim where short — objective/constraints, decisions
  and the alternatives rejected, file paths/symbols/identifiers/URLs/commands and their exact
  outcomes, error messages and stack frames, expensively-discovered system facts, and what is
  finished/in-progress/outstanding — followed by what to leave out (pretty-printed listings,
  superseded tool output, dead-end exploration) and four output rules: output only the summary (no
  preamble, no sign-off), terse bullets under short headings, never invent or soften a fact, and never
  mention that compaction happened.
- **`COMPACTION_UPDATE_INSTRUCTION`** (`packages/loop/src/runtime/context/compaction-prompt.ts:38-42`)
  is appended after `DEFAULT_COMPACTION_PROMPT` — immediately followed by the prior summary's own
  text — whenever a rolling summary anchor already exists (see `updateBlock` below). Its own doc
  comment states the failure it exists to prevent: "without it the second compaction would silently
  *discard* the first summary rather than absorb it: the anchor is replaced in place, not appended to,
  so the model has to return the whole merged text" (`:34-36`). The instruction text itself tells the
  model it is updating, not writing, a summary; to return the complete merged text rather than a
  delta or a reference to the earlier version; and to let the merged summary grow past the prior
  one's length only when the transcript introduced facts that genuinely must be carried forward.

### The compaction summarizer's two-message call (`packages/loop/src/runtime/context/llm-compaction.ts:188-210`)

```
[
  { role: "system", content: `${prompt}${contributionsBlock}${anchorBlock}${updateBlock}` },
  { role: "user", content: `Transcript to compact:\n\n${renderSpan(span)}` },
]
```
where `contributionsBlock` is the `CONTRIBUTIONS_HEADER` (`packages/loop/src/runtime/context/llm-compaction.ts:110-112`) plus the
selected contribution texts, `anchorBlock` is `\n\n${label}:\n${body}`, and `updateBlock` is
`COMPACTION_UPDATE_INSTRUCTION` plus `"Summary so far:\n${priorSummary}"` when a prior anchor exists.

### `CompactionQueue` (`packages/kernel/src/runs/compaction-queue.ts:14-35`)

An in-memory array of `CompactionRequest`, plus a `closed` flag: `push` appends and returns `true`
while open, `false` once `close()` has been called; `drain()` returns and empties the array;
`undrained()` inspects without consuming.

## 4. Behavior

### 4.1 Construction and seeding (`createLiveContext`, `packages/loop/src/runtime/context/live-context.ts:42-141`)

1. `createLiveEntryStore(seed, scope.logger ?? NOOP_LOGGER)` hydrates the mutable entry array and
   running char total (`packages/loop/src/runtime/context/live-context.ts:47`, `packages/loop/src/runtime/context/live-entry-store.ts:100-124`).
2. A `createCompactionSelector` is built over the store's live `entries`/`totalChars` closures and
   the given `config` (`packages/loop/src/runtime/context/live-context.ts:71-75`).
3. `enforceToolImageBudget()` runs once immediately, before any method is exposed, because a
   continuation may hydrate a snapshot written by an older, unbounded runtime
   (`packages/loop/src/runtime/context/live-context.ts:138-140`).

### 4.2 Appending (`packages/loop/src/runtime/context/live-context.ts:147-244`)

Every `append*` method eventually calls `store.push`/`store.appendDurable`/`store.appendVolatile`.
`appendDurable` (`packages/loop/src/runtime/context/live-entry-store.ts:171-174`) splices the new entry at `durableInsertIndex()` —
one index past the last durable (non-volatile) entry — **not** at the array's end. `durableInsertIndex`
(`packages/loop/src/runtime/context/live-entry-store.ts:131-135`) walks backward from the end while `isVolatile` holds
(`canonical || noteKind !== undefined`), so a durable append always lands ahead of the trailing
volatile run (the canonical block and runtime notes) rather than behind it. This costs nothing to
report (`packages/loop/src/runtime/context/live-entry-store.ts:160-170`): the entries it can displace are exactly the ones spliced out
and re-appended every iteration anyway.

`appendToolMessage` (`packages/loop/src/runtime/context/live-context.ts:208-244`) additionally: checks `willTruncateToolResult`
(config-gated, content-length-gated — `packages/loop/src/runtime/context/compaction-policy.ts:111-113`); if truncating, computes
`headChars = ceil(maxResultChars/2)`, `tailChars = maxResultChars - headChars`, slices head and tail,
and builds the marker (see §3); either way it pushes the tool entry as **evictable**
(`store.push(..., true, taskId)`) and calls `enforceToolImageBudget()` again afterward
(`packages/loop/src/runtime/context/live-context.ts:230,242`).

### 4.3 `enforceToolImageBudget` (`packages/loop/src/runtime/context/live-context.ts:90-136`)

Walks entries newest-to-oldest; for each tool message carrying `images`, keeps images until
`MAX_TOOL_IMAGES_PER_RESULT` (4) or `MAX_LIVE_TOOL_IMAGE_CHARS` (12,000,000 total remaining) is
exhausted, or a single image exceeds `MAX_TOOL_IMAGE_CHARS` (8,000,000); dropped images are replaced
by the marker text appended to `content`, and the entry's `chars` is recomputed. If any entry changed,
and the **lowest** rewritten index is inside the durable prefix, it reports a `prefix_break` with
cause `"image_budget"` before calling `store.replace(...)`.

### 4.4 `setCanonicalState` / `appendRuntimeNote` (`packages/loop/src/runtime/context/live-context.ts:189-206, 246-258`)

Both are **volatile** (`canonical: true` / `noteKind` set): each replaces its single prior instance
by `removeAt` (which reports a `prefix_break` with cause `"remove"` if the removed index was inside
the durable prefix) then `appendVolatile` (which pushes to the array's absolute end, unreported —
`packages/loop/src/runtime/context/live-entry-store.ts:183-186`), then `store.sync()` to refresh the projected `messages` array.

### 4.5 `setStableBlock` (`packages/loop/src/runtime/context/live-context.ts:260-279`, contract at `packages/loop/src/runtime/context/compaction-contracts.ts:157-201`)

Looks up the existing entry with the same `blockKind`. If found and its rendered text equals the
new `content`, it is a no-op down to object identity (`packages/loop/src/runtime/context/live-context.ts:264`). Otherwise the old
entry loses its `blockKind`, becomes `evictable`, and is flagged `superseded`; the **new** block is
appended durable (`appendDurable`, never in place), so the old bytes never move and the whole prefix
ahead of them survives untouched.

### 4.6 `cacheBreakpoints` (`packages/loop/src/runtime/context/compaction-selection.ts:38-48, 111-117`)

`lastStableIndex(from)` scans forward from 0, stopping at the first volatile entry, tracking the
last index that `isStable` (not volatile, not system-role). `stable` is `lastStableIndex(length-1)`.
`prior` walks back from `stable` to the nearest preceding assistant-role entry, then computes
`lastStableIndex(that_index - 1)` — this crosses exactly one tool-call batch of any width, landing on
the position `stable` held one iteration ago.

### 4.7 Selection (`packages/loop/src/runtime/context/compaction-selection.ts:79-108`)

- `evictableCandidates(excludeSummaries, ignoreProtection)`: every entry where `evictable &&
  !(excludeSummaries && summary)`, minus (unless `ignoreProtection`) the `protectedTail` set.
- `protectedTail(indices)` (`:61-77`): walks candidate indices from the newest backward, accumulating
  `chars`, admitting an index while its running `estimateTokensForChars` stays within
  `effectivePreserveTokens()` (= `max(0, min(config.preserveRecentTokens, floor(lowWaterTokens()*0.5)))`),
  skipping `superseded` entries — a superseded stable block never spends the tail reserve.
- `selectOldestEvictable(excludeSummaries, mode)` (`:91-108`): if `!config.enabled` returns `[]`; in
  `"forced"` mode returns every unprotected candidate; in `"scheduled"` mode returns nothing if the
  estimate is already `<= highWaterTokens()`, else picks oldest-first candidates until the running
  estimate would drop to `<= lowWaterTokens()`.

### 4.8 Mechanical eviction — `LiveContext.compact` (`packages/loop/src/runtime/context/live-context.ts:329-340`)

Calls `selector.selectOldestEvictable(false, mode)`; if nonempty, builds the eviction marker and
calls `rewriteDroppingTools(new Set(drop), { content: marker, evictable: true, summary: false })`,
which delegates to `rebuildDroppingTools` (§4.11) and reports a `CompactionEvent` with
`operation: "eviction"`.

### 4.9 `forceEvictOldest` (`packages/loop/src/runtime/context/live-context.ts:346-370`)

Ignores `preserveRecentTokens` protection (`evictableCandidates(false, true)`), additionally
excludes any non-summary user-role entry, then drops oldest-first until the running total is
`<= targetChars` — `lowWaterTokens()*2` when `windowTokens > 0`, else `+Infinity` (drop everything
eligible). Returns `undefined` immediately if `!config.enabled`.

This method's sole production caller is the mid-call overflow-recovery loop in
`packages/loop/src/runtime/loop/model-call.ts`, not the per-iteration compaction thunk — see
§4.16.

### 4.10 Summarization — `replaceSpanWithSummary` (`packages/loop/src/runtime/context/live-context.ts:297-327`)

If no anchor entry exists yet: builds `content = SUMMARY_ANCHOR_PREFIX + summary`, calls
`rewriteDroppingTools(drop, { content, evictable: false, summary: true })` — the new anchor is
**inserted** at the oldest dropped position (never appended past the volatile tail — see §4.11) —
and reports `anchor_updated: false`. If an anchor already exists: the existing entry's `message`/
`chars` are rewritten **in place**, `reportPrefixBreak` fires with cause `"summary_anchor"` if that
index was inside the durable prefix, then `rewriteDroppingTools(drop)` (no insert — the span is
simply removed) rebuilds the total, and `anchor_updated: true` is reported.

### 4.11 `rebuildDroppingTools` (`packages/loop/src/runtime/context/context-rewrite.ts:28-124`)

1. For every dropped tool-result index, finds its **owning assistant** (the nearest preceding
   assistant entry whose `tool_calls` contains that `tool_call_id`) and records which call ids to
   strip from it (`:34-59`).
2. Walks entries in order, skipping dropped indices; at the **oldest** dropped index (if an `insert`
   was given and none has been inserted yet), splices in the replacement entry there (`:67-78`).
3. For an assistant entry that lost some of its `tool_calls`, rebuilds it with the remaining calls;
   if it lost **all** calls and has no prose, the whole entry is dropped (`:89-93`); otherwise a new
   assistant message is built with the surviving calls (or none) and original reasoning.
4. After the main pass, if an insert happened, the inserted entry is bubbled forward past any
   immediately-following `tool`-role entries so it never sits ahead of a tool result that still
   answers an earlier assistant turn (`:113-121`).
5. Calls `args.replace(next)` (bound to `store.replace(next, "compaction")` by `packages/loop/src/runtime/context/live-context.ts:68`)
   and returns the total `chars` freed.

### 4.12 `store.replace` (`packages/loop/src/runtime/context/live-entry-store.ts:204-220`)

Compares the new array against the old, entry-by-identity, up to
`min(durableInsertIndex(), next.length)`; the first differing index (or `next.length` itself if the
new array is shorter than the durable boundary) is reported as a `prefix_break` with the given
`cause` (default `"replace"`) **before** the array is actually swapped in.

### 4.13 The `/compact` control path

| Step | Function | File:line |
| --- | --- | --- |
| User types `/compact [request]` | `run.compact` action | `packages/code/src/app/commands.tsx:283-301` |
| TUI calls the run handle | `onCompactRun` → `props.run.compact` | `packages/code/src/views/App.tsx:689-690` |
| Kernel pushes onto the queue | `RunHandle.compact` | `packages/kernel/src/runs/managed-run.ts:331-335` |
| Queue accepts/rejects | `CompactionQueue.push` | `packages/kernel/src/runs/compaction-queue.ts:18-22` |
| Loop drains at iteration preamble | `buildCompactionThunk`'s returned thunk | `packages/loop/src/runtime/loop/loop.ts:243` |
| Loop announces real pipeline start | `trace.signal("compaction_started", ...)` | `packages/loop/src/runtime/loop/loop.ts` (`buildCompactionThunk`) |
| Contributions gathered if a request or scheduled need exists | `collectCompactionContributions` | `packages/loop/src/runtime/loop/lifecycle-hooks.ts:315-340` |
| Policy applied | `attemptCompaction`/`runCompaction` | `packages/loop/src/runtime/context/llm-compaction.ts:394,480` |
| Thunk's returned event recorded to trace | `runIterationPreamble` | `packages/loop/src/runtime/loop/loop-iteration.ts:49-50` |
| A truncation event from `appendToolMessage` recorded separately | inline in the tool-dispatch loop, gated by `willTruncateToolResult`/`core.spillToolResult` | `packages/loop/src/runtime/loop/loop.ts:780-795` |

`buildCompactionThunk` (`packages/loop/src/runtime/loop/loop.ts:236-334`) is the orchestration point: it drains
`core.compactionSource` (an optional `CompactionSource`, `packages/loop/src/runtime/loop/loop.ts:118`), determines whether a
scheduled pass is needed via `ctx.needsCompaction()`, and fires `onPreCompact` hooks only if any
hook declares one **and** (a request was made or scheduled compaction is needed). The resulting
pipeline first emits `compaction_started` with `mode: "forced"` or `"scheduled"` through
`TracePort.signal`. That signal is observable before any hook or model wait but is never persisted;
the terminal outcome remains the replay authority. The resulting
hook contributions are folded into **both** branches below identically — the unrequested/scheduled
call to `runCompaction` (`...(contributions.length > 0 ? { contributions } : {})`, `packages/loop/src/runtime/loop/loop.ts:277-281`)
and the forced call to `attemptCompaction` (`[...contributions, ...userContributions]`,
`packages/loop/src/runtime/loop/loop.ts:318`) — so a registered `onPreCompact` hook shapes an ordinary automatic pass exactly as
much as an explicit `/compact` request, whenever a scheduled need independently exists.

If nothing was requested this iteration, the thunk always calls `runCompaction` (mechanical
fallback always allowed). For an explicit request the three skip/fallback branches are distinct,
not one shared rule:

- `!core.compaction.enabled` → `compaction_skipped` reason `"disabled"`, returned **unconditionally**
  — no fallback to mechanical eviction even when `scheduledNeeded` is true (`packages/loop/src/runtime/loop/loop.ts:305-307`).
- the user supplied text but the agent has no `compactionPrompt` → `compaction_skipped` reason
  `"summarization_disabled"`, falling back to `ctx.compact()` **only if** `scheduledNeeded`, else
  `undefined` (`packages/loop/src/runtime/loop/loop.ts:309-312`).
- otherwise, `attemptCompaction` is called in `"forced"` mode with `fallbackOnFailure:
  userContributions.length === 0` — an explicit request carrying user text disables the mechanical
  safety net for that pass, so only an empty forced request (queued with no text of its own) still
  falls back on a summarizer failure (CTX-07). Whichever reason `attemptCompaction` itself produces
  (`nothing_to_compact`/`summarization_failed`/`summary_not_effective`) is recorded skipped and then
  **also** falls back only if `scheduledNeeded` (`packages/loop/src/runtime/loop/loop.ts:331-332`).

### 4.14 `attemptCompaction` (`packages/loop/src/runtime/context/llm-compaction.ts:394-465`)

1. If no `compactionPrompt` at all: mechanical `ctx.compact({ mode })` only.
2. Else `ctx.selectSummarizableSpan({ mode })` — which is `selector.selectOldestEvictable(true,
   mode)` (`packages/loop/src/runtime/context/live-context.ts:286`): **excluding** existing summaries, unlike the plain mechanical
   `ctx.compact()` path (§4.8), which passes `false` and may re-evict an already-evicted marker. If
   no span is found, mechanical fallback (if allowed) or `"nothing_to_compact"`.
3. Else calls `summarizeContext(...)`, charges `args.ledger.consume(usage)` and
   `addUsage(args.usage, usage)` **before** deciding whether to adopt the result — the call is
   billed regardless of adoption (`packages/loop/src/runtime/context/llm-compaction.ts:443-444`, documented at `:363-373`).
   The call sets `reasoningEffort: "off"` for ordinary provider kinds so reasoning cannot consume the
   bounded summary output, but omits the override for `openai-codex` and `xai-grok`: an entitled
   subscription model may publish only reasoning levels such as `low`/`high`, so its own supported
   default is safer than serializing unsupported `none`
   (`packages/loop/src/runtime/context/llm-compaction.ts:219-228, 254-256`).
4. Adoption test: `nextAnchorChars - priorAnchorChars < spanChars && nextAnchorChars <=
   anchorCeilingChars(windowTokens)` (`:440-443`) — growth of the anchor must be smaller than the
   span it absorbs, and the anchor may not exceed `windowTokens` chars. `compactionOutputTokens`'s
   own 1024-token floor (`:278`) can itself exceed a quarter of a very small declared window; the
   two caps are documented as crossing only below roughly a 4096-token window, where the floor is
   already wider than `anchorCeilingChars` — above that the ceiling never binds
   (`anchorCeilingChars` at `:283-304`). If the test passes, `ctx.replaceSpanWithSummary(...)` is
   called and `"applied"` is returned.
5. If the test fails, `reportSummarizerFailure(..., "summary_not_effective")` logs at `warn`, then
   mechanical fallback tagged `fallback_reason: "summary_not_effective"` or
   `{ kind: "skipped", reason: "summary_not_effective" }`.
6. On a throw during `summarizeContext`: if `args.signal?.aborted`, the error is **rethrown**
   (`:459`, so run cancellation is never masked as a compaction failure); otherwise
   `reportSummarizerFailure(..., "summarization_failed", err)` then mechanical fallback tagged
   `fallback_reason: "summarization_failed"` or skip.
7. On the `"applied"` branch, `attemptCompaction` itself stamps `contribution_count` onto the
   returned event, but only when `appliedContributions.length > 0` (`packages/loop/src/runtime/context/llm-compaction.ts:444-452`).
   `user_contribution_count` and `requested: true` are **not** set here — they are stamped
   afterward by `buildCompactionThunk`, and only on the forced/`/compact` path, by filtering
   `outcome.appliedContributions` down to `source === "user"` (`packages/loop/src/runtime/loop/loop.ts:320-328`).

### 4.15 Occupancy estimation (`packages/loop/src/runtime/context/compaction-selection.ts:50-57, 121-126`)

`estimateTokens()` is chars/4 (`estimateTokensForChars`) until `observeUsage(inputTokens)` is ever
called with a finite positive value, after which the selector anchors: subsequent estimates are
`anchorTokens + ceil((currentChars - anchorChars)/4)`, so real provider-reported usage corrects the
naive heuristic's drift and every later estimate tracks it by delta.

### 4.16 Emergency mid-call eviction — a second, independent recovery path

`buildCompactionThunk` (§4.13) runs once per iteration, before the model is called. A separate
mechanism reacts **during** the call itself, when a provider actually refuses a prompt for length.

`callModelWithRecovery` (`packages/loop/src/runtime/loop/model-call.ts:84-132`) is handed, at its one
production call site:

```
evict: () => {
  reachWatch.observeOverflow(ctx.estimateTokens());
  return ctx.forceEvictOldest();
},
rebuild: () => withStreaming(buildModelCall(core, d, retryCtx)),
overflowDiagnostic: (original) =>
  `context does not fit: ${core.agent}'s non-evictable context (~${ctx.estimateTokens()} tokens) ` +
  `exceeds the model context window (${core.compaction.windowTokens} tokens); ` +
  `eviction cannot recover. Provider error: ${original.message}`,
```
(`packages/loop/src/runtime/loop/loop.ts:902-910`).

On a `context_overflow` `ProviderError`, `callModelWithRecovery` calls `evict()` and retries, up to
`MAX_OVERFLOW_RECOVERIES = 3` times per model call (`packages/loop/src/runtime/loop/loop-iteration.ts:7`, `packages/loop/src/runtime/loop/model-call.ts:96-107`),
rebuilding the whole `LLMCallParams` — including a freshly recomputed `cacheBreakpoints()` — via
`rebuild()` on every retry (`packages/loop/src/runtime/loop/model-call.ts:105`). `reachWatch.observeOverflow` and
`ctx.forceEvictOldest()` are co-invoked from that one `evict` closure, over the same
`ctx.estimateTokens()` reading (`packages/loop/src/runtime/loop/loop.ts:902-905`); a successful eviction is traced as an ordinary
`"compaction"` event (`packages/loop/src/runtime/loop/model-call.ts:102-103`).

If `evict()` returns `undefined` — no candidates left, or `!core.compaction.enabled` (§4.9) —
`callModelWithRecovery` throws the synthesized terminal `ProviderError` built from
`overflowDiagnostic` (`packages/loop/src/runtime/loop/model-call.ts:108-115`). Because `forceEvictOldest()` itself returns
`undefined` unconditionally whenever `!config.enabled` (`packages/loop/src/runtime/context/live-context.ts:347`), turning compaction
off removes this last-resort recovery as well as the scheduled/forced passes: a run with compaction
disabled has no mechanism left to survive a mid-call `context_overflow`.

## 5. Invariants

`INV-0xx` ids are the repository-wide ones, owned here; `CTX-xx` ids are local to this document.

**INV-069.** None of the context-compaction modules (`context-compaction.ts`,
`compaction-contracts.ts`, `compaction-policy.ts`, `compaction-selection.ts`, `context-rewrite.ts`,
`live-entry-store.ts`, `live-context.ts`) import an LLM provider module or an agent-spawn module
(matched by path fragments `llm-provider`, `ai-sdk-adapter`, `providers/`, `spawn-subagent`,
`subagent-loop`, `lead-loop`).
Production: the seven files listed keep zero such imports (verified at each file's import
block, e.g. `packages/loop/src/runtime/context/live-context.ts:1-28`, `llm-compaction.ts` is deliberately excluded from this list
because it *does* import `LLMProvider`).
Test: `packages/loop/tests/architecture/context-compaction-boundary.test.ts:23-33`.

**INV-070.** None of those same seven context modules ever reference `TokenLedger`,
`IterationCounter`, or the bare words `ledger`/`counter`.
Test: `packages/loop/tests/architecture/context-compaction-boundary.test.ts:35-39`.
Note: `llm-compaction.ts` *does* reference `TokenLedger` (`packages/loop/src/runtime/context/llm-compaction.ts:8,319,437`) — it is not
one of the seven boundary-checked files, so this invariant does not constrain it; the budget-ledger
threading through `RunCompactionArgs.ledger` is [loop-budgets-clocks-and-guards](budgets-and-guards.md)' territory.

**INV-071.** The `context-compaction.ts` facade re-exports `createLiveContext`,
`deriveMaxResultChars` and `DISABLED_COMPACTION` by identity (`===`), and does **not** expose
`createLiveEntryStore`, `createCompactionSelector`, or `rebuildDroppingTools` through it.
Production: `packages/loop/src/runtime/context/context-compaction.ts:5-7`.
Test: `packages/loop/tests/architecture/context-compaction-facade.test.ts:12-19`.

**INV-072.** The package manifest (`packages/loop/package.json`) adds no export-map entrypoint whose
path matches `compaction|live-context|live-entry` — implementation modules stay unreachable from
outside the package.
Test: `packages/loop/tests/architecture/context-compaction-facade.test.ts:28-37`.

**CTX-01.** A durable append always lands at `durableInsertIndex()`, strictly ahead of
every trailing volatile (`canonical || noteKind !== undefined`) entry — never at the array's
absolute end.
Production: `packages/loop/src/runtime/context/live-entry-store.ts:131-135, 171-174`.
Test: `packages/loop/tests/unit/context-compaction.test.ts:1484-1520` ("volatile entries stay in one
trailing run, so a cached prefix survives").

**CTX-02.** `cacheBreakpoints().stable` never lands on a volatile or system-role entry;
`.prior` exactly crosses one assistant→tool-call batch of any width.
Production: `packages/loop/src/runtime/context/compaction-selection.ts:38-48, 111-117`.
Test: `packages/loop/tests/unit/context-compaction.test.ts:308-377` (`"never anchors on a system-role entry"`,
`"skips the canonical block and the runtime note at the tail"`, `"keeps prior exact across a wide
parallel tool batch"`).

**CTX-03.** `setStableBlock` is a byte-identical no-op, down to object identity, when
re-supplied content equal to the current live block's rendered text; a genuine change always
**appends** a new durable entry and marks the superseded one `evictable`/`superseded`, never
rewriting or removing it.
Production: `packages/loop/src/runtime/context/live-context.ts:260-279`.
Test: `packages/loop/tests/unit/context-compaction.test.ts:417-568` (the whole `LiveContext.setStableBlock` describe block,
in particular `:508-535` "a revision preserves the entire prefix, byte for byte" and `:536-543` "is
a no-op down to object identity").

**CTX-04.** Mechanical eviction and forced eviction never orphan a `tool_call_id`: every
dropped tool result's id is stripped from its owning assistant's `tool_calls`, and an assistant
entry that loses every call and has no remaining prose is dropped entirely rather than left as an
empty turn.
Production: `packages/loop/src/runtime/context/context-rewrite.ts:34-59, 81-109`.
Test: `packages/loop/tests/unit/context-compaction.test.ts:1014-1146` ("pairing-preserving eviction", "pairing after
eviction", "summary replacement preserves assistant↔tool pairing").

**CTX-05.** A summarizer call that never streamed a delta is still charged in full to the
run's ledger/usage accumulator before the caller decides whether to adopt its result; growth of the
rolling anchor, not its absolute size, gates adoption (`nextAnchorChars - priorAnchorChars <
spanChars`).
Production: `packages/loop/src/runtime/context/llm-compaction.ts:437-443`.
Test: `packages/loop/tests/unit/llm-compaction.test.ts:266-310` ("with a compaction prompt:
summarizes the span, folds usage, replaces it with the summary", "does NOT adopt a summary whose
marker+text would not shrink the span").

**CTX-06.** A summary the provider cut off at `maxOutputTokens` (`finishReason ===
"length"`) is always refused, never adopted — because the caller rewrites the single rolling anchor
in place with no other copy of the prior text.
Production: `packages/loop/src/runtime/context/llm-compaction.ts:226-233, 259-261`.
Test: `packages/loop/tests/unit/llm-compaction.test.ts:492-528` ("refuses a summary the provider cut off at the cap, keeping
the old anchor", "adopts a summary that stopped for any other reason").

**CTX-07.** An explicit, user-requested compaction whose summarizer fails is reported
`compaction_skipped`, never silently downgraded to blind mechanical eviction, unless the request
carried no user contribution text.
Production: `packages/loop/src/runtime/loop/loop.ts:303-327` (`fallbackOnFailure: userContributions
.length === 0`).
Test: `packages/loop/tests/unit/llm-compaction.test.ts:360-393` ("keeps the context intact when an
instructed forced summary fails", "keeps the context intact when an instructed forced summary would
not shrink it").

**CTX-08.** A contribution can only ever be *added* to the base compaction prompt, never
replace it — enforced by argument shape (`buildCompactionMessages` takes `prompt` and
`contributions` as separate parameters with no path by which one assigns to the other) and by the
message layout (base prompt always emitted first, whole).
Production: `packages/loop/src/runtime/context/llm-compaction.ts:188-210`; type-level guarantee at `packages/capability/src/api.ts:577-587`.
Test: `packages/loop/tests/unit/compaction-contributions.test.ts:29-49` ("the base prompt is never
replaced").

**CTX-09.** A scheduled summary that falls back to mechanical eviction remains distinguishable from
ordinary policy eviction: its durable `CompactionEvent` carries `fallback_reason` equal to
`"summarization_failed"` or `"summary_not_effective"`. The provider error body remains diagnostic
only.
Production: `packages/loop/src/runtime/context/llm-compaction.ts` (`attemptCompaction`).
Test: `packages/loop/tests/unit/llm-compaction.test.ts` ("falls back to mechanical eviction when the
summary call throws" and "does NOT adopt a summary whose marker+text would not shrink the span").

**CTX-10.** A settled continuation is compacted as a replacement value, never mutated in place.
Guided `/compact <request>` uses the run's original resolved profile and refuses a failed or
non-shrinking instructed summary. Smaller-model fitting performs only pairing-preserving mechanical
eviction until the target model's high-water mark is met; retained entries, including opaque
provider continuation metadata, remain structurally identical. Production:
`compactStoredContext`, `fitStoredContextToWindow`, and `estimateStoredContextTokens` in
`packages/loop/src/runtime/context/stored-context-compaction.ts`; persistence and active/settled
routing at `packages/kernel/src/runs/run-service.ts:167-263`. Test:
`packages/loop/tests/unit/stored-context-compaction.test.ts` and
`packages/kernel/tests/unit/run-service-lifecycle.test.ts:104-140`.

**CTX-11.** A compaction summary call explicitly disables reasoning for ordinary provider kinds, but
never sends Clarvis's `off` effort to `openai-codex` or `xai-grok`. Subscription-backed models use the
provider's supported default because their entitled effort list is authoritative and may not contain
`none`.
Production: `packages/loop/src/runtime/context/llm-compaction.ts:219-228, 254-256`.
Test: `packages/loop/tests/unit/llm-compaction.test.ts:485-502` ("turns reasoning off explicitly rather
than leaving it unset", "uses the supported provider default for subscription compaction").

**CTX-12.** Every requested or watermark-triggered pass emits one live-only `compaction_started`
before pre-compaction hooks or summarizer work, and that start is absent from durable trace entries.
The summary timeout defaults to 120 seconds.
Production: `packages/loop/src/runtime/loop/loop.ts` (`buildCompactionThunk`),
`packages/capability/src/env.ts` (`envSchema`).
Test: `packages/loop/tests/component/lifecycle-observers-wiring.test.ts` ("forces a queued compaction
below the automatic threshold and appends user text after hooks") and
`packages/capability/tests/unit/env.test.ts` (`"applies documented defaults on an empty environment"`).

## 6. Failure modes and degradation

| Condition | Handling | Site |
| --- | --- | --- |
| Summarizer returns empty/whitespace-only text | Throws `Error("compaction summary was empty")` | `packages/loop/src/runtime/context/llm-compaction.ts:255-258` |
| Summarizer's `finishReason === "length"` | Throws `Error("compaction summary was truncated at maxOutputTokens")` | `packages/loop/src/runtime/context/llm-compaction.ts:259-261` |
| Summarizer call throws, run **not** aborted | Logged at `warn` (`compaction.summarizer_failed`), falls back to mechanical eviction tagged `fallback_reason: "summarization_failed"` (scheduled path) or reports `"summarization_failed"` (forced path with no fallback) | `packages/loop/src/runtime/context/llm-compaction.ts` (`attemptCompaction`) |
| Summarizer call throws, run **is** aborted (`signal.aborted`) | Rethrown — never masked as a compaction failure | `packages/loop/src/runtime/context/llm-compaction.ts:459` |
| Adopted summary would not shrink the span, or exceeds the anchor ceiling | `"summary_not_effective"`, same fallback/skip split | `packages/loop/src/runtime/context/llm-compaction.ts:440-457` |
| `onPreCompact` hook throws | Swallowed; logged `hook.pre_compact_failed`; that hook contributes nothing, others still run | `packages/loop/src/runtime/loop/lifecycle-hooks.ts:315-340` |
| A `CompactionContribution.text` is not a string | Silently skipped (never trusted) | `packages/loop/src/runtime/context/llm-compaction.ts:150` |
| Contributions overflow `CONTRIBUTIONS_BLOCK_MAX_CHARS` (12,000) | Lowest-precedence (earliest) contributions dropped first, in reverse-select-then-restore-order | `packages/loop/src/runtime/context/llm-compaction.ts:145-164` |
| A single contribution exceeds `CONTRIBUTION_MAX_CHARS` (4,000) | Clamped (`.slice`), not dropped | `packages/loop/src/runtime/context/llm-compaction.ts:151` |
| Tool-result spill write fails (`writeFile` throws) | Logs `tool.spill_failed` at `warn`, resolves `undefined` — the truncation marker's `full output at …` clause is simply omitted | `packages/loop/src/runtime/context/tool-spill.ts:41-60` |
| A declared `context_window_tokens` is larger than what the provider actually accepts | `compaction.unreachable` warned once per agent loop, from a `context_overflow` observed *below* the high-water mark — a diagnosis only, never a clamp | `packages/loop/src/runtime/loop/compaction-reach.ts:46-70` (adjacent module; consumes `CompactionConfig` from this subsystem) |
| `target_fraction` set equal to (or above) `context_fraction` | Guarded upstream, not here: `resolveSubagentProfiles` clamps `targetFraction` to stay `MIN_COMPACTION_HYSTERESIS` (0.2) below `fraction` | `packages/loop/src/runtime/subagents/subagent-profiles.ts:129-179` (out of this document's module list; see §7) |
| `compact()`/`forceEvictOldest()` find nothing eligible | Returns `undefined`; caller treats as "nothing to do", never an error | `packages/loop/src/runtime/context/live-context.ts:329-331, 346-352` |
| `forceEvictOldest()` returns `undefined` inside the mid-call overflow retry loop (nothing left to evict, or `!core.compaction.enabled`) | `callModelWithRecovery` throws a synthesized terminal `context_overflow` `ProviderError` naming `windowTokens`/`estimateTokens`, rather than retrying further (§4.16) | `packages/loop/src/runtime/loop/model-call.ts:108-115`, `packages/loop/src/runtime/loop/loop.ts:902-910` |
| `/compact` pushed after the run has already settled | `CompactionQueue.push` returns `false` (the queue was `close()`d); `RunHandle.compact` throws `kernelError("not_found", "run '<id>' is no longer active")` rather than silently dropping the request. Two independent producers call `close()`: the run's settlement `finally` block, and the engine's own teardown | `packages/kernel/src/runs/managed-run.ts:317-335`; `packages/loop/src/runtime/loop/run-agent.ts:629-634` |
| `RunService.compact` receives `mechanical_target_tokens` for an active run | `invalid_request`: mechanical context fitting requires a settled run | `packages/kernel/src/runs/run-service.ts:179-185`; transport duplicates the same live-handle guard at `packages/kernel/src/transport/server.ts:570-588` |
| `mechanical_target_tokens` or `target_window_tokens` is not a positive safe integer | `invalid_request`; no context is read or replaced | `packages/kernel/src/runs/run-service.ts:172-178,264-270` |
| Settled run has no `final_context` | `{ status: "skipped", reason: "no_context" }` | `packages/kernel/src/runs/run-service.ts:187-191` |
| Mechanical fitting cannot reach the target high-water mark without dropping protected context | `{ status: "skipped", reason: "cannot_fit" }`; persisted context is unchanged | `packages/loop/src/runtime/context/stored-context-compaction.ts:90-106`, persistence only after a compacted result at `packages/kernel/src/runs/run-service.ts:192-214` |
| `needsCompaction()` on a disabled config | `false` (selector short-circuits on `!config.enabled`) | `packages/loop/src/runtime/context/compaction-selection.ts:95` |
| Continuation hydrates a snapshot from an older, unbounded runtime (oversized inline images) | `enforceToolImageBudget()` runs once at construction, before any method is exposed, to bound it retroactively | `packages/loop/src/runtime/context/live-context.ts:138-140` |

Nothing in this subsystem throws out of a `LiveContext` method under ordinary operation — `compact`,
`forceEvictOldest`, `replaceSpanWithSummary`, `appendToolMessage` etc. are all synchronous and
I/O-free (`packages/loop/src/runtime/context/tool-spill.ts:25-28` notes this explicitly: the port hands `LiveContext` a resolved path,
never the ability to write one, so the context itself cannot fail on I/O).

## 7. Coupling

**Depends on** (imports, `packages/loop/src/runtime/context/live-context.ts:1-28` and siblings):
- `@clarvis/capability` — `LiveMessage`, `MessageContent`, `ToolCallRef`, `ToolResultImage`,
  `AssistantReasoningPart`, `contentToText`, `NOOP_LOGGER`, `Logger`, `levelEnabled`,
  `ContextSnapshotEntry`, `sanitizeErrorMessage`, `LLMProvider`/`LLMUsage`/`ResolvedProviderConfig`
  (only in `llm-compaction.ts`), `TokenAccumulator`, `CompactionContribution`. A type-only or
  structural dependency in every case except `llm-compaction.ts`'s runtime call to `args.llm.call(...)`.
- `@clarvis/paths` — `ensureWorkspaceLocalDir`, `workspaceStatePaths` (`packages/loop/src/runtime/context/tool-spill.ts:6`) — the sole
  filesystem-touching module in this subsystem.
- Sibling modules within `runtime/context/`: `live-context.ts` imports from `compaction-contracts.ts`,
  `compaction-policy.ts`, `compaction-selection.ts`, `context-rewrite.ts`, `live-entry-store.ts` —
  all internal, all type- or value-level, forming a DAG the boundary test enforces has no edge
  reaching outside this subsystem's own concerns (§5, INV-069/070).
- `../budget/budget.ts` (`TokenLedger`) and `../usage.ts` (`addUsage`) — **only** from
  `llm-compaction.ts`, which is explicitly excluded from the INV-070 boundary check. This is the one
  place this subsystem touches budget/ledger machinery, and it does so to *report* usage the summarizer
  call incurred, not to enforce a budget itself — enforcement is [loop-budgets-clocks-and-guards](budgets-and-guards.md)'
  territory.
- `../../error-text.ts` (`errorText`) — only in `llm-compaction.ts`, for rendering a caught error
  safely inside a `catch` block (`packages/loop/src/runtime/context/llm-compaction.ts:352-356`).

**What forces the direction:**
- `context-compaction-boundary.test.ts` fails the build if any of the seven listed files imports a
  provider or spawn module, or references ledger/counter vocabulary — a static grep over each file's
  import lines and full text (`:23-39`).
- `context-compaction-facade.test.ts` fails if the facade's re-exported bindings are not `===` to the
  implementation functions, if the three internal names leak through the facade, or if the package
  manifest gains an export-map entry matching the forbidden path fragments (`:12-37`).

**Depended on by:**
- `packages/loop/src/runtime/loop/loop.ts` — the primary consumer. Imports `LiveContext`,
  `CompactionConfig`, `CompactionEvent` (type-only) and `willTruncateToolResult` from the
  `context-compaction.ts` facade (`packages/loop/src/runtime/loop/loop.ts:16-21`), and `attemptCompaction`/`runCompaction` plus
  `CompactionAnchor` (type-only) from `llm-compaction.ts` directly (`packages/loop/src/runtime/loop/loop.ts:23-24`). This is a
  runtime edge: `d.ctx` (a `LiveContext`) is read and mutated on every iteration
  (`buildModelCall`, `packages/loop/src/runtime/loop/loop.ts:386-437`), and `buildCompactionThunk`'s returned closure is invoked
  from the iteration preamble (`compact: buildCompactionThunk(core, d)` — cited above as the call
  site at `packages/loop/src/runtime/loop/loop.ts:850`).
- `packages/loop/src/runtime/loop/model-call.ts` — `callModelWithRecovery`'s `evict`/`rebuild`
  hooks are `LiveContext.forceEvictOldest()`'s sole production caller and `buildModelCall`'s sole
  reason to be re-invoked mid-call (§4.16); it imports `CompactionEvent` (type-only) to trace what
  an eviction produced (`packages/loop/src/runtime/loop/model-call.ts:9,102-103`).
- `packages/loop/src/runtime/loop/compaction-reach.ts` — imports `CompactionConfig` (type-only) to
  build a per-agent-loop watch over provider `context_overflow` rejections (§6), consulted from the
  same `evict` closure as `forceEvictOldest` (§4.16).
- `packages/loop/src/runtime/subagents/subagent-profiles.ts` and `run-subagent.ts` — build the
  concrete `CompactionConfig` a run's `LiveContext` is constructed with, from `CompactionConfigInput`
  frontmatter and env defaults (`packages/loop/src/runtime/subagents/subagent-profiles.ts:173-190`); import `deriveMaxResultChars`,
  `derivePreserveRecentTokens`, `DISABLED_COMPACTION` from the facade. This assembly logic is outside
  `runtime/context/**` and belongs to whichever document owns agent-profile resolution — referenced
  here only because it is this subsystem's sole config producer.
- `packages/kernel/src/runs/managed-run.ts` — constructs the `CompactionQueue`
  (`createCompactionQueue`, imported from `packages/kernel/src/runs/compaction-queue.ts:14`), exposes
  it as `ManagedRunContext.compaction: CompactionSource` (structurally typed against
  `@clarvis/capability`'s `CompactionSource`), and implements `RunHandle.compact` by pushing onto it.
  This is the kernel's one runtime edge into this subsystem's vocabulary, and it never imports
  `@clarvis/loop`'s context modules directly — only the `CompactionRequest`/`CompactionSource` types
  from `@clarvis/capability` and `@clarvis/loop`'s type re-export (`packages/kernel/src/runs/compaction-queue.ts:1`).
- `packages/code/src/app/commands.tsx` and `packages/code/src/views/App.tsx` — the TUI's `/compact`
  slash command and its wiring to `RunHandle.compact`, reaching this subsystem only through the
  protocol type, never the implementation.

## 8. Open questions

- **Why `MIN_COMPACTION_HYSTERESIS` is exactly `0.2`**, beyond the arithmetic the comment at
  `packages/loop/src/runtime/subagents/subagent-profiles.ts:129-155` walks through (the "roughly one full miss per fifty iterations"
  claim for the *default* 0.8/0.5 pair specifically, at `:137-138`) — no test asserts that specific
  ratio for arbitrary operator-chosen fractions; the floor's own value is a judgment call the code
  states but does not derive from anything measured in this repository's test suite.
- **Whether `rewrite` (`PrefixBreakCause`, `packages/loop/src/runtime/context/live-entry-store.ts:37-38`) has ever fired in production.**
  The type comment says it "has no producer today" and is reserved for "the next in-place message
  mutator" — no call site anywhere in `runtime/context/**` passes `"rewrite"` to
  `reportPrefixBreak`. This is dead vocabulary by the code's own admission, not an inferred
  defect. `"replace"` — the default parameter value of `LiveEntryStore.replace`
  (`packages/loop/src/runtime/context/live-entry-store.ts:204`) — is equally unreached by the same standard: both production call
  sites of `store.replace` bind an explicit cause instead of taking the default
  (`packages/loop/src/runtime/context/live-context.ts:68` binds `"compaction"`, `packages/loop/src/runtime/context/live-context.ts:135` binds `"image_budget"`), and no
  test in scope invokes the default either. Of six `PrefixBreakCause` members, two are
  dead in production.
- **The precise shape of `CompactionAnchor.label`/`.body`** for a real lead vs. a real sub-agent run.
  `packages/loop/src/runtime/loop/run-agent.ts:449` supplies a `staticAnchor` fallback when no `folded.anchor` closure is given, but
  constructing what a lead's or sub-agent's anchor actually contains is orchestration logic in
  `runtime/loop/run-agent.ts` and `runtime/subagents/*`, outside `runtime/context/**`; it is not traced
  further here because it belongs to a different document's scope (loop/subagent orchestration).
  `llm-compaction.ts` only consumes `{ label, body }` as opaque strings (`packages/loop/src/runtime/context/llm-compaction.ts:198`).
- **Whether `attemptCompaction`'s `"scheduled"` and forced `ctx.compact()` fallback paths can ever
  double-count a summarization's usage against the ledger if `runCompaction` itself throws after
  `args.ledger.consume(usage)` but before returning.** No code path in scope exhibits that specific
  sequencing failure (the consume call and the return are not separated by anything that can
  throw in the source), so it is recorded only as a structural observation, not a confirmed
  defect.
- **The exact behavior of `pre_compact` as an *external*-dialect hook event** (its wire shape, the
  `{"kind":"context","text":...}` verdict format mentioned at `packages/capability/src/hooks-config.ts:50-58`,
  and how a foreign-authored hook's output is normalized into a `CompactionContribution`) is the
  [hooks-execution](../execution/hooks.md) document's territory; what is confirmed here is only that `COMPACTION_HOOK_EVENTS = ["pre_compact"]`
  exists (`packages/capability/src/hooks-config.ts:59`) and that `collectCompactionContributions` is this subsystem's
  consuming edge, not the hook dispatch mechanism itself.
- **The ledger/budget arithmetic `TokenLedger.consume` performs** (how `usage` translates into a
  spent/remaining figure, escalation, or budget-exceeded signaling) is explicitly
  [loop-budgets-clocks-and-guards](budgets-and-guards.md)' scope; `../budget/budget.ts` is outside this document's
  scope beyond the confirmed type import.
