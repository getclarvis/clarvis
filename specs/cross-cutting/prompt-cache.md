# Prompt history, agent affinity and cache qualification

## Ownership

This contract covers the serialized prompt history, persistent agent affinity, provider replay
metadata, cache diagnostics and qualification evidence. The loop owns context mechanics; plan and
memory compose through the kernel. Backend cache allocation and retention remain provider behavior,
not a simulated Clarvis contract. A preserved prefix is necessary evidence, not proof of a cache hit.

Related contracts: [context compaction](../engine/context-compaction.md),
[LLM transport](../foundations/llm.md), [plan capability](../capabilities/plan-capability.md),
[memory indexing](../capabilities/memory-indexer.md), and
[subscription authentication](../hosts/subscription-providers.md).

## Historical sequence

Without deliberate compaction, every previously serialized historical item retains its content,
existing provider identity, metadata and order. New messages, tool calls, tool results, runtime notes
and capability reminders append after the entire existing sequence, including its last reminder.

`setCanonicalState` publishes another reminder on every invocation, even with unchanged text. It
marks the older publication superseded for compaction without altering that publication's message.
`appendRuntimeNote` follows the same rule. `setStableBlock` is a no-op for unchanged content; a change
appends a new block and marks the previous block superseded. The latest publication is current;
older publications remain historical context. These flags are context ownership metadata, not
provider-visible replacements or authorization to rewrite a sent item.

```text
A: history → reminder v1
B: history → reminder v1 → new calls/results → repeated reminder v1
C: history → reminder v1 → new calls/results → repeated reminder v1 → reminder v2
```

Continuation reconstructs the persisted sequence in its original order. It retains previous runtime
notes, capability blocks and image payloads; deactivating a capability does not erase its historical
messages. Newly active capability blocks and the new user turn append. The system instructions and
advertised tool catalog must also remain equivalent for a cache-preserving transition.

New tool results are truncated before their first request. Image admission reserves capacity for
previously retained images and trims the new result. Hydration rejects an oversized persisted image
snapshot instead of silently rewriting it. Deliberate compaction can remove evictable history and
replace summaries, records the expected break, and retains the latest canonical state and active
stable blocks needed to continue. A new base has its own measured recovery window.

**PC01 — append-only publication.** Production:
[`createLiveEntryStore`](../../packages/loop/src/runtime/context/live-entry-store.ts),
[`createLiveContext`](../../packages/loop/src/runtime/context/live-context.ts),
[`buildEntrySeed`](../../packages/loop/src/runtime/entry-seed.ts), and
[`buildLeadInputPersona`](../../packages/loop/src/runtime/subagents/build-lead-input.ts).
Test: [`cache-prefix-capture.test.ts`](../../packages/loop/tests/integration/cache-prefix-capture.test.ts)
asserts exact SDK HTTP history prefixes; [`context-snapshot.test.ts`](../../packages/loop/tests/unit/context-snapshot.test.ts),
[`prefix-break.test.ts`](../../packages/loop/tests/unit/prefix-break.test.ts) and
[`entry-seed-markers.test.ts`](../../packages/loop/tests/unit/entry-seed-markers.test.ts) cover persistence,
image admission and restoration.

**PC02 — historical reminders do not authorize stale mutations.** The plan store remains the source
of truth. CAS checks, human approval and mutation rules apply regardless of which historical header
a model quotes. Reminder frequency remains per iteration; publication only on state change is a
separate behavioral experiment, requiring task-following, CAS, approval and completion evidence.
Production: [`buildPlansOrchestration`](../../packages/plan/src/capability/orchestration.ts),
[`planCasHeader`](../../packages/plan/src/capability/canonical-state.ts) and
[`createPlanStore`](../../packages/plan/src/store.ts).
Test: [`prompt-cache-composition.test.ts`](../../packages/kernel/tests/integration/prompt-cache-composition.test.ts)
uses the real kernel, plan store, loop and SDK, including an external update, rejected historical CAS
and persisted continuation after kernel restart.
The same suite captures complete SDK catalogs and history through HTTP retry, two actual
same-profile child instances, cancellation of an in-flight physical request, guard-policy resume
and the real memory indexing pass. The pass rejects an inherited workspace tool at dispatch while
retaining its advertised name, description, schema and position.

## Persistent identity

`RunRequest` and `StartRunParams` carry `session_id` and `agent_instance_id`. The session is the
persisted conversation; the agent ID identifies one instance, not a profile or role. Hosted turns
persist the leader's `agent_instance_id` in the session intent before starting inference. Direct runs
persist missing identities in their request: the execution ID supplies the conversation ID and a
single assigned agent ID supplies the instance. Continuations inherit both unless explicitly
branching into another agent instance. Each spawned child uses its existing persisted delegation ID.

The typed `composePromptCacheKey(PromptCacheIdentity)` is the only composer. Raw components accept
the existing ASCII execution-ID alphabet: letters, digits, `.`, `_`, `:`, `-`. Embedded underscores
are encoded as `%5F`, leaving exactly one raw `_` separator. Percent signs are rejected in raw IDs.
For example, session `exec_abc` and agent `child-1` produce `exec%5Fabc_child-1`. This encoding is
bijective; the complete key must fit 512 characters and is never truncated. Switching from the old
shared key produces an initial backend warmup; it does not justify later warmup exclusions.

`withPromptCacheDefaults` composes from the session and the effective instance on every call. A
caller cannot restore the old shared key through `LLMCallParams.promptCacheKey`. TTL remains a
separate setting, defaulting to `1h` when the run can wait for human interaction and `5m` otherwise.

Memory queue claims persist a dedicated agent ID and reserve each execution ID before inference.
Recovery preserves the agent ID and continues the previous indexing execution when its context is
available. The durable predecessor reservation list also crosses a claim that died before
creating its execution trace. Missing context for a predecessor with recorded input fails closed.
The indexing conversation keeps the source session where it continues that session;
isolated indexing uses the persisted source run as its conversation. A separately created indexing
conversation receives another instance ID. Agent IDs, provider item IDs and tool `call_id` values
have different jobs and are not interchangeable.

**PC03 — stable, distinct affinity.** Production:
[`composePromptCacheKey`](../../packages/capability/src/prompt-cache-identity.ts),
[`executeRun`](../../packages/loop/src/runtime/execute-run.ts),
[`withPromptCacheDefaults`](../../packages/llm/src/prompt-cache-provider.ts),
[hosted session preparation](../../packages/kernel/src/hosting/sessions.ts),
[`runSubagent`](../../packages/loop/src/runtime/subagents/run-subagent.ts) and
[memory queue claims](../../packages/memory/src/file-store/jobs.ts).
Test: [`prompt-cache-identity.test.ts`](../../packages/capability/tests/unit/prompt-cache-identity.test.ts),
[`prompt-cache-provider.test.ts`](../../packages/llm/tests/unit/prompt-cache-provider.test.ts),
[`openai-compatible-run.test.ts`](../../packages/loop/tests/integration/openai-compatible-run.test.ts)
and the kernel composition test.

## Provider wire and replay

| Adapter | Cache and affinity fields |
| --- | --- |
| OpenAI Responses | `prompt_cache_key`; no invented explicit breakpoint fields |
| ChatGPT `openai-codex` | `prompt_cache_key`; host `session-id` is SHA-256 of the same composed key |
| xAI subscription | `prompt_cache_key`; host `x-grok-conv-id` derives from the same key |
| OpenAI-compatible | Existing `prompt_cache_key`, `session_id`, `x-session-id` and configured marker behavior |
| Anthropic | Existing system and rolling message `cache_control` breakpoints and TTL policy |
| Google | Existing adapter behavior; no new cache protocol |

ChatGPT's existing `x-client-request-id` behavior is preserved. It is not repurposed as the harness's
physical-attempt number. Kernel subscription authority remains on the host; identity fields cross
the guest contract, credentials do not. No new reasoning mode, transport protocol or breakpoint is
introduced by this correction.

Provider-issued assistant item IDs, phase, reasoning summaries and opaque reasoning metadata survive
response conversion, persistence and request serialization. Reasoning parts sharing an ID assemble
one item, including encrypted content that appears only on the last part. Function-call item ID and
`call_id` both survive. The SDK's omitted function-call item ID is restored at the final fetch boundary
only when that ID already exists in provider metadata; user messages and tool outputs receive no
invented optional IDs. Existing serializer IDs win.

**PC04 — replay fidelity.** Production:
[`buildCallResult`](../../packages/llm/src/ai-sdk/result.ts),
[`toModelMessages`](../../packages/llm/src/to-model-messages.ts),
[`withResponsesReplayIds`](../../packages/llm/src/ai-sdk/responses-replay.ts) and
[`createOpenAICodexAdapter`](../../packages/kernel/src/subscriptions/openai-codex.ts).
Test: [`wire-cache-diff.test.ts`](../../packages/llm/tests/integration/wire-cache-diff.test.ts) and
[`provider-request-shape.test.ts`](../../packages/llm/tests/integration/provider-request-shape.test.ts)
exercise the real SDK and captured HTTP JSON without credentials. They do not prove backend hits.

## Diagnostics and evidence

`SerializedPrefixWatch` compares hashes of actual serialized instructions, ordered tools and history
items. It retains at most 32 conversations with at most 8192 items each, discarding observations
outside that bound. It reports the first differing surface/item, never a guessed remote token-cache
boundary. `createCachePrefixWatch` detects both cache loss and cached-token stagnation as input grows.
It distinguishes initial warming and deliberate compaction, and does not interpret missing provider
usage as measured zero. Absence of `context.prefix_break` does not establish cache reuse.

The schema-versioned report in [`tooling/cache/types.ts`](../../tooling/cache/types.ts) records each
physical HTTP attempt, including retries, cancellation, memory and compaction. Safe evidence includes
requested/resolved model, requested/effective effort where available, SDK/config/fixture identity,
endpoint without sensitive query data, effective key and affinity hashes, serialized surface/item
hashes, first divergence, timings, tool-call identities and usage presence. Reports contain no
credentials, raw prompts or encrypted reasoning. Unknown consumption remains explicit.
Completed-call snapshots from a failed restart worker remain in the trial and global consumption
ledger, deduplicated by physical attempt. A process failure cannot erase already observed usage.
Serialized model and reasoning effort are recorded separately from requested settings and any
provider-reported effective values. Item metadata records existing IDs, phase, call correlation,
summary-part counts and encrypted-content presence without recording the encrypted content.
The subscription summarizer retains its production omission of a requested reasoning effort;
the report records that absence rather than labeling it `medium`. Its deliberate alternate
summary prompt and auxiliary consumption are separate from the evaluated agents, which request
`medium`. Any provider-reported summarizer effort is recorded without inventing a requested value.

**PC05 — independent per-agent verdicts.** Weighted hit is `sum(cached) / sum(input)`, never the
arithmetic mean of percentages. Require `0 <= cached <= input`. Global/child volume cannot repair
a failing leader. Auxiliary calls remain in consumption accounting. Production diagnostic:
[`createCachePrefixWatch`](../../packages/loop/src/runtime/loop/iteration-metrics.ts).
Qualification implementation: [`evaluateCacheAgents`](../../tooling/cache/evaluation.ts),
[`createCacheRecorder`](../../tooling/cache/recorder.ts) and [`CacheBudget`](../../tooling/cache/limits.ts).
Test: [`prompt-cache-evaluation.test.ts`](../../tooling/tests/unit/prompt-cache-evaluation.test.ts) and
[`prompt-cache-recorder.test.ts`](../../tooling/tests/unit/prompt-cache-recorder.test.ts) use independent
measured-series fixtures, including cached 25984 with input 100476, a 75.61% aggregate hiding a
30.37% leader, healthy growth, unknown usage, cancellation and auxiliary cost.

## Qualification requirements

The required subscription target is `openai-codex`, `gpt-6-astra`, effort `medium`; C01/C02/C04 also
run on `gpt-5.6-sol`, reported separately. An OpenAI API result cannot qualify ChatGPT.
When the provider reports a resolved model, it must equal the requested qualification model;
an arbitrary suffix is not accepted as evidence of that model. An absent effective model remains
explicitly absent.
Use synthetic,
versioned, distinct corpus blocks and sequential opaque cursors, roughly 20k initial tokens and 1k
new tokens per call. Measure actual growth; additions should stay near or below 5% of prior input.
Nonce stays constant within one trial. A different key alone does not establish a cold cache.

| Scenario | Required checkpoints |
| --- | --- |
| C01 | Leader growth and appended runtime notes |
| C02 | Warm before create; at least 12 calls at one revision; update and completion with at least three continuations each |
| C03 | Two concurrent same-profile children; independent stable keys and verdicts throughout each activity window |
| C04 | New turn, same session/instance/catalog/history |
| C05 | Cancellation/resume, including guard-policy change and reconciled attempts |
| C06 | Actual memory-indexing conversation with multiple calls and its own identity |
| C07 | Process restart and immediate persisted replay |
| C08 | Oversized new result truncated before its first request |
| C09 | Actual compaction, new base, input savings and cache recovery |
| C10 | Deliberate prefix mutation versus append-only control; separate from healthy aggregates |
| C11 | Installed launcher and loaded bundle, real PTY, plan, two turns, memory and UI/trace reconciliation |

Each evaluated conversation needs at least 12 valid calls. Only its first two calls are excluded
from performance, while their consumption remains counted. Warm weighted hit must be at least 90%;
each of its last three hits must be at least 85%. A warm window of at least ten calls must grow input
by at least 8000 tokens or 25%; cached growth below 10% of that growth fails. Insufficient growth is
incomplete. C02's post-create window is evaluated independently of pre-create warming. Retry,
continuation and restart do not receive free warming; evaluate the transition call and at least three
continuations. C08 applies the same transition window to the first request marked with a newly
truncated result; preserving older results does not exempt that first request from the hit floor.
C09 permits exactly two warming calls on its explicitly recorded new base, then the
same thresholds. Three valid trials per required model/scenario must each pass; failed trials remain
in the record and are never replaced by retry-until-green.

Every live execution declares per-trial and global physical-call, input, output and duration limits.
Limits include auxiliary work, stop execution when reached, and never expand automatically.
Unavailable authentication, quota, absent usage, missing checkpoints or mismatched artifact identity
leave qualification incomplete. A successful process exit cannot substitute for these checkpoints.

Final artifact evidence identifies the full commit, dirty/additional build inputs, lockfile, Bun,
OS/architecture, SDK, fixture/configuration, archive, resolved launcher and actual loaded bundle hash.
Build once after the last relevant change and reuse that artifact. Run with isolated install/state,
without `CLARVIS_CODE_SOURCE`; verify real tool effects, two turns, plan and memory, usage scopes and
process cleanup. Source-only execution and deterministic SDK tests remain separate evidence layers.
The installed driver waits for the composer to be ready before each turn and for both indexing
traces to settle before reconciling consumption. The UI session scope includes leader turns;
memory indexing is accounted separately. The displayed `In` is gross input minus cached input,
while the cache percentage uses cached divided by gross input; output is the session output total.
Other native platforms are unverified until their own installed-provider journey runs.

The Linux installed harness can reuse the operator's global OAuth through
[`prepareHostAuthView`](../../tooling/cache/host-auth-view.ts): a host mount namespace shares the
original renewable subscription store and masks unrelated global state with disposable directories.
No credential file is copied into fixture state or a guest. Authentication refresh still uses the
kernel's normal store, lease and resolver. Test-created mountpoints are removed only after the owned
processes stop. The artifact observer test exercises renewal against the original synthetic store
and verifies that application writes land only in isolated state.

**PC06 — complete, artifact-bound evidence.** `sealCacheArtifact` seals the existing archive after
packaging. The full runner checks source inputs before scheduling each trial and requires all
mandatory model/scenario repetitions. `auditCacheTrial` recomputes physical/trace reconciliation
and requires scenario-specific checkpoints; C03 evaluates the leader before, during and after
child activity independently. `auditCacheReport` requires the same archive for every trial and
the matching actually loaded bundle for all three C11 journeys. Production:
[`evidence.ts`](../../tooling/cache/evidence.ts), [`live.ts`](../../tooling/cache/live.ts),
[`artifact.ts`](../../tooling/cache/artifact.ts) and
[`artifact-preload.ts`](../../tooling/cache/artifact-preload.ts).
Test: [`prompt-cache-evaluation.test.ts`](../../tooling/tests/unit/prompt-cache-evaluation.test.ts)
rejects missing checkpoints, an unrelated resolved model, an unhealthy first truncated-result
request and unrelated artifact evidence;
[`prompt-cache-artifact.test.ts`](../../tooling/tests/unit/prompt-cache-artifact.test.ts) verifies
the bytes observed by the installed-module loader without substituting a version-string check.
