# `@clarvis/llm` — provider adapter, decorators and error classification

> Implemented at `packages/llm/`. Every claim below is anchored to a file and line. Open questions
> are collected in the final section.

## 1. Purpose

`@clarvis/llm` is the package that turns Clarvis's provider-neutral `LLMProvider` port
(`packages/capability/src/llm-port.ts:254`) into actual HTTP calls against four provider SDK
families, and that turns everything those calls can do wrong into one normalized `ProviderError`
(`packages/capability/src/llm-port.ts:294`). It is the only package in the monorepo that declares
`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` and `ai` as
dependencies (`packages/llm/package.json:47-54`).

Concretely it owns five things. (a) The **adapter**: `AiSdkAdapter`
(`packages/llm/src/ai-sdk-adapter.ts:137`) builds the right SDK client from a
`ResolvedProviderConfig`, converts the loop's messages/tools/tuning into the AI SDK call shape,
streams or generates, and maps every failure. (b) The **decorator stack** — prompt-cache defaults
(`packages/llm/src/prompt-cache-provider.ts:29`), call logging (`packages/llm/src/logging-llm-provider.ts:74`), transport retry
(`packages/llm/src/retry-llm-provider.ts:100`) and a host-owned admission gate (`packages/llm/src/model-call-admission.ts:373`) —
each an `LLMProvider` wrapping an `LLMProvider`. (c) The **classifier**, `classifyProviderError`
(`packages/llm/src/classify-provider-error.ts:296`), which decides which of the six `FailureKind`s
(`packages/capability/src/run.ts:243-244`) a failure is, and therefore whether it is retried at all.
(d) The **transport bounds**: `createBoundedFetch` (`packages/llm/src/ai-sdk/bounded-fetch.ts:62`) caps a response
body and one unterminated SSE event before an SDK parser can retain them. (e) A deliberate
**two-entry split** so that importing a decorator does not statically load four provider SDKs
(`packages/llm/src/index.ts:6-13`, `packages/llm/src/lazy.ts:44`), enforced by `tests/architecture/lazy-entry.test.ts`.

The package has no `zod` dependency and defines no settings schema
(`packages/llm/package.json:47-54`); it is configured entirely through function arguments handed to
it by `@clarvis/loop`'s `buildRunDeps` (`packages/loop/src/runtime/build-run-deps.ts:453-474`).

---

## 2. Surface

### 2.1 Exports map

| Subpath | `bun` | `types` | `import` | Source |
|---|---|---|---|---|
| `.` | `./src/index.ts` | `./dist/index.d.ts` | `./dist/index.js` | `packages/llm/package.json:13-17` |
| `./adapter` | `./src/adapter.ts` | `./dist/adapter.d.ts` | `./dist/adapter.js` | `packages/llm/package.json:18-22` |
| `./package.json` | literal | — | — | `packages/llm/package.json:23` |

`packages/llm/src/index.ts:15-21` re-exports seven modules (`lazy.ts`, `classify-provider-error.ts`,
`logging-llm-provider.js`, `model-call-admission.js`, `prompt-cache-provider.js`,
`retry-llm-provider.js`, `to-model-messages.js`) and explicitly **not** the adapter; its own TSDoc states
the reason: re-exporting it "would statically pull `@ai-sdk/anthropic`, `@ai-sdk/google`,
`@ai-sdk/openai` and `@ai-sdk/openai-compatible` into every consumer that only wanted a decorator"
(`packages/llm/src/index.ts:6-11`).

### 2.2 Entry `.` — exported symbols

| Symbol | Kind | Defined at | Signature / value |
|---|---|---|---|
| `createAiSdkProvider` | fn | `packages/llm/src/lazy.ts:41` | `(opts: AiSdkProviderOptions) => LLMProvider` |
| `AiSdkProviderOptions` | iface | `packages/llm/src/lazy.ts:6` | `{ resolveRegistryKey; resolveSubscription?; timeoutMs?; maxResponseBytes?; maxSseEventBytes?; logger? }` |
| `parseRetryAfter` | fn | `packages/llm/src/classify-provider-error.ts:219` | `(value: string \| null \| undefined, now?: number) => number \| undefined` |
| `classifyProviderError` | fn | `packages/llm/src/classify-provider-error.ts:296` | `(input: ClassifyInput) => Classification` |
| `HeaderLike` | iface | `packages/llm/src/classify-provider-error.ts:7` | `{ get(name): string \| null }` |
| `ClassifyInput` | iface | `packages/llm/src/classify-provider-error.ts:20` | `{ status?; headers?; body?; cause?; timedOut?; isRetryable?; now?; logger? }` |
| `Classification` | iface | `packages/llm/src/classify-provider-error.ts:43` | `{ kind: FailureKind; status?; retryAfterMs? }` |
| `withCallLogging` | fn | `packages/llm/src/logging-llm-provider.ts:74` | `(inner: LLMProvider, logger: Logger) => LLMProvider` |
| `DEFAULT_MAX_ACTIVE_MODEL_CALLS` | const | `packages/llm/src/model-call-admission.ts:12` | `4` |
| `DEFAULT_MAX_QUEUED_MODEL_CALLS` | const | `packages/llm/src/model-call-admission.ts:13` | `8` |
| `DEFAULT_MODEL_CALL_ABORT_SETTLE_MS` | const | `packages/llm/src/model-call-admission.ts:14` | `250` |
| `ModelCallAdmissionState` | type | `packages/llm/src/model-call-admission.ts:16` | `"open" \| "quarantined" \| "closed"` |
| `ModelCallUnavailableReason` | type | `packages/llm/src/model-call-admission.ts:17` | `"queue_full" \| "quarantined" \| "closed"` |
| `ModelCallAdmissionSnapshot` | iface | `packages/llm/src/model-call-admission.ts:19` | `{ state; active; queued; quarantined; maxActive; maxQueued }` |
| `ModelCallAdmissionOptions` | iface | `packages/llm/src/model-call-admission.ts:28` | `{ maxActive?; maxQueued?; abortSettleMs?; onStateChange?; logger? }` |
| `admissionStateLogger` | fn | `packages/llm/src/model-call-admission.ts:58` | `(logger) => (snapshot) => void` |
| `ModelCallUnavailableError` | class | `packages/llm/src/model-call-admission.ts:82` | `CodedError`, `code = "model_call_unavailable"` |
| `ModelCallStuckError` | class | `packages/llm/src/model-call-admission.ts:99` | `CodedError`, `code = "model_call_stuck"` |
| `ModelCallAdmissionController` | class | `packages/llm/src/model-call-admission.ts:145` | `snapshot()`, `close()`, `call(inner, params)` |
| `createModelCallAdmissionController` | fn | `packages/llm/src/model-call-admission.ts:366` | `(options?) => ModelCallAdmissionController` |
| `withModelCallAdmission` | fn | `packages/llm/src/model-call-admission.ts:373` | `(inner, controller) => LLMProvider` |
| `withPromptCacheDefaults` | fn | `packages/llm/src/prompt-cache-provider.ts:29` | `(inner, defaults: PromptCacheDefaults) => LLMProvider` |
| `PromptCacheDefaults` | iface | `packages/llm/src/prompt-cache-provider.ts:11` | `{ promptCacheKey: string; promptCacheTtl: PromptCacheTtl }` |
| `backoffDelayMs` | fn | `packages/llm/src/retry-llm-provider.ts:51` | `(n, retryAfterMs, baseDelayMs, maxDelayMs, maxRetryAfterMs?) => number` |
| `withTransportRetry` | fn | `packages/llm/src/retry-llm-provider.ts:100` | `(inner, opts: TransportRetryOptions) => LLMProvider` |
| `TransportRetryOptions` | iface | `packages/llm/src/retry-llm-provider.ts:22` | `{ maxRetries; baseDelayMs; maxDelayMs; maxRetryAfterMs?; logger? }` |
| `toModelMessages` | fn | `packages/llm/src/to-model-messages.ts:69` | `(messages: LiveMessage[], opts?) => ModelMessage[]` |
| `ToModelMessagesOptions` | iface | `packages/llm/src/to-model-messages.ts:51` | `{ stripImages?: boolean }` |

### 2.3 Entry `./adapter` — exported symbols

| Symbol | Kind | Defined at | What |
|---|---|---|---|
| `AiSdkAdapter` | class | `packages/llm/src/ai-sdk-adapter.ts:137` | the `LLMProvider` over the AI SDK |
| `AiSdkProviderConfig` | iface | `packages/llm/src/ai-sdk-adapter.ts:45` | `{ resolveRegistryKey?; generateText?; streamText?; fetch?; resolveSubscription?; logger? }` |
| `AiSdkGuardrails` | iface | `packages/llm/src/ai-sdk-adapter.ts:62` | `{ timeoutMs?; maxResponseBytes?; maxSseEventBytes? }` |
| `SubscriptionRequestAuth` | iface | `packages/llm/src/ai-sdk-adapter.ts:67` | token-opaque `{ scheme; apply(input, init) }` request authority |
| `createBoundedFetch` | fn | `packages/llm/src/ai-sdk/bounded-fetch.ts:62` | `(options?) => typeof fetch` |
| `DEFAULT_PROVIDER_MAX_RESPONSE_BYTES` | const | `packages/llm/src/ai-sdk/bounded-fetch.ts:4` | `32 * 1024 * 1024` |
| `DEFAULT_PROVIDER_MAX_SSE_EVENT_BYTES` | const | `packages/llm/src/ai-sdk/bounded-fetch.ts:7` | `4 * 1024 * 1024` |
| `ProviderResponseLimitError` | class | `packages/llm/src/ai-sdk/bounded-fetch.ts:10` | `{ limit: "response" \| "sse_event"; maxBytes }` |
| `createStreamMetrics` | fn | `packages/llm/src/stream-metrics.ts:48` | `(path, source) => StreamMetrics` |
| `streamMetrics` | fn | `packages/llm/src/stream-metrics.ts:100` | `(source = "loop") => StreamMetrics` (process-wide memo) |
| `StreamMetrics` | iface | `packages/llm/src/stream-metrics.ts:24` | `{ count(name, n?) }` |

### 2.4 Modules with no entrypoint owner

`src/ai-sdk/errors.ts`, `src/ai-sdk/request-options.ts`, `src/ai-sdk/result.ts`,
`src/ai-sdk/streaming.ts`, `src/model-call-timeout-bridge.ts` and
`src/openai-compatible-request.ts` export symbols that neither `index.ts` nor `adapter.ts` names.
They are reachable only by relative path — which is how the unit tests import them, e.g.
`packages/llm/tests/unit/ai-sdk-modules.test.ts:4-13` and
`packages/llm/tests/unit/model-call-admission.test.ts:9`. Most of their individual exports are
described where their behavior is first discussed in sections 3–4 below (e.g.
`buildCallTuning`/`buildRequestOptions` in 3.2–3.5, `buildCallResult`/`normalizeUsage`/
`normalizeModelText` in 4.8, `toProviderError` in 4.9, `makeDeltaBatcher`/`makeToolInputReporter`
in 3.6/4.4); `openAICompatibleSettings` (`packages/llm/src/openai-compatible-request.ts:211`), whose
`includeUsage: true`/`baseUrl`-required/`transformRequestBody`-composing behavior is cited at
LLM-29 in section 5's invariants list, is one such export and is named here explicitly so that
citation is locatable by symbol, not only by line.

### 2.5 Environment variables read by this package

| Variable | Read at | Effect |
|---|---|---|
| `CLARVIS_STREAM_DEBUG` | `packages/llm/src/stream-metrics.ts:102` | when non-empty, `streamMetrics()` returns a JSONL file sink instead of the no-op |
| *(any name)* | `packages/llm/src/ai-sdk-adapter.ts:272` | `process.env[name]` is the **default** credential/header resolver when `AiSdkProviderConfig.resolveRegistryKey` is absent |

There is no other environment read in `packages/llm/src`. The provider timeouts, retry budget and
transport bounds arrive as arguments from the host (`packages/loop/src/runtime/build-run-deps.ts:453-474`).

---

## 3. Data and formats

Nothing in this package is persisted except the optional stream-metrics JSONL. What it does define
are wire-shaped values.

### 3.1 The AI SDK call object

`buildRequestOptions` (`packages/llm/src/ai-sdk/request-options.ts:538`) returns `{ request, diagnostics }`, and
the adapter spreads only `request` onto the SDK call (`packages/llm/src/ai-sdk-adapter.ts:396-401`). The TSDoc
gives the reason for the two keys: "spreading one object onto the SDK call would put a
`diagnostics` field on the wire" (`packages/llm/src/ai-sdk/request-options.ts:534-536`).

`request` shape (`packages/llm/src/ai-sdk/request-options.ts:542-555`):

| Field | Type | Produced by |
|---|---|---|
| `system?` | `string \| SystemModelMessage[]` | `splitSystemMessages` (`:475`), array form only when a cache marker is attached (`:564-577`) |
| `headers?` | `Record<string,string>` | `{ "x-session-id": promptCacheKey }`, openai-compatible only (`:578-581`) |
| `messages` | `ModelMessage[]` | `split.rest` |
| `tools?` | `ToolSet` | `toAiSdkTools` (`:493`), keyed by `wireName` |
| `toolChoice?` | AI SDK tool choice | `toAiSdkToolChoice` (`:509`), only when `tools !== undefined` (`:600-603`) |
| `reasoning?` | `"none"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"` | `buildCallTuning` (`:161`) |
| `providerOptions?` | `Record<string, Record<string, JSONValue>>` | `buildCallTuning` |
| `maxOutputTokens?` | `number` | `buildCallTuning` |

The adapter adds `model`, `abortSignal` (when a signal exists) and a hard `maxRetries: 0`
(`packages/llm/src/ai-sdk-adapter.ts:396-401`) — the TSDoc says SDK retries are disabled "so
{@link withTransportRetry} owns retry policy" (`packages/llm/src/ai-sdk-adapter.ts:369-370`).

### 3.2 Reasoning and cache tuning, per provider `kind`

`buildCallTuning` (`packages/llm/src/ai-sdk/request-options.ts:161-235`), pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts:129-170`:

| `kind` | `reasoningEffort` route | shape emitted | `reasoning_path` |
|---|---|---|---|
| `openai` | `providerOptions.openai.reasoningEffort`; `"off"` → `"none"` (`:181-183`) | `{ openai: { reasoningEffort } }` | `"openai"` |
| `openai-codex`, `xai-grok` | the same OpenAI Responses option; `"off"` → `"none"` (`:187-191`) | `{ openai: { store: false, forceReasoning: true, reasoningEffort } }` | `"openai"` |
| `openai-compatible` | `providerOptions.openaiCompatible.reasoningEffort`; `"off"` → `"none"` (`:184-186`) | `{ openaiCompatible: { reasoningEffort } }` | `"compatible"` |
| `anthropic`, effort `"max"` | `providerOptions.anthropic.effort = "max"` (`:188-190`) | bypasses the standardized field | `"anthropic_max"` |
| `anthropic`, other | top-level `reasoning`; `"off"` → `"none"` (`:192-194`, floor computed at `:195`) | `reasoning: <effort>` | `"standard"` |
| `google` | top-level `reasoning`; `"off"`→`"none"`, `"max"`→`"xhigh"` (`:196-199`) | `reasoning: <effort>` | `"standard"` |

Additional per-kind fields:

- `openai-compatible` always gets `usage: { include: true }` (`:202-210`, the field itself at
  `:205`), and when `promptCacheKey` is set, both `prompt_cache_key` **and** `session_id` carrying
  the same value (`:206-208`).
- `openai` gets `promptCacheKey` (camelCase) when a key is set (`:212-214`).
- Anthropic non-`off` effort also computes `thinkingFloor = reasoningOutputFloor(kind, effort)`
  (`:195`) and the effective cap becomes `Math.max(configured, thinkingFloor)` (`:216-219`). The
  floor table is `packages/capability/src/reasoning-budget.ts:14-22` plus a fixed
  `ANTHROPIC_ANSWER_HEADROOM_TOKENS = 8192` (`:22`); the test pins `low → 10 240`,
  `xhigh → 24 576`, `max → 40 960`
  (`packages/llm/tests/unit/ai-sdk-modules.test.ts:154-165`).

`reasoningSummary` is limited to `openai`, `openai-codex`, and `xai-grok`, and only when not `"off"`
(`packages/llm/src/ai-sdk/request-options.ts:179-185`);
`packages/llm/tests/unit/ai-sdk-modules.test.ts:190-197` asserts an Anthropic call given a
`reasoningSummary` produces `providerOptions === undefined`.

`openai-codex` deliberately omits `maxOutputTokens` even when configured, while `xai-grok` retains
it (`packages/llm/src/ai-sdk/request-options.ts:224-235`), because the ChatGPT Codex Responses
transport rejects that output cap. The real SDK request-shape test pins both subscription paths at
`packages/llm/tests/integration/provider-request-shape.test.ts:356-455`.

### 3.3 The `RequestDiagnostics` record

`RequestCacheDiagnostics` (`packages/llm/src/ai-sdk/request-options.ts:87-107`) and
`RequestTuningDiagnostics` (`:67-72`) are computed values the adapter logs and never forwards. The
cache record's fields and how each is derived (`packages/llm/src/ai-sdk/request-options.ts:592-604`):

| Field | Derivation |
|---|---|
| `kind?`, `mode?` | `providerConfig.kind` / `.promptCache`, omitted when absent |
| `marked` | `"anthropic"` \| `"compatible"` \| `"none"` |
| `requested_breakpoints` | `params.cacheBreakpoints?.length ?? 0` |
| `applied_breakpoints` | count actually marked |
| `walked_back` | openai-compatible only; a requested index that moved to an earlier message |
| `system_marked` | a system block exists **and** this kind marks |
| `cache_key_sent` | `promptCacheKey` set **and** kind is `openai`, `openai-codex`, or `openai-compatible` |
| `session_pinned` | the `x-session-id` header was emitted (openai-compatible + key) |
| `ttl?` | `params.promptCacheTtl` |

A no-provider call produces exactly `marked: "none"`, both breakpoint counts equal to zero, and
`walked_back`, `system_marked`, `cache_key_sent`, and `session_pinned` all false
— pinned by `packages/llm/tests/unit/observability.test.ts:434-445`.

### 3.4 The `openai-compatible` cache-marker sentinel

`CACHE_MARKER_KEY = "__clarvis_cache_control"` (`packages/llm/src/openai-compatible-request.ts:42`). It rides
inside `providerOptions.openaiCompatible` (`cacheMarkerOptions`, `:53-55`), and is consumed and
deleted by `applyCacheControlMarkers` (`:112`) inside the client's `transformRequestBody`
(`:235`). Its TSDoc records the mechanism: identity-based marking rather than index-based, because
"the caller's array is reshaped three times before it becomes `body.messages`"
(`packages/llm/src/openai-compatible-request.ts:31-36`), and it "**must** delete it" or it is "an unknown
top-level message field: a 400 from a strict provider, silently ignored by a lax one" (`:38-40`).

Real wire evidence: `packages/llm/tests/integration/provider-request-shape.test.ts:154-155` asserts
the serialized body contains `cache_control` and does **not** contain `__clarvis_cache_control`.

### 3.5 What an `openai-compatible` request body actually contains

`packages/llm/tests/integration/wire-cache-diff.test.ts:103-110` pins the complete top-level key set
of a real `@ai-sdk/openai-compatible` request built by this adapter:

```
["max_tokens", "messages", "model", "prompt_cache_key", "session_id", "usage"]
```

and `:124-128` pins `body.session_id === body.prompt_cache_key === headers["x-session-id"]`, constant
across three turns.

### 3.6 Stream-metrics JSONL

`createStreamMetrics` (`packages/llm/src/stream-metrics.ts:48`) appends one JSON object per line to the file named
by `CLARVIS_STREAM_DEBUG`. Two record shapes:

- a window line, every 1000 ms (`:82`), carrying
  `{ at, source, window_ms, counts, rates, rss, heap_used, external }` (`:70-79`) — emitted even
  when `counts` is empty (`:64-68` produce `{}`);
- a totals line on `process.on("exit")`, only when `totals.size > 0`:
  `{ at, source, totals }` (`:84-87`).

Counters written by this package: `provider_delta`, `provider_chars`, and
`batcher_flush_<channel>` (`packages/llm/src/ai-sdk/streaming.ts:76, 100-101`).

---

## 4. Behavior

### 4.1 Provider construction — the lazy boundary

`createAiSdkProvider` (`packages/llm/src/lazy.ts:41`) returns an `LLMProvider` whose `call` memoizes a build
promise (`:71-73`). The source performs `await import("./ai-sdk-adapter.ts")` (`:53`) and constructs
`AiSdkAdapter` with `resolveRegistryKey`/`resolveSubscription`/`logger` as the config and
`timeoutMs`/`maxResponseBytes`/`maxSseEventBytes` as guardrails (`:54-67`). Only `import type`
reaches `@clarvis/capability` from this module (`packages/llm/src/lazy.ts:1`), which is what keeps the main entry
SDK-free.

`packages/llm/tests/component/lazy.test.ts:48-52` asserts the credential resolver is not called
before the first `call`; `:54-65` asserts the first call reaches the configured base URL and threads
the resolver's value into the `Authorization` header.

### 4.2 One model call, in the order `AiSdkAdapter.call` runs it

`packages/llm/src/ai-sdk-adapter.ts:372-546`:

1. **Refuse an unresolved provider.** No `params.providerConfig` → `ProviderError` kind `"client"`
   (`:364-369`).
2. **Build the client** via `resolveRegistryModel` → `buildRegistryFactory` (`:370`, `:163-172`,
   `:237-298`). Ordering inside:
   - resolve the key through `resolveRegistryKey ?? process.env` (`:241-243`);
   - resolve `${VAR}` headers through the *same* lookup (`:245`, `packages/llm/src/openai-compatible-request.ts:251`);
   - if `apiKeyEnv` is named but unset → `ProviderError` kind `"client"` naming the variable
     (`:272-278`);
   - switch on `kind`: `openai`/`anthropic`/`google` call `requireKey()`, `openai-compatible` uses
     its optional API key, and `openai-codex`/`xai-grok` require `resolveSubscription`, resolve fresh
     request authority at the physical fetch boundary, and use fixed Responses base URLs
     (`packages/llm/src/ai-sdk-adapter.ts:310-362`). The placeholder SDK key is never sent because
     `SubscriptionRequestAuth.apply` owns the final authenticated request; the integration test
     asserts this at `packages/llm/tests/integration/provider-request-shape.test.ts:356-455`.
3. **Describe the pair once** — `describeResolvedModel` (`:192`) emits `llm.provider.resolved` at
   `debug`, memoized on `` `${provider}` + U+0000 + `${modelId}` `` in `describedModels` (`:199-201`). It runs
   *after* the factory, so a rejected configuration produces no line at all
   (`packages/llm/tests/component/ai-sdk-adapter-observability.test.ts:151-165`).
4. **Layer the timeout** — `timeoutAbort(timeoutMs ?? defaultTimeoutMs, params.signal, bridge)`.
   With no positive timeout it returns the parent signal unchanged; otherwise it combines the two
   with `AbortSignal.any`. Streaming parts call `markActivity()`, which updates one timestamp; the
   single timer checks that timestamp and re-arms at most once per timeout window. The configured
   value is therefore an inactivity window for streaming and an absolute bound for generation,
   where no progress signal exists. On expiry the controller aborts with the bridge's
   `ModelCallInactivityError`.
5. **Decide image stripping** — `stripImages = !(params.capabilities?.has("vision") ?? true)`
   (`:378`).
6. **Convert** — `toModelMessages(params.messages, { stripImages })` (`:384`), then
   `buildRequestOptions` (`:385`), then `reportRequest` (`:386`).
7. **Branch.** `openai-codex`, or any call with `onStreamDelta`, uses the streaming path below.
   Every other call without `onStreamDelta` uses `generateText(callArgs)` and
   `buildCallResult(result)`. The subscription exception is required by the pinned ChatGPT Codex
   Responses transport, which rejects `stream: false`; an internal caller may discard deltas but
   may not select one-shot generation.
8. **Finally** — `batcher?.dispose(); cleanup();` (`:533-536`).

Production: `AiSdkAdapter.call` in `packages/llm/src/ai-sdk-adapter.ts`
(`providerRequiresStream`, the generation branch, and the no-op delta sink). Test:
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts` (`"streams ChatGPT subscription
calls even without a delta consumer"`).

### 4.3 The streaming path

`packages/llm/src/ai-sdk-adapter.ts:408-527`:

- `Output.text()` is replaced by `nonRetainingTextOutput`, whose `parsePartialOutput` returns
  `{ partial: text.length }` (`:401-406`). `packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts:228-250`
  calls that function directly and asserts it answers `{ partial: 29 }` for a 29-character prefix,
  under the title "uses a non-cumulative partial output and never reads aggregate getters".
- `streamText` is given `onError` (records the first error), `onStepEnd` and `onEnd` (both keep
  `partialUsage`; `onEnd` also captures the aggregate). Each callback and each yielded stream part
  calls `markActivity()`, resetting the inactivity window without allocating a timer or log record
  per part.
- The part loop (`:451-474`) maps each part type:

| Part type | Effect |
|---|---|
| `text-delta` | first-output report `"text"`; `batcher.push("text", …)` |
| `reasoning-delta` | first-output report `"reasoning"`; `batcher.push("reasoning", …)` |
| `tool-input-start` / `-delta` / `-end` | first-output report `"tool_input"`; forwarded to `makeToolInputReporter`; `-end` emits the final cumulative count with `complete: true` |
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
  of kind `"transient"` (`:500-517`). Pinned by
  `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts:414-438`.
- Otherwise `buildCallResult(aggregate)` and merge any stream-retained text lifecycle metadata;
  subscription-backed results additionally carry `billing_source: "subscription"`
  (`packages/llm/src/ai-sdk-adapter.ts:626-646`).

`streamStarted` is computed as `outputObserved || batcher.emitted()` (`:479`, `:501`, `:522`) — a
`tool-input-start` alone is enough, pinned by
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts:251-267`.

### 4.4 Delta batching

`makeDeltaBatcher` (`packages/llm/src/ai-sdk/streaming.ts:45`) with defaults `{ maxChars: 384, maxMs: 64 }`
(`:19`). Behaviour:

| Event | Condition | Effect |
|---|---|---|
| `push(ch, text)` | `text.length === 0` | return (`:99`) |
| `push(ch, text)` | `ch !== channel` | `flush()` first, so channels never merge (`:102`) |
| `push` | `buf.length >= maxChars` or `now - lastFlush >= maxMs` | `flush()` (`:105`) |
| `push` | otherwise | `arm()` an idle timer for `maxMs` (`:106`, `:87-97`) |
| idle timer fires | buffer non-empty | `flush()`; a throw is captured into `sinkError` (`:89-95`) |
| `flush()` | `sinkError` set | rethrow it (wrapping a non-`Error` in `new Error(…, { cause })`) (`:68-72`) |
| `flush()` | first batch of a channel | `reset: true` (`:74-75`) |
| `dispose()` | — | `disarm()` only (`:108`) |

Tool arguments use the separate `makeToolInputReporter` cumulative throttle. `start` publishes the
tool identity with `chars: 0`; `delta` counts every fragment but forwards at most once per call per
`TOOL_INPUT_REPORT_MS = 250`; `end` always forwards the final count with `complete: true`. Calls are
keyed by `call_id`, so interleaved parallel argument streams neither merge nor imply one another has
finished. Production: `makeToolInputReporter`. Test:
`packages/llm/tests/unit/delta-batcher.test.ts` and
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`.

The idle timer's TSDoc names the failure it closes: without it, "the tail of the last sentence sat
in `buf` until the whole stream drained", because "the provider stops sending text the moment it
starts emitting tool-call arguments" (`packages/llm/src/ai-sdk/streaming.ts:33-36`, within the `@remarks`
docblock at `:21-44`).

`makeToolInputReporter` (`:149`) is a **throttle**, not a batcher: `TOOL_INPUT_REPORT_MS = 250`
(`:127`), `chars` is cumulative, `start` reports immediately with `chars: 0` (`:161`), `delta` skips
a report inside the window (`:167-168`), `end` always reports and deletes the entry (`:172-177`), and
a `delta` for an unknown `call_id` is ignored rather than inferred (`:165`).

### 4.5 Prompt-cache breakpoint placement

Two mutually exclusive paths, chosen at `packages/llm/src/ai-sdk/request-options.ts:559-561`:

- `markAnthropic = kind === "anthropic" && promptCache !== "off"` (`:549`) — so absent `promptCache` still
  marks.
- `markCompatible = kind === "openai-compatible" && promptCache === "explicit" && cacheBreakpoints !== undefined`.

**Anthropic** — `withCacheBreakpoints` (`:283`) over `cacheBreakpointTargets` (`:256`):
`undefined` requested rolls a single breakpoint onto the newest usable message (`:261-264`);
otherwise out-of-range, duplicate and system-role indices are discarded and at most
`MAX_MESSAGE_CACHE_BREAKPOINTS = 2` (`:243`) newest survive (`:266-267`). The system block is marked
separately (`:567-574`). Pinned by `packages/llm/tests/unit/ai-sdk-modules.test.ts:236-258`.

**openai-compatible** — `withOpenAICompatibleCacheMarkers` (`:403`). `requested === undefined` marks
**nothing** (`:407`); the TSDoc explains that "on a provider that bills to create an entry a marker
there is a pure surcharge for a prefix no later request can match" (`:368-370`). A requested index
whose message cannot carry a marker walks **back** to the newest one that can, skipping indices
another target already claimed (`:410-421`), setting `walkedBack`.

`markerSiteOf` (`:343`) decides where a marker survives serialisation:

| Message shape | Site | Line |
|---|---|---|
| `role: "tool"` | `"none"` | `:344` |
| assistant with any `tool-call` part | `"none"` | `:345-350` |
| no text at all | `"none"` | `:351-356` |
| user with string content or exactly one part | `"only-part"` | `:358-360` |
| anything else | `"message"` | `:357` |

`markMessage` (`:453`) attaches to exactly one site, promoting a string to a single text part on the
`"only-part"` path (`:461-466`).

On the wire, `applyCacheControlMarkers` (`packages/llm/src/openai-compatible-request.ts:112`) then rewrites:

| Wire content | Result | Line |
|---|---|---|
| `role: "tool"` or any `tool_calls` present | markers stripped, content untouched | `:129-133` |
| plain string | one `{type:"text", text, cache_control:{type:"ephemeral"}}` block | `:134-139` |
| block array | marker on the **last** text block, all sentinels stripped | `:140-152` |
| `null` content | marker dropped, nothing else changes | `:154` |

A message counts as marked from **either** the message or any block (`:122-124`), and an unmarked
body is returned by identity (`touched` guard, `:117`, `:156`) — pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts:639-641`.

The two transforms compose as `applyCacheControlMarkers(applyBodyExtras(args, extras))`
(`packages/llm/src/openai-compatible-request.ts:235`) — body extras first, markers second.

### 4.6 `applyBodyExtras`

`packages/llm/src/openai-compatible-request.ts:179-191`: `undefined` extras return the body by identity (`:183`);
a key in `FORBIDDEN_PROVIDER_BODY_KEYS` (`packages/capability/src/provider-resolver.ts:40-46`:
`messages`, `tools`, `model`, `stream`, `tool_choice`) is skipped (`:186`); a `null` value **deletes**
the key rather than sending `null` (`:187`). Pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts:586-597`, and end-to-end at
`packages/llm/tests/integration/provider-request-shape.test.ts:111-156`, where `messages`, `model`
and `tools` supplied through `body` do not reach the wire while `session_id: "session-1"` does.

### 4.7 Message conversion

`toModelMessages` (`packages/llm/src/to-model-messages.ts:69`) makes one indexing pass over assistant
`tool_calls` to build `toolNameById` (`:76-80`), then maps:

| Role | Output |
|---|---|
| `tool` with images (and not stripping) | `output: { type: "content", value: [text?, …file parts] }` (`:86-97`) |
| `tool` otherwise | `output: { type: "text", value: content }` (`:98`); `toolName` falls back to `"unknown"` (`:105`) |
| `assistant` with reasoning, retained text parts or tool calls | `[…reasoning parts, …retained text parts (including provider options), …tool-call parts]`; otherwise one text part when non-empty; `input: tc.arguments ?? {}` |
| `assistant` plain | `content: contentToText(m.content)` (`:139`) |
| `system` | `content: contentToText(m.content)` (`:141`) |
| `user` | `toUserContent(...)` (`:142`) |

`toUserContent` (`:18`) with `stripImages` replaces each image with
`` `[image #${idx} omitted: active model lacks vision]` `` (`:31`) using a counter shared across the
whole message list, so numbering is global and monotonic (`:74`) —
`packages/llm/tests/unit/to-model-messages.test.ts:217-251` pins that ordering.

### 4.8 Result normalization

`buildCallResult` (`packages/llm/src/ai-sdk/result.ts:53`):

- `normalizeModelText` (`:115`) removes C0/C1 control bytes except tab/newline/CR (`:6-10`, `:119`)
  and returns `undefined` when only whitespace remains (`:120`).
- Every tool call's `input` goes through `normalizeToolArguments`
  (`packages/capability/src/tool-arguments.ts:57`); a failure yields `arguments: {}` **plus**
  `malformedArguments: norm.preview` (`packages/llm/src/ai-sdk/result.ts:64-70`). The TSDoc states the
  consequence of not normalizing here: a raw string "comes back **double-encoded** on the next
  request, so the model's own history demonstrates the malformed shape and it reproduces it"
  (`:43-46`), and notes the SDK cannot catch it because `toAiSdkTools` builds each tool with a bare
  `jsonSchema(...)` and no `validate` (`:48-51`).
- `reasoningParts` are lifted from the **last** assistant message in `responseMessages`
  (`:75-93`), preserving opaque `providerOptions`. Round-tripped end to end for Anthropic
  signatures (`packages/llm/tests/integration/provider-request-shape.test.ts:424-461`), OpenAI
  `item_reference` (`:357-391`) and openai-compatible `reasoning_content` (`:224-257`).
- `textParts` retain assistant text plus opaque provider options and normalize only the public
  `commentary`/`final_answer` phase. `buildCallResult` accepts aggregate response messages/content,
  while `AiSdkAdapter.call` retains streaming text lifecycle metadata. `toModelMessages` replays the
  original parts instead of flattening them. Tests: “retains assistant text phase” in
  `packages/llm/tests/unit/ai-sdk-modules.test.ts`, “replays phased assistant text” in
  `packages/llm/tests/unit/to-model-messages.test.ts`, and “retains native Responses commentary
  metadata” in `packages/llm/tests/integration/provider-request-shape.test.ts`.
- `normalizeUsage` (`:24`) defaults all four counters to `0` and reads `inputTokenDetails`
  defensively (`:25-31`).
- `raw.finishReason` passes through unmodified onto `LLMCallResult.finishReason` when present
  (`:59`, `:100`); absent, the field is simply omitted. Asserted end to end by
  `packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts:147`
  (`res.finishReason === "tool-calls"`) and by
  `packages/llm/tests/unit/ai-sdk-modules.test.ts:385-390`.

### 4.9 Error normalization — `toProviderError`

`packages/llm/src/ai-sdk/errors.ts:214-263`, in strict order:

| # | Condition | Result |
|---|---|---|
| 1 | `findProviderResponseLimitError(err)` matches (`:219`) | `ProviderError(limit.message, { kind: "client", …extra })` (`:220-222`) |
| 2 | `APICallError.isInstance(err)` (`:223`) | classify with status/headers/body/`isRetryable`; message from `describeHttpFailure` (`:224-239`) |
| 3 | `readStructuredProviderError(err)` matches (`:241`) | classify the in-stream payload's own status (`:243-255`) |
| 4 | otherwise (`:257`) | `ProviderError("Model call failed (transport error).", …)` (`:258-263`) |

`readStructuredProviderError` (`:183-197`) accepts only a **non-`Error`** object (`:186`), unwraps an
`error` key (`:188-189`), requires a readable message via `pickBodyMessage` (`:190`), and takes
`code`/`status` as an HTTP status only inside `[100, 599]` (`:191-196`). Its TSDoc names the failure
it fixes: an OpenAI-compatible endpoint reporting a late failure as a data frame "fell to the
transport branch … and defaulted to the non-retryable `client` kind: a plainly retryable rate limit
then killed the run on its first occurrence" (`:167-173`). Pinned by
`packages/llm/tests/unit/ai-sdk-modules.test.ts:468-512`, including the negative case: an `Error`
carrying `code: "ECONNRESET"` stays on the transport path (`:501-507`).

Message composition (`describeHttpFailure`, `:148-154`): `statusLabel(status)` (`:88-110`), plus the
provider's own explanation when the body carried one, otherwise `statusGuidance(status)`
(`:119-136`). The explanation is `sanitizeErrorMessage`-redacted, whitespace-collapsed and capped at
`MAX_REASON_LEN = 200` with a trailing `…` (`:74-78`, `:25`). The exact strings for 401/402/403/404/
408/413/429/502 are pinned by `packages/llm/tests/unit/ai-sdk-modules.test.ts:514-559`.

### 4.10 Classification — `classifyProviderError`

`packages/llm/src/classify-provider-error.ts:296-331`, evaluated top to bottom:

| Order | Rule | Kind | Line |
|---|---|---|---|
| 1 | body/cause text matches `OVERFLOW_SIGNALS` (10 entries) | `context_overflow` | `:306` (`:49-60`) |
| 2 | text matches `QUOTA_SIGNALS` (5 entries) | `quota` | `:308` (`:73-79`) |
| 3 | text matches `CONTENT_POLICY_SIGNALS` (8 entries) | `content_policy` | `:310` (`:95-104`) |
| 4 | `status === 401 \|\| 403` | `auth` | `:312` |
| 5 | `429`, `529`, `5xx`, `2xx`, `timedOut`, `isRetryable`, or (no status **and** network-like cause) | `transient` | `:314-324` |
| 6 | any other `4xx` | `client` | `:326` |
| 7 | text matches `OVERLOAD_SIGNALS` (8 entries) | `transient` | `:328` (`:62-71`) |
| 8 | default | `client` | `:330` |

The ordering is load-bearing in two places the code itself documents. Quota is tested **before**
content policy "a quota or billing body occasionally carries the word 'safety' in boilerplate, and
the reverse ordering would file a spend problem as a policy refusal" (`:84-87`); and every
content-policy entry is multi-word or underscored because a bare `"safety"` "matched Azure and
Bedrock boilerplate that rides along on ordinary rate-limit and overload responses" and would have
turned those into permanent refusals (`:88-93`). Both are pinned:
`packages/llm/tests/unit/classify-provider-error.test.ts:264-277` (incidental "safety" on a 429 stays
`transient`) and `:278-285` (quota wins when both signals appear).

Rule 5's `2xx` arm is explained at `:285-287`: "reaching the classifier with a success status means
the body was malformed or truncated" — pinned at
`packages/llm/tests/unit/classify-provider-error.test.ts:39-48`, with `:50-58` showing text signals
still beat it.

`isNetworkErrorLike` (`:179-203`) walks `name`/`message`/`code`, nested `cause` and aggregated
`errors`, to depth 3, against 22 signals (`:148-172`).

Retry-delay extraction, `readRetryAfter` (`:251-271`), in priority order: `retry-after-ms` (numeric,
already in ms), then `retry-after`, `x-ratelimit-reset-after`, `anthropic-ratelimit-unified-reset`
through `parseRetryAfter`. `parseRetryAfter` (`:219`) accepts whole **or decimal** seconds
(`:226-230`) and an HTTP-date resolved against `now` and clamped to `0` (`:231-234`).

### 4.11 Transport retry

`withTransportRetry` (`packages/llm/src/retry-llm-provider.ts:100`). `maxRetries <= 0` bypasses the loop but still
promotes `err.partialUsage` onto `err.accumulatedUsage` (`:107-114`). Otherwise, per attempt
(`:152-223`):

| Event | Effect |
|---|---|
| success | return `withLost(result)` — attaches `retriedUsage` only when something was lost (`:149-151`, `:154-155`) |
| any `ProviderError` | `chargeLost(err)` accumulates `partialUsage` (`:164`, `:145-148`) |
| not transient, or `attempt >= maxRetries`, or signal already aborted | `gaveUp(…)`, attach `accumulatedUsage`, rethrow (`:165-172`) |
| `err.streamStarted` and a live delta consumer is present | `gaveUp(err, "stream_started")`, rethrow — no retry, except for `ModelCallInactivityError` |
| `ModelCallInactivityError` | remains retryable after earlier visible progress; inactivity is the recovery boundary |
| `err.streamStarted` with no `onStreamDelta`/`onToolInputDelta` consumer | retry remains eligible; no partial turn escaped the aggregate call |
| `err.retryAfterMs > maxRetryAfterMs` | `gaveUp(err, "retry_after_too_long")`, rethrow (`:184-188`) |
| otherwise | `attempt += 1`, compute delay, fire `params.onRetry`, `warn`, sleep (`:189-217`) |
| abort during the sleep | `gaveUp(err, "aborted")`, rethrow (`:218-222`) |

`chargeLost` runs for **every** `ProviderError`, not only retryable ones; the TSDoc says a first-
attempt `auth` or `quota` failure "still billed whatever it read, and skipping it would make
`usage_attributed` report `false` for tokens that were in fact readable" (`:157-162`).

`backoffDelayMs` (`:51-61`): a server-advised `retryAfterMs` wins, capped at `maxRetryAfterMs`
(`:58`); otherwise `min(maxDelayMs, base * 2^(n-1))` with up to 25% jitter, re-capped at
`maxDelayMs` (`:59-60`). `packages/llm/tests/unit/retry-llm-provider.test.ts:284-299` asserts the cap
holds at maximum jitter.

`cancellableSleep` (`:70-85`) `unref`s its timer so a pending backoff never keeps the process alive
(`:82`).

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
`maxRetryAfterMs = params.maxRetryAfterMs ?? opts.maxRetryAfterMs ?? maxDelayMs` (`:105-106`), and
the function's own TSDoc states it directly (`:91-92`). Pinned by
`packages/llm/tests/unit/retry-llm-provider.test.ts:346-355`, titled "reports the per-call
maxRetries override, not the wrapper default".

### 4.12 Call logging

`withCallLogging` (`packages/llm/src/logging-llm-provider.ts:74`). Every payload is behind a level guard
(`wantsDebug`/`wantsWarn`, `:77-78`); `approxInputChars` (`:26`) is memoized per call through
`chars()` (`:90`) and its TSDoc forbids calling it outside a guard: "it is O(transcript) on every
physical model attempt, and `@clarvis/code` runs its kernel at `silent`" (`:21-24`).

| Moment | Record | Level | Line |
|---|---|---|---|
| start | `llm.call.start` | debug | `:93-98` |
| every 20 s in flight | `llm.call.pending` | warn | includes `stream_started` and, after progress, `last_progress_ms`; no per-delta log |
| return, `< 30 s` | `llm.call.done` | debug | `:119-136` |
| return, `>= 30 s` | `llm.call.slow` | warn | `:118-134` |
| throw | `llm.call.failed`, then rethrow unchanged | warn | `:138-151` |

`attempt_of_call` counts physical attempts by keying a `WeakMap` on the params **object**
(`:52`, `:79-80`), which works because "`withTransportRetry` sits *outside* this decorator and
re-enters `inner.call(params)` with the very same object" (`:44-50`). The pending interval is
`unref`'d and not armed at all when warnings are discarded (`:100`, `:113`).

### 4.13 Admission control

`ModelCallAdmissionController.call` (`packages/llm/src/model-call-admission.ts:194-292`):

1. `acquire(params.signal)` (`:195`, `:294-321`).
2. `bridgeModelCallTimeout(params)` attaches the timeout channel under a module-private `Symbol`
   (`:196`, `packages/llm/src/model-call-timeout-bridge.ts:3`, `:67-71`).
3. Callbacks are re-wrapped through mutable locals so they can be detached (`:198-215`).
4. `Promise.race([outcome, aborted, timedOut])` (`:246`).
5. Not interrupted → detach callbacks, release, return or rethrow (`:248-253`).
6. Interrupted → race the outcome against an `abortSettleMs` timer (`:256-263`). Settled in time →
   release; a rejection wins over the interruption error (`:266-270`). Otherwise **quarantine**:
   increment, reject the whole queue, `llm.admission.stuck` at `warn`, arm a release on the
   eventual settlement, throw `ModelCallStuckError` (`:272-288`).
7. `finally` → `bridged.bridge.cleanup()` (`:290`).

State machine, from `snapshot()` (`:176-185`) and the mutators:

| State | Event | Next state | Effect |
|---|---|---|---|
| `open` | `acquire`, `signal.aborted === true` before enqueue | `open` | throw the signal's own abort error immediately, **not** `ModelCallUnavailableError` (`:297`) |
| `open` | `acquire`, `active < maxActive` and queue empty | `open` | permit granted (`:298-302`) |
| `open` | `acquire`, `queue.length >= maxQueued` | `open` | throw `ModelCallUnavailableError("queue_full")` (`:303-305`) |
| `open` | `inner.call(forwarded)` throws **synchronously** (not a rejected promise) | `open` | callbacks cleared, the just-taken permit released, error rethrown unchanged (`:217-224`) |
| `open` | `acquire`, otherwise | `open` | enqueue FIFO waiter (`:307-320`) |
| `open` | call settles | `open` | `release(false)` → `drain()` (`:323-328`, `:330-345`) |
| `open` | interrupted call does not settle in `abortSettleMs` | `quarantined` | queue rejected, `warn`, `ModelCallStuckError` (`:272-288`) |
| `quarantined` | `acquire` | `quarantined` | throw `ModelCallUnavailableError("quarantined")` (`:296`) |
| `quarantined` | stuck transport finally settles | `open` | `quarantinedCount -= 1`, `release(true)` (`:283-287`) |
| any | `close()` | `closed` | queue rejected with `"closed"` (`:187-192`) |
| `closed` | `acquire` | `closed` | throw `ModelCallUnavailableError("closed")` (`:295`) |

`drain()` refuses to run while closed or quarantined (`:331`) and skips a waiter whose signal already
aborted (`:334-338`). `changed()` swallows a throwing `onStateChange` with one of the package's few
non-TSDoc `//` comments: "Diagnostics are observers, never part of admission ownership. A broken
metrics sink must not strand an active permit or reject healthy work" (`:359-362`) — pinned by
`packages/llm/tests/unit/model-call-admission.test.ts:49-60`. `src/` carries several other such
comments (e.g. `packages/llm/src/model-call-timeout-bridge.ts:39`, `packages/llm/src/stream-metrics.ts:57`,
`packages/llm/src/ai-sdk/bounded-fetch.ts:53-54`, `packages/llm/src/ai-sdk/result.ts:5,116-118`), all explaining a similarly
non-obvious "must not fail loudly here" boundary.

Constructor validation is strict: `maxActive` must be a **positive** integer (`:122-128`),
`maxQueued`/`abortSettleMs` non-negative integers (`:130-136`); a violation is a `TypeError`.

### 4.14 The timeout bridge

`bridgeModelCallTimeout` returns params carrying the bridge under `MODEL_CALL_TIMEOUT_BRIDGE` plus
the bridge itself. `markStreamStarted` remembers whether provider output preceded an idle expiry.
`markTimedOut` mints one `ModelCallInactivityError`, including that stream-start fact, and resolves
the promise with it; the adapter's timeout branches enrich the cooperative failure with any
available partial usage before it crosses retry. `registerCleanup` returns an unregister closure and
is a no-op after `cleanup()`; `cleanup()` is idempotent and each
cleanup's throw is swallowed — "Timer cleanup is housekeeping. It must never replace a provider
result". `modelCallTimeoutBridgeOf` is what the adapter reads; it returns `undefined` when admission never wrapped the call
(`packages/llm/tests/unit/model-call-timeout-bridge.test.ts:26-29`).

This is what lets the admission gate release a permit on a *cooperative* timeout rather than
quarantining it — `packages/llm/tests/component/ai-sdk-adapter.test.ts:259-286` (`state: "open"`,
`active: 0`) versus `:287-320` (a transport that ignores the timeout → `ModelCallStuckError`,
`state: "quarantined"`).

### 4.15 Bounded fetch

`createBoundedFetch` (`packages/llm/src/ai-sdk/bounded-fetch.ts:62`) wraps the base fetch with its own
`AbortController` combined with the caller's signal (`:99-102`), then:

| Check | Effect | Line |
|---|---|---|
| declared `content-length > maxResponseBytes` | `reportLimit`, abort upstream, detach body cancel, throw before reading | `:104-111` |
| `response.body === null` | pass through untouched | `:112` |
| cumulative bytes `> maxResponseBytes` | `reportLimit`, `fail(controller, …)` | `:145-150` |
| SSE only: bytes since the last delimiter `> maxSseEventBytes` | `reportLimit`, `fail(...)` | `:152-165` |
| consumer cancels the wrapped body | abort upstream, cancel the reader | `:168-171` |

The SSE scan (`:152-159`) counts `\n` as a line end, resets `eventBytes` on a blank line
(`lineBytes === 0`), and ignores `\r` — which is why a `\r\n\r\n` delimiter split across two source
chunks is still recognised (`packages/llm/tests/unit/bounded-fetch.test.ts:83-98`).

`detachCancellation` (`:49-56`) routes the cancel through `suppressSecondaryRejection`
(`packages/capability/src/tasks.ts:63`) so "a non-cooperative cancel algorithm" cannot delay the
already-decided outcome (`:47-48`); both halves are pinned by
`packages/llm/tests/unit/bounded-fetch.test.ts:20-42` and `:54-81`, which reject the cancellation
promise *after* the limit error has already surfaced.

`findProviderResponseLimitError` (`:184-195`) walks a `cause` chain to depth 8 with a `seen` set
against cycles.

### 4.16 Decorator composition, as the host wires it

`packages/loop/src/runtime/build-run-deps.ts:453-474` builds, innermost first:

```
createAiSdkProvider(...)                       :453
  → withModelCallAdmission(provider, gate)     :466
  → withCallLogging(..., logger)               :466
  → withTransportRetry(..., {...})             :465
```

and `packages/loop/src/runtime/execute-run.ts:398` wraps that again per run with
`withPromptCacheDefaults(deps.llm, { promptCacheKey, promptCacheTtl })`. This places retry
**outside** logging, which is exactly the arrangement `attemptsByParams` depends on
(`packages/llm/src/logging-llm-provider.ts:44-50`), and admission **inside** logging, so each
physical attempt takes one permit.

---

## 5. Invariants

Numbered; each carries the production site and the test that pins it.

**LLM-1 (owns INV-032).** The main entry `src/index.ts` never statically reaches
`ai-sdk-adapter.ts` or `stream-metrics.ts`, and nothing it statically reaches names `ai` or any
`@ai-sdk/*` specifier.
Production: `packages/llm/src/index.ts:15-21`; the escape hatch is the dynamic
`await import("./ai-sdk-adapter.ts")` at `packages/llm/src/lazy.ts:44`.
Test: `packages/llm/tests/architecture/lazy-entry.test.ts:71-73`, `:75-77`, `:79-86`.

**LLM-2 (owns INV-033).** That walk is not vacuous: the main entry *does* statically reach
`retry-llm-provider.ts`, `logging-llm-provider.ts` and `lazy.ts`.
Production: `packages/llm/src/index.ts:15, 17, 20`.
Test: `packages/llm/tests/architecture/lazy-entry.test.ts:88-93`.

**LLM-3 (owns INV-034).** The `./adapter` entry *does* statically reach `ai-sdk-adapter.ts`.
Production: `packages/llm/src/adapter.ts:10`.
Test: `packages/llm/tests/architecture/lazy-entry.test.ts:95-98`.

**LLM-4.** The static-specifier extractor LLM-1..3 rest on must see bound imports, re-exports and
bare side-effect imports, and must erase `import type`, `export type` and dynamic `import()`.
Production: the regexes at `packages/llm/tests/architecture/lazy-entry.test.ts:14`, `:22`, `:30`.
Test: same file, `:104-128`.

**LLM-5.** A provider declaring `apiKeyEnv` whose variable is unset fails locally with a
`ProviderError` naming the variable, before any request is sent — including for
`openai-compatible`, which otherwise requires no key.
Production: `packages/llm/src/ai-sdk-adapter.ts:281-287` (and the keyless path at `:291-298`).
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts:155-173` (asserts the variable name is in
the message and `generateText` was never called) and `:175-185` (a keyless endpoint declaring nothing
still works).

**LLM-6.** `llm.provider.resolved` is emitted at most once per `(provider, model)` pair, never at
all when the client could not be built, and carries the base URL's **host only**, header **names**
only, and the API key as a boolean.
Production: `packages/llm/src/ai-sdk-adapter.ts:207-225`, `hostOf` at `:83-90`, ordering at
`:168-171`.
Test: `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts:44-79` (no `sk-`, no header
value, no path), `:103-116` (unparsable URL omitted), `:131-150` (once per pair), `:151-165` (silent
on a build failure).

**LLM-7.** A cache breakpoint the caller asked for that did not reach the request is reported at
`warn`, and is reported even when `debug` is off.
Production: `packages/llm/src/ai-sdk-adapter.ts:329-342`.
Test: `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts:243-262` (`none_markable`),
`:263-287` (`collapsed`), `:289-296` (silent when the kind never marks), `:298-311` (warn-only logger
still gets it).

**LLM-8.** The request `diagnostics` object never reaches a provider: it is a separate return key
from `request`, and only `request` is spread onto the SDK call.
Production: `packages/llm/src/ai-sdk/request-options.ts:605-617`; the spread at
`packages/llm/src/ai-sdk-adapter.ts:396-401`.
Test: `packages/llm/tests/integration/wire-cache-diff.test.ts:103-110` pins the exact top-level key
set of the serialized body, which contains no `diagnostics`.

**LLM-9.** SDK-level retries are disabled on every call (`maxRetries: 0`), so `withTransportRetry`
is the sole retry authority.
Production: `packages/llm/src/ai-sdk-adapter.ts:400`.
Test: **unpinned** — no test asserts `callArgs.maxRetries === 0`.

**LLM-10.** A per-call timeout is a `ModelCallInactivityError` classified as `transient`, never as a
permanent `client` fault. On a streaming path the deadline resets on every provider part; generation
has no progress signal and remains absolutely bounded.
Production: `timeoutAbort` and both timeout branches in `AiSdkAdapter.call`.
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts:241-257` (generate) and
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts` (silent timeout and active stream).

**LLM-11.** A stream that ends with no aggregate is a **transient** failure, reported at `warn` with
`stream_started` and `partial_output_tokens`.
Production: `packages/llm/src/ai-sdk-adapter.ts:509-526`.
Test: `packages/llm/tests/component/ai-sdk-adapter-observability.test.ts:414-438`, `:439-450`.

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
Test: `packages/llm/tests/unit/retry-llm-provider.test.ts:450-463` and `:464-474`.

**LLM-14.** Every failed `ProviderError` attempt's `partialUsage` is accumulated and surfaced —
as `retriedUsage` on an eventual success, or as `accumulatedUsage` on the final error — and absent
usage stays absent rather than becoming zero.
Production: `packages/llm/src/retry-llm-provider.ts:145-151`, `:164`, `:170`, `:181`, `:186`, `:220`;
also the `maxRetries <= 0` path at `:107-114`.
Test: `packages/llm/tests/unit/retry-llm-provider.test.ts:393-411` (accumulates onto success),
`:421-425` ("leaves retriedUsage absent when no failed attempt reported usage"), `:426-437`
(`accumulatedUsage` on exhaustion), `:55-74` (promoted with no retry loop).

**LLM-15.** Only `kind === "transient"` is retried. `client`, `auth`, `quota`, `content_policy` and
`context_overflow` are terminal, as is any non-`ProviderError` throw.
Production: `packages/llm/src/retry-llm-provider.ts:34-36`, `:165-172`.
Test: `packages/llm/tests/unit/retry-llm-provider.test.ts:83-92`, `:93-100`, `:364-391`.

**LLM-16.** Classification order is: overflow text → quota text → content-policy text → 401/403 →
retryable statuses/flags → other 4xx → overload text → default `client`.
Production: `packages/llm/src/classify-provider-error.ts:306-330`.
Test: `packages/llm/tests/unit/classify-provider-error.test.ts:278-285` (quota before content
policy), `:264-277` (incidental "safety" on a 429 stays transient), `:110-117` (4xx with overload
text is `client`), `:118-124` (overload text with no definitive 4xx is transient), `:137-142`
(unknown payload defaults to `client`).

**LLM-17.** A 2xx status reaching the classifier is `transient`, but explicit text signals override
it.
Production: `packages/llm/src/classify-provider-error.ts:318`, ahead of the `:306`/`:308` guards.
Test: `packages/llm/tests/unit/classify-provider-error.test.ts:39-48`, `:50-58`.

**LLM-18.** A structured provider error delivered *inside* a 200 stream is classified on its own
`code`/`status`, and an `Error` carrying an errno-shaped `code` is not.
Production: `packages/llm/src/ai-sdk/errors.ts:183-197`, `:241-256`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:475-482`, `:483-488`, `:489-495`,
`:501-507`, `:508-512`.

**LLM-19.** A provider's own error text is surfaced but secret-redacted and bounded at 200
characters plus an ellipsis; a bare transport failure surfaces no message at all.
Production: `packages/llm/src/ai-sdk/errors.ts:74-78`, `:258`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:540-548` (redaction),
`:561-582` (extraction variants and the `<= 224`-character bound ending in `…`),
`:462-466` ("maps a transport failure without leaking its message").

**LLM-20.** `retry-after-ms` is preferred over `retry-after`, and decimal seconds are accepted.
Production: `packages/llm/src/classify-provider-error.ts:256-260`, `:226-230`.
Test: `packages/llm/tests/unit/classify-provider-error.test.ts:298-303`, `:304-308`, `:309-313`,
`:314-317`.

**LLM-21.** `withPromptCacheDefaults` fills the key and the TTL **independently**; a call pinning
one still inherits the other.
Production: `packages/llm/src/prompt-cache-provider.ts:37-38`.
Test: `packages/llm/tests/unit/prompt-cache-provider.test.ts:41-49`, `:50-56`, `:57-64`.

**LLM-22.** An `openai-compatible` request carrying a `promptCacheKey` pins the backend on **both**
halves — `session_id` in the body and `x-session-id` as a header — with the same value; no other
kind gets either. This condition (`kind === "openai-compatible" && promptCacheKey !== undefined`,
`:578-580`) does not test `promptCache` at all, so the pin is sent even under `implicit` mode, where
no `cache_control` marker is ever applied — pinning and marking are fully decoupled decisions.
Production: `packages/llm/src/ai-sdk/request-options.ts:199-201`, `:588-591`.
Test: `packages/llm/tests/integration/wire-cache-diff.test.ts:82-92` (asserts a stable
`prompt_cache_key`/header pair across turns run under `promptCache: "implicit"` while no
`cache_control`/sentinel ever appears), `:124-128`,
`packages/llm/tests/unit/ai-sdk-modules.test.ts:73`, `:78-85`, `:87-93`.

**LLM-23.** An `implicit` prompt-cache mode sends no `cache_control` and no sentinel, and the wire
prefix stays byte-identical turn over turn.
Production: `markCompatible` requires `mode === "explicit"`
(`packages/llm/src/ai-sdk/request-options.ts:560-561`).
Test: `packages/llm/tests/integration/wire-cache-diff.test.ts:85-99`.

**LLM-24.** The `__clarvis_cache_control` sentinel never reaches the wire, wherever it landed.
Production: `packages/llm/src/openai-compatible-request.ts:127` (message level) and `:76-80`
(unconditional block sweep).
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:599-618`, `:620-637`, `:639-656`;
end-to-end at `packages/llm/tests/integration/provider-request-shape.test.ts:155`.

**LLM-25.** A `role: "tool"` message, and any message carrying `tool_calls`, keeps its wire `content`
a plain string — never promoted to a block array — and the breakpoint walks back instead. The
sentinel is stripped from such a message unconditionally even when nothing in `@clarvis/llm` itself
marked it, "for a host that builds its own markers with no adapter in the path": several
OpenAI-compatible gateways accept only a string as `content` there, so promoting it to a block array
"is a schema change unrelated to caching that reads as an unrelated 400"
(`packages/llm/src/openai-compatible-request.ts:99-110`).
Production: `markerSiteOf` (`packages/llm/src/ai-sdk/request-options.ts:354-360`) and
`applyCacheControlMarkers` (`packages/llm/src/openai-compatible-request.ts:129-133`).
Test: `packages/llm/tests/integration/provider-request-shape.test.ts:163-189` (asserts both contents
are strings, neither carries `cache_control`, and the markers landed at indices `[0, 1]`);
`packages/llm/tests/unit/ai-sdk-modules.test.ts:620-637`.

**LLM-26.** At most two message-level cache breakpoints per request, on both the Anthropic and the
openai-compatible path; a system-role index is discarded rather than consuming a slot; two requested
indices that walk back never collapse onto one message.
Production: `MAX_MESSAGE_CACHE_BREAKPOINTS = 2` (`packages/llm/src/ai-sdk/request-options.ts:253`),
`cacheBreakpointTargets` (`:256-268`), the `targets.has(j)` skip in `markable` (`:412`).
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:236-258`;
`packages/llm/tests/unit/observability.test.ts:360-380`.

**LLM-27.** `undefined` `cacheBreakpoints` marks nothing on openai-compatible, but rolls a single
breakpoint onto the newest usable message on Anthropic.
Production: `packages/llm/src/ai-sdk/request-options.ts:417` versus `:271-274`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:277` (`request("explicit")` with no
breakpoints contains no sentinel) and `:257` (Anthropic's rolling default).

**LLM-28.** `FORBIDDEN_PROVIDER_BODY_KEYS` are dropped from the operator's `body` escape hatch even
with no settings schema in the path, and a `null` value **deletes** the key rather than sending
`null`.
Production: `packages/llm/src/openai-compatible-request.ts:186-188`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:586-597`;
end-to-end at `packages/llm/tests/integration/provider-request-shape.test.ts:111-156`.

**LLM-29.** `includeUsage: true` is unconditional for `openai-compatible`, so the standard
`stream_options: { include_usage: true }` is always requested.
Production: `packages/llm/src/openai-compatible-request.ts:234`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:658-672`.

**LLM-30.** An unset `${VAR}` in a configured header fails fast as a `client` `ProviderError`
naming the variables, rather than escaping as a `MissingEnvVarsError` the outer catch would classify
as transient; a non-`MissingEnvVarsError` throw from the lookup propagates unchanged.
Production: `packages/llm/src/openai-compatible-request.ts:256-266`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:673-691`.

**LLM-31.** Tool arguments are normalized exactly once, where the SDK output becomes an
`LLMToolCall`; a malformed payload yields `{}` plus a `malformedArguments` preview, never a silent
`{}`.
Production: `packages/llm/src/ai-sdk/result.ts:62-72`.
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:327-344`, `:357-373`.

**LLM-32.** Model text has C0/C1 control characters stripped (tab, LF and CR kept) and collapses to
`undefined` when only whitespace remains; a large body is processed by one linear replacement, never
by a codepoint array.
Production: `packages/llm/src/ai-sdk/result.ts:6-10`, `:115-120` (with the reason in one of
`src/`'s few non-TSDoc comments, `:116-118`).
Test: `packages/llm/tests/unit/ai-sdk-modules.test.ts:346-355` (including a 1 MiB body).

**LLM-33.** Images are stripped exactly when the resolved model lacks the `"vision"` capability, and
a stripped image becomes a **numbered placeholder**, never a dropped part; numbering is global across
the whole message list.
Production: `packages/llm/src/ai-sdk-adapter.ts:387`;
`packages/llm/src/to-model-messages.ts:31`, `:74`.
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts:201-228`;
`packages/llm/tests/unit/to-model-messages.test.ts:188-206`, `:207-216`, `:217-251`, `:280-297`.

**LLM-34.** The admission gate defaults to 4 active and 8 queued calls, admits FIFO, and refuses a
call beyond the queue with `ModelCallUnavailableError("queue_full")`.
Production: `packages/llm/src/model-call-admission.ts:12-13`, `:298-305`, `:330-345`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts:41-47`, `:62-90`.

**LLM-35.** A cancelled transport that has not exited within `abortSettleMs` quarantines the gate:
the queue is rejected, new calls are refused, and the gate reopens only when that transport finally
settles — whether it resolves or rejects.
Production: `packages/llm/src/model-call-admission.ts:272-288`, `:283-287`, `:296`, `:331`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts:92-126` (resolves) and `:127-153`
(rejects).

**LLM-36.** A throwing `onStateChange` observer can neither strand a permit nor reject healthy work.
Production: `packages/llm/src/model-call-admission.ts:356-363`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts:49-60`.

**LLM-37.** Admission forwards the caller's `onStreamDelta`/`onToolInputDelta`/`onRetry` and detaches
them the moment the call settles, so a late emission from the same provider handle is dropped.
Production: `packages/llm/src/model-call-admission.ts:198-215`, `:211-215`, `:249`, `:264`.
Test: `packages/llm/tests/unit/model-call-admission.test.ts:230-269`.

**LLM-38.** A per-call timeout observed through the bridge releases a **cooperative** transport's
permit (state stays `open`), while a transport that ignores it is quarantined.
Production: bridge at `packages/llm/src/model-call-timeout-bridge.ts:45-53`, consumed at
`packages/llm/src/ai-sdk-adapter.ts:384`, raced at
`packages/llm/src/model-call-admission.ts:241-246`.
Test: `packages/llm/tests/component/ai-sdk-adapter.test.ts:259-286` versus `:287-320`.

**LLM-39.** `admissionStateLogger` emits one `info` per state **transition**, deduped per instance,
never per snapshot.
Production: `packages/llm/src/model-call-admission.ts:61-79`.
Test: `packages/llm/tests/unit/observability.test.ts:159-178`, `:179-196`, `:197-204`, `:205-212`.

**LLM-40.** A provider response exceeding the byte bound, or an SSE event never reaching a
delimiter, fails the attempt as a non-retryable `client` error, and the failure does not wait on a
non-cooperative cancel algorithm.
Production: `packages/llm/src/ai-sdk/bounded-fetch.ts:104-111`, `:145-165`, `:49-56`;
flattening to `client` at `packages/llm/src/ai-sdk/errors.ts:219-222`.
Test: `packages/llm/tests/unit/bounded-fetch.test.ts:9-18`, `:20-42`, `:44-52`, `:54-81`,
`:100-112`; end-to-end at
`packages/llm/tests/integration/provider-request-shape.test.ts:318-334` (asserts
`kind: "client"` and a message containing "SSE event exceeded").

**LLM-41.** Cancelling the bounded body aborts the upstream request and cancels the source reader.
Production: `packages/llm/src/ai-sdk/bounded-fetch.ts:168-171`.
Test: `packages/llm/tests/unit/bounded-fetch.test.ts:113-145`.

**LLM-42.** The batcher never leaves a tail stranded: an idle timer flushes after `maxMs` with no
further delta, and a channel switch flushes first so text and reasoning never merge.
Production: `packages/llm/src/ai-sdk/streaming.ts:87-97`, `:102`.
Test: `packages/llm/tests/unit/delta-batcher.test.ts:69-82`, `:83-95`, `:138-151`, `:166-175`.

**LLM-43.** A sink failure raised inside the idle timer is captured and surfaced on the owning call,
including a non-`Error` throw.
Production: `packages/llm/src/ai-sdk/streaming.ts:58`, `:68-72`, `:89-95`.
Test: `packages/llm/tests/unit/delta-batcher.test.ts:96-111`, `:112-137`.

**LLM-44.** `logging-llm-provider` computes nothing the active level will discard: `approxInputChars`
is not called at `silent`, is called at most once per call at `debug`, and the pending interval is
not armed when warnings are discarded.
Production: `packages/llm/src/logging-llm-provider.ts:77-78`, `:89-90`, `:100`.
Test: `packages/llm/tests/unit/logging-llm-provider.test.ts:216-227`, `:228-238`, `:239-254`,
`:255-265`, `:266-277`.

**LLM-45.** `approxInputChars` produces exactly the length `contentToText` would have produced.
Production: `packages/llm/src/logging-llm-provider.ts:26-41`.
Test: `packages/llm/tests/unit/logging-llm-provider.test.ts:278-298`.

**LLM-46.** `attempt_of_call` counts physical attempts of one logical call, keyed on the params
object identity.
Production: `packages/llm/src/logging-llm-provider.ts:52`, `:79-80`.
Test: `packages/llm/tests/unit/logging-llm-provider.test.ts:167-190`.

**LLM-47.** `llm.retry.gave_up` is emitted for every terminal outcome of the retry loop, carrying one
of five reasons.
Production: `packages/llm/src/retry-llm-provider.ts:31-32`, `:127-144`.
Test: `packages/llm/tests/unit/observability.test.ts:42-58` (`non_transient`), `:59-88`
(`exhausted` with lost tokens), `:89-97` (`stream_started`), `:98-106` (`retry_after_too_long`),
`:107-117` and `:118-136` (`aborted`), `:137-147` (silent with no retry policy).

**LLM-48.** A provider error body that degrades the classification says so at `debug`, and does not
throw when no logger was supplied.
Production: `packages/llm/src/ai-sdk/errors.ts:64-68` (`llm.error.body_unparsed`);
`packages/llm/src/classify-provider-error.ts:121-124` (`llm.error.body_unstringifiable`) and
`:134-137` (`llm.error.cause_unstringifiable`).
Test: `packages/llm/tests/unit/observability.test.ts:236-248`, `:249-263`, `:264-270`.

**LLM-49.** `streamMetrics()` selects a JSONL file sink when `CLARVIS_STREAM_DEBUG` is non-empty,
otherwise selects a no-op, and memoizes that first selection process-wide. `createStreamMetrics`
never throws — not even when its log directory disappears.
Production: `packages/llm/src/stream-metrics.ts:29`, `:97-105`, `:53-59` (the `try/catch` around
`appendFileSync`, with the comment "Instrumentation must never take the run down with it", `:57`).
Test: `packages/llm/tests/unit/stream-metrics.test.ts` exercises the enabled selector in a fresh Bun
child process, the unset memo in-process, and the complete file sink directly.

**LLM-50.** `createStreamMetrics` is exported so a test can reach it statically; the file must not be
reached through a cache-busted dynamic import.
Production: `packages/llm/src/stream-metrics.ts:48`, whose TSDoc records the measurement — CI
"reported lines 39-84 as dead and failed the package's line floor on three consecutive runs while
every one of its 229 tests passed" (`:38-47`).
Test: enforced socially by the header comment at
`packages/llm/tests/unit/stream-metrics.test.ts:7-23` and by the static import at `:5`;
no mechanical guard exists.

**LLM-51.** `@clarvis/llm` carries a **100% functions / 100% lines** coverage floor and has no
`NO_COUNTER_ALLOWLIST` entry, so every file in `src/` must appear in the LCOV report.
Production: `tooling/checks/coverage.ts:32`; the absence of an `llm` key in
`NO_COUNTER_ALLOWLIST` (`tooling/checks/coverage.ts:72-205`).
Test: the coverage script itself, run by `bun run test:coverage`.

**LLM-52.** Every package test script carries `--timeout 60000`.
Production: `packages/llm/package.json:36-41`.
Test: unpinned within this package.

---

## 6. Failure modes and degradation

### 6.1 Error taxonomy produced by this package

| Error | Class | Where raised | Retryable |
|---|---|---|---|
| unresolved provider config | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts:374-377` | no |
| `apiKeyEnv` names an unset variable | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts:303-308` | no |
| key-requiring kind with no key | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts:262-265` | no |
| subscription kind with no kernel resolver | `ProviderError` kind `client` | `packages/llm/src/ai-sdk-adapter.ts:328-335` | no |
| recognized `subscription_*` failure | sanitized `ProviderError`; kind `auth`, `quota`, or `client` by code | `packages/llm/src/ai-sdk/errors.ts:219-257` | no under current mapping |
| `openai-compatible` with no `baseUrl` | `ProviderError` kind `client` | `packages/llm/src/openai-compatible-request.ts:224-226` | no |
| header `${VAR}` unset | `ProviderError` kind `client` | `packages/llm/src/openai-compatible-request.ts:260-263` | no |
| per-call timeout | `ModelCallInactivityError` → `transient`, with stream-start/available partial usage | `timeoutAbort`, `ModelCallInactivityError`, timeout branches in `AiSdkAdapter.call` | yes, including after earlier visible progress |
| stream ended with no aggregate | `ProviderError` kind `transient` | `packages/llm/src/ai-sdk-adapter.ts:521-525` | yes |
| response/SSE bound breached | `ProviderResponseLimitError`, flattened to `ProviderError` kind `client` | `packages/llm/src/ai-sdk/bounded-fetch.ts:10`; `packages/llm/src/ai-sdk/errors.ts:220-222` | no |
| any HTTP/API failure | `ProviderError` with classified kind | `packages/llm/src/ai-sdk/errors.ts:223-239` | depends |
| in-stream structured error | `ProviderError` with the payload's own status | `packages/llm/src/ai-sdk/errors.ts:241-255` | depends |
| unrecognised throw | `ProviderError("Model call failed (transport error).")` | `packages/llm/src/ai-sdk/errors.ts:257-263` | depends on `isNetworkErrorLike` |
| admission refusal | `ModelCallUnavailableError` (`code: "model_call_unavailable"`, `reason`) | `packages/llm/src/model-call-admission.ts:82-97` | not a `ProviderError`, so never retried |
| cancelled transport will not exit | `ModelCallStuckError` (`code: "model_call_stuck"`) | `packages/llm/src/model-call-admission.ts:99-109` | not a `ProviderError` |
| bad admission option | `TypeError` | `packages/llm/src/model-call-admission.ts:125`, `:133` | construction-time |

`ModelCallUnavailableError` and `ModelCallStuckError` are `CodedError`s
(`packages/capability/src/errors.ts:10`), not `ProviderError`s, so `withTransportRetry`'s
`isTransient` guard (`packages/llm/src/retry-llm-provider.ts:34-36`) rejects them and the loop sees them
immediately.

### 6.2 What degrades silently, and what says so

| Degradation | Handler | Diagnostic |
|---|---|---|
| an error body that is not JSON | `packages/llm/src/ai-sdk/errors.ts:61-69` | `llm.error.body_unparsed` at `debug` |
| a body that will not stringify | `packages/llm/src/classify-provider-error.ts:118-125` | `llm.error.body_unstringifiable` at `debug` |
| a cause that will not stringify | `packages/llm/src/classify-provider-error.ts:130-138` | `llm.error.cause_unstringifiable` at `debug` |
| a cache breakpoint that did not land | `packages/llm/src/ai-sdk-adapter.ts:337-342` | `llm.cache.breakpoint_lost` at `warn` |
| a transport bound breached | `packages/llm/src/ai-sdk/bounded-fetch.ts:80-96` | `llm.transport.limit_exceeded` at `warn`; the TSDoc notes this is "the only place the two fields the error carries survive" (`:75-78`) |
| a stuck cancelled transport | `packages/llm/src/model-call-admission.ts:275-282` | `llm.admission.stuck` at `warn` |
| the retry budget stopping | `packages/llm/src/retry-llm-provider.ts:129-143` | `llm.retry.gave_up` at `debug` |
| a `StreamMetrics` write failing | `packages/llm/src/stream-metrics.ts:56-58` | none — swallowed |
| a timer cleanup throwing | `packages/llm/src/model-call-timeout-bridge.ts:37-40` | none — swallowed |
| a throwing `onStateChange` | `packages/llm/src/model-call-admission.ts:359-362` | none — swallowed |
| a body cancel algorithm failing | `packages/llm/src/ai-sdk/bounded-fetch.ts:51-55` | none — swallowed |
| a base URL that will not parse | `packages/llm/src/ai-sdk-adapter.ts:85-89` | the `base_url` field is omitted rather than logged raw |

### 6.3 The complete log-event vocabulary this package emits

| Event | Level | Site |
|---|---|---|
| `llm.provider.resolved` | debug | `packages/llm/src/ai-sdk-adapter.ts:214` |
| `llm.cache.breakpoint_lost` | warn | `packages/llm/src/ai-sdk-adapter.ts:339` |
| `llm.cache.request` | debug | `packages/llm/src/ai-sdk-adapter.ts:345` |
| `llm.request.tuning` | debug | `packages/llm/src/ai-sdk-adapter.ts:349` |
| `llm.stream.first_token` | debug | `packages/llm/src/ai-sdk-adapter.ts:432` |
| `llm.stream.no_aggregate` | warn | `packages/llm/src/ai-sdk-adapter.ts:515` |
| `llm.call.start` | debug | `packages/llm/src/logging-llm-provider.ts:95` |
| `llm.call.pending` | warn | `withCallLogging`; carries `stream_started` and optional `last_progress_ms` |
| `llm.call.done` / `llm.call.slow` | debug / warn | `packages/llm/src/logging-llm-provider.ts:121`; carries `finish_reason: result.finishReason` (`:132`, `undefined` when the result has none — pinned by `packages/llm/tests/unit/logging-llm-provider.test.ts:117-155`) |
| `llm.call.failed` | warn | `packages/llm/src/logging-llm-provider.ts:142` |
| `llm.retry.scheduled` | warn | `packages/llm/src/retry-llm-provider.ts:207` |
| `llm.retry.gave_up` | debug | `packages/llm/src/retry-llm-provider.ts:131` |
| `llm.admission.state` | info | `packages/llm/src/model-call-admission.ts:67` |
| `llm.admission.stuck` | warn | `packages/llm/src/model-call-admission.ts:277` |
| `llm.transport.limit_exceeded` | warn | `packages/llm/src/ai-sdk/bounded-fetch.ts:88` |
| `llm.error.body_unparsed` | debug | `packages/llm/src/ai-sdk/errors.ts:65` |
| `llm.error.body_unstringifiable` | debug | `packages/llm/src/classify-provider-error.ts:122` |
| `llm.error.cause_unstringifiable` | debug | `packages/llm/src/classify-provider-error.ts:135` |

No module in `packages/llm/src` writes to `process.stdout`, `process.stderr` or `console.*`; every
logger is defaulted to `NOOP_LOGGER` at construction rather than optionally chained
(`packages/llm/src/ai-sdk-adapter.ts:163`, `packages/llm/src/ai-sdk/bounded-fetch.ts:66`, `packages/llm/src/model-call-admission.ts:173`,
`packages/llm/src/ai-sdk/errors.ts:217`, `packages/llm/src/classify-provider-error.ts:121`).

---

## 7. Coupling

### 7.1 What this package depends on

| Dependency | Kind | What forces it |
|---|---|---|
| `@clarvis/capability` | runtime, static | `LLMProvider`/`LLMCallParams`/`LLMCallResult` are the port implemented (`packages/llm/src/ai-sdk-adapter.ts:13-19`); `ProviderError`, `NOOP_LOGGER`, `levelEnabled` are value imports (`:20`); `normalizeToolArguments` (`packages/llm/src/ai-sdk/result.ts:3`); `sanitizeErrorMessage` (`packages/llm/src/ai-sdk/errors.ts:5`); `contentToText` (`packages/llm/src/to-model-messages.ts:3`); `unref` (`packages/llm/src/retry-llm-provider.ts:4`, `packages/llm/src/model-call-admission.ts:4`); `CodedError` (`packages/llm/src/model-call-admission.ts:2`); `suppressSecondaryRejection` (`packages/llm/src/ai-sdk/bounded-fetch.ts:1`); `resolveStringMapWith`/`MissingEnvVarsError`/`FORBIDDEN_PROVIDER_BODY_KEYS` (`packages/llm/src/openai-compatible-request.ts:16-22`); `reasoningOutputFloor` (`packages/llm/src/ai-sdk/request-options.ts:12`) |
| `ai` | runtime, static — **adapter side only** | `generateText`/`streamText`/`Output` (`packages/llm/src/ai-sdk-adapter.ts:1-8`); `jsonSchema`/`tool` (`packages/llm/src/ai-sdk/request-options.ts:1-10`); `APICallError` (`packages/llm/src/ai-sdk/errors.ts:1`) |
| `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google` | runtime, static — **adapter side only** | the four `create*` factories at `packages/llm/src/ai-sdk-adapter.ts:9-12`, dispatched at `:288-306` |
| `node:fs` | runtime | `appendFileSync` (`packages/llm/src/stream-metrics.ts:1`) |

`@clarvis/paths` is **not** a dependency — this package writes no Clarvis directory. The only path it
touches is the operator-supplied `CLARVIS_STREAM_DEBUG` file.

The four provider SDKs are reachable from the `.` entry only through the **dynamic** import at
`packages/llm/src/lazy.ts:44`. `openai-compatible-request.ts` is deliberately free of every `@ai-sdk/*` import,
and its own TSDoc gives both reasons: the adapter's tests replace `generateText`/`streamText` so
`transformRequestBody` never runs there, and "a module that touches only plain objects can never
break" the lazy-entry walk (`packages/llm/src/openai-compatible-request.ts:7-13`).

### 7.2 What depends on this package

| Consumer | Edge | Forced by |
|---|---|---|
| `@clarvis/loop` | runtime, static, hard dependency | `packages/loop/package.json:81` (`workspace:*`), and the value imports at `packages/loop/src/runtime/build-run-deps.ts:17-25` and `packages/loop/src/runtime/execute-run.ts:4` |

That is the only `@clarvis/*` package importing it. `packages/capability/src/env-interpolate.ts:6`,
`packages/capability/src/env-ref.ts:4`, `packages/tasks/src/trace.ts:81` and
`packages/code/src/adapters/stream-metrics.ts:46` mention `@clarvis/llm` only inside TSDoc prose —
no import. `@clarvis/code` carries its **own** copy of the stream-metrics sink;
`packages/llm/src/stream-metrics.ts:21-22` records that "the packages do not share a dependency edge,
and a debug counter is not worth minting one".

The direction is forced structurally: nothing in `packages/llm/src` imports `@clarvis/loop`,
`@clarvis/kernel`, `@clarvis/trace`, `@clarvis/paths` or `@clarvis/protocol`, and the settings
schema the operator authors lives elsewhere — this package receives already-`ResolvedProviderConfig`
values (`packages/capability/src/llm-port.ts:142-149`).

### 7.3 Type-only versus runtime edges within the package

`packages/llm/src/lazy.ts:1` uses `import type` exclusively for `@clarvis/capability`, which is what keeps the
lazy entry free of any evaluation. `packages/llm/src/prompt-cache-provider.ts:1-2` and
`packages/llm/src/to-model-messages.ts:1-2` are likewise type-only against their SDK/capability types (the latter
takes one value import, `contentToText`, at `:3`).

### 7.4 What this document delegates

- **Prefix-cache economics** — why an append-only transcript is cheap and a mid-prefix edit is not —
  belongs to [prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md). This document covers only the mechanism by which
  markers, keys and session pins reach the wire.
- **Model/provider resolution and pricing** — how a `ResolvedProviderConfig` is produced from
  settings, and `parseModelRef`/`resolveProvider` — belongs to
  [model-catalog-and-provider-resolution](../hosts/model-catalog.md). This package consumes the resolved value only.
- **Where admission, retry budget and timeouts are wired into a run**, and the `CLARVIS_*` env
  values that set them (`packages/loop/src/runtime/build-run-deps.ts:453-474`), belong to
  [loop-budgets-clocks-and-guards](../engine/budgets-and-guards.md).

---

## 8. Open questions

1. **LLM-9 is unpinned.** `maxRetries: 0` (`packages/llm/src/ai-sdk-adapter.ts:462`) is what makes
   `withTransportRetry` the sole retry authority, and no test asserts it. Deleting the line would
   double-retry every transient failure silently, with a green suite. No indirect assertion has
   been found (attempt counting in `packages/llm/tests/component/ai-sdk-adapter.test.ts` uses a
   mocked `generateText`, which never consults the field).

2. ~~**`AiSdkGuardrails.timeoutMs` is documented as the only guardrail on the constructor's `@param`
   line.**~~ **Resolved: the TSDoc was stale.** All three fields are used, and the `@param` now says
   so — `timeoutMs` becomes the per-call default when a call names none, and the other two are handed
   to `createBoundedFetch`, each falling back to its package default
   (`packages/llm/src/ai-sdk-adapter.ts:155`–`:159`). The interface itself was undocumented and now
   carries a member comment each (`:58`–`:71`).

4. ~~**The bridge-minted timeout error carries no attempt cost.**~~ **Resolved for observable
   evidence.** `markStreamStarted` now puts the stream-start fact on the bridge's
   `ModelCallInactivityError`, and the adapter handles every timed-out catch before the generic
   `ProviderError` passthrough so available `partialUsage` is retained. Usage remains absent when the
   provider emitted no usage frame before cancellation; that is unknown evidence, not a synthesized
   zero. Tests: `packages/llm/tests/unit/model-call-timeout-bridge.test.ts` and
   `packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`.

6. **The `bestEffort`/`detachObserved` neighbours of `suppressSecondaryRejection`
   (`packages/capability/src/tasks.ts:49`, `:58`) accept an `options.logger`, but
   `suppressSecondaryRejection` (`:63-71`) ignores its `observedBy` argument beyond a non-empty
   check** (`:67-69`). So `detachCancellation`'s two distinct `observedBy` strings
   (`packages/llm/src/ai-sdk/bounded-fetch.ts:109`, `:126`, `:170`) reach no sink. Whether that is a
   deliberate documentation-only convention or an unfinished channel is not stated in the source.

7. **`MarkerSite` correctness is asserted against a reading of the SDK's own
   `convertToOpenAICompatibleChatMessages`** (`packages/llm/src/ai-sdk/request-options.ts:312-318`),
   which is inside `@ai-sdk/openai-compatible` and outside this document's scope. The integration test at
   `packages/llm/tests/integration/provider-request-shape.test.ts:163-189` exercises the real SDK, so
   the behaviour is pinned; the *derivation* is not verifiable from this repository.

8. **The measurements quoted in TSDoc are not reproducible here.** The `deepseek-v4-pro` affinity
   probe (`packages/llm/src/ai-sdk/request-options.ts:151-158`;
   `packages/llm/tests/integration/wire-cache-diff.test.ts:112-123`), the "~95 chars/s a real run
   streams at" (`packages/llm/src/ai-sdk/streaming.ts:37`), the "~3000 reports per call at ~1 ms
   inter-arrival" (`:124-125`) and the "229 tests" coverage incident
   (`packages/llm/src/stream-metrics.ts:44`) are all statements in comments. They are recorded as what
   the code claims, not as verified facts.

9. **`ResolvedProviderConfig.promptCache` semantics table** lives in `@clarvis/capability`
   (`packages/capability/src/llm-port.ts:120-138`) rather than here. This package implements it at
   `packages/llm/src/ai-sdk/request-options.ts:559-561`; whether every row of that table is fully
   exercised is a question for the provider-resolution document.

10. **No test in scope asserts the `TypeError` messages from `positiveInteger`/`nonnegativeInteger`**
    (`packages/llm/src/model-call-admission.ts:125`, `:133`), despite the package's 100% line floor.
    No coverage report was run, so whether another test reaches them incidentally, or whether the
    floor is currently satisfied by some untraced path, is undetermined.

11. **Two `ModelCallAdmissionController` edge paths are unpinned.** The already-aborted-signal-at-
    `acquire` short-circuit (`packages/llm/src/model-call-admission.ts:297`) and the synchronous-throw-from-
    `inner.call` release path (`:217-224`) both have code (added to the section 4.13 state table
    above) but no test in `packages/llm/tests/unit/model-call-admission.test.ts` exercises either
    one.
