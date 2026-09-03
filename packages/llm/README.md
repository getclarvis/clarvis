# @clarvis/llm

The provider layer for the Clarvis loop: the [Vercel AI SDK](https://sdk.vercel.ai) backend behind
`@clarvis/capability`'s `LLMProvider` port, the retry / logging / prompt-cache decorators that wrap
it, the provider-error classifier, and the conversion from the engine's messages to the SDK's.

It depends on `@clarvis/capability` and nothing else in the workspace. `@clarvis/loop` receives an
`LLMProvider` and never talks to a provider itself.

## Contract

Provider adaptation, decorators, error classification, and the lazy entry split are specified in
[`foundations/llm.md`](../../specs/foundations/llm.md). Prefix caching and session affinity are
specified in [`cross-cutting/prompt-cache.md`](../../specs/cross-cutting/prompt-cache.md).
Kernel-owned ChatGPT/Grok subscription request authority is specified in
[`hosts/subscription-providers.md`](../../specs/hosts/subscription-providers.md).

The lazy provider accepts an async `resolveSubscription` seam. It is invoked from the physical fetch
callback immediately before I/O, so renewable tokens never enter call params or decorators. The
scheme wrapper in the kernel pins the origin and overwrites identity headers after SDK assembly;
the adapter removes its placeholder key, keeps existing byte/SSE/abort bounds, uses Responses for
both schemes, and reports `billing_source: "subscription"` without inventing monetary cost.

## Two entries, on purpose

| Entry                  | Contents                                                                          | Loads the SDKs? |
| ---------------------- | --------------------------------------------------------------------------------- | --------------- |
| `@clarvis/llm`         | `createAiSdkProvider`, the decorators, `classifyProviderError`, `toModelMessages` | no              |
| `@clarvis/llm/adapter` | `AiSdkAdapter`, `streamMetrics`                                                   | yes             |

The split is load-bearing, not organisational. The four provider SDKs are the heaviest imports in
the workspace, and a host assembling its run dependencies wants `withTransportRetry` long before any
model is called. If the main entry re-exported the adapter, importing a decorator would pull all
four SDKs in with it — so it does not, and `createAiSdkProvider` reaches the adapter through a
dynamic import instead, building it once on the first `call`.

`tests/architecture/lazy-entry.test.ts` asserts that no static import or re-export reachable from `src/index.ts`
arrives at the adapter. Without it the property is invisible: adding an `export *` would break it
with a green typecheck and a green suite.

## Test ownership

The suite makes its effect boundary explicit:

- `tests/unit/` owns provider policy, decorators, conversion, error classification, streaming
  batching and the pure request/result helpers;
- `tests/component/` owns composition of `AiSdkAdapter` and the lazy provider with injected or
  intercepted collaborators;
- `tests/integration/` owns the real AI SDK request wire exercised through intercepted `fetch`;
- `tests/architecture/` owns the static lazy-loading invariant.

Run an individual layer with `test:unit`, `test:component`, `test:integration`, or
`test:architecture`. The ordinary `test` and `test:coverage` commands continue to execute every
layer together, so classification does not change the covered behavior.

## Usage

```ts
import {
  createAiSdkProvider,
  createModelCallAdmissionController,
  withCallLogging,
  withModelCallAdmission,
  withTransportRetry,
} from "@clarvis/llm";

const provider = createAiSdkProvider({
  resolveRegistryKey: (name) => process.env[name],
  timeoutMs: 120_000,
  maxResponseBytes: 32 * 1024 * 1024,
  maxSseEventBytes: 4 * 1024 * 1024,
});
const admission = createModelCallAdmissionController({ maxActive: 4, maxQueued: 8 });

const llm = withTransportRetry(
  withCallLogging(withModelCallAdmission(provider, admission), logger),
  {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    maxRetryAfterMs: 60_000,
    logger,
  },
);
```

The nesting matters and is the one `@clarvis/loop`'s `build-run-deps.ts` uses: retry on the
**outside**, logging within it, and physical-call admission innermost. A retry releases its slot
during backoff; every actual attempt re-enters the host-owned FIFO gate. An aborted transport that
does not settle within `CLARVIS_MODEL_ABORT_SETTLE_MS` (250 ms by default) keeps its slot and
quarantines the gate until it exits. This is deliberately distinct from the longer whole-run abort
grace: a provider slot must stop admitting work quickly, while the agent loop gets enough time to
run cooperative teardown. Quarantine prevents new work from piling on top of a provider call the
host no longer controls. The adapter's own per-call/default timeout reports through the same
admission boundary: even when a transport ignores its timeout signal, the permit is quarantined
rather than remaining silently active and filling the queue behind it.

For a streaming call, that per-call timeout is an **inactivity** window. Every provider part resets
the window, so a large `write_file` argument may take longer than the configured timeout in total as
long as deltas continue arriving. The hot path updates one timestamp; one timer checks it and re-arms
at most once per timeout window, so progress does not allocate a timer or log record per delta.
Non-streaming generation still has no observable progress and therefore keeps the timeout as an
absolute call bound.

`TransportRetryOptions` is an attempt cap plus a backoff —
`maxRetries`, `baseDelayMs`, `maxDelayMs`, and optionally `maxRetryAfterMs` (the ceiling applied to
a server's `Retry-After`) and a `logger`. Only errors the classifier calls `transient` are retried.
Once a live delta has reached `onStreamDelta` or `onToolInputDelta`, retry stops to avoid replaying
and rebilling the whole prompt. `ModelCallInactivityError` is the deliberate exception: after the
configured interval with no new stream activity, the stopped attempt remains retryable even when
earlier progress was visible. A provider stream used only to assemble an internal aggregate has no
consumer-visible partial turn, so a transient failure may also retry before its caller sees a result;
compaction summaries rely on this distinction.

ChatGPT subscription requests always use the adapter's streaming path, even for internal callers
such as the command judge that do not consume live deltas. The pinned Codex Responses transport
rejects `stream: false`; choosing one-shot generation for those callers turns an automatic command
review into an immediate HTTP 400. Other providers still stream only when the caller supplies
`onStreamDelta`.

Responses assistant text metadata is retained on both aggregate and streaming paths. A later call
replays the original text parts, item ids and phases instead of flattening them to a bare string;
this is required for manual `store: false` continuation and does not rewrite an older prompt prefix.

## What it tells an operator

Every record carries a stable `event` field; the prose is free to change. Where a logger is
accepted it defaults to `NOOP_LOGGER`, so a host that supplies none pays nothing — and the
adapter's expensive fields are all built behind a `levelEnabled` guard, because the bindings object
is allocated at the call site before any backend sees its level.

| Level   | `event`                                  | When                                                                 |
| ------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `debug` | `llm.provider.resolved`                  | once per `(provider, model)`, when its client is built               |
| `debug` | `llm.cache.request`                      | what the request asked the prompt cache for                          |
| `warn`  | `llm.cache.breakpoint_lost`              | a requested breakpoint did not land, or two collapsed into one       |
| `debug` | `llm.request.tuning`                     | the reasoning route, the output cap and whether images were stripped |
| `debug` | `llm.stream.first_token`                 | once per streamed call, at the first output part                     |
| `warn`  | `llm.stream.no_aggregate`                | the stream ended with no final result                                |
| `warn`  | `llm.transport.limit_exceeded`           | a response or SSE event breached its byte bound                      |
| `debug` | `llm.error.body_unparsed`                | a provider error body was not JSON                                   |
| `debug` | `llm.error.body_unstringifiable`         | a provider error body was dropped from the classifier's signal text  |
| `warn`  | `llm.retry.scheduled`                    | a transient failure is about to be retried                           |
| `debug` | `llm.retry.gave_up`                      | why the retrying stopped                                             |
| `info`  | `llm.admission.state`                    | the physical-call gate changed state — **transitions only**          |
| `warn`  | `llm.admission.stuck`                    | a cancelled transport would not settle and the gate is quarantined   |
| `debug` | `llm.call.start` / `.done`               | one physical attempt, with its usage split                           |
| `warn`  | `llm.call.pending` / `.slow` / `.failed` | that attempt taking too long, its latest stream progress, or failing |

Three properties are load-bearing rather than tidy:

- **`llm.cache.request` is built only from values `buildRequestOptions` already computed**, and is
  returned as a `diagnostics` record rather than logged from inside that module. Nothing re-walks or
  re-marks the message array: the marking is index- and identity-sensitive, and a second pass over it
  is the shape of the defect commit `20a7a21` fixed. It logs indices and counts, never content.
- **`llm.provider.resolved` reduces `base_url` to its host**, reports headers by name and the API key
  by presence. A base URL's path is gateway routing and its query is where a token ends up.
- **The per-delta path gets no log line at all.** `llm.stream.first_token` fires from the
  `!outputObserved` arm only, which costs the one boolean test that used to be an unconditional
  store; per-chunk telemetry belongs to the `streamMetrics` counter sink behind `CLARVIS_STREAM_DEBUG`.
  The 20-second `llm.call.pending` sampler reports `stream_started` and `last_progress_ms` instead of
  claiming a call with recent deltas never responded.

`admissionStateLogger(logger)` is the handler a host wires to
`ModelCallAdmissionOptions.onStateChange`; `@clarvis/loop`'s `createHostModelCallAdmission` does it.
It dedupes on the state name, because `onStateChange` fires several times per model call and
`open → open` is not news.
