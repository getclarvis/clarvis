# What a provider's prefix cache charges for, and how Clarvis keeps it

> Implemented at `packages/loop/src`, `packages/llm/src` and their tests. Every claim below is
> anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

Every non-Anthropic provider Clarvis targets (OpenAI, OpenAI-compatible gateways such as
OpenRouter/DeepSeek) caches on the **longest byte-identical prefix** of a request; Anthropic caches on
explicit `cache_control` breakpoints but still requires the bytes ahead of a breakpoint to match
exactly. Either way, one rule governs cost: appending to a request is free, and mutating position *k*
of a prior request re-bills everything from *k* onward, however small the edit
(`packages/loop/tests/prefix-stability.ts:9-18`). This subsystem is the set of engine rules,
call-shape rules and tests that keep the request Clarvis sends **append-only** for the life of a run,
plus the provider-facing mechanics (session affinity, explicit breakpoints) that ask a provider to
actually serve that prefix back.

The problem is not hypothetical: one measured session paid **2,929,430 tokens — 35.7% of its uncached
input** — to a single 7.4 KB block rewritten in place at 32% of a 140k-token transcript
(`packages/loop/tests/prefix-stability.ts:16-18`; the same figure recurs at
`packages/loop/src/runtime/context/live-entry-store.ts:29-30` and
`packages/loop/src/runtime/loop/iteration-metrics.ts:75-77`). A continuation's own seed block, if
regenerated instead of carried forward, was separately measured at **115,432 tokens** for one boundary
(`packages/loop/src/runtime/entry-seed.ts:116`, pinned at
`packages/loop/tests/unit/entry-seed-markers.test.ts:92-97`).

This document owns: the byte-identical-prefix rule and its cost model; `LiveContext`'s
append/volatile/durable vocabulary as it bears on the cache; the stable request head (system message,
tool array); the no-per-run-identity-in-tool-descriptions rule; sub-agent tail-only growth; reasoning
replay (structural, not textual); the cache key and its session affinity
(`prompt_cache_key`/`session_id`/`x-session-id`); Anthropic breakpoints versus read semantics; and the
pricing harness in `prefix-stability.ts`. It explicitly delegates: compaction's eviction/summarization
mechanics to [engine/context-compaction.md](../engine/context-compaction.md); the AI SDK provider transport in general to
[foundations/llm.md](../foundations/llm.md); how a model's cache mode (`explicit`/`implicit`/`off`) is derived from the
catalog to [hosts/model-catalog.md](../hosts/model-catalog.md); and the memory continuation pass's byte-identical
surfaces to [capabilities/memory-indexer.md](../capabilities/memory-indexer.md).

## 2. Surface

### 2a. `@clarvis/llm` — provider-facing cache mechanics

| Symbol | Signature / shape | File:line |
|---|---|---|
| `withPromptCacheDefaults` | `(inner: LLMProvider, defaults: PromptCacheDefaults) => LLMProvider` | `packages/llm/src/prompt-cache-provider.ts:29` |
| `PromptCacheDefaults` | `{ promptCacheKey: string; promptCacheTtl: PromptCacheTtl }` | `packages/llm/src/prompt-cache-provider.ts:11` |
| `CACHE_MARKER_KEY` | `"__clarvis_cache_control"` | `packages/llm/src/openai-compatible-request.ts:42` |
| `cacheMarkerOptions` | `() => { openaiCompatible: Record<string, boolean> }` | `packages/llm/src/openai-compatible-request.ts:53` |
| `applyCacheControlMarkers` | `(body) => body`, rewrites marked messages into `content` block arrays carrying `cache_control` | `packages/llm/src/openai-compatible-request.ts:112` |
| `openAICompatibleSettings` | builds the `createOpenAICompatible` settings incl. `transformRequestBody` | `packages/llm/src/openai-compatible-request.ts:211` |
| `applyBodyExtras` *(out of scope; owned by [foundations/llm.md](../foundations/llm.md), named here only because `transformRequestBody` composes it ahead of the cache-marker pass — see §4.2 step 8)* | `(body, extras) => body` — merges an operator's configured `body` extras in, dropping forbidden keys and null-deleting others | `packages/llm/src/openai-compatible-request.ts:179-191` |
| `resolveConfiguredHeaders` *(out of scope; owned by [foundations/llm.md](../foundations/llm.md))* | `(headers, lookup) => headers \| undefined`, throwing `ProviderError` on an unresolved `${VAR}` | `packages/llm/src/openai-compatible-request.ts:251-267` |
| `buildRequestOptions` | `(params: LLMCallParams, modelMessages: ModelMessage[]) => { request, diagnostics: RequestDiagnostics }` | `packages/llm/src/ai-sdk/request-options.ts:538` |
| `RequestCacheDiagnostics` | `{ kind?, mode?, marked, requested_breakpoints, applied_breakpoints, walked_back, system_marked, cache_key_sent, session_pinned, ttl? }` | `packages/llm/src/ai-sdk/request-options.ts:87-105` |
| `MAX_MESSAGE_CACHE_BREAKPOINTS` | `2` | `packages/llm/src/ai-sdk/request-options.ts:253` |

### 2b. `@clarvis/loop` — the append-only transcript and its cache-facing operations

| Symbol | Signature | File:line |
|---|---|---|
| `LiveContext.cacheBreakpoints` | `() => { stable: number; prior: number }` | `packages/loop/src/runtime/context/live-context.ts:281` |
| `LiveContext.appendAssistant`/`appendAssistantToolCalls`/`appendToolMessage`/`appendUser`/`appendNote` | append durable entries; never rewrite in place | `packages/loop/src/runtime/context/live-context.ts:147-244` (`appendUser`/`appendNote` at `:185-191`) |
| `LiveContext.setCanonicalState`/`appendRuntimeNote` | replace the one **volatile** entry of that kind; always the trailing run | `packages/loop/src/runtime/context/live-context.ts:189-258` |
| `LiveContext.setStableBlock` | `(kind: string, content: string) => void` — identical content is a no-op down to object identity; otherwise the old entry is marked evictable+superseded and a new durable entry is appended ahead of the volatile tail, never rewritten in place | `packages/loop/src/runtime/context/live-context.ts:260-279` |
| `LiveEntryStore.durablePrefixEnd` | `() => number` — index one past the last durable entry | `packages/loop/src/runtime/context/live-entry-store.ts:80` |
| `LiveEntryStore.reportPrefixBreak` | `(index, cause: PrefixBreakCause) => void` | `packages/loop/src/runtime/context/live-entry-store.ts:90` |
| `PrefixBreakCause` | `"remove" \| "rewrite" \| "replace" \| "image_budget" \| "summary_anchor" \| "compaction"` | `packages/loop/src/runtime/context/live-entry-store.ts:37-38` |
| `buildEntrySeed` | `(a: { messages, deps: EntrySeedDeps, shape }) => EntrySeed` | `packages/loop/src/runtime/entry-seed.ts:126` |
| `createCachePrefixWatch` | `() => CachePrefixWatch` (`observe(cachedTokens: number): boolean`) | `packages/loop/src/runtime/loop/iteration-metrics.ts:105` |
| `cacheReadRatio` | `(usage: LLMUsage) => number` | `packages/loop/src/runtime/loop/iteration-metrics.ts:138` |
| `renderForPrefix` | `(messages: readonly LiveMessage[]) => string` — test-only pricing helper | `packages/loop/tests/prefix-stability.ts:32` |
| `prefixSurvival` | `(before: string, after: string) => number` in `[0,1]` | `packages/loop/tests/prefix-stability.ts:54` |

Provider continuation metadata follows the same append-only rule: assistant `text_parts` (including
Responses item id and phase) are installed when that assistant entry is appended, preserved by
`LiveContext.snapshot`, and replayed by `toModelMessages` without modifying an earlier entry.
Production: `buildCallResult`, `LiveContext.appendAssistant`, `LiveContext.appendAssistantToolCalls`,
and `toModelMessages`. Tests: `packages/loop/tests/unit/context-snapshot.test.ts`,
`packages/loop/tests/unit/prefix-break.test.ts`, and
`packages/llm/tests/integration/wire-cache-diff.test.ts`.

### 2c. Request-schema fields (validated per run)

| Field | Type/bounds | Default | File:line |
|---|---|---|---|
| `prompt_cache_key` | string, 1–512 chars, optional | `execution_id` | `packages/loop/src/validation/request/request-schema.ts:35-46` |
| `prompt_cache_ttl` | `"5m" \| "1h"`, optional | `"1h"` if `humanParkLikely`, else `"5m"` | `packages/loop/src/validation/request/request-schema.ts:57-66`, `packages/loop/src/runtime/execute-run.ts:344` |

Both fields validate through `runRequestSchema`; a Zod issue on either path classifies as
`invalid_prompt_cache_key`/`invalid_prompt_cache_ttl` (`packages/loop/src/validation/request/parsing.ts:16-21`),
both declared `ErrorCode` members (`packages/capability/src/run.ts:195-196`).

### 2d. Wire fields actually sent (openai-compatible)

| Field | Where set | Scope |
|---|---|---|
| `prompt_cache_key`/`session_id` (body, snake_case) | `packages/llm/src/ai-sdk/request-options.ts:202-208` | openai-compatible only |
| `promptCacheKey` (body, camelCase) | `packages/llm/src/ai-sdk/request-options.ts:211-213` | openai only |
| `x-session-id` (header) | `packages/llm/src/ai-sdk/request-options.ts:588-590` | openai-compatible only, when `promptCacheKey` is set |
| `cache_control` (Anthropic message/system `providerOptions`) | `packages/llm/src/ai-sdk/request-options.ts:31-35` (`anthropicCacheControl`) | anthropic, when `promptCache !== "off"` |
| `cache_control` (openai-compatible content block) | `packages/llm/src/openai-compatible-request.ts:112-157` | openai-compatible, only when `promptCache === "explicit"` and breakpoints requested |

## 3. Data and formats

### 3.1 `LLMCallParams` cache-relevant fields

`packages/capability/src/llm-port.ts:190-210`:

```ts
promptCacheKey?: string;
promptCacheTtl?: PromptCacheTtl;           // "5m" | "1h" — packages/capability/src/api.ts:385
cacheBreakpoints?: readonly number[];      // indices into `messages`, oldest first
```

`cacheBreakpoints` is supplied by the loop from `LiveContext.cacheBreakpoints()`
(`packages/loop/src/runtime/loop/loop.ts:418-425`), filtered to non-negative indices:

```ts
const breakpoints = d.ctx.cacheBreakpoints();               // { stable, prior }
const cacheBreakpoints = [breakpoints.prior, breakpoints.stable].filter((i) => i >= 0);
```

### 3.2 `ResolvedProviderConfig.promptCache` table

Reproduced from `packages/capability/src/llm-port.ts:130-138` (documented there, consumed by
`packages/llm/src/ai-sdk/request-options.ts:558-560`):

| value | `anthropic` | `openai-compatible` |
|---|---|---|
| `"explicit"` | cache breakpoints | `cache_control` blocks |
| `"implicit"` | cache breakpoints | nothing — informational |
| `"off"` | no breakpoints | nothing |
| absent | cache breakpoints | nothing |

`PromptCacheMode = "explicit" \| "implicit" \| "off"` — `packages/capability/src/api.ts:175`. How a
model's mode is resolved from the catalog is out of scope here ([hosts/model-catalog.md](../hosts/model-catalog.md)).

### 3.3 `RequestCacheDiagnostics` — what one assembled request decided

`packages/llm/src/ai-sdk/request-options.ts:87-105`:

```ts
interface RequestCacheDiagnostics {
  kind?: string; mode?: string;
  marked: "anthropic" | "compatible" | "none";
  requested_breakpoints: number;
  applied_breakpoints: number;
  walked_back: boolean;
  system_marked: boolean;
  cache_key_sent: boolean;
  session_pinned: boolean;   // both session_id body field AND x-session-id header present
  ttl?: PromptCacheTtl;
}
```

Logged as `llm.cache.request` (debug) and, when a requested breakpoint failed to land, escalated to
`llm.cache.breakpoint_lost` (warn) — `packages/llm/src/ai-sdk-adapter.ts:310-348`.

### 3.4 `ContextSnapshotEntry` — the persisted, restorable transcript shape

`packages/capability/src/run.ts:384-400`:

```ts
interface ContextSnapshotEntry {
  message: LiveMessage;
  evictable: boolean; summary: boolean; canonical: boolean;
  task_id?: string; note_kind?: string; block_kind?: string;
}
```

`canonical: true` or a present `note_kind` marks a **volatile** entry — always the trailing run, never
inside the durable prefix (`packages/loop/src/runtime/context/live-entry-store.ts:130`, mirrored at
`packages/loop/src/runtime/entry-seed.ts:70-72`).

### 3.5 `context.prefix_break` log record

`packages/loop/src/runtime/context/live-entry-store.ts:143-159`:

```ts
{
  event: "context.prefix_break",
  index, entries: entries.length,
  char_offset: <chars before index>,
  chars_recharged: <total - char_offset>,
  cause: PrefixBreakCause,
}
```
Level is `debug` for `"compaction"`/`"summary_anchor"` (priced, scheduled rewrites), `warn` for every
other cause — `remove`, `rewrite` (no producer today, kept as a name), `replace`, `image_budget`
(`packages/loop/src/runtime/context/live-entry-store.ts:48-51`).

### 3.6 `iteration.cache` log record

`packages/loop/src/runtime/loop/iteration-metrics.ts:232-241`:

```ts
{ event: "iteration.cache", iteration, input_tokens, cached_tokens, ratio }
```
`debug` ordinarily; `warn` — with message `"the provider served a shorter cached prefix than it served
last iteration…"` — when `CachePrefixWatch.observe(cached_tokens)` returns `true`.

### 3.7 Real wire example (from a pinned integration test)

`packages/llm/tests/integration/wire-cache-diff.test.ts:103-110` asserts the **complete** top-level
key set an implicit-cache openai-compatible request carries:

```json
["max_tokens", "messages", "model", "prompt_cache_key", "session_id", "usage"]
```
with `session_id === prompt_cache_key` on every turn and `headers["x-session-id"] === session_id`
(`:124-128`).

## 4. Behavior

### 4.1 Where the request-level cache key and TTL come from (per run)

1. `executeRun` mints or reuses `executionId` (`packages/loop/src/runtime/execute-run.ts:315-323`).
2. `promptCacheKey = parsed.prompt_cache_key ?? executionId` — `packages/loop/src/runtime/execute-run.ts:343`.
3. `promptCacheTtl = parsed.prompt_cache_ttl ?? (shape.humanParkLikely ? "1h" : "5m")` —
   `packages/loop/src/runtime/execute-run.ts:344`. `humanParkLikely` is true when the entry agent has
   `ask_user` granted (or a capability needs a human) and `elicit_wait_ms !== 0`
   (`packages/loop/src/validation/request/run-shape.ts:20-28`). For a kernel-mediated run this
   fallback often never gets to fire: `@clarvis/kernel`'s `createSettingsRunAssembler` independently
   defaults `prompt_cache_ttl` to `"1h"` whenever `guardParksOnHuman(params.guard_mode, merged.guard,
   params.guard_judge !== undefined)` is true — i.e. the effective guard mode routes bash
   confirmations to a human — before the request ever reaches `runRequestSchema`/`executeRun`
   (`packages/kernel/src/runs/settings-assembler.ts:433-439`, `guardParksOnHuman` at
   `packages/kernel/src/guard/resolver.ts:66-87`, whose own doc comment states "the loop cannot derive
   this itself because guard mode is resolved from host settings it never sees"). This is a second,
   independent TTL default, ahead of and separate from `humanParkLikely`'s.
4. `deps.llm` is wrapped once, for the whole run: `withPromptCacheDefaults(deps.llm, { promptCacheKey,
   promptCacheTtl })` — `packages/loop/src/runtime/execute-run.ts:394`. Every model call in the run —
   lead, retries, compaction, and every sub-agent spawned by `delegate_task` (which reuses `base.llm` /
   `ctx.llm` unchanged: `packages/loop/src/runtime/subagents/delegate-task.ts:488,565`) — flows through
   this one decorator instance, so all of them share one `promptCacheKey`/`promptCacheTtl` pair unless a
   caller overrides one field on a specific call.
5. `withPromptCacheDefaults` fills in only the fields the call left `undefined`, independently —
   a call pinning its own key still inherits the run's TTL (`packages/llm/src/prompt-cache-provider.ts:33-40`,
   pinned by `packages/llm/tests/unit/prompt-cache-provider.test.ts:41-55`).

**The `execution_id` default is per-run, not per-session.** The request-schema doc says so explicitly:
"Defaults to the run's `execution_id` … which stabilizes the key within a single run … To keep cache
affinity ACROSS a conversation's `continue_from` turns, pass your own stable value … on every turn — the
`execution_id` default changes per turn and does not carry over"
(`packages/loop/src/validation/request/request-schema.ts:28-46`). `@clarvis/code` supplies that stable
value: it sets `promptCacheKey = sess.meta()?.id` — the session id, not a fresh execution id — on every
turn it starts (`packages/code/src/run-host.ts:643,691,716,785,797,841,857`). Neither
`@clarvis/kernel`'s `packages/kernel/src/runs/settings-assembler.ts:433-435` nor `packages/kernel/src/workflows/workflows-service.ts:354-356,470-472` derive or
override `prompt_cache_key`; they only forward whatever the caller supplied.

### 4.2 Assembling one request (`buildRequestOptions`)

1. `buildCallTuning` (`packages/llm/src/ai-sdk/request-options.ts:159-234`) computes reasoning
   settings and, for `openai`/`openai-compatible`, attaches `promptCacheKey` as a provider option
   (native `promptCacheKey`, or the snake_case `prompt_cache_key`/`session_id` pair).
2. If `kind === "anthropic"` and `promptCache !== "off"`: `withCacheBreakpoints` marks up to
   `MAX_MESSAGE_CACHE_BREAKPOINTS` (2) message indices with `anthropicCacheControl(ttl)`
   (`:266-293`, `:20-35`). `"5m"` omits the `ttl` key entirely so the body stays byte-identical to a
   run that never set it; `"1h"` adds `ttl: "1h"` (`:26-29`).
3. Else if `kind === "openai-compatible"` and `promptCache === "explicit"` and breakpoints were
   requested: `withOpenAICompatibleCacheMarkers` marks up to 2 indices, walking each requested index
   **backward** to the newest message whose `markerSiteOf` is not `"none"` (skips a `tool` message
   and an assistant turn holding only tool-calls) — never dropping a marker outright
   (`:403-429`, `markerSiteOf` at `:341-374`).
4. `splitSystemMessages` lifts every `system`-role message into one joined `system` string/array
   (`:475-486`); if a breakpoint applies to the system content it is wrapped with the same
   `cache_control`/marker fragment (`:560-577`).
5. `sessionHeaders = { "x-session-id": promptCacheKey }` when `kind === "openai-compatible"` and a key
   is set (`:578-580`).
6. `RequestCacheDiagnostics` is assembled from what steps 2–5 actually did — never re-derived by
   re-walking the message array (`:582-593`).
7. The adapter (`packages/llm/src/ai-sdk-adapter.ts:394-395`) calls `buildRequestOptions`, then
   `reportRequest` logs `llm.cache.request`/`llm.request.tuning` at `debug` and escalates to
   `llm.cache.breakpoint_lost` (`warn`) whenever `applied_breakpoints` came back lower than what was
   requested (`:301-339`).
8. For `openai-compatible`, `transformRequestBody` (`openAICompatibleSettings`,
   `packages/llm/src/openai-compatible-request.ts:211-237`) runs after the SDK serializes the body, as
   the two-function composition `applyCacheControlMarkers(applyBodyExtras(args, extras))` (`:235`) — the
   operator's configured `body` extras are merged in **first**, then the cache-marker pass runs
   **second** and sees them already applied: `applyCacheControlMarkers` finds every message carrying
   `CACHE_MARKER_KEY` (on the message or on a block), rewrites its `content` into a block array with
   `cache_control: { type: "ephemeral" }` on the last text block, and **always** strips the sentinel —
   from a `tool` role or a `tool_calls` assistant turn it strips-only, never promotes (`:100-157`).

### 4.3 Assembling one run's transcript so it stays append-only

`LiveEntryStore` (`packages/loop/src/runtime/context/live-entry-store.ts`) is the single authority for
entry order. It tracks `durableInsertIndex()`: walk backward from the end while an entry `isVolatile`
(`canonical` or has a `noteKind`) — the boundary between the cached durable prefix and the trailing
volatile run (`:130-135`). Every ordinary append (`appendDurable`, called by `push`,
`appendToolMessage`, `appendAssistant*`) splices in **at that boundary**, ahead of the volatile tail,
which means the operation never touches an index the provider has already been billed for and reports
nothing (`:171-174`). `appendVolatile` (used by `appendRuntimeNote`, `setCanonicalState`) always pushes
to the true end and is never inside the durable prefix. `removeAt`/`replace` report a
`context.prefix_break` **only** when the mutated/removed/diverging index is `< durableInsertIndex()`
(`:187-215`); a shift confined to the volatile tail is silent by design
(`packages/loop/tests/unit/prefix-break.test.ts:52-62`).

### 4.4 Composing the entry agent's opening context (`buildEntrySeed`)

`packages/loop/src/runtime/entry-seed.ts:126-186`, order: system head → filtered continuation history
→ pinned seed blocks not already carried → this turn's messages.

| Step | Rule | Cite |
|---|---|---|
| System head | Rebuilt fresh every run from `buildSystemSections`, but identical bytes for the life of one run (nothing in `deps` changes turn to turn) | `:142-149` |
| Continuation filter | Drop every restored entry that `isRestoredVolatile` (`canonical` or has `note_kind`) — its owner republishes it via `beforeIteration` | `:70-72, 101-108, 156-160` |
| Seed-block dedup | A capability's seed block already present in the continuation (matched by its `seedMarker` open tag) is **kept**, not regenerated; only a block whose marker the continuation does **not** carry is freshly appended, and only after the restored history | `:110-124, 167-179` |
| Dropped capability | A restored block whose marker is not among this run's fresh `seedBlocks` is dropped outright (its capability is no longer active) | `:120-121`, test at `packages/loop/tests/unit/entry-seed-markers.test.ts:118-136` |
| Non-vision image collapse | For a non-vision entry agent (`entryResolved.capabilities` lacking `"vision"`), every surviving restored continuation entry's image content parts are replaced with the text placeholder `"[image from an earlier turn]"` before splicing — a one-time transform of ordinary restored content, distinct from the seed-block/volatile rules above | `:74-85, 135, 176` |

### 4.5 Runtime detection of a broken prefix (in-band, on every model call)

`CachePrefixWatch` (`packages/loop/src/runtime/loop/iteration-metrics.ts:105-123`), one instance per
agent loop (`packages/loop/src/runtime/loop/loop.ts:882`), folds each iteration's `cached_tokens`:

| Prior `cached_tokens` | This iteration's `cached_tokens` | `observe()` returns | Effect |
|---|---|---|---|
| `undefined` (first call) | any | `false` | arms nothing — no prior to compare |
| `p` (`p > 0`) | `c ≥ p * 0.9` | `false` | quiet; ratio may still drop (large tool result) without meaning a break |
| `p` (`p > 0`) | `c < p * 0.9` and not yet reported | `true` | `reportIterationCache` logs `iteration.cache` at `warn` |
| same break persisting | `c` still `< p * 0.9` | `false` (already `reported`) | logged once per distinct break, not once per call below threshold |
| break resolved then a **new** one appears | — | `true` again | `reported` resets the moment a call is no longer "lost" (`:104-106`) |

`CACHE_PREFIX_LOSS = 0.1` absorbs ordinary provider block rounding
(`packages/loop/src/runtime/loop/iteration-metrics.ts:58, 84`). The comparison is against **prior
`cached_tokens`**, never `input_tokens`, because the trailing volatile run is by design outside the
cached prefix every iteration, so `cached < previous input` is the normal, healthy state from the
second iteration on (`:78-83`).

### 4.6 Revising a stable block without recharging the prefix (`setStableBlock`)

`LiveContext.setStableBlock(kind, content)` (`packages/loop/src/runtime/context/live-context.ts:260-279`)
is the mechanism the headline 2,929,430-token regression in §1 exists to prevent: (1) supplying
byte-identical content is a no-op down to object identity — `if (contentToText(superseded.message.content)
=== content) return;` (`:264`), the entries array is not touched at all; (2) a real revision never
rewrites the old entry's message in place — it marks the superseded entry `evictable = true` /
`superseded = true` and deletes its `blockKind` (`:265-267`), then appends a brand-new durable entry via
`store.appendDurable` (`:270-277`) ahead of the volatile tail, so the mutation lands after
`durableInsertIndex()` and reports nothing. `packages/loop/tests/unit/context-compaction.test.ts:501-519`
exercises exactly this against a rendered prefix (doc comment: "a revision must re-charge nothing at
all... 2,929,430 tokens across one session"), asserting `prefixSurvival(before, after) === 1` and
`after.startsWith(before)`; `:523-530` pins the no-op case the same way; `:536-543` asserts
`ctx.messages[1]` is the same object reference across two identical calls.

### 4.7 Reasoning replay

`LLMCallResult.reasoningParts` (opaque provider-specific continuation state — Anthropic signatures,
OpenAI reasoning items) is attached to the assistant `LiveMessage` as a `reasoning` field
(`packages/capability/src/llm-port.ts:68-78`). `toModelMessages` converts it back to AI SDK
`{ type: "reasoning", text, providerOptions }` content parts on the **assistant** turn
(`packages/llm/src/to-model-messages.ts:112-131`) — a structural content type, never folded into the
`text`/prose the transcript renders. `contentToText` (`packages/capability/src/message-content.ts:10-13`)
only ever reads a message's `content` field, never its `reasoning` field, so nothing that renders
transcript text for a human or a compaction summarizer can surface it.

### 4.8 Bounding inline tool images (`enforceToolImageBudget`)

`packages/loop/src/runtime/context/live-context.ts:77-140`, invoked after every `appendToolMessage` and
once when a continuation is hydrated (`:140`). Walking entries newest-first, it admits each tool
result's images into a budget bounded by `MAX_LIVE_TOOL_IMAGE_CHARS` overall and, per image,
`MAX_TOOL_IMAGE_CHARS`/`MAX_TOOL_IMAGES_PER_RESULT`; anything it will not keep is dropped and the
message content gets a trailing marker naming how many images and roughly how many payload chars were
released (`:114-119`). Its own doc comment states a prefix-cost rule the rest of this document does not
otherwise capture: "The prefix-break report deliberately excludes the **last** durable entry. This runs
immediately after each `appendToolMessage`, so trimming the result that was just pushed rewrites bytes
no provider has seen yet and costs nothing; only a rewrite reaching further back releases an image the
previous request already carried, and that is the one worth a warning" (`:84-89`), implemented as
`if (lowestRewritten < store.durablePrefixEnd() - 1) store.reportPrefixBreak(lowestRewritten,
"image_budget")` (`:133-134`).

## 5. Invariants

`INV-nnn` entries are catalogue invariants owned by this document; `PCX-nn` entries are invariants
derived directly from the code by this document and are not in the catalogue.

**INV-084.** The request head (system message + tool definitions) sent to the model is byte-for-byte
identical across every iteration of one run: the same `JSON.stringify(tools)`, the same tool ordering
(not incidental Set/Map iteration order), and the same rendered system message content.
Production: `packages/loop/src/runtime/entry-seed.ts:142-149` (system head built once per run from
inputs that do not change turn to turn); the tool array is part of `LoopDerived`, computed once per
`runAgentLoop` invocation (`packages/loop/src/runtime/loop/loop.ts:871`) and passed unchanged to every
`buildModelCall` (`:402-434`).
Test: `packages/loop/tests/integration/prefix-invariants.test.ts:68` (tool definitions),
`:77` (tool order), `:87` (system head).

**INV-085.** No tool description interpolates a per-run identity value (an `exec_<hex>` id or a
13-digit millisecond timestamp).
Test: `packages/loop/tests/integration/prefix-invariants.test.ts:100-105`. The pattern this guards
against is the shape minted by `generateExecutionId` (`exec_` + a v4 UUID —
`packages/trace/src/execution-id.ts:8-9`); no production tool-description builder found under
`packages/tools/src` or `packages/loop/src/runtime/tools` interpolates one — this is a standing
negative property enforced only by the test, not by a type or a lint rule.

**INV-086.** A sub-agent's conversation grows only at the tail: request *N+1*'s rendered messages
always start with request *N*'s rendered messages verbatim, and it carries no canonical/stable block
and no `[runtime:` note — those are contributed only to the run's entry agent.
Production: a delegated sub-agent's capability activation is built with `entry: false`
(`packages/loop/src/runtime/capabilities/delegation.ts:101-105`, via
`activationForScope(deps.runCapabilities, { agent: "subagent", entry: false, ... })`), whereas the run's
entry agent's own seed is built with `entry: true`
(`packages/loop/src/runtime/entry-seed.ts:137-141`, `systemSectionsFor(deps.runCapabilities, { agent:
..., entry: true, grants: ... })`). A capability's canonical-state/stable-block contribution is
therefore only reachable through the entry path's `LiveContext.setCanonicalState`/`setStableBlock`
(`packages/loop/src/runtime/context/live-context.ts:246-279`), never through the sub-agent's own,
independently-built input.
Test: `packages/loop/tests/integration/prefix-invariants.test.ts:163` (tail-only growth),
`:177` (no canonical block, no runtime note).

**INV-087.** Reasoning content a provider returns is replayed to the provider structurally (as
assistant-turn reasoning state) on later iterations but never rendered as visible message-content
prose in any request.
Production: `packages/llm/src/to-model-messages.ts:112-131` (assembles a `reasoning` AI-SDK content
part, separate from `text`); `packages/capability/src/message-content.ts:10-13` (`contentToText` never
reads `reasoning`).
Test: `packages/loop/tests/integration/prefix-invariants.test.ts:192` (loop-level, provider-neutral);
also pinned at the real-wire level for OpenAI-compatible (`reasoning_content` field) at
`packages/llm/tests/integration/provider-request-shape.test.ts:224-251` and for Anthropic (`thinking` +
`signature`) at `:421-457`.

**INV-088.** Ordinary continuation and model-selection inspection never rewrite a persisted
`final_context`. An explicit settled `/compact`, or a confirmed switch to a model whose smaller
window requires eviction, is a deliberate cache-breaking replacement. Mechanical fitting preserves
every retained entry exactly and changes only the evicted prefix; the model setting is written only
after the replacement fits. Production: `fitStoredContextToWindow` in
`packages/loop/src/runtime/context/stored-context-compaction.ts` and `ModelView.choose` in
`packages/code/src/views/config/ModelView.tsx`. Test:
`packages/loop/tests/unit/stored-context-compaction.test.ts` and
`packages/code/tests/integration/model-view-render.test.tsx`.

**PCX-01 (derived).** A durable-prefix mutation is reported as `context.prefix_break` (with
`chars_recharged` priced against the byte offset) whenever the changed/removed/diverging index is
strictly before `durablePrefixEnd()`; a change confined to the trailing volatile run reports nothing.
Production: `packages/loop/src/runtime/context/live-entry-store.ts:143-159, 187-188, 204-215`.
Test: `packages/loop/tests/unit/prefix-break.test.ts:21-141` (removal, replace, and the "shifts only the
volatile tail ⇒ silent" case at `:52-62`).

**PCX-02 (derived).** `context.prefix_break` demotes exactly two causes — `"compaction"` and
`"summary_anchor"` — to `debug`; every other cause (`remove`, `rewrite`, `replace`, `image_budget`)
logs at `warn`.
Production: `packages/loop/src/runtime/context/live-entry-store.ts:48-51, 143-144`.
Test: `packages/loop/tests/unit/prefix-break.test.ts:111-140` (compaction → debug),
`:175-222` (summary anchor and eviction → debug), `:158-173` (image budget → warn).

**PCX-03 (derived).** A continuation's own capability seed block (matched by its declared
`seedMarker` open tag) is kept byte-identical rather than regenerated, and a restored volatile entry
(`canonical` or carrying a `note_kind`) is always dropped and never carried forward.
Production: `packages/loop/src/runtime/entry-seed.ts:70-72, 110-124, 156-179`.
Test: `packages/loop/tests/unit/entry-seed-markers.test.ts:99-116` (keeps the carried block),
`:153-171` (drops restored volatile entries), `:177-198` (reproduces the restored transcript as an
unbroken prefix).
**Exception:** this is byte-identical only for a *vision-capable* entry agent. For an entry agent
lacking the `vision` capability, `buildEntrySeed` runs every surviving restored entry through
`collapseHistoricalImages`, which replaces each image content part with the text placeholder
`"[image from an earlier turn]"` before splicing it in — a genuine one-time rewrite of ordinary restored
content, not a verbatim carry-forward (`entryStripsImages` gate at `packages/loop/src/runtime/entry-seed.ts:135`,
transform at `:74-85`, applied at `:176`).

**PCX-04 (derived).** `withPromptCacheDefaults` fills `promptCacheKey`/`promptCacheTtl`
**independently**: a call that pins one still inherits the run's default for the other.
Production: `packages/llm/src/prompt-cache-provider.ts:33-40`.
Test: `packages/llm/tests/unit/prompt-cache-provider.test.ts:41-64` (all four combinations).

**PCX-05 (derived).** For `openai-compatible`, a request pins backend affinity on **two** channels
carrying the **same value**: body `session_id` and header `x-session-id`, both equal to
`prompt_cache_key`; both stay constant across every turn of a byte-identical-prefix conversation.
Production: `packages/llm/src/ai-sdk/request-options.ts:202-213, 578-580`.
Test: `packages/llm/tests/integration/wire-cache-diff.test.ts:85-128` (constant across 3 turns;
`session_id === prompt_cache_key`; single distinct `x-session-id` value across all calls).

**PCX-06 (derived).** At most `MAX_MESSAGE_CACHE_BREAKPOINTS` (2) message-level breakpoints are ever
applied per request, on both the Anthropic and openai-compatible-explicit paths, leaving one slot free
of the 4 Anthropic allows once the system block's own breakpoint is counted.
Production: `packages/llm/src/ai-sdk/request-options.ts:238-243, 283-293, 528-534`.
Test: implicit in `packages/llm/tests/integration/provider-request-shape.test.ts:163-187` (walks a
breakpoint backward rather than dropping it) — unpinned for the exact count-2 ceiling itself (no test
requests 3+ indices and asserts exactly 2 survive).

**PCX-07 (derived).** `CACHE_MARKER_KEY` never reaches the wire: `applyCacheControlMarkers` strips it
from every message and every content block, whether or not the message was promotable to a
`cache_control` block (a `tool` role or a `tool_calls`-bearing assistant turn is stripped but never
promoted).
Production: `packages/llm/src/openai-compatible-request.ts:76-80, 100-156`.
Test: `packages/llm/tests/integration/provider-request-shape.test.ts:111-157` (`raw` excludes
`__clarvis_cache_control`); `:163-187` (tool/assistant turn content stays a plain string, no
`cache_control`).

**PCX-08 (derived).** `CachePrefixWatch` flags a break on **falling `cached_tokens`** alone (a >10%
drop from the previous iteration), never on the cache-read ratio, and reports each distinct break
exactly once until it resolves and a new one appears.
Production: `packages/loop/src/runtime/loop/iteration-metrics.ts:68-123`.
Test: `packages/loop/tests/unit/observability.test.ts:157-198` (silent on ratio-only drops and on a
provider that never caches; one line per distinct break; re-arms after a false-positive-free
resolution).

**PCX-09 (derived).** `LiveContext.setStableBlock` never rewrites a stable block's message in place:
identical content is a no-op down to object identity, and a real revision marks the superseded entry
evictable+superseded and appends a brand-new durable entry ahead of the volatile tail.
Production: `packages/loop/src/runtime/context/live-context.ts:260-279`.
Test: `packages/loop/tests/unit/context-compaction.test.ts:508-519` (a revision preserves the entire
prefix, `prefixSurvival === 1`), `:523-530` (unchanged content is a pure no-op), `:536-543` (no-op down
to object identity — `ctx.messages[1]` is the same reference across two identical calls).

**PCX-10 (derived).** `enforceToolImageBudget`'s prefix-break report excludes the last durable entry:
a trim confined to the tool result just pushed by the current `appendToolMessage` call is silent,
because no provider has been billed for those bytes yet; only a rewrite reaching an earlier durable
entry reports `"image_budget"`.
Production: `packages/loop/src/runtime/context/live-context.ts:84-89` (doc comment stating the rule),
`:133-134` (`if (lowestRewritten < store.durablePrefixEnd() - 1)`).
Test: `packages/loop/tests/unit/prefix-break.test.ts:158-173` (image budget reported at `warn`).

## 6. Failure modes and degradation

| Condition | Handling | Cite |
|---|---|---|
| `prompt_cache_key` fails schema (empty or >512 chars) | `ValidationError` classified `invalid_prompt_cache_key`; run never starts | `packages/loop/src/validation/request/parsing.ts:16-18`, `packages/capability/src/run.ts:195` |
| `prompt_cache_ttl` not `"5m"`/`"1h"` | `ValidationError` classified `invalid_prompt_cache_ttl` | `packages/loop/src/validation/request/parsing.ts:20-21`, `packages/capability/src/run.ts:196` |
| A requested Anthropic/openai-compatible-explicit breakpoint lands on an unmarkable message (`tool` role, or an assistant turn holding only tool-calls) | Walked back to the newest markable index rather than dropped; if it collapses onto another target's index, `applied_breakpoints` reports fewer than requested | `packages/llm/src/ai-sdk/request-options.ts:341-374, 403-429` |
| Every requested breakpoint fails to land (`applied_breakpoints === 0`) or two collapse to one | `llm.cache.breakpoint_lost` logged at `warn` regardless of the configured log level | `packages/llm/src/ai-sdk-adapter.ts:310-324`; unconditional-`warn` pinned at `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts:296-300` (nearby, "warns even when debug is off") |
| A durable transcript entry is mutated/removed/repositioned in place | `context.prefix_break` at `warn` (or `debug` for the two priced causes) — this is a report, not a refusal; the mutation still proceeds | `packages/loop/src/runtime/context/live-entry-store.ts:143-159` |
| The provider serves a shorter cached prefix than the previous iteration | `iteration.cache` escalates to `warn`; the run itself is unaffected — this is observability only, no retry or abort | `packages/loop/src/runtime/loop/iteration-metrics.ts:228-241` |
| A configured header template references an unset env var | `ProviderError` (kind `"client"`) thrown eagerly rather than left to retry as transient | `packages/llm/src/openai-compatible-request.ts:251-267` |
| `cfg.baseUrl` missing for an openai-compatible provider | `ProviderError` (kind `"client"`) at client construction | `packages/llm/src/openai-compatible-request.ts:223-227` |
| A logger below `debug` | `llm.cache.request`/`llm.request.tuning` are not built at all (guarded by `levelEnabled`) — the diagnostics cost nothing when discarded | `packages/llm/src/ai-sdk-adapter.ts:339-340`; pinned at `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts:226-233` |
| No logger bound to a `LiveContext` scope | `context.prefix_break`/silence — normalized to `NOOP_LOGGER`, never throws | `packages/loop/src/runtime/context/compaction-contracts.ts:47-50`, pinned at `packages/loop/tests/unit/prefix-break.test.ts:224-227` |

Nothing in this subsystem retries a broken prefix or refuses a call because of one: every mechanism
above is diagnostic (a log line at a chosen severity) except the two hard validation failures at the
top, which reject the run request before any call is made.

## 7. Coupling

- **`@clarvis/llm` has no dependency on `@clarvis/loop`.** `withPromptCacheDefaults`,
  `buildRequestOptions` and `applyCacheControlMarkers` operate purely on `LLMCallParams`/wire-body
  shapes declared in `@clarvis/capability`; `@clarvis/loop` is the only caller that constructs those
  params from a live transcript. This is a static, one-directional import edge
  (`packages/loop/src/runtime/execute-run.ts:4` imports `withPromptCacheDefaults` from `@clarvis/llm`;
  nothing in `packages/llm/src` imports `@clarvis/loop`).
- **`LiveContext` forces the append-only shape structurally, not by convention.** Every mutation site
  in the engine that appends to a run's transcript goes through `LiveEntryStore`
  (`packages/loop/src/runtime/context/live-entry-store.ts`) — it is the "single authority for entry
  order" per its own doc comment (`:51`). A capability cannot bypass it because `LiveContext` (the type
  every capability and the loop itself holds) exposes no other way to mutate `entries`.
- **`buildModelCall` (loop) is the sole producer of `cacheBreakpoints` for an `LLMCallParams`.**
  `packages/loop/src/runtime/loop/loop.ts:418-425` reads `LiveContext.cacheBreakpoints()` once per
  call and forwards at most two indices; `@clarvis/llm` never computes a breakpoint itself, it only
  decides — per `ResolvedProviderConfig.promptCache` — whether and how to act on the ones it is given.
- **`execute-run.ts` is the sole place the run-level `promptCacheKey`/`promptCacheTtl` pair is
  bound to `deps.llm`** (`packages/loop/src/runtime/execute-run.ts:361-362,412`); every
  downstream collaborator — the lead loop, a delegated sub-agent, compaction's own summarization calls
  — receives the **same wrapped provider instance**, so none of them can diverge on TTL/key without an
  explicit per-call override. It is not, however, the sole place a *default* for either field is
  computed: `@clarvis/kernel`'s `createSettingsRunAssembler` independently defaults
  `prompt_cache_ttl` to `"1h"` via `guardParksOnHuman` ahead of `executeRun`'s own `humanParkLikely`
  fallback (`packages/kernel/src/runs/settings-assembler.ts:433-439`,
  `packages/kernel/src/guard/resolver.ts:66-87`) — see §4.1 point 3.
- **`@clarvis/code` is what actually achieves cross-turn session affinity**, by supplying
  `prompt_cache_key = sess.meta()?.id` on every `startRun` call
  (`packages/code/src/run-host.ts:643,691,716,785,797,841,857`). The loop and kernel are agnostic to
  this: `@clarvis/kernel`'s `settings-assembler.ts` and `workflows-service.ts` only forward whatever
  `prompt_cache_key` a caller supplied — the session-scoping behavior belongs entirely to the TUI host,
  not to any package this document's scope otherwise covers.
- **`entry-seed.ts` depends on `RunCapability.systemSection`/`seedMarker`** (declared in
  `@clarvis/capability`) to decide which restored entries are seed blocks versus ordinary transcript.
  A capability that emits a `seedBlock` without a matching `seedMarker` is
  unmatchable here by the function's own doc comment (`packages/loop/src/runtime/entry-seed.ts:43-48`)
  — this is a real, load-bearing coupling the code states explicitly rather than an inferred
  one.
- **What depends on this document:** `packages/loop/src/runtime/loop/loop.ts` (calls `cacheBreakpoints()`
  every iteration), `packages/loop/src/runtime/execute-run.ts` (binds the decorator), and every provider
  path in `@clarvis/llm`'s adapter (`ai-sdk-adapter.ts`, `openai-compatible-request.ts`). Nothing
  outside `@clarvis/loop`/`@clarvis/llm` reads `PrefixBreakCause`, `CachePrefixWatch` or
  `RequestCacheDiagnostics` directly — they are internal machinery whose only externally visible trace
  is the log lines in §3.5/§3.6 and §3.3.
- **Storage maintenance is outside the message-prefix path.** `StorageService`, global artifact
  housekeeping and trace retention inspect filesystem metadata or persisted records after/between
  runs; none receives `LiveContext`, `LiveEntryStore` or `LLMCallParams`. Session-protected trace
  cleanup deletes only unreferenced persisted records and does not rewrite an active or resumed
  message list. Production: `packages/kernel/src/storage/storage-service.ts`,
  `packages/paths/src/housekeeping.ts`, and the `TraceCleanup` composition in
  `packages/kernel/src/file-kernel.ts`. This preserves the append-only/non-volatile-prefix contract.

## 8. Open questions

- **Why `MAX_MESSAGE_CACHE_BREAKPOINTS` is 2, not some other number**, beyond the stated arithmetic
  ("Anthropic allows four per request; the system block takes one, so two here leaves the budget at
  three" — `packages/llm/src/ai-sdk/request-options.ts:236-253`, which does not actually explain why 3
  was not used for the two non-system slots; the doc comment's own arithmetic leaves one slot
  unaccounted for). Not chased further — this is the code's own stated reasoning, quoted, not an
  inference drawn here.
- **No test asserts the exact ceiling of 2 breakpoints** (i.e., that a 3rd requested index is dropped
  rather than kept) — see PCX-06's "unpinned" note. The nearest test only exercises the walk-back
  behavior for indices that already number ≤2.
- **INV-085's guard has no known production producer to point at.** No file under `packages/tools/src`
  or `packages/loop/src/runtime/tools` was found constructing a tool description containing an
  `exec_<hex>` pattern or a 13-digit timestamp; the invariant is therefore purely a regression guard
  against a defect class, not a fix commit that can be located and cited. If such a producer exists
  in a package outside this document's scope, it is not known here.
- **Whether any host other than `@clarvis/code` achieves session-scoped affinity across
  `continue_from` turns** was not established — `@clarvis/server`'s `clarvis_run` MCP tool surface and
  its per-request `prompt_cache_key` handling belong to [foundations/llm.md](../foundations/llm.md)/server specs, not chased
  here.
- **The precise numeric constants behind `CACHE_PREFIX_LOSS = 0.1`** and the `5m`/`1h` TTL choice are
  stated as design decisions in doc comments but their derivation (why 10% and not, say, 5%) is not
  present in the code beyond the "absorbs the block rounding every provider reports in" remark
  (`packages/loop/src/runtime/loop/iteration-metrics.ts:57-58,84`).
- **How a model's `promptCache` mode (`explicit`/`implicit`/`off`) is actually derived from the model
  catalog** for a given `(provider, model)` pair is out of scope here by the document's own
  delegation; it is specified in [hosts/model-catalog.md](../hosts/model-catalog.md).
- **The `"rewrite"` `PrefixBreakCause` member has no producer today** — the type comment says as much
  ("it is the name the next in-place message mutator must report under" —
  `packages/loop/src/runtime/context/live-entry-store.ts:32-35`) — confirmed dead-but-intentional by
  reading, not inferred.
