# `@clarvis/llm` — provider adapter, decorators and error classification

> Implemented at `packages/llm/`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

`@clarvis/llm` is the package that turns Clarvis's provider-neutral `LLMProvider` port
(`packages/capability/src/llm-port.ts`) into actual HTTP calls against four provider SDK
families, and that turns everything those calls can do wrong into one normalized `ProviderError`
(`packages/capability/src/llm-port.ts`). It is the only package in the monorepo that declares
`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` and `ai` as
dependencies (`packages/llm/package.json`).

Concretely it owns five things. (a) The **adapter**: `AiSdkAdapter`
(`packages/llm/src/ai-sdk-adapter.ts`) builds the right SDK client from a
`ResolvedProviderConfig`, converts the loop's messages/tools/tuning into the AI SDK call shape,
streams or generates, and maps every failure. (b) The **decorator stack** — prompt-cache defaults
(`packages/llm/src/prompt-cache-provider.ts`), call logging (`packages/llm/src/logging-llm-provider.ts`), transport retry
(`packages/llm/src/retry-llm-provider.ts`) and a host-owned admission gate (`packages/llm/src/model-call-admission.ts`) —
each an `LLMProvider` wrapping an `LLMProvider`. (c) The **classifier**, `classifyProviderError`
(`packages/llm/src/classify-provider-error.ts`), which decides which of the six `FailureKind`s
(`packages/capability/src/run.ts`) a failure is, and therefore whether it is retried at all.
(d) The **transport bounds**: `createBoundedFetch` (`packages/llm/src/ai-sdk/bounded-fetch.ts`) caps a response
body and one unterminated SSE event before an SDK parser can retain them. (e) A deliberate
**two-entry split** so that importing a decorator does not statically load four provider SDKs
(`packages/llm/src/index.ts`, `packages/llm/src/lazy.ts`), enforced by `tests/architecture/lazy-entry.test.ts`.

The package has no `zod` dependency and defines no settings schema
(`packages/llm/package.json`); it is configured entirely through function arguments handed to
it by `@clarvis/loop`'s `buildRunDeps` (`packages/loop/src/runtime/build-run-deps.ts`).

---

## 2. Surface

### 2.1 Exports map

| Subpath | `bun` | `types` | `import` | Source |
| --- | --- | --- | --- | --- |
| `.` | `./src/index.ts` | `./dist/index.d.ts` | `./dist/index.js` | `packages/llm/package.json` |
| `./adapter` | `./src/adapter.ts` | `./dist/adapter.d.ts` | `./dist/adapter.js` | `packages/llm/package.json` |
| `./package.json` | literal | — | — | `packages/llm/package.json` |

`packages/llm/src/index.ts` re-exports seven modules (`lazy.ts`, `classify-provider-error.ts`,
`logging-llm-provider.js`, `model-call-admission.js`, `prompt-cache-provider.js`,
`retry-llm-provider.js`, `to-model-messages.js`) and explicitly **not** the adapter; its own TSDoc states
the reason: re-exporting it "would statically pull `@ai-sdk/anthropic`, `@ai-sdk/google`,
`@ai-sdk/openai` and `@ai-sdk/openai-compatible` into every consumer that only wanted a decorator"
(`packages/llm/src/index.ts`).

### 2.2 Entry `.` — exported symbols

| Symbol | Kind | File | Signature / value |
| --- | --- | --- | --- |
| `createAiSdkProvider` | fn | `packages/llm/src/lazy.ts` | `(opts: AiSdkProviderOptions) => LLMProvider` |
| `AiSdkProviderOptions` | iface | `packages/llm/src/lazy.ts` | `{ resolveRegistryKey; resolveSubscription?; timeoutMs?; maxResponseBytes?; maxSseEventBytes?; logger? }` |
| `parseRetryAfter` | fn | `packages/llm/src/classify-provider-error.ts` | `(value: string \| null \| undefined, now?: number) => number \| undefined` |
| `classifyProviderError` | fn | `packages/llm/src/classify-provider-error.ts` | `(input: ClassifyInput) => Classification` |
| `HeaderLike` | iface | `packages/llm/src/classify-provider-error.ts` | `{ get(name): string \| null }` |
| `ClassifyInput` | iface | `packages/llm/src/classify-provider-error.ts` | `{ status?; headers?; body?; cause?; timedOut?; isRetryable?; now?; logger? }` |
| `Classification` | iface | `packages/llm/src/classify-provider-error.ts` | `{ kind: FailureKind; status?; retryAfterMs? }` |
| `withCallLogging` | fn | `packages/llm/src/logging-llm-provider.ts` | `(inner: LLMProvider, logger: Logger) => LLMProvider` |
| `DEFAULT_MAX_ACTIVE_MODEL_CALLS` | const | `packages/llm/src/model-call-admission.ts` | `4` |
| `DEFAULT_MAX_QUEUED_MODEL_CALLS` | const | `packages/llm/src/model-call-admission.ts` | `8` |
| `DEFAULT_MODEL_CALL_ABORT_SETTLE_MS` | const | `packages/llm/src/model-call-admission.ts` | `250` |
| `ModelCallAdmissionState` | type | `packages/llm/src/model-call-admission.ts` | `"open" \| "quarantined" \| "closed"` |
| `ModelCallUnavailableReason` | type | `packages/llm/src/model-call-admission.ts` | `"queue_full" \| "quarantined" \| "closed"` |
| `ModelCallAdmissionSnapshot` | iface | `packages/llm/src/model-call-admission.ts` | `{ state; active; queued; quarantined; maxActive; maxQueued }` |
| `ModelCallAdmissionOptions` | iface | `packages/llm/src/model-call-admission.ts` | `{ maxActive?; maxQueued?; abortSettleMs?; onStateChange?; logger? }` |
| `admissionStateLogger` | fn | `packages/llm/src/model-call-admission.ts` | `(logger) => (snapshot) => void` |
| `ModelCallUnavailableError` | class | `packages/llm/src/model-call-admission.ts` | `CodedError`, `code = "model_call_unavailable"` |
| `ModelCallStuckError` | class | `packages/llm/src/model-call-admission.ts` | `CodedError`, `code = "model_call_stuck"` |
| `ModelCallAdmissionController` | class | `packages/llm/src/model-call-admission.ts` | `snapshot()`, `close()`, `call(inner, params)` |
| `createModelCallAdmissionController` | fn | `packages/llm/src/model-call-admission.ts` | `(options?) => ModelCallAdmissionController` |
| `withModelCallAdmission` | fn | `packages/llm/src/model-call-admission.ts` | `(inner, controller) => LLMProvider` |
| `withPromptCacheDefaults` | fn | `packages/llm/src/prompt-cache-provider.ts` | `(inner, defaults: PromptCacheDefaults) => LLMProvider` |
| `PromptCacheDefaults` | iface | `packages/llm/src/prompt-cache-provider.ts` | `{ identity: PromptCacheIdentity; promptCacheTtl: PromptCacheTtl }` |
| `backoffDelayMs` | fn | `packages/llm/src/retry-llm-provider.ts` | `(n, retryAfterMs, baseDelayMs, maxDelayMs, maxRetryAfterMs?) => number` |
| `withTransportRetry` | fn | `packages/llm/src/retry-llm-provider.ts` | `(inner, opts: TransportRetryOptions) => LLMProvider` |
| `TransportRetryOptions` | iface | `packages/llm/src/retry-llm-provider.ts` | `{ maxRetries; baseDelayMs; maxDelayMs; maxRetryAfterMs?; logger? }` |
| `toModelMessages` | fn | `packages/llm/src/to-model-messages.ts` | `(messages: LiveMessage[], opts?) => ModelMessage[]` |
| `ToModelMessagesOptions` | iface | `packages/llm/src/to-model-messages.ts` | `{ stripImages?: boolean }` |

### 2.3 Entry `./adapter` — exported symbols

| Symbol | Kind | File | What |
| --- | --- | --- | --- |
| `AiSdkAdapter` | class | `packages/llm/src/ai-sdk-adapter.ts` | the `LLMProvider` over the AI SDK |
| `AiSdkProviderConfig` | iface | `packages/llm/src/ai-sdk-adapter.ts` | `{ resolveRegistryKey?; generateText?; streamText?; fetch?; resolveSubscription?; logger? }` |
| `AiSdkGuardrails` | iface | `packages/llm/src/ai-sdk-adapter.ts` | `{ timeoutMs?; maxResponseBytes?; maxSseEventBytes? }` |
| `SubscriptionRequestAuth` | iface | `packages/llm/src/ai-sdk-adapter.ts` | token-opaque `{ scheme; apply(input, init) }` request authority |
| `createBoundedFetch` | fn | `packages/llm/src/ai-sdk/bounded-fetch.ts` | `(options?) => typeof fetch` |
| `DEFAULT_PROVIDER_MAX_RESPONSE_BYTES` | const | `packages/llm/src/ai-sdk/bounded-fetch.ts` | `32 * 1024 * 1024` |
| `DEFAULT_PROVIDER_MAX_SSE_EVENT_BYTES` | const | `packages/llm/src/ai-sdk/bounded-fetch.ts` | `4 * 1024 * 1024` |
| `ProviderResponseLimitError` | class | `packages/llm/src/ai-sdk/bounded-fetch.ts` | `{ limit: "response" \| "sse_event"; maxBytes }` |
| `createStreamMetrics` | fn | `packages/llm/src/stream-metrics.ts` | `(path, source) => StreamMetrics` |
| `streamMetrics` | fn | `packages/llm/src/stream-metrics.ts` | `(source = "loop") => StreamMetrics` (process-wide memo) |
| `StreamMetrics` | iface | `packages/llm/src/stream-metrics.ts` | `{ count(name, n?) }` |

### 2.4 Modules with no entrypoint owner

`src/ai-sdk/errors.ts`, `src/ai-sdk/request-options.ts`, `src/ai-sdk/result.ts`,
`src/ai-sdk/streaming.ts`, `src/model-call-timeout-bridge.ts` and
`src/openai-compatible-request.ts` export symbols that neither `index.ts` nor `adapter.ts` names.
They are reachable only by relative path — which is how the unit tests import them, e.g.
`packages/llm/tests/unit/ai-sdk-modules.test.ts` and
`packages/llm/tests/unit/model-call-admission.test.ts`. Most of their individual exports are
described where their behavior is first discussed in sections 3–4 below (e.g.
`buildCallTuning`/`buildRequestOptions` in 3.2–3.5, `buildCallResult`/`normalizeUsage`/
`normalizeModelText` in 4.8, `toProviderError` in 4.9, `makeDeltaBatcher`/`makeToolInputReporter`
in 3.6/4.4); `openAICompatibleSettings` (`packages/llm/src/openai-compatible-request.ts`), whose
`includeUsage: true`/`baseUrl`-required/`transformRequestBody`-composing behavior is cited at
LLM-29 in section 5's invariants list, is one such export and is named here explicitly so that
citation is locatable by symbol, not only by line.

### 2.5 Environment variables read by this package

| Variable | Read at | Effect |
| --- | --- | --- |
| `CLARVIS_STREAM_DEBUG` | `packages/llm/src/stream-metrics.ts` | when non-empty, `streamMetrics()` returns a JSONL file sink instead of the no-op |
| *(any name)* | `packages/llm/src/ai-sdk-adapter.ts` | `process.env[name]` is the **default** credential/header resolver when `AiSdkProviderConfig.resolveRegistryKey` is absent |

There is no other environment read in `packages/llm/src`. The provider timeouts, retry budget and
transport bounds arrive as arguments from the host (`packages/loop/src/runtime/build-run-deps.ts`).

---

## 3. Data and formats

Nothing in this package is persisted except the optional stream-metrics JSONL. What it does define
are wire-shaped values.

### 3.1 The AI SDK call object

`buildRequestOptions` (`packages/llm/src/ai-sdk/request-options.ts`) returns `{ request, diagnostics }`, and
the adapter spreads only `request` onto the SDK call (`packages/llm/src/ai-sdk-adapter.ts`). The TSDoc
gives the reason for the two keys: "spreading one object onto the SDK call would put a
`diagnostics` field on the wire" (`packages/llm/src/ai-sdk/request-options.ts`).

`request` shape (`packages/llm/src/ai-sdk/request-options.ts`):

| Field | Type | Produced by |
| --- | --- | --- |
| `system?` | `string \| SystemModelMessage[]` | `splitSystemMessages`, array form only when a cache marker is attached |
| `headers?` | `Record<string,string>` | `{ "x-session-id": promptCacheKey }`, openai-compatible only |
| `messages` | `ModelMessage[]` | `split.rest` |
| `tools?` | `ToolSet` | `toAiSdkTools`, keyed by `wireName` |
| `toolChoice?` | AI SDK tool choice | `toAiSdkToolChoice`, only when `tools !== undefined` |
| `reasoning?` | `"none"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"` | `buildCallTuning` |
| `providerOptions?` | `Record<string, Record<string, JSONValue>>` | `buildCallTuning` |
| `maxOutputTokens?` | `number` | `buildCallTuning` |

The adapter adds `model`, `abortSignal` (when a signal exists) and a hard `maxRetries: 0`
(`packages/llm/src/ai-sdk-adapter.ts`) — the TSDoc says SDK retries are disabled "so
{@link withTransportRetry} owns retry policy" (`packages/llm/src/ai-sdk-adapter.ts`).

### 3.2 Reasoning and cache tuning, per provider `kind`

`buildCallTuning` (`packages/llm/src/ai-sdk/request-options.ts`), pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts`:

| `kind` | `reasoningEffort` route | shape emitted | `reasoning_path` |
| --- | --- | --- | --- |
| `openai` | `providerOptions.openai.reasoningEffort`; `"off"` → `"none"` | `{ openai: { reasoningEffort } }` | `"openai"` |
| `openai-codex`, `xai-grok` | the same OpenAI Responses option; `"off"` → `"none"` | `{ openai: { store: false, forceReasoning: true, reasoningEffort } }` | `"openai"` |
| `openai-compatible` | `providerOptions.openaiCompatible.reasoningEffort`; `"off"` → `"none"` | `{ openaiCompatible: { reasoningEffort } }` | `"compatible"` |
| `anthropic`, effort `"max"` | `providerOptions.anthropic.effort = "max"` | bypasses the standardized field | `"anthropic_max"` |
| `anthropic`, other | top-level `reasoning`; `"off"` → `"none"` (floor computed) | `reasoning: <effort>` | `"standard"` |
| `google` | top-level `reasoning`; `"off"`→`"none"`, `"max"`→`"xhigh"` | `reasoning: <effort>` | `"standard"` |

Additional per-kind fields:

- `openai-compatible` always gets `usage: { include: true }` (the field itself), and when `promptCacheKey` is set, both `prompt_cache_key` **and** `session_id` carrying
  the same value.
- `openai`, `openai-codex`, and `xai-grok` get `promptCacheKey` (camelCase, serialized by the
  Responses adapter as `prompt_cache_key`) when a key is set. Grok still receives no OpenAI cache
  breakpoint.
- Anthropic non-`off` effort also computes `thinkingFloor = reasoningOutputFloor(kind, effort)`
   and the effective cap becomes `Math.max(configured, thinkingFloor)`. The
  floor table is `packages/capability/src/reasoning-budget.ts` plus a fixed
  `ANTHROPIC_ANSWER_HEADROOM_TOKENS = 8192`; the test pins `low → 10 240`,
  `xhigh → 24 576`, `max → 40 960`
  (`packages/llm/tests/unit/ai-sdk-modules.test.ts`).

`reasoningSummary` is limited to `openai`, `openai-codex`, and `xai-grok`, and only when not `"off"`
(`packages/llm/src/ai-sdk/request-options.ts`);
`packages/llm/tests/unit/ai-sdk-modules.test.ts` asserts an Anthropic call given a
`reasoningSummary` produces `providerOptions === undefined`.

`openai-codex` deliberately omits `maxOutputTokens` even when configured, while `xai-grok` retains
it (`packages/llm/src/ai-sdk/request-options.ts`), because the ChatGPT Codex Responses
transport rejects that output cap. The real SDK request-shape test pins both subscription paths at
`packages/llm/tests/integration/provider-request-shape.test.ts`.

### 3.3 The `RequestDiagnostics` record

`RequestCacheDiagnostics` (`packages/llm/src/ai-sdk/request-options.ts`) and
`RequestTuningDiagnostics` are computed values the adapter logs and never forwards. The
cache record's fields and how each is derived (`packages/llm/src/ai-sdk/request-options.ts`):

| Field | Derivation |
| --- | --- |
| `kind?`, `mode?` | `providerConfig.kind` / `.promptCache`, omitted when absent |
| `marked` | `"anthropic"` \| `"compatible"` \| `"none"` |
| `requested_breakpoints` | `params.cacheBreakpoints?.length ?? 0` |
| `applied_breakpoints` | count actually marked |
| `walked_back` | compatible; a requested index that moved to an earlier markable message |
| `system_marked` | a system block exists **and** this kind marks |
| `cache_key_sent` | `promptCacheKey` set **and** kind is `openai`, `openai-codex`, `xai-grok`, or `openai-compatible` |
| `session_pinned` | the `x-session-id` header was emitted (openai-compatible + key) |
| `ttl?` | `params.promptCacheTtl` |

A no-provider call produces exactly `marked: "none"`, both breakpoint counts equal to zero, and
`walked_back`, `system_marked`, `cache_key_sent`, and `session_pinned` all false
— pinned by `packages/llm/tests/unit/observability.test.ts`.

### 3.4 The `openai-compatible` cache-marker sentinel

`CACHE_MARKER_KEY = "__clarvis_cache_control"` (`packages/llm/src/openai-compatible-request.ts`). It rides
inside `providerOptions.openaiCompatible` (`cacheMarkerOptions`), and is consumed and
deleted by `applyCacheControlMarkers` inside the client's `transformRequestBody`. Its TSDoc records the mechanism: identity-based marking rather than index-based, because
"the caller's array is reshaped three times before it becomes `body.messages`"
(`packages/llm/src/openai-compatible-request.ts`), and it "**must** delete it" or it is "an unknown
top-level message field: a 400 from a strict provider, silently ignored by a lax one".

Real wire evidence: `packages/llm/tests/integration/provider-request-shape.test.ts` asserts
the serialized body contains `cache_control` and does **not** contain `__clarvis_cache_control`.

### 3.5 What an `openai-compatible` request body actually contains

`packages/llm/tests/integration/wire-cache-diff.test.ts` pins the complete top-level key set
of a real `@ai-sdk/openai-compatible` request built by this adapter:

```
["max_tokens", "messages", "model", "prompt_cache_key", "session_id", "usage"]
```

The same wire-cache integration test pins
`body.session_id === body.prompt_cache_key === headers["x-session-id"]` across three turns.

### 3.6 Stream-metrics JSONL

`createStreamMetrics` (`packages/llm/src/stream-metrics.ts`) appends one JSON object per line to the file named
by `CLARVIS_STREAM_DEBUG`. Two record shapes:

- a window line, every 1000 ms, carrying
  `{ at, source, window_ms, counts, rates, rss, heap_used, external }` — emitted even
  when `counts` is empty ( produce `{}`);
- a totals line on `process.on("exit")`, only when `totals.size > 0`:
  `{ at, source, totals }`.

Counters written by this package: `provider_delta`, `provider_chars`, and
`batcher_flush_<channel>` (`packages/llm/src/ai-sdk/streaming.ts`).

---

## 4. Behavior

### 4.1 Provider construction — the lazy boundary

`createAiSdkProvider` (`packages/llm/src/lazy.ts`) returns an `LLMProvider` whose `call` memoizes a build
promise. The source performs `await import("./ai-sdk-adapter.ts")` and constructs
`AiSdkAdapter` with `resolveRegistryKey`/`resolveSubscription`/`logger` as the config and
`timeoutMs`/`maxResponseBytes`/`maxSseEventBytes` as guardrails. Only `import type`
reaches `@clarvis/capability` from this module (`packages/llm/src/lazy.ts`), which is what keeps the main entry
SDK-free.

`packages/llm/tests/component/lazy.test.ts` asserts the credential resolver is not called
before the first `call` asserts the first call reaches the configured base URL and threads
the resolver's value into the `Authorization` header.

### 4.2 One model call, in the order `AiSdkAdapter.call` runs it

`packages/llm/src/ai-sdk-adapter.ts`:

1. **Refuse an unresolved provider.** No `params.providerConfig` → `ProviderError` kind `"client"`.
2. **Build the client** via `resolveRegistryModel` → `buildRegistryFactory`. Ordering inside:
   - resolve the key through `resolveRegistryKey ?? process.env`;
   - resolve `${VAR}` headers through the *same* lookup (`packages/llm/src/openai-compatible-request.ts`);
   - if `apiKeyEnv` is named but unset → `ProviderError` kind `"client"` naming the variable;
   - switch on `kind`: `openai`/`anthropic`/`google` call `requireKey()`, `openai-compatible` uses
     its optional API key, and `openai-codex`/`xai-grok` require `resolveSubscription`, resolve fresh
     request authority at the physical fetch boundary, and use fixed Responses base URLs
     (`packages/llm/src/ai-sdk-adapter.ts`). The placeholder SDK key is never sent because
     `SubscriptionRequestAuth.apply` owns the final authenticated request; the integration test
     asserts this at `packages/llm/tests/integration/provider-request-shape.test.ts`.
3. **Describe the pair once** — `describeResolvedModel` emits `llm.provider.resolved` at
   `debug`, memoized on `` `${provider}` + U+0000 + `${modelId}` `` in `describedModels`. It runs
   *after* the factory, so a rejected configuration produces no line at all
   (`packages/llm/tests/component/ai-sdk-adapter-observability.test.ts`).
4. **Layer the timeout** — `timeoutAbort(timeoutMs ?? defaultTimeoutMs, params.signal, bridge)`.
   With no positive timeout it returns the parent signal unchanged; otherwise it combines the two
   with `AbortSignal.any`. Streaming parts call `markActivity()`, which updates one timestamp; the
   single timer checks that timestamp and re-arms at most once per timeout window. The configured
   value is therefore an inactivity window for streaming and an absolute bound for generation,
   where no progress signal exists. On expiry the controller aborts with the bridge's
   `ModelCallInactivityError`.
5. **Decide image stripping** — `stripImages = !(params.capabilities?.has("vision") ?? true)`.
6. **Convert** — `toModelMessages(params.messages, { stripImages })`, then
   `buildRequestOptions`, then `reportRequest`.
7. **Branch.** `openai-codex`, or any call with `onStreamDelta`, uses the streaming path below.
   Every other call without `onStreamDelta` uses `generateText(callArgs)` and
   `buildCallResult(result)`. The subscription exception is required by the pinned ChatGPT Codex
   Responses transport, which rejects `stream: false`; an internal caller may discard deltas but
   may not select one-shot generation.
8. **Finally** — `batcher?.dispose(); cleanup();`.

Production: `AiSdkAdapter.call` in `packages/llm/src/ai-sdk-adapter.ts`
(`providerRequiresStream`, the generation branch, and the no-op delta sink). Test:
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts` (`"streams ChatGPT subscription
calls even without a delta consumer"`).

### 4.3 The streaming path

`packages/llm/src/ai-sdk-adapter.ts`:

- `Output.text()` is replaced by `nonRetainingTextOutput`, whose `parsePartialOutput` returns
  `{ partial: text.length }`. `packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`
  calls that function directly and asserts it answers `{ partial: 29 }` for a 29-character prefix,
  under the title "uses a non-cumulative partial output and never reads aggregate getters".
- `streamText` is given `onError` (records the first error), `onStepEnd` and `onEnd` (both keep
  `partialUsage`; `onEnd` also captures the aggregate). Each callback and each yielded stream part
  calls `markActivity()`, resetting the inactivity window without allocating a timer or log record
  per part.
- The part loop maps each part type:

| Part type | Effect |
| --- | --- |
| `text-delta` | first-output report `"text"`; `batcher.push("text", …)` |
| `reasoning-delta` | first-output report `"reasoning"`; `batcher.push("reasoning", …)` |
| `tool-input-start` / `-delta` / `-end` | first-output report `"tool_input"`; forwarded to `makeToolInputReporter`; `-end` emits final cumulative argument and provider-stream counts with `complete: true` |
| `finish-step` | `partialUsage = part.usage` |
| `finish` | `partialUsage = part.totalUsage` |
| `tool-call` / `file` / `source` | first-output report with that channel name |
| `error` | `streamError ??= part.error` |

  `firstOutput` emits `llm.stream.first_token` at `debug` exactly once, carrying `ttft_ms` and the
  channel, and marks the admission timeout bridge as stream-started. Its TSDoc states the constraint
  directly: a `logger.debug` per delta is forbidden because this loop runs thousands of times per
  call.
- After `batcher.flush()`, a `streamError` is turned into an error. **The timeout is recognised here,
  before generic mapping**, so it retains the explicit inactivity subtype and the stream's available
  attempt evidence. The outer catch performs the same recognition for async throws that bypass a
  structured stream-error part.
- No error but `aggregate === undefined` → `llm.stream.no_aggregate` at `warn` and a `ProviderError`
  of kind `"transient"`. Pinned by
  `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts`.
- Otherwise `buildCallResult(aggregate)` and merge any stream-retained text lifecycle metadata;
  subscription-backed results additionally carry `billing_source: "subscription"`
  (`packages/llm/src/ai-sdk-adapter.ts`).

`streamStarted` is computed as `outputObserved || batcher.emitted()` — a
`tool-input-start` alone is enough, pinned by
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`.

### 4.4 Delta batching

`makeDeltaBatcher` (`packages/llm/src/ai-sdk/streaming.ts`) with defaults `{ maxChars: 384, maxMs: 64 }`. Behaviour:

| Event | Condition | Effect |
| --- | --- | --- |
| `push(ch, text)` | `text.length === 0` | return |
| `push(ch, text)` | `ch !== channel` | `flush()` first, so channels never merge |
| `push` | `buf.length >= maxChars` or `now - lastFlush >= maxMs` | `flush()` |
| `push` | otherwise | `arm()` an idle timer for `maxMs` |
| idle timer fires | buffer non-empty | `flush()`; a throw is captured into `sinkError` |
| `flush()` | `sinkError` set | rethrow it (wrapping a non-`Error` in `new Error(…, { cause })`) |
| `flush()` | first batch of a channel | `reset: true` |
| `dispose()` | — | `disarm()` only |

Tool arguments use the separate `makeToolInputReporter` cumulative throttle. `start` publishes the
tool identity with `chars: 0`; `delta` counts every argument fragment while `observe` adds text and
reasoning characters to the distinct physical-attempt `stream_chars` total. Reports forward at most
once per call per `TOOL_INPUT_REPORT_MS = 250`; `end` always forwards the final counts with
`complete: true`. Calls are
keyed by `call_id`, so interleaved parallel argument streams neither merge nor imply one another has
finished. Production: `makeToolInputReporter`. Test:
`packages/llm/tests/unit/delta-batcher.test.ts` and
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`.

The idle timer's TSDoc names the failure it closes: without it, "the tail of the last sentence sat
in `buf` until the whole stream drained", because "the provider stops sending text the moment it
starts emitting tool-call arguments" (`packages/llm/src/ai-sdk/streaming.ts`, within the `@remarks`
docblock).

`makeToolInputReporter` is a **throttle**, not a batcher: `TOOL_INPUT_REPORT_MS = 250`, argument `chars` and attempt-wide `stream_chars` are cumulative, `start` reports
immediately with `chars: 0`, `delta` and `observe` skip a report inside the window, `end` always
reports and deletes the entry, and a `delta` for an unknown `call_id` is ignored rather than
inferred.

### 4.5 Prompt-cache breakpoint placement

Two mutually exclusive marker paths are chosen by `buildRequestOptions`:

- `markAnthropic = kind === "anthropic" && promptCache !== "off"` — so absent `promptCache` still
  marks.
- `markCompatible = kind === "openai-compatible" && promptCache === "explicit" && cacheBreakpoints !== undefined`.

**Anthropic** — `withCacheBreakpoints` over `cacheBreakpointTargets` :
`undefined` requested rolls a single breakpoint onto the newest usable message;
otherwise out-of-range, duplicate and system-role indices are discarded and at most
`MAX_MESSAGE_CACHE_BREAKPOINTS = 2` newest survive. The system block is marked
separately. Pinned by `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**openai-compatible** — `withOpenAICompatibleCacheMarkers`. `requested === undefined` marks
**nothing**; the TSDoc explains that "on a provider that bills to create an entry a marker
there is a pure surcharge for a prefix no later request can match". A requested index
whose message cannot carry a marker walks **back** to the newest one that can, skipping indices
another target already claimed, setting `walkedBack`.

`markerSiteOf` decides where a marker survives serialisation:

| Message shape | Site |
| --- | --- |
| `role: "tool"` | `"none"` |
| assistant with any `tool-call` part | `"none"` |
| no text at all | `"none"` |
| user with string content or exactly one part | `"only-part"` |
| anything else | `"message"` |

`markMessage` attaches to exactly one site, promoting a string to a single text part on the
`"only-part"` path.

On the wire, `applyCacheControlMarkers` (`packages/llm/src/openai-compatible-request.ts`) then rewrites:

| Wire content | Result |
| --- | --- |
| `role: "tool"` or any `tool_calls` present | markers stripped, content untouched |
| plain string | one `{type:"text", text, cache_control:{type:"ephemeral"}}` block |
| block array | marker on the **last** text block, all sentinels stripped |
| `null` content | marker dropped, nothing else changes |

A message counts as marked from **either** the message or any block, and an unmarked
body is returned by identity (`touched` guard) — pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts`.

The two transforms compose as `applyCacheControlMarkers(applyBodyExtras(args, extras))`
(`packages/llm/src/openai-compatible-request.ts`) — body extras first, markers second.

**Native OpenAI Responses** — `openai` and `openai-codex` never enter either marker transform.
Their provider-managed cache receives the run-stable `promptCacheKey`, serialized as
`prompt_cache_key`, and the original message shapes remain untouched even when a generic model
setting says `promptCache === "explicit"`. models.dev publishes cache pricing, not an endpoint-level
inline-marker capability, and the ChatGPT subscription transport rejects
`prompt_cache_breakpoint`. Pinned by `packages/llm/tests/unit/ai-sdk-modules.test.ts`,
`packages/llm/tests/unit/observability.test.ts`, and the real wire assertions in
`packages/llm/tests/integration/provider-request-shape.test.ts`.

### 4.6 `applyBodyExtras`

`packages/llm/src/openai-compatible-request.ts`: `undefined` extras return the body by identity;
a key in `FORBIDDEN_PROVIDER_BODY_KEYS` (`packages/capability/src/provider-resolver.ts`:
`messages`, `tools`, `model`, `stream`, `tool_choice`) is skipped; a `null` value **deletes**
the key rather than sending `null`. Pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts`, and end-to-end at
`packages/llm/tests/integration/provider-request-shape.test.ts`, where `messages`, `model`
and `tools` supplied through `body` do not reach the wire while `session_id: "session-1"` does.

### 4.7 Message conversion

`toModelMessages` (`packages/llm/src/to-model-messages.ts`) makes one indexing pass over assistant
`tool_calls` to build `toolNameById`, then maps:

| Role | Output |
| --- | --- |
| `tool` with images (and not stripping) | `output: { type: "content", value: [text?, …file parts] }` |
| `tool` otherwise | `output: { type: "text", value: content }`; `toolName` falls back to `"unknown"` |
| `assistant` with reasoning, retained text parts or tool calls | `[…reasoning parts, …retained text parts (including provider options), …tool-call parts]`; otherwise one text part when non-empty; `input: tc.arguments ?? {}` |
| `assistant` plain | `content: contentToText(m.content)` |
| `system` | `content: contentToText(m.content)` |
| `user` | `toUserContent(...)` |

`toUserContent` with `stripImages` replaces each image with
`` `[image #${idx} omitted: active model lacks vision]` `` using a counter shared across the
whole message list, so numbering is global and monotonic —
`packages/llm/tests/unit/to-model-messages.test.ts` pins that ordering.

### 4.8 Result normalization

`buildCallResult` (`packages/llm/src/ai-sdk/result.ts`):

- `normalizeModelText` removes C0/C1 control bytes except tab/newline/CR
  and returns `undefined` when only whitespace remains.
- Every tool call's `input` goes through `normalizeToolArguments`
  (`packages/capability/src/tool-arguments.ts`); a failure yields `arguments: {}` **plus**
  `malformedArguments: norm.preview` (`packages/llm/src/ai-sdk/result.ts`). The TSDoc states the
  consequence of not normalizing here: a raw string "comes back **double-encoded** on the next
  request, so the model's own history demonstrates the malformed shape and it reproduces it", and notes the SDK cannot catch it because `toAiSdkTools` builds each tool with a bare
  `jsonSchema(...)` and no `validate`.
- `reasoningParts` are lifted from the **last** assistant message in `responseMessages`, preserving opaque `providerOptions`. Round-tripped end to end for Anthropic
  signatures (`packages/llm/tests/integration/provider-request-shape.test.ts`), OpenAI
  `item_reference` and openai-compatible `reasoning_content`.
- `textParts` retain assistant text plus opaque provider options and normalize only the public
  `commentary`/`final_answer` phase. `buildCallResult` accepts aggregate response messages/content,
  while `AiSdkAdapter.call` retains streaming text lifecycle metadata. `toModelMessages` replays the
  original parts instead of flattening them. Tests: “retains assistant text phase” in
  `packages/llm/tests/unit/ai-sdk-modules.test.ts`, “replays phased assistant text” in
  `packages/llm/tests/unit/to-model-messages.test.ts`, and “retains native Responses commentary
  metadata” in `packages/llm/tests/integration/provider-request-shape.test.ts`.
- `normalizeUsage` retains numeric zero placeholders and reads `inputTokenDetails` defensively.
  Missing or invalid input/output telemetry sets `usage_unknown`; missing cache-read telemetry
  sets `cache_unknown`. A provider's explicit valid zero sets neither flag. Production:
  `normalizeUsage` in [result.ts](../../packages/llm/src/ai-sdk/result.ts). Test: `separates missing
  usage from measured zero and preserves known input without cache detail` in
  [ai-sdk-modules.test.ts](../../packages/llm/tests/unit/ai-sdk-modules.test.ts).
  The compatible SDK's usage-converter hook preserves missing raw counters before SDK defaults
  can replace them with zero. It changes usage interpretation only, preserving request options
  and transport. Production: `convertCompatibleUsage` in
  [compatible-usage.ts](../../packages/llm/src/ai-sdk/compatible-usage.ts), installed by `AiSdkAdapter`.
  Test: missing-total and cache-only controls through actual SDK HTTP in
  [goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts).
- `raw.finishReason` passes through unmodified onto `LLMCallResult.finishReason` when present; absent, the field is simply omitted. Asserted end to end by
  `packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`
  (`res.finishReason === "tool-calls"`) and by
  `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

### 4.9 Error normalization — `toProviderError`

`packages/llm/src/ai-sdk/errors.ts`, in strict order:

| # | Condition | Result |
| --- | --- | --- |
| 1 | `findProviderResponseLimitError(err)` matches | `ProviderError(limit.message, { kind: "client", …extra })` |
| 2 | `APICallError.isInstance(err)` | classify with status/headers/body/`isRetryable`; message from `describeHttpFailure` |
| 3 | `readStructuredProviderError(err)` matches | classify the in-stream payload's own status |
| 4 | otherwise | `ProviderError("Model call failed (transport error).", …)` |

`readStructuredProviderError` accepts only a **non-`Error`** object, unwraps an
`error` key, requires a readable message via `pickBodyMessage`, and takes
`code`/`status` as an HTTP status only inside `[100, 599]`. Its TSDoc names the failure
it fixes: an OpenAI-compatible endpoint reporting a late failure as a data frame "fell to the
transport branch … and defaulted to the non-retryable `client` kind: a plainly retryable rate limit
then killed the run on its first occurrence". Pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts`, including the negative case: an `Error`
carrying `code: "ECONNRESET"` stays on the transport path.

Message composition (`describeHttpFailure`): `statusLabel(status)`, plus the
provider's own explanation when the body carried one, otherwise `statusGuidance(status)`. The explanation is `sanitizeErrorMessage`-redacted, whitespace-collapsed and capped at
`MAX_REASON_LEN = 200` with a trailing `…`. The exact strings for 401/402/403/404/
408/413/429/502 are pinned by `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

### 4.10 Classification — `classifyProviderError`

`packages/llm/src/classify-provider-error.ts`, evaluated top to bottom:

| Order | Rule | Kind |
| --- | --- | --- |
| 1 | body/cause text matches `OVERFLOW_SIGNALS` (10 entries) | `context_overflow` |
| 2 | text matches `QUOTA_SIGNALS` (5 entries) | `quota` |
| 3 | text matches `CONTENT_POLICY_SIGNALS` (8 entries) | `content_policy` |
| 4 | `status === 401 \|\| 403` | `auth` |
| 5 | `429`, `529`, `5xx`, `2xx`, `timedOut`, `isRetryable`, or (no status **and** network-like cause) | `transient` |
| 6 | any other `4xx` | `client` |
| 7 | text matches `OVERLOAD_SIGNALS` (8 entries) | `transient` |
| 8 | default | `client` |

The ordering is load-bearing in two places the code itself documents. Quota is tested **before**
content policy "a quota or billing body occasionally carries the word 'safety' in boilerplate, and
the reverse ordering would file a spend problem as a policy refusal"; and every
content-policy entry is multi-word or underscored because a bare `"safety"` "matched Azure and
Bedrock boilerplate that rides along on ordinary rate-limit and overload responses" and would have
turned those into permanent refusals. Both are pinned:
`packages/llm/tests/unit/classify-provider-error.test.ts` (incidental "safety" on a 429 stays
`transient`) (quota wins when both signals appear).

Rule 5's `2xx` arm is explained : "reaching the classifier with a success status means
the body was malformed or truncated" — pinned at
`packages/llm/tests/unit/classify-provider-error.test.ts`, with showing text signals
still beat it.

`isNetworkErrorLike` walks `name`/`message`/`code`, nested `cause` and aggregated
`errors`, to depth 3, against 22 signals.

Retry-delay extraction, `readRetryAfter`, in priority order: `retry-after-ms` (numeric,
already in ms), then `retry-after`, `x-ratelimit-reset-after`, `anthropic-ratelimit-unified-reset`
through `parseRetryAfter`. `parseRetryAfter` accepts whole **or decimal** seconds
 and an HTTP-date resolved against `now` and clamped to `0`.

### 4.11 Transport retry

`withTransportRetry` (`packages/llm/src/retry-llm-provider.ts`). `maxRetries <= 0` bypasses the loop but still
promotes `err.partialUsage` onto `err.accumulatedUsage`. Otherwise, per attempt
:

| Event | Effect |
| --- | --- |
| success | return `withLost(result)` — attaches `retriedUsage` only when something was lost |
| any `ProviderError` | `chargeLost(err)` accumulates `partialUsage` |
| not transient, or `attempt >= maxRetries`, or signal already aborted | `gaveUp(…)`, attach `accumulatedUsage`, rethrow |
| `err.streamStarted` and a live delta consumer is present | `gaveUp(err, "stream_started")`, rethrow — no retry, except for `ModelCallInactivityError` |
| `ModelCallInactivityError` | remains retryable after earlier visible progress; inactivity is the recovery boundary |
| `err.streamStarted` with no `onStreamDelta`/`onToolInputDelta` consumer | retry remains eligible; no partial turn escaped the aggregate call |
| `err.retryAfterMs > maxRetryAfterMs` | `gaveUp(err, "retry_after_too_long")`, rethrow |
| otherwise | `attempt += 1`, compute delay, fire `params.onRetry`, `warn`, sleep |
| abort during the sleep | `gaveUp(err, "aborted")`, rethrow |

`chargeLost` runs for **every** `ProviderError`, not only retryable ones; the TSDoc says a first-
attempt `auth` or `quota` failure "still billed whatever it read, and skipping it would make
`usage_attributed` report `false` for tokens that were in fact readable".

`backoffDelayMs` : a server-advised `retryAfterMs` wins, capped at `maxRetryAfterMs`; otherwise `min(maxDelayMs, base * 2^(n-1))` with up to 25% jitter, re-capped at
`maxDelayMs`. `packages/llm/tests/unit/retry-llm-provider.test.ts` asserts the cap
holds at maximum jitter.

`cancellableSleep` `unref`s its timer so a pending backoff never keeps the process alive.

The stream-started policy is consumer-relative. A text/reasoning or tool-input callback ordinarily
means a partial turn escaped and the prompt must not be replayed; an internal streaming transport
used only to assemble an aggregate result may retry because its caller observed nothing. The one
product exception is `ModelCallInactivityError`: once the provider has produced no new part for the
complete timeout window, retry remains the recovery path even if earlier tool-input progress was
visible. This is pinned by `packages/llm/tests/unit/retry-llm-provider.test.ts` under "POLICY: no
retry after a consumer observed the stream", including text, tool-input, consumerless internal-stream
and explicit inactivity-timeout cases.

A call's own `maxRetries`/`maxRetryAfterMs` on `params` take precedence over the decorator's
configured `opts` values: `maxRetries = params.maxRetries ?? opts.maxRetries` and
`maxRetryAfterMs = params.maxRetryAfterMs ?? opts.maxRetryAfterMs ?? maxDelayMs`, and
the function's own TSDoc states it directly. Pinned by
`packages/llm/tests/unit/retry-llm-provider.test.ts`, titled "reports the per-call
maxRetries override, not the wrapper default".

### 4.12 Call logging

`withCallLogging` (`packages/llm/src/logging-llm-provider.ts`). Every payload is behind a level guard
(`wantsDebug`/`wantsWarn`); `approxInputChars` is memoized per call through
`chars()` and its TSDoc forbids calling it outside a guard: "it is O(transcript) on every
physical model attempt, and `@clarvis/code` runs its kernel at `silent`".

| Moment | Record | Level | File |
| --- | --- | --- | --- |
| start | `llm.call.start` | debug | — |
| every 20 s in flight | `llm.call.pending` | warn | includes `stream_started` and, after progress, `last_progress_ms`; no per-delta log |
| return, `< 30 s` | `llm.call.done` | debug | — |
| return, `>= 30 s` | `llm.call.slow` | warn | — |
| throw | `llm.call.failed`, then rethrow unchanged | warn | — |

`attempt_of_call` counts physical attempts by keying a `WeakMap` on the params **object**, which works because "`withTransportRetry` sits *outside* this decorator and
re-enters `inner.call(params)` with the very same object". The pending interval is
`unref`'d and not armed at all when warnings are discarded.

### 4.13 Admission control

`ModelCallAdmissionController.call` (`packages/llm/src/model-call-admission.ts`):

1. `acquire(params.signal)`.
2. `bridgeModelCallTimeout(params)` attaches the timeout channel under a module-private `Symbol`
   (`packages/llm/src/model-call-timeout-bridge.ts`).
3. Callbacks are re-wrapped through mutable locals so they can be detached.
4. `Promise.race([outcome, aborted, timedOut])`.
5. Not interrupted → detach callbacks, release, return or rethrow.
6. Interrupted → race the outcome against an `abortSettleMs` timer. Settled in time →
   release; a rejection wins over the interruption error. Otherwise **quarantine**:
   increment, reject the whole queue, `llm.admission.stuck` at `warn`, arm a release on the
   eventual settlement, throw `ModelCallStuckError`.
7. `finally` → `bridged.bridge.cleanup()`.

State machine, from `snapshot()` and the mutators:

| State | Event | Next state | Effect |
| --- | --- | --- | --- |
| `open` | `acquire`, `signal.aborted === true` before enqueue | `open` | throw the signal's own abort error immediately, **not** `ModelCallUnavailableError` |
| `open` | `acquire`, `active < maxActive` and queue empty | `open` | permit granted |
| `open` | `acquire`, `queue.length >= maxQueued` | `open` | throw `ModelCallUnavailableError("queue_full")` |
| `open` | `inner.call(forwarded)` throws **synchronously** (not a rejected promise) | `open` | callbacks cleared, the just-taken permit released, error rethrown unchanged |
| `open` | `acquire`, otherwise | `open` | enqueue FIFO waiter |
| `open` | call settles | `open` | `release(false)` → `drain()` |
| `open` | interrupted call does not settle in `abortSettleMs` | `quarantined` | queue rejected, `warn`, `ModelCallStuckError` |
| `quarantined` | `acquire` | `quarantined` | throw `ModelCallUnavailableError("quarantined")` |
| `quarantined` | stuck transport finally settles | `open` | `quarantinedCount -= 1`, `release(true)` |
| any | `close()` | `closed` | queue rejected with `"closed"` |
| `closed` | `acquire` | `closed` | throw `ModelCallUnavailableError("closed")` |

`drain()` refuses to run while closed or quarantined and skips a waiter whose signal already
aborted. `changed()` swallows a throwing `onStateChange` with one of the package's few
non-TSDoc `//` comments: "Diagnostics are observers, never part of admission ownership. A broken
metrics sink must not strand an active permit or reject healthy work" — pinned by
`packages/llm/tests/unit/model-call-admission.test.ts`. `src/` carries several other such
comments (e.g. `packages/llm/src/model-call-timeout-bridge.ts`, `packages/llm/src/stream-metrics.ts`,
`packages/llm/src/ai-sdk/bounded-fetch.ts`, `packages/llm/src/ai-sdk/result.ts`), all explaining a similarly
non-obvious "must not fail loudly here" boundary.

Constructor validation is strict: `maxActive` must be a **positive** integer,
`maxQueued`/`abortSettleMs` non-negative integers; a violation is a `TypeError`.

### 4.14 The timeout bridge

`bridgeModelCallTimeout` returns params carrying the bridge under `MODEL_CALL_TIMEOUT_BRIDGE` plus
the bridge itself. `markStreamStarted` remembers whether provider output preceded an idle expiry.
`markTimedOut` mints one `ModelCallInactivityError`, including that stream-start fact, and resolves
the promise with it; the adapter's timeout branches enrich the cooperative failure with any
available partial usage before it crosses retry. `registerCleanup` returns an unregister closure and
is a no-op after `cleanup()`; `cleanup()` is idempotent and each
cleanup's throw is swallowed — "Timer cleanup is housekeeping. It must never replace a provider
result". `modelCallTimeoutBridgeOf` is what the adapter reads; it returns `undefined` when admission never wrapped the call
(`packages/llm/tests/unit/model-call-timeout-bridge.test.ts`).

This is what lets the admission gate release a permit on a *cooperative* timeout rather than
quarantining it — `packages/llm/tests/component/ai-sdk-adapter.test.ts` (`state: "open"`,
`active: 0`) (a transport that ignores the timeout → `ModelCallStuckError`,
`state: "quarantined"`).

### 4.15 Bounded fetch

`createBoundedFetch` (`packages/llm/src/ai-sdk/bounded-fetch.ts`) wraps the base fetch with its own
`AbortController` combined with the caller's signal, then:

| Check | Effect |
| --- | --- |
| declared `content-length > maxResponseBytes` | `reportLimit`, abort upstream, detach body cancel, throw before reading |
| `response.body === null` | pass through untouched |
| cumulative bytes `> maxResponseBytes` | `reportLimit`, `fail(controller, …)` |
| SSE only: bytes since the last delimiter `> maxSseEventBytes` | `reportLimit`, `fail(...)` |
| consumer cancels the wrapped body | abort upstream, cancel the reader |

The SSE scan counts `\n` as a line end, resets `eventBytes` on a blank line
(`lineBytes === 0`), and ignores `\r` — which is why a `\r\n\r\n` delimiter split across two source
chunks is still recognised (`packages/llm/tests/unit/bounded-fetch.test.ts`).

`detachCancellation` routes the cancel through `suppressSecondaryRejection`
(`packages/capability/src/tasks.ts`) so "a non-cooperative cancel algorithm" cannot delay the
already-decided outcome; both halves are pinned by
`packages/llm/tests/unit/bounded-fetch.test.ts`, which reject the cancellation
promise *after* the limit error has already surfaced.

`findProviderResponseLimitError` walks a `cause` chain to depth 8 with a `seen` set
against cycles.

### 4.16 Decorator composition, as the host wires it

`packages/loop/src/runtime/build-run-deps.ts` builds, innermost first:

```
createAiSdkProvider(...)                       :453
  → withModelCallAdmission(provider, gate)     :466
  → withCallLogging(..., logger)               :466
  → withTransportRetry(..., {...})             :465
```

and `packages/loop/src/runtime/execute-run.ts` wraps that again per run with
`withPromptCacheDefaults(deps.llm, { identity, promptCacheTtl })`. This places retry
**outside** logging, which is exactly the arrangement `attemptsByParams` depends on
(`packages/llm/src/logging-llm-provider.ts`), and admission **inside** logging, so each
physical attempt takes one permit.

---

## 5. Invariants

Numbered; each carries the production site and the test that pins it.

**LLM-1 (owns INV-032).** The main entry `src/index.ts` never statically reaches
`ai-sdk-adapter.ts` or `stream-metrics.ts`, and nothing it statically reaches names `ai` or any
`@ai-sdk/*` specifier.
Production: `packages/llm/src/index.ts`; the escape hatch is the dynamic
`await import("./ai-sdk-adapter.ts")` at `packages/llm/src/lazy.ts`.
Test: `packages/llm/tests/architecture/lazy-entry.test.ts`.

**LLM-2 (owns INV-033).** That walk is not vacuous: the main entry *does* statically reach
`retry-llm-provider.ts`, `logging-llm-provider.ts` and `lazy.ts`.
Production: `packages/llm/src/index.ts`.
Test: `packages/llm/tests/architecture/lazy-entry.test.ts`.

**LLM-3 (owns INV-034).** The `./adapter` entry *does* statically reach `ai-sdk-adapter.ts`.
Production: `packages/llm/src/adapter.ts`.
Test: `packages/llm/tests/architecture/lazy-entry.test.ts`.

**LLM-4.** The static-specifier extractor LLM-1..3 rest on must see bound imports, re-exports and
bare side-effect imports, and must erase `import type`, `export type` and dynamic `import()`.
Production: the regexes at `packages/llm/tests/architecture/lazy-entry.test.ts`.
Test: same file.

**LLM-5.** A provider declaring `apiKeyEnv` whose variable is unset fails locally with a
`ProviderError` naming the variable, before any request is sent — including for
`openai-compatible`, which otherwise requires no key.
Production: `packages/llm/src/ai-sdk-adapter.ts` (and the keyless path).
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts` (asserts the variable name is in
the message and `generateText` was never called) (a keyless endpoint declaring nothing
still works).

**LLM-6.** `llm.provider.resolved` is emitted at most once per `(provider, model)` pair, never at
all when the client could not be built, and carries the base URL's **host only**, header **names**
only, and the API key as a boolean.
Production: `packages/llm/src/ai-sdk-adapter.ts`, `hostOf`, ordering.
Test: `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts` (no `sk-`, no header
value, no path) (unparsable URL omitted) (once per pair) (silent
on a build failure).

**LLM-7.** A cache breakpoint the caller asked for that did not reach the request is reported at
`warn`, and is reported even when `debug` is off.
Production: `packages/llm/src/ai-sdk-adapter.ts`.
Test: `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts` (`none_markable`) (`collapsed`) (silent when the kind never marks) (warn-only logger
still gets it).

**LLM-8.** The request `diagnostics` object never reaches a provider: it is a separate return key
from `request`, and only `request` is spread onto the SDK call.
Production: `packages/llm/src/ai-sdk/request-options.ts`; the spread at
`packages/llm/src/ai-sdk-adapter.ts`.
Test: `packages/llm/tests/integration/wire-cache-diff.test.ts` pins the exact top-level key
set of the serialized body, which contains no `diagnostics`.

**LLM-9.** SDK-level retries are disabled on every call (`maxRetries: 0`), so `withTransportRetry`
is the sole retry authority.
Production: `packages/llm/src/ai-sdk-adapter.ts`.
Test: **unpinned** — no test asserts `callArgs.maxRetries === 0`.

**LLM-10.** A per-call timeout is a `ModelCallInactivityError` classified as `transient`, never as a
permanent `client` fault. On a streaming path the deadline resets on every provider part; generation
has no progress signal and remains absolutely bounded.
Production: `timeoutAbort` and both timeout branches in `AiSdkAdapter.call`.
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts` (generate) and
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts` (silent timeout and active stream).

**LLM-11.** A stream that ends with no aggregate is a **transient** failure, reported at `warn` with
`stream_started` and `partial_output_tokens`.
Production: `packages/llm/src/ai-sdk-adapter.ts`.
Test: `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts`.

**LLM-12.** `streamStarted` is true if any output was observed **or** the batcher emitted anything —
a `tool-input-start` before any prose counts — and the timeout bridge receives the same fact.
Production: `firstOutput` and timeout attempt-cost construction in `AiSdkAdapter.call`; `emitted()`
in `makeDeltaBatcher`.
Test: `packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts` (tool-input error and timeout bridge).

**LLM-13.** A transient failure whose stream reached `onStreamDelta` or `onToolInputDelta` is **not**
retried, except for `ModelCallInactivityError`: a full timeout window with no new part deliberately
remains retryable. A consumerless internal stream may retry even when the provider observed output,
because no partial turn escaped to the caller.
Production: `packages/llm/src/retry-llm-provider.ts` (`streamedToConsumer`).
Test: `packages/llm/tests/unit/retry-llm-provider.test.ts` ("refuses to retry a transient failure that
already emitted output", "retries an internal stream that no consumer observed", and "does not retry
after a tool-input consumer observed the stream", plus "retries an explicit inactivity timeout after
tool-input progress stopped").
Test: `packages/llm/tests/unit/retry-llm-provider.test.ts`.

**LLM-14.** Every failed `ProviderError` attempt's `partialUsage` is accumulated and surfaced —
as `retriedUsage` on an eventual success, or as `accumulatedUsage` on the final error. An unreported
attempt keeps `usage_unknown` and `cache_unknown` beside the numeric partial totals; adding a
later measured attempt never clears that uncertainty. With retries disabled, missing partial
usage remains absent and is likewise unknown to host accounting.
Production: `packages/llm/src/retry-llm-provider.ts`;
also the `maxRetries <= 0` path.
Test: `packages/llm/tests/unit/retry-llm-provider.test.ts` (accumulates onto success), `retains uncertainty when no failed attempt reported usage`, and `preserves known failed-attempt counters while retaining a separate unreported attempt`
(`accumulatedUsage` on exhaustion) (promoted with no retry loop).

**LLM-15.** Only `kind === "transient"` is retried. `client`, `auth`, `quota`, `content_policy` and
`context_overflow` are terminal, as is any non-`ProviderError` throw.
Production: `packages/llm/src/retry-llm-provider.ts`.
Test: `packages/llm/tests/unit/retry-llm-provider.test.ts`.

**LLM-16.** Classification order is: overflow text → quota text → content-policy text → 401/403 →
retryable statuses/flags → other 4xx → overload text → default `client`.
Production: `packages/llm/src/classify-provider-error.ts`.
Test: `packages/llm/tests/unit/classify-provider-error.test.ts` (quota before content
policy) (incidental "safety" on a 429 stays transient) (4xx with overload
text is `client`) (overload text with no definitive 4xx is transient)
(unknown payload defaults to `client`).

**LLM-17.** A 2xx status reaching the classifier is `transient`, but explicit text signals override
it.
Production: `packages/llm/src/classify-provider-error.ts`, ahead of the / guards.
Test: `packages/llm/tests/unit/classify-provider-error.test.ts`.

**LLM-18.** A structured provider error delivered *inside* a 200 stream is classified on its own
`code`/`status`, and an `Error` carrying an errno-shaped `code` is not.
Production: `packages/llm/src/ai-sdk/errors.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**LLM-19.** A provider's own error text is surfaced but secret-redacted and bounded at 200
characters plus an ellipsis; a bare transport failure surfaces no message at all.
Production: `packages/llm/src/ai-sdk/errors.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts` (redaction) (extraction variants and the `<= 224`-character bound ending in `…`) ("maps a transport failure without leaking its message").

**LLM-20.** `retry-after-ms` is preferred over `retry-after`, and decimal seconds are accepted.
Production: `packages/llm/src/classify-provider-error.ts`.
Test: `packages/llm/tests/unit/classify-provider-error.test.ts`.

**LLM-21.** `withPromptCacheDefaults` fills the key and the TTL **independently**; a call pinning
one still inherits the other.
Production: `packages/llm/src/prompt-cache-provider.ts`.
Test: `packages/llm/tests/unit/prompt-cache-provider.test.ts`.

**LLM-22.** An `openai-compatible` request carrying a `promptCacheKey` pins the backend on **both**
halves — `session_id` in the body and `x-session-id` as a header — with the same value; no other
kind gets either. This condition (`kind === "openai-compatible" && promptCacheKey !== undefined`) does not test `promptCache` at all, so the pin is sent even under `implicit` mode, where
no `cache_control` marker is ever applied — pinning and marking are fully decoupled decisions.
Production: `packages/llm/src/ai-sdk/request-options.ts`.
Test: `packages/llm/tests/integration/wire-cache-diff.test.ts` (asserts a stable
`prompt_cache_key`/header pair across turns run under `promptCache: "implicit"` while no
`cache_control`/sentinel ever appears),
`packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**LLM-23.** An `implicit` prompt-cache mode sends no `cache_control` and no sentinel, and the wire
prefix stays byte-identical turn over turn.
Production: `markCompatible` requires `mode === "explicit"`
(`packages/llm/src/ai-sdk/request-options.ts`).
Test: `packages/llm/tests/integration/wire-cache-diff.test.ts`.

**LLM-24.** The `__clarvis_cache_control` sentinel never reaches the wire, wherever it landed.
Production: `packages/llm/src/openai-compatible-request.ts` (message level)
(unconditional block sweep).
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts`;
end-to-end at `packages/llm/tests/integration/provider-request-shape.test.ts`.

**LLM-25.** A `role: "tool"` message, and any message carrying `tool_calls`, keeps its wire `content`
a plain string — never promoted to a block array — and the breakpoint walks back instead. The
sentinel is stripped from such a message unconditionally even when nothing in `@clarvis/llm` itself
marked it, "for a host that builds its own markers with no adapter in the path": several
OpenAI-compatible gateways accept only a string as `content` there, so promoting it to a block array
"is a schema change unrelated to caching that reads as an unrelated 400"
(`packages/llm/src/openai-compatible-request.ts`).
Production: `markerSiteOf` (`packages/llm/src/ai-sdk/request-options.ts`) and
`applyCacheControlMarkers` (`packages/llm/src/openai-compatible-request.ts`).
Test: `packages/llm/tests/integration/provider-request-shape.test.ts` (asserts both contents
are strings, neither carries `cache_control`, and the markers landed at indices `[0, 1]`);
`packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**LLM-26.** At most two message-level cache breakpoints per request on the Anthropic and
openai-compatible paths; a system-role index is discarded rather than consuming a slot; two
requested indices that walk back never claim the same message.
Production: `MAX_MESSAGE_CACHE_BREAKPOINTS`, `cacheBreakpointTargets`, and
`withOpenAICompatibleCacheMarkers` in
`packages/llm/src/ai-sdk/request-options.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts` and
`packages/llm/tests/unit/observability.test.ts`.

**LLM-27.** `undefined` `cacheBreakpoints` marks nothing on openai-compatible, but rolls a single
breakpoint onto the newest usable message on Anthropic. Native OpenAI never uses these indices.
Production: `withOpenAICompatibleCacheMarkers` and `cacheBreakpointTargets` in
`packages/llm/src/ai-sdk/request-options.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**LLM-28.** `FORBIDDEN_PROVIDER_BODY_KEYS` are dropped from the operator's `body` escape hatch even
with no settings schema in the path, and a `null` value **deletes** the key rather than sending
`null`.
Production: `packages/llm/src/openai-compatible-request.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts`;
end-to-end at `packages/llm/tests/integration/provider-request-shape.test.ts`.

**LLM-29.** `includeUsage: true` is unconditional for `openai-compatible`, so the standard
`stream_options: { include_usage: true }` is always requested.
Production: `packages/llm/src/openai-compatible-request.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**LLM-30.** An unset `${VAR}` in a configured header fails fast as a `client` `ProviderError`
naming the variables, rather than escaping as a `MissingEnvVarsError` the outer catch would classify
as transient; a non-`MissingEnvVarsError` throw from the lookup propagates unchanged.
Production: `packages/llm/src/openai-compatible-request.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**LLM-31.** Tool arguments are normalized exactly once, where the SDK output becomes an
`LLMToolCall`; a malformed payload yields `{}` plus a `malformedArguments` preview, never a silent
`{}`.
Production: `packages/llm/src/ai-sdk/result.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts`.

**LLM-32.** Model text has C0/C1 control characters stripped (tab, LF and CR kept) and collapses to
`undefined` when only whitespace remains; a large body is processed by one linear replacement, never
by a codepoint array.
Production: `packages/llm/src/ai-sdk/result.ts` (with the reason in one of
`src/`'s few non-TSDoc comments).
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts` (including a 1 MiB body).

**LLM-33.** Images are stripped exactly when the resolved model lacks the `"vision"` capability, and
a stripped image becomes a **numbered placeholder**, never a dropped part; numbering is global across
the whole message list.
Production: `packages/llm/src/ai-sdk-adapter.ts`;
`packages/llm/src/to-model-messages.ts`.
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts`;
`packages/llm/tests/unit/to-model-messages.test.ts`.

**LLM-34.** The admission gate defaults to 4 active and 8 queued calls, admits FIFO, and refuses a
call beyond the queue with `ModelCallUnavailableError("queue_full")`.
Production: `packages/llm/src/model-call-admission.ts`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts`.

**LLM-35.** A cancelled transport that has not exited within `abortSettleMs` quarantines the gate:
the queue is rejected, new calls are refused, and the gate reopens only when that transport finally
settles — whether it resolves or rejects.
Production: `packages/llm/src/model-call-admission.ts`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts` (resolves)
(rejects).

**LLM-36.** A throwing `onStateChange` observer can neither strand a permit nor reject healthy work.
Production: `packages/llm/src/model-call-admission.ts`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts`.

**LLM-37.** Admission forwards the caller's `onStreamDelta`/`onToolInputDelta`/`onRetry` and detaches
them the moment the call settles, so a late emission from the same provider handle is dropped.
Production: `packages/llm/src/model-call-admission.ts`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts`.

**LLM-38.** A per-call timeout observed through the bridge releases a **cooperative** transport's
permit (state stays `open`), while a transport that ignores it is quarantined.
Production: bridge at `packages/llm/src/model-call-timeout-bridge.ts`, consumed at
`packages/llm/src/ai-sdk-adapter.ts`, raced at
`packages/llm/src/model-call-admission.ts`.
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts`.

**LLM-39.** `admissionStateLogger` emits one `info` per state **transition**, deduped per instance,
never per snapshot.
Production: `packages/llm/src/model-call-admission.ts`.
Test: `packages/llm/tests/unit/observability.test.ts`.

**LLM-40.** A provider response exceeding the byte bound, or an SSE event never reaching a
delimiter, fails the attempt as a non-retryable `client` error, and the failure does not wait on a
non-cooperative cancel algorithm.
Production: `packages/llm/src/ai-sdk/bounded-fetch.ts`;
flattening to `client` at `packages/llm/src/ai-sdk/errors.ts`.
Test: `packages/llm/tests/unit/bounded-fetch.test.ts`; end-to-end at
`packages/llm/tests/integration/provider-request-shape.test.ts` (asserts
`kind: "client"` and a message containing "SSE event exceeded").

**LLM-41.** Cancelling the bounded body aborts the upstream request and cancels the source reader.
Production: `packages/llm/src/ai-sdk/bounded-fetch.ts`.
Test: `packages/llm/tests/unit/bounded-fetch.test.ts`.

**LLM-42.** The batcher never leaves a tail stranded: an idle timer flushes after `maxMs` with no
further delta, and a channel switch flushes first so text and reasoning never merge.
Production: `packages/llm/src/ai-sdk/streaming.ts`.
Test: `packages/llm/tests/unit/delta-batcher.test.ts`.

**LLM-43.** A sink failure raised inside the idle timer is captured and surfaced on the owning call,
including a non-`Error` throw.
Production: `packages/llm/src/ai-sdk/streaming.ts`.
Test: `packages/llm/tests/unit/delta-batcher.test.ts`.

**LLM-44.** `logging-llm-provider` computes nothing the active level will discard: `approxInputChars`
is not called at `silent`, is called at most once per call at `debug`, and the pending interval is
not armed when warnings are discarded.
Production: `packages/llm/src/logging-llm-provider.ts`.
Test: `packages/llm/tests/unit/logging-llm-provider.test.ts`.

**LLM-45.** `approxInputChars` produces exactly the length `contentToText` would have produced.
Production: `packages/llm/src/logging-llm-provider.ts`.
Test: `packages/llm/tests/unit/logging-llm-provider.test.ts`.

**LLM-46.** `attempt_of_call` counts physical attempts of one logical call, keyed on the params
object identity.
Production: `packages/llm/src/logging-llm-provider.ts`.
Test: `packages/llm/tests/unit/logging-llm-provider.test.ts`.

**LLM-47.** `llm.retry.gave_up` is emitted for every terminal outcome of the retry loop, carrying one
of five reasons.
Production: `packages/llm/src/retry-llm-provider.ts`.
Test: `packages/llm/tests/unit/observability.test.ts` (`non_transient`)
(`exhausted` with lost tokens) (`stream_started`) (`retry_after_too_long`) (`aborted`) (silent with no retry policy).

**LLM-48.** A provider error body that degrades the classification says so at `debug`, and does not
throw when no logger was supplied.
Production: `packages/llm/src/ai-sdk/errors.ts` (`llm.error.body_unparsed`);
`packages/llm/src/classify-provider-error.ts` (`llm.error.body_unstringifiable`) (`llm.error.cause_unstringifiable`).
Test: `packages/llm/tests/unit/observability.test.ts`.

**LLM-49.** `streamMetrics()` selects a JSONL file sink when `CLARVIS_STREAM_DEBUG` is non-empty,
otherwise selects a no-op, and memoizes that first selection process-wide. `createStreamMetrics`
never throws — not even when its log directory disappears.
Production: `packages/llm/src/stream-metrics.ts` (the `try/catch` around
`appendFileSync`, with the comment "Instrumentation must never take the run down with it").
Test: `packages/llm/tests/unit/stream-metrics.test.ts` exercises the enabled selector in a fresh Bun
child process, the unset memo in-process, and the complete file sink directly.

**LLM-50.** `createStreamMetrics` is exported so a test can reach it statically; the file must not be
reached through a cache-busted dynamic import.
Production: `createStreamMetrics` in `packages/llm/src/stream-metrics.ts`, whose TSDoc records that
CI omitted the implementation from LCOV on three consecutive runs while the package tests passed.
Test: enforced socially by the header comment at
`packages/llm/tests/unit/stream-metrics.test.ts` and by the static import;
no mechanical guard exists.

**LLM-51.** `@clarvis/llm` carries a **100% functions / 100% lines** coverage floor and has no
`NO_COUNTER_ALLOWLIST` entry, so every file in `src/` must appear in the LCOV report.
Production: `tooling/checks/coverage.ts`; the absence of an `llm` key in
`NO_COUNTER_ALLOWLIST` (`tooling/checks/coverage.ts`).
Test: the coverage script itself, run by `bun run test:coverage`.

**LLM-52.** Every package test script carries `--timeout 60000`.
Production: `packages/llm/package.json`.
Test: unpinned within this package.

**LLM-53.** Native `openai` and `openai-codex` requests remain provider-managed regardless of the
generic `promptCache` value: `promptCacheKey` is forwarded, messages and system content are not
decorated, and neither `prompt_cache_breakpoint` nor `prompt_cache_options` is emitted.
Production: `buildCallTuning` and `buildRequestOptions` in
`packages/llm/src/ai-sdk/request-options.ts`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts` and
`packages/llm/tests/integration/provider-request-shape.test.ts`.

**LLM-54.** A Grok subscription Responses call forwards the stable `promptCacheKey` as
`prompt_cache_key` but never receives `prompt_cache_breakpoint`; its separate subscription transport
uses the same conversation identity for `x-grok-conv-id`.
Production: `buildCallTuning` in `packages/llm/src/ai-sdk/request-options.ts` and
`createXaiGrokAdapter.apply` in `packages/kernel/src/subscriptions/xai-grok.ts`.
Test: “uses Grok's subscription Responses path and retains its supported output cap” in
`packages/llm/tests/integration/provider-request-shape.test.ts` and “pins Grok subscription transport
and derives its required headers after assembly” in
`packages/kernel/tests/unit/subscription-adapters.test.ts`.

---

## 6. Failure modes and degradation

### 6.1 Error taxonomy produced by this package

| Error | Class | Where raised | Retryable |
| --- | --- | --- | --- |
| unresolved provider config | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts` | no |
| `apiKeyEnv` names an unset variable | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts` | no |
| key-requiring kind with no key | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts` | no |
| subscription kind with no kernel resolver | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts` | no |
| recognized `subscription_*` failure | sanitized `ProviderError`; kind `auth`, `quota`, or `client` by code | `packages/llm/src/ai-sdk/errors.ts` | no under current mapping |
| `openai-compatible` with no `baseUrl` | `ProviderError` kind `client` | `packages/llm/src/openai-compatible-request.ts` | no |
| header `${VAR}` unset | `ProviderError` kind `client` | `packages/llm/src/openai-compatible-request.ts` | no |
| per-call timeout | `ModelCallInactivityError` → `transient`, with stream-start/available partial usage | `timeoutAbort`, `ModelCallInactivityError`, timeout branches in `AiSdkAdapter.call` | yes, including after earlier visible progress |
| stream ended with no aggregate | `ProviderError` kind `transient` | `packages/llm/src/ai-sdk-adapter.ts` | yes |
| response/SSE bound breached | `ProviderResponseLimitError`, flattened to `ProviderError` kind `client` | `packages/llm/src/ai-sdk/bounded-fetch.ts`; `packages/llm/src/ai-sdk/errors.ts` | no |
| any HTTP/API failure | `ProviderError` with classified kind | `packages/llm/src/ai-sdk/errors.ts` | depends |
| in-stream structured error | `ProviderError` with the payload's own status | `packages/llm/src/ai-sdk/errors.ts` | depends |
| unrecognised throw | `ProviderError("Model call failed (transport error).")` | `packages/llm/src/ai-sdk/errors.ts` | depends on `isNetworkErrorLike` |
| admission refusal | `ModelCallUnavailableError` (`code: "model_call_unavailable"`, `reason`) | `packages/llm/src/model-call-admission.ts` | not a `ProviderError`, so never retried |
| cancelled transport will not exit | `ModelCallStuckError` (`code: "model_call_stuck"`) | `packages/llm/src/model-call-admission.ts` | not a `ProviderError` |
| bad admission option | `TypeError` | `packages/llm/src/model-call-admission.ts` | construction-time |

`ModelCallUnavailableError` and `ModelCallStuckError` are `CodedError`s
(`packages/capability/src/errors.ts`), not `ProviderError`s, so `withTransportRetry`'s
`isTransient` guard (`packages/llm/src/retry-llm-provider.ts`) rejects them and the loop sees them
immediately.

### 6.2 What degrades silently, and what says so

| Degradation | Handler | Diagnostic |
| --- | --- | --- |
| an error body that is not JSON | `packages/llm/src/ai-sdk/errors.ts` | `llm.error.body_unparsed` at `debug` |
| a body that will not stringify | `packages/llm/src/classify-provider-error.ts` | `llm.error.body_unstringifiable` at `debug` |
| a cause that will not stringify | `packages/llm/src/classify-provider-error.ts` | `llm.error.cause_unstringifiable` at `debug` |
| a cache breakpoint that did not land | `packages/llm/src/ai-sdk-adapter.ts` | `llm.cache.breakpoint_lost` at `warn` |
| a transport bound breached | `packages/llm/src/ai-sdk/bounded-fetch.ts` | `llm.transport.limit_exceeded` at `warn`; the TSDoc notes this is "the only place the two fields the error carries survive" |
| a stuck cancelled transport | `packages/llm/src/model-call-admission.ts` | `llm.admission.stuck` at `warn` |
| the retry budget stopping | `packages/llm/src/retry-llm-provider.ts` | `llm.retry.gave_up` at `debug` |
| a `StreamMetrics` write failing | `packages/llm/src/stream-metrics.ts` | none — swallowed |
| a timer cleanup throwing | `packages/llm/src/model-call-timeout-bridge.ts` | none — swallowed |
| a throwing `onStateChange` | `packages/llm/src/model-call-admission.ts` | none — swallowed |
| a body cancel algorithm failing | `packages/llm/src/ai-sdk/bounded-fetch.ts` | none — swallowed |
| a base URL that will not parse | `packages/llm/src/ai-sdk-adapter.ts` | the `base_url` field is omitted rather than logged raw |

### 6.3 The complete log-event vocabulary this package emits

| Event | Level | Site |
| --- | --- | --- |
| `llm.provider.resolved` | debug | `packages/llm/src/ai-sdk-adapter.ts` |
| `llm.cache.breakpoint_lost` | warn | `packages/llm/src/ai-sdk-adapter.ts` |
| `llm.cache.request` | debug | `packages/llm/src/ai-sdk-adapter.ts` |
| `llm.request.tuning` | debug | `packages/llm/src/ai-sdk-adapter.ts` |
| `llm.stream.first_token` | debug | `packages/llm/src/ai-sdk-adapter.ts` |
| `llm.stream.no_aggregate` | warn | `packages/llm/src/ai-sdk-adapter.ts` |
| `llm.call.start` | debug | `packages/llm/src/logging-llm-provider.ts` |
| `llm.call.pending` | warn | `withCallLogging`; carries `stream_started` and optional `last_progress_ms` |
| `llm.call.done` / `llm.call.slow` | debug / warn | `packages/llm/src/logging-llm-provider.ts`; carries `finish_reason: result.finishReason` (`undefined` when the result has none — pinned by `packages/llm/tests/unit/logging-llm-provider.test.ts`) |
| `llm.call.failed` | warn | `packages/llm/src/logging-llm-provider.ts` |
| `llm.retry.scheduled` | warn | `packages/llm/src/retry-llm-provider.ts` |
| `llm.retry.gave_up` | debug | `packages/llm/src/retry-llm-provider.ts` |
| `llm.admission.state` | info | `packages/llm/src/model-call-admission.ts` |
| `llm.admission.stuck` | warn | `packages/llm/src/model-call-admission.ts` |
| `llm.transport.limit_exceeded` | warn | `packages/llm/src/ai-sdk/bounded-fetch.ts` |
| `llm.error.body_unparsed` | debug | `packages/llm/src/ai-sdk/errors.ts` |
| `llm.error.body_unstringifiable` | debug | `packages/llm/src/classify-provider-error.ts` |
| `llm.error.cause_unstringifiable` | debug | `packages/llm/src/classify-provider-error.ts` |

No module in `packages/llm/src` writes to `process.stdout`, `process.stderr` or `console.*`; every
logger is defaulted to `NOOP_LOGGER` at construction rather than optionally chained
(`packages/llm/src/ai-sdk-adapter.ts`, `packages/llm/src/ai-sdk/bounded-fetch.ts`, `packages/llm/src/model-call-admission.ts`,
`packages/llm/src/ai-sdk/errors.ts`, `packages/llm/src/classify-provider-error.ts`).

---

## 7. Coupling

The kernel's isolated runtime consumes the host `LLMProvider` port built by the loop, without a
direct dependency on this package. It resolves admitted provider/model configuration on the host,
reconstructs capabilities, forwards per-call retry limits, and preserves typed `ProviderError`
recovery/accounting fields over the private channel. Physical requests still pass through this
package's admission and retry decorators. The wire schema and bounded queue belong to
[isolated-agent-runtime](../hosts/isolated-agent-runtime.md).
Production: `hostModelBroker` in
[`local-container-runtime.ts`](../../packages/kernel/src/runtime/local-container-runtime.ts), `modelBody`
in [`guest-loop-executor.ts`](../../packages/kernel/src/runtime/guest-loop-executor.ts), and
`encodeRuntimeProviderError` in
[`provider-error.ts`](../../packages/kernel/src/runtime/provider-error.ts).
Test: real host SDK and retry-decorator cases in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts),
and typed provider error round-trips in
[`runtime-execution-rpc.test.ts`](../../packages/kernel/tests/contract/runtime-execution-rpc.test.ts).

### 7.1 What this package depends on

| Dependency | Kind | What forces it |
| --- | --- | --- |
| `@clarvis/capability` | runtime, static | `LLMProvider`/`LLMCallParams`/`LLMCallResult` are the port implemented (`packages/llm/src/ai-sdk-adapter.ts`); `ProviderError`, `NOOP_LOGGER`, `levelEnabled` are value imports; `normalizeToolArguments` (`packages/llm/src/ai-sdk/result.ts`); `sanitizeErrorMessage` (`packages/llm/src/ai-sdk/errors.ts`); `contentToText` (`packages/llm/src/to-model-messages.ts`); `unref` (`packages/llm/src/retry-llm-provider.ts`, `packages/llm/src/model-call-admission.ts`); `CodedError` (`packages/llm/src/model-call-admission.ts`); `suppressSecondaryRejection` (`packages/llm/src/ai-sdk/bounded-fetch.ts`); `resolveStringMapWith`/`MissingEnvVarsError`/`FORBIDDEN_PROVIDER_BODY_KEYS` (`packages/llm/src/openai-compatible-request.ts`); `reasoningOutputFloor` (`packages/llm/src/ai-sdk/request-options.ts`) |
| `ai` | runtime, static — **adapter side only** | `generateText`/`streamText`/`Output` (`packages/llm/src/ai-sdk-adapter.ts`); `jsonSchema`/`tool` (`packages/llm/src/ai-sdk/request-options.ts`); `APICallError` (`packages/llm/src/ai-sdk/errors.ts`) |
| `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google` | runtime, static — **adapter side only** | the four `create*` factories at `packages/llm/src/ai-sdk-adapter.ts`, dispatched |
| `node:fs` | runtime | `appendFileSync` (`packages/llm/src/stream-metrics.ts`) |

`@clarvis/paths` is **not** a dependency — this package writes no Clarvis directory. The only path it
touches is the operator-supplied `CLARVIS_STREAM_DEBUG` file.

The four provider SDKs are reachable from the `.` entry only through the **dynamic** import at
`packages/llm/src/lazy.ts`. `openai-compatible-request.ts` is deliberately free of every `@ai-sdk/*` import,
and its own TSDoc gives both reasons: the adapter's tests replace `generateText`/`streamText` so
`transformRequestBody` never runs there, and "a module that touches only plain objects can never
break" the lazy-entry walk (`packages/llm/src/openai-compatible-request.ts`).

### 7.2 What depends on this package

| Consumer | Edge | Forced by |
| --- | --- | --- |
| `@clarvis/loop` | runtime, static, hard dependency | `packages/loop/package.json` (`workspace:*`), and the value imports at `packages/loop/src/runtime/build-run-deps.ts` and `packages/loop/src/runtime/execute-run.ts` |

That is the only `@clarvis/*` package importing it. `packages/capability/src/env-interpolate.ts`,
`packages/capability/src/env-ref.ts`, `packages/tasks/src/trace.ts` and
`packages/code/src/adapters/stream-metrics.ts` mention `@clarvis/llm` only inside TSDoc prose —
no import. `@clarvis/code` carries its **own** copy of the stream-metrics sink;
`packages/llm/src/stream-metrics.ts` records that "the packages do not share a dependency edge,
and a debug counter is not worth minting one".

The direction is forced structurally: nothing in `packages/llm/src` imports `@clarvis/loop`,
`@clarvis/kernel`, `@clarvis/trace`, `@clarvis/paths` or `@clarvis/protocol`, and the settings
schema the operator authors lives elsewhere — this package receives already-`ResolvedProviderConfig`
values (`packages/capability/src/llm-port.ts`).

### 7.3 Type-only versus runtime edges within the package

`packages/llm/src/lazy.ts` uses `import type` exclusively for `@clarvis/capability`, which is what keeps the
lazy entry free of any evaluation. `packages/llm/src/prompt-cache-provider.ts` and
`packages/llm/src/to-model-messages.ts` are likewise type-only against their SDK/capability types (the latter
takes one value import, `contentToText`).

### 7.4 What this document delegates

- **Prefix-cache economics** — why an append-only transcript is cheap and a mid-prefix edit is not —
  belongs to [prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md). This document covers only the mechanism by which
  markers, keys and session pins reach the wire.
- **Model/provider resolution and pricing** — how a `ResolvedProviderConfig` is produced from
  settings, and `parseModelRef`/`resolveProvider` — belongs to
  [model-catalog-and-provider-resolution](../hosts/model-catalog.md). This package consumes the resolved value only.
- **Where admission, retry budget and timeouts are wired into a run**, and the `CLARVIS_*` env
  values that set them (`packages/loop/src/runtime/build-run-deps.ts`), belong to
  [loop-budgets-clocks-and-guards](../engine/budgets-and-guards.md).

---

## 8. Open questions

1. **LLM-9 is unpinned.** `maxRetries: 0` (`packages/llm/src/ai-sdk-adapter.ts`) is what makes
   `withTransportRetry` the sole retry authority, and no test asserts it. Deleting the line would
   double-retry every transient failure silently, with a green suite. No indirect assertion has
   been found (attempt counting in `packages/llm/tests/component/ai-sdk-adapter.test.ts` uses a
   mocked `generateText`, which never consults the field).

2. ~~**`AiSdkGuardrails.timeoutMs` is documented as the only guardrail on the constructor's `@param`
   line.**~~ **Resolved: the TSDoc was stale.** All three fields are used, and the `@param` now says
   so — `timeoutMs` becomes the per-call default when a call names none, and the other two are handed
   to `createBoundedFetch`, each falling back to its package default
   (`packages/llm/src/ai-sdk-adapter.ts`). The interface itself was undocumented and now
   carries a member comment each.

4. ~~**The bridge-minted timeout error carries no attempt cost.**~~ **Resolved for observable
   evidence.** `markStreamStarted` now puts the stream-start fact on the bridge's
   `ModelCallInactivityError`, and the adapter handles every timed-out catch before the generic
   `ProviderError` passthrough so available `partialUsage` is retained. Usage remains absent when the
   provider emitted no usage frame before cancellation; that is unknown evidence, not a synthesized
   zero. Tests: `packages/llm/tests/unit/model-call-timeout-bridge.test.ts` and
   `packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`.

6. **The `bestEffort`/`detachObserved` neighbours of `suppressSecondaryRejection`
   (`packages/capability/src/tasks.ts`) accept an `options.logger`, but
   `suppressSecondaryRejection` ignores its `observedBy` argument beyond a non-empty
   check**. So `detachCancellation`'s two distinct `observedBy` strings
   (`packages/llm/src/ai-sdk/bounded-fetch.ts`) reach no sink. Whether that is a
   deliberate documentation-only convention or an unfinished channel is not stated in the source.

7. **`MarkerSite` correctness is asserted against a reading of the SDK's own
   `convertToOpenAICompatibleChatMessages`** (`packages/llm/src/ai-sdk/request-options.ts`),
   which is inside `@ai-sdk/openai-compatible` and outside this document's scope. The integration test at
   `packages/llm/tests/integration/provider-request-shape.test.ts` exercises the real SDK, so
   the behaviour is pinned; the *derivation* is not verifiable from this repository.

8. **The measurements quoted in TSDoc are not reproducible here.** The `deepseek-v4-pro` affinity
   probe (`packages/llm/src/ai-sdk/request-options.ts`;
   `packages/llm/tests/integration/wire-cache-diff.test.ts`), the "~95 chars/s a real run
   streams at" (`packages/llm/src/ai-sdk/streaming.ts`), the "~3000 reports per call at ~1 ms
   inter-arrival" and the "229 tests" coverage incident
   (`packages/llm/src/stream-metrics.ts`) are all statements in comments. They are recorded as what
   the code claims, not as verified facts.

9. **`ResolvedProviderConfig.promptCache` semantics table** lives in `@clarvis/capability`
   (`packages/capability/src/llm-port.ts`) rather than here. This package implements it at
   `packages/llm/src/ai-sdk/request-options.ts`; whether every row of that table is fully
   exercised is a question for the provider-resolution document.

10. **No test in scope asserts the `TypeError` messages from `positiveInteger`/`nonnegativeInteger`**
    (`packages/llm/src/model-call-admission.ts`), despite the package's 100% line floor.
    No coverage report was run, so whether another test reaches them incidentally, or whether the
    floor is currently satisfied by some untraced path, is undetermined.

11. **Two `ModelCallAdmissionController` edge paths are unpinned.** The already-aborted-signal-at-
    `acquire` short-circuit (`packages/llm/src/model-call-admission.ts`) and the synchronous-throw-from-
    `inner.call` release path both have code (added to the section 4.13 state table
    above) but no test in `packages/llm/tests/unit/model-call-admission.test.ts` exercises either
    one.

## Persisted replay and serialized-prefix diagnostics

Tool-call provider metadata retains an existing Responses item ID separately from `call_id`.
`withResponsesReplayIds` restores that item ID if the SDK omits it, without inventing IDs for
optional user/tool-output items. `SerializedPrefixWatch` compares bounded content hashes at the
actual JSON fetch boundary and reports the first changed instruction/catalog/history surface.
`cacheUsageKnown: false` distinguishes absent cache counters from observed zero.
Production: [`withResponsesReplayIds`](../../packages/llm/src/ai-sdk/responses-replay.ts),
[`SerializedPrefixWatch`](../../packages/llm/src/ai-sdk/request-prefix.ts),
[`buildCallResult`](../../packages/llm/src/ai-sdk/result.ts).
Test: [`wire-cache-diff.test.ts`](../../packages/llm/tests/integration/wire-cache-diff.test.ts) and
[`request-prefix.test.ts`](../../packages/llm/tests/unit/request-prefix.test.ts).
See the [prompt-cache contract](../cross-cutting/prompt-cache.md) for per-instance composition,
provider-specific fields and performance qualification.
