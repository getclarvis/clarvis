# @clarvis/capability

The **capability contract**: what a cross-cutting loop feature is written against, and the machinery
that composes a list of them. A dependency-free leaf of the graph — its only external dependency is
`zod` — so a capability can live in its own package instead of inside `@clarvis/loop`.

```text
capability ──> llm | supervision | trace | mcp-client | hooks | skills | memory | plan
           ──> tasks | loop | workflows | kernel | server
```

## Contract

The authoritative contract is [`foundations/capability.md`](../../specs/foundations/capability.md);
composition into the engine is specified in
[`engine/capability-composition.md`](../../specs/engine/capability-composition.md). Grants and the
diagnostic port are cross-cutting contracts in
[`cross-cutting/grants.md`](../../specs/cross-cutting/grants.md) and
[`cross-cutting/observability.md`](../../specs/cross-cutting/observability.md).

## Why it is separate from the engine

The engine used to own the contract, which meant a capability shipped from outside it still had to
edit `packages/loop` to register anything. This package is the half of the engine that a capability
author needs: the request and settings vocabulary, the ports, the trace kinds, and `compose`.

## Exports

| Entry                       | Contents                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@clarvis/capability`       | the contract (`Capability`, `RunCapability`, `AgentCapability`, `AgentLoopContribution`), persisted trace projector registry, `compose`, and settings/run vocabulary |
| `@clarvis/capability/ports` | `ContextPort`, `TracePort`, `Logger`, `Elicit`, `AgentRegistryPort`, `LLMProvider`                                                                                   |
| `@clarvis/capability/trace` | `BuiltinTraceKind`, `TraceKind`, `TraceDetailMap`, `TraceDetailFor`, `TraceEvent`, persisted trace projector types/registry, `ExecutionRecord`                       |

`McpServerConfig` carries the complete normalized MCP seam shared by settings, plugin manifests and
direct run requests. In addition to transport fields, that includes stdio `cwd`/`env_vars`, remote
Bearer and environment-backed headers, per-server startup/tool timeouts, enabled/required state,
tool allow/deny lists, authentication timing, and OAuth pre-registration (`client_id`, callback
URL/port, and an optional HTTPS CIMD URL). `expandVariables` defaults to true in consumers;
portable package adapters may set it false after applying their own format-limited placeholder
expansion; environment-backed credential fields remain explicit references and are always resolved.
An `enabled: false` declaration is removed by run parsing before pool or skill-capability composition.
The engine-only `auto_tools` flag remains host composition rather than transport configuration:
after a server connects, every tool it advertised joins every agent's effective MCP allow-list for
that run without changing the persisted profile. `MCPConnection.instructions`
carries bounded initialization guidance back across the same leaf contract.

## Test ownership

This package owns the complete unit matrices for its contracts and vocabulary: capability
composition and registries, open trace/error vocabularies, secret redaction, tool-argument
normalization, compute-clock and semaphore state machines, environment/configuration parsing, and
the platform-free helpers shared by packages above it. Consumers keep only the wiring or outcome that is
uniquely observable at their seam; they do not repeat these matrices.

The suite has three explicit levels:

- `tests/unit` contains deterministic contract, parser, state-machine, and projection behavior;
- `tests/integration` contains the narrow Bun-regex runtime canary for the sanitizer's linearity;
- `tests/architecture` checks that this package's source never imports itself through its published
  package name.

Run `bun run test:unit`, `bun run test:integration`, or `bun run test:architecture` for one level.
`bun run test` composes all three. Coverage executes the source-bearing unit and integration levels,
then runs the architecture scan separately so repository topology is not presented as source
behavior coverage.

## Request view, static declarations and run services

After validation, the engine creates one shared `CapabilityRequestView` and gives that same view
first to every `Capability.requiresUserInput` preflight and then, as the request half of
`RunCapabilityContext`, to every `Capability.forRun`. `requestParam(key)` is the single seam for an
open request parameter declared by a capability settings spec; a capability never casts the parsed
request, and preflight cannot accidentally inspect a different shape from activation.

`Capability.grants` is likewise static. Before validating a run, the engine copies the host registry
and adds every registered capability's grant declarations to that isolated per-run registry. Unknown
profile grants are rejected; duplicate declarations must agree. `entryCanSpawn: true` declares that
an entry carrying the grant can produce supervised children without teaching the engine that grant's
feature name. Static `persistedTraceProjectors` follow the same ownership rule for contributed trace
kinds and are composed into one immutable per-run projector registry.

`CapabilityServices` is the run-scoped typed port registry. The engine publishes substrate before
any `forRun`; capabilities may publish their own ports while activating, and consumers resolve peers
at `attach` time so capability registration order does not decide visibility. The optional task
tracking contract and its owner-neutral `TASK_TRACKING_PORT` have one canonical declaration here.
Without a provider, child spawning remains available through `spawn_subagent`; with a provider,
the tracker contributes the required `task_id` property for `delegate_task`.

Activation and persistence hooks are host extension boundaries, so they have finite wall budgets.
All `forRun` activations and `seedBlock` contributions run concurrently under
`CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS` (5 s by default, hard-capped at 60 s); a timeout skips that
capability or block without retaining the run. `finalizeRun` and `onRunEnd` use
`CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` (2 s by default). A timed-out finalizer forfeits only its new
state value, while a timed-out post-persist observer continues detached. The host's physical
extension admission does **not** release that detached call until its real promise settles: ordinary
extension code has 32 slots, run-end work has an independent eight-slot reserve, and one stable
operation may hold at most four (`CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS`,
`CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS`, and
`CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION`). Saturation skips new work rather than
creating one zombie promise per run; the separate run-end class preserves finalization after a
cancelled run even when ordinary hooks are stuck. Capability implementations must still observe
`ctx.signal`: admission bounds non-cooperation, but cannot forcibly stop arbitrary extension code.

Hook configuration is bounded before commands or regular expressions are compiled: one source may
declare 64 hooks, the merged run keeps 128, a command is at most 8,192 characters, a matcher at most
64 patterns of 2,048 characters, and a configured timeout at most 60 seconds. These are resource
ceilings, not precedence changes: operator hooks still run before plugin hooks.

The open run vocabulary also carries `AgentsParam`, including the supervision registry's
`max_total_buffer_bytes`. It is an aggregate retained-activity ceiling rather than another
per-child hint: `@clarvis/supervision` divides it across the configured live and retained child
slots, and its settings schema applies the absolute 32-MiB maximum.

The provider vocabulary includes the strict `openai-codex` and `xai-grok` kinds, but this leaf owns
no OAuth service or credential type. `ResolvedProviderConfig` and `LLMCallParams` remain token-free;
a configured model may retain provider-published `reasoning_efforts` as non-secret metadata so a
host can offer only valid effort choices without re-fetching a catalog;
a successful subscription-backed `LLMCallResult` may identify its billing authority only as
`billing_source: "subscription"`. The complete host contract is
[`subscription-providers.md`](../../specs/hosts/subscription-providers.md).

Prompt-cache controls are likewise provider-scoped at this port. `cacheBreakpoints` names stable
transcript boundaries without prescribing a wire format: Anthropic maps them to `cache_control`,
native OpenAI Responses remain provider-managed behind a stable `promptCacheKey`, and Grok uses the
same key plus its subscription routing header for its implicit append-only cache. An arbitrary compatible
endpoint never inherits another provider's marker protocol from a shared model id.

`LLMCallParams.onToolInputDelta` is a bounded cumulative progress seam rather than a raw provider
delta stream: it reports the tool identity and argument character count, plus an optional separate
`stream_chars` total across provider text, reasoning, and tool input. The latter is liveness
evidence and may advance while argument `chars` remains zero. The callback repeats the final counts
with `complete: true` when the provider closes that argument stream. `RetryInfo.message`
carries the bounded classified failure that scheduled a retry, so a durable retry trace can explain
an otherwise opaque wait without retaining model or tool payloads.

`parseTaskTitle` and `TASK_TITLE_MAX` likewise give every child producer one human-label contract:
one non-empty line, normalized horizontal whitespace, and at most 60 Unicode code points. A consumer
must reject an invalid model-authored title instead of deriving one from the full task or clipping it;
otherwise workflow leaders, work-item leaders and ordinary sub-agents drift back to different labels.
`parseDelegateTaskText` and `DELEGATE_TASK_MAX_CHARS` are the corresponding full-brief boundary:
`delegate_task` accepts at most 32,768 Unicode characters, using the same measure in its JSON Schema
and programmatic validation while preserving Markdown and whitespace exactly.

`OutputTokenBudget` is the structural port for a capability that owns a shared output ceiling. An
agent contribution may publish one without exposing workflow vocabulary to the engine. Reservations
are synchronous and settle with actual spend, which closes the check-then-call race between
concurrent agents; a budget implementation may grant less than requested but never more than its
current headroom.

## The two ports

`AgentBuildContext` would otherwise reference the engine's `LiveContext` (~50 members) and
`TraceHandle`, dragging the loop into this package. Instead it is declared over two ports that the
engine's concrete types satisfy **structurally** — no adapter, no cast:

```ts
interface ContextPort {
  appendNote(content: string): void;
  setStableBlock(kind: string, content: string): void;
  setCanonicalState(content: string): void;
}

interface TracePort {
  record<K extends TraceKind>(kind: K, detail: TraceDetailFor<K>): void;
  signal<K extends TraceKind>(kind: K, detail: TraceDetailFor<K>): void;
  now(): number;
}
```

Both are the measured minimum across every capability in the monorepo. The engine's ordinary local
loop budget remains deliberately **absent** from the build context: no capability reads it. A shared
cross-run/tree ceiling is contributed separately through `AgentLoopContribution.outputBudget`.

`TracePort` keeps the **generic** signature rather than the loose `record(kind: string, detail:
unknown)` it could have had, and that is a decision, not an accident. The engine's own loop writes
through this port, so a loose signature would silently drop type-checking on all 37 built-in kinds
at once. Generic over `TraceKind`, a built-in kind still has its detail shape checked at the call
site while a kind a downstream capability invents is accepted with a detail of `unknown`. `signal`
is the live-only twin — it reaches a watching UI and is never persisted — and `now()` is the
run-relative clock the shared tool-call envelope stamps `started_at`/`ended_at` off.

Compaction uses both halves deliberately: `compaction_started` is a live-only signal emitted before
hooks or summary-model work, while `compaction`/`compaction_skipped` remain durable outcomes. A
mechanical fallback after an attempted summary carries only the bounded `fallback_reason`, never the
provider error body.

Widening a port is a design decision, not a convenience — every member added here is a member the
engine can no longer change freely.

## The trace kinds are open

`TraceKind` is `BuiltinTraceKind | (string & {})`, so a capability records its own kinds without the
engine declaring them. Where the exact detail type matters, use `BuiltinTraceKind`, and narrow with
`isBuiltinTraceEntry` before switching — an exhaustiveness check still bottoms out in `never`, but
only over the kinds the engine actually owns.

`BUILTIN_TRACE_KINDS` is the single source of truth: the type is derived from the array and the
runtime guard tests against it, so the two cannot drift. A compile-time lock additionally pins
`TraceDetailMap`'s keys to that same set.

A capability that wants its contributed entry to persist as a typed flat event declares static
`Capability.persistedTraceProjectors`. The engine composes one immutable registry per run and the
trace mapper consults it before the generic contributed-event fallback. The owning capability must
validate the entry's opaque `detail` inside its projector and publish any narrower persisted-event
type and runtime guard its host needs; neither the engine vocabulary nor the trace implementation
has to learn the capability's discriminators. Duplicate projector kinds fail during registry
composition rather than selecting a winner silently.
Projectors for names in `BUILTIN_TRACE_KINDS` are rejected: contributed projectors may extend the
persisted vocabulary, but they cannot replace the engine's canonical on-disk events.

`ExecutionRecord.host_metadata` is a deliberately opaque, optional host-owned snapshot annotation.
The loop and trace packages carry and sanitize it without learning its schema; the file kernel uses
that seam to persist the active Extension Profile's `{ id, fingerprint }`. The Extension Profile
contract is owned by [`hosts/extension-profiles.md`](../../specs/hosts/extension-profiles.md), not by this leaf.

## Vocabulary it owns, and why it is here rather than elsewhere

Several things in this package are vocabulary rather than contract. Each is here because the
alternative was a dependency edge nobody wanted:

| Module                                              | Why not elsewhere                                                                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-ref.ts` (`parseModelRef`, `resolveProvider`) | read by the request schema, the memory factory, subagent profiles and the kernel's guard judge — none of which should depend on a provider implementation                                            |
| `reasoning-budget.ts` (`reasoningOutputFloor`)      | pure arithmetic needed by both the engine's hot loop and the adapter; leaving it in `@clarvis/llm` would make `runtime/loop/` import the provider layer                                              |
| `message-content.ts` (`contentToText`)              | shared by the engine and the memory adapter                                                                                                                                                          |
| `sanitize.ts`                                       | the secret-redaction rules, below                                                                                                                                                                    |
| `errors.ts`                                         | the five-class `CodedError` hierarchy: its members split across the trace/engine boundary, so splitting the file would make `@clarvis/loop` import its own error's base class from the trace package |
| `frontmatter-fence.ts` (`splitFrontmatterFence`)    | the `---` split shared by `@clarvis/skills` and `@clarvis/loop`'s agent definitions, below — a _string_ operation, so it lands here rather than in the filesystem leaf                               |
| `capability-executables.ts`                         | the serializable declaration, platform/env resolver and narrow session port shared by hosts and language-neutral Memory/Plans adapters                                                               |

Plus `tool-arguments.ts`, `call-envelope.ts` (`openCallEnvelope`), `handler-base.ts`
(`handlerBaseOf`) and the hook vocabulary (`hooks-config.ts`) — the last because the settings block
declares it and the loop adapter in `@clarvis/hooks/capability` executes against it, so it belongs
to neither package alone.

That shared hook vocabulary includes the exact user skill-command expansion event, compatible
external event/tool names, and both identities for a projected tool call: its model-facing wire name
plus an optional stable dotted full name. Keeping those values below the optional hooks package lets
the engine expose them without loading hook runtime code on the eager settings path.

### `sanitize.ts` is one rule set with two behaviours

`@clarvis/loop` and `@clarvis/memory` each carried a copy that had **silently diverged in output**.
Both behaviours are preserved here by composition rather than by picking a winner:

- `sanitizeToolPayload` / `sanitizeErrorMessage` match the generic secret words
  `password|token|secret` **only against a quoted value**. This rule set runs over every persisted
  tool argument and result, and rehydration replays the trace — so an unquoted `[:=]` match would
  rewrite `const token = getToken(req)` into `const token: [redacted]`, and _that_ is what a restored
  session would then show as the file's contents.
- `sanitizeText` folds those words into the header-key rule and matches them **unquoted**, because
  memory persists text no upstream sanitizer saw and is never replayed as a file.
- The differing rule is a **single combined alternation**, not two sequential rules: two rules applied
  in sequence redact overlapping matches differently from one alternation scanned in a single pass.
- `sanitizeDeep(value, redact)` takes the string redactor as a parameter. That is the whole reason a
  merge was possible — the disagreement is an argument instead of a fork.

### `tool-arguments.ts`

`LLMToolCall.arguments` is `unknown` by contract, and a provider really does hand back a **truncated
JSON string**. The old answer — "if it isn't an object, it's `{}`" — turned a transport fault into a
schema error about a property the model had in fact sent, and then taught the broken shape back to
the model through the assistant turn.

Assistant prose can likewise retain provider-issued `text_parts`. Each part keeps its visible
`commentary`/`final_answer` phase plus opaque `providerOptions` such as a Responses item id. The loop
may render the phase, but only the matching provider adapter interprets the continuation envelope.

Normalization happens **once**, in `@clarvis/llm`'s `buildCallResult`. A rejected payload sets
`LLMToolCall.malformedArguments` to a bounded preview and both dispatchers refuse the call. Two rules
are load-bearing: an _absent_ payload is still a legitimate `{}` (`list_dir`, `list_memories` and
`monitor_list` are called that way), and the convergence-guard signature is built from the
**preview** rather than the normalized `{}` — otherwise every malformed call reads as the same call
and the guard kills the run faster than the bug it is reporting.

### `call-envelope.ts`

`openCallEnvelope` validates a call's arguments through an injected
`AgentBuildContext.validateArgs` port rather than an ajv instance of its own, which is what keeps
this package's only external dependency `zod`. Supplying a `schema` with **no** `validate` throws:
the alternative is a validation boundary failing open in silence.

`ToolCallDetail.guard` is the durable final command-review fact for a guarded
call. It records mode, allowed/denied outcome, and answerer on the terminal
`tool_call`; progress events deliberately do not carry an interim verdict.

### `frontmatter-fence.ts` splits; it does not parse

`splitFrontmatterFence(raw)` strips a leading BOM and leading whitespace, finds the `---` fence
(LF or CRLF), and returns one of three outcomes — `fenced` with the frontmatter **text** and the
body, `absent`, or `unterminated`. It carries **no YAML parser**: parsing and validation stay with
the caller, which is what keeps this package's only external dependency `zod` and its Node-builtin
count zero.

`@clarvis/skills`' `SKILL.md` reader and `@clarvis/loop`'s agent-definition reader each had an
independent, byte-identical copy of the regex, and their error handling had already diverged —
`skills` always rejects an unterminated fence, `loop` rejects it only in `"strict"` mode. That
disagreement is _policy_, so `unterminated` is **reported, not thrown**, and each caller keeps its
own answer.

`@clarvis/plan`'s `splitDocument` is deliberately **not** a caller and needs no drift test. It is a
different contract, not a copy: it requires a fence, requires the frontmatter to parse to a mapping,
and strips neither a BOM nor leading whitespace — because a plan file without frontmatter must be an
**error**. Folding it in would give it this module's "no fence means no frontmatter" reading and
produce exactly the silently empty plan the repository guidance forbids.

Two `---` lines with nothing between them read as `unterminated`, not as an empty block: the closing
fence must be preceded by a newline the opening fence did not already consume. An _empty_ block is
`---`, a blank line, `---`. That is the behaviour both callers already had, preserved exactly.

The BOM strip is written as the escape `/^\uFEFF/`, never as a literal BOM codepoint — a literal one
in a source file is forbidden repository-wide.

## Diagnostics

`src/log.ts` is the contract half — `NOOP_LOGGER`, `LOG_LEVELS`, `levelEnabled`, `bind`,
`parseLogScopes`/`levelFor`, `createSampler`, `createRateLimiter` — and is documented by
[`specs/cross-cutting/observability.md`](../../specs/cross-cutting/observability.md). This package also emits four events of its
own. Each takes its logger from an options bag and defaults to `NOOP_LOGGER`, never `logger?:`: an
optional-chained call is one more branch at every call site, and this package holds a 1.00/1.00
coverage floor.

| Level | Event                                    | Fields                                                                                             |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| info  | `capability.elicit_no_response`          | `waited_ms`                                                                                        |
| debug | `capability.extension_permit_refused`    | `operation`, `call_class`, `reason`, `active_normal`, `active_run_end`, `max_active_per_operation` |
| debug | `capability.admission_observer_failed`   | `err`                                                                                              |
| debug | `capability.compute_clock.loop_rejected` | `err`                                                                                              |

`capability.extension_permit_refused` exists because a refusal reaches its caller as an exception
class and nothing else, so a host that is legitimately saturated and one holding a permit for an
operation that will never settle produce the identical symptom. The occupancy counts are what
separate them. `capability.elicit_no_response` is the only record that a human never answered: above
`map.onNoResponse()` the run simply proceeds on the caller's default.

## Settings: static built-ins, dynamic downstream

The engine spreads its own settings blocks into the schema **statically**, so zod's inference stays
exact and the `SettingsFile` / `ParsedRunRequest` drift locks keep working. `CapabilityRegistry` is
the open half: a capability shipped in its own package registers its block, and the host validates
it against `CapabilitySettingsSpec.schema` rather than the engine declaring it. Registration must
happen before settings are parsed.

## Prompt-cache continuity

The typed `PromptCacheIdentity` and `composePromptCacheKey` compose a persisted session and agent instance, escaping embedded underscores and rejecting keys over 512 characters. `RunRequest` carries `session_id` and `agent_instance_id`; tool-call provider metadata, assistant phase and reasoning remain persisted replay data.

See the [prompt-cache contract](../../specs/cross-cutting/prompt-cache.md) for replay, identity
validation and separate deterministic, live-provider and installed-artifact qualification.
