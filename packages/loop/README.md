# `@clarvis/loop`

The embeddable Clarvis agent-loop engine. It runs model-backed agents and
sub-agents in process, with tool use, budgets, context compaction, persistence,
steering and structured results.

`@clarvis/loop` is an engine, not a server. Use `@clarvis/kernel` to program
against the Clarvis kernel contract.

Hard workspace dependencies: `@clarvis/capability` (the contract), `@clarvis/llm` (the
provider port's implementation), `@clarvis/mcp-client`, `@clarvis/paths`,
`@clarvis/supervision` and `@clarvis/trace`. The three feature packages —
`@clarvis/hooks`, `@clarvis/skills` and `@clarvis/tools` — are
`optionalDependencies`, and **none of them may import this package**: that is what keeps the graph a DAG, and
`tests/architecture/optional-package-boundary.test.ts` enforces it across both their
`src/` and their `tests/`. The inverse guard walks the complete static runtime
graph from `src/lib.ts`, ensuring the main entry remains importable when any
optional package is absent.

`@clarvis/memory` and `@clarvis/workflows` sit the other way round: they depend
on this package and compose it. `@clarvis/plan` is likewise host-registered and
never named by the engine. A host builds each capability and hands it over —
memory and planning through `buildExecuteRunDeps({ capabilities })` so ordinary
runs and their in-process sub-agents inherit them, workflows per `executeRun`
call so a workflow leader deliberately does not. The kernel also removes memory
from those auxiliary leader runs; only their primary manager produces a memory job.

Provider model entries may retain `reasoning_efforts` alongside their window, output, capability,
and prompt-cache metadata. The engine validates and carries these provider-published strings but
does not interpret them; model-aware host configuration surfaces own normalization and selection.
Provider-native model ids may contain `/`, `.`, and `:` after the provider segment, including local
server tags such as `local/qwen2.5-coder:7b`.

The engine no longer talks to a provider, implements trace persistence, or speaks
MCP itself. What remains of the last two is engine _policy_ — when to record and
when to call — while the transports live in `@clarvis/trace` and
`@clarvis/mcp-client`.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> is not published independently.

## Contract

The loop contract is divided across the eight focused specs under the
[`engine` map](../../specs/README.md#engine--the-loop-itself): lifecycle, request/settings,
capability composition, tool dispatch, compaction, budgets/guards, delegation, and vision routing.
Changes may also implicate the cross-cutting contracts for
[`grants`](../../specs/cross-cutting/grants.md),
[`prompt caching`](../../specs/cross-cutting/prompt-cache.md), and
[`elicitation`](../../specs/cross-cutting/elicitation.md).

## Core flow

```ts
import { buildExecuteRunDeps, executeRun, loadEnv } from "@clarvis/loop";

const built = await buildExecuteRunDeps({
  env: loadEnv(process.env),
  workspaceRoot: process.cwd(),
});

try {
  const outcome = await executeRun({
    owner: "local",
    deps: built.deps,
    rawBody: {
      messages: [{ role: "user", content: "Explain this repository" }],
      entry: "coder",
      profiles: [
        {
          name: "coder",
          model: "openai/gpt-5",
          base_prompt: "You are a coding agent.",
          tools: [],
          iteration_limit: 10,
        },
      ],
    },
    onEvent: (event) => {
      // Stream trace events to the host.
    },
  });

  console.log(outcome.executionId, outcome.response);
} finally {
  await built.dispose();
}
```

`buildExecuteRunDeps({ mcpAuthorization })` optionally creates the shared remote-MCP OAuth
coordinator. The host owns the private store path and may supply a browser opener; the builder wires
the coordinator into HTTP/SSE transports and closes its callback listener together with the
connection manager in `dispose()`.

Every run acquires remote MCP servers with background browser authorization. Clarvis still opens the
authorization page, but the current run never waits for a human response: that server is recorded as
degraded and contributes no tools to the run. Ignoring the page therefore cannot hold model work;
completing it persists the credential for a later run. A non-OAuth terminal connection failure keeps
the existing all-servers-failed policy.

`rawBody` is validated into a `RunRequest`; the exact provider, profile, budget
and orchestration fields are defined by the exported API types. Hosts normally
assemble this request from their own configuration surface.

`openai-codex` and `xai-grok` are strict subscription kinds: request/settings validation rejects an
API-key variable, base URL, arbitrary headers, or arbitrary body on either. Different profiles in
one agent graph may select models from different connected subscriptions; the host resolves each
physical request through its kernel-owned authority. The local beta includes project-approved
public-client registrations for eligible ChatGPT and Grok accounts. That is a Clarvis project
decision, not provider endorsement. A host composed without subscription registrations reports the
schemes unavailable, and synthetic transports exercise this path in tests; live account-controlled
provider canaries remain a separate release gate. See
[`subscription-providers.md`](../../specs/hosts/subscription-providers.md).

## Capabilities

Cross-cutting behavior composes through the `Capability` contract:

```text
requiresUserInput(requestView) → forRun(context with the same requestView)
                              → forAgent(scope) → attach(build context)
```

Capabilities may contribute tools, prompt sections, lifecycle behavior,
settings, run parameters, events and static persisted trace projectors. `executeRun` composes the
host registry plus every registered capability's projectors once, then shares that immutable
snapshot across live emission, journal writes and final trace mapping so those paths cannot disagree.
Assistant entries append provider-issued text parts together with their plain display text. Those
parts survive snapshots and compaction unchanged, so continuation metadata is added only with the
new turn and never retrofitted into an existing durable prefix.
The public settled-context helpers can estimate a persisted snapshot, run the same guided forced
compaction without another agent iteration, or mechanically fit it to a smaller model window.
Mechanical fitting preserves retained entries byte-for-byte, including opaque provider metadata;
the caller owns the explicit persisted replacement and its cache-breaking consequences.
Built-ins cover:

- coding tools and command guards;
- `host_vcs` as an exec-gated host-boundary command: `edit_workspace` alone never advertises or
  dispatches it, while `run_commands` still subjects every invocation to command review;
- one owner-only temporary root per run, advertised as `TMPDIR`, `TEMP`, and `TMP` to shell commands
  and admitted by that run's native tools; a verified directory created through an explicit absolute
  POSIX `mktemp -d` template joins the same run-owned set, and every member is removed after the run
  record is persisted;
- skills;
- user elicitation;
- lifecycle hooks;
- exact user skill-command expansion observers, carried as host-derived request context and fired
  before seed context rather than approximated from an ordinary prompt;
- independent child spawning (`spawn_subagent`) and tracked task delegation (`delegate_task`);
- agent supervision (`agent_list`, `agent_poll`, `agent_stop`, `agent_steer`,
  `await_agents`), over the run-scoped registry in `@clarvis/supervision`.

`spawn_subagent` is always the plan-free route and has no `task_id` property. A task-tracking
capability adds `delegate_task`, whose `task_id` is required and must name an existing open work
item. An unknown or closed id is rejected with the currently spawnable ids and an explicit
instruction to use `spawn_subagent` for independent work. Both input schemas tolerate and ignore
surplus properties once their known arguments are valid.

The `Capability` contract itself lives in `@clarvis/capability`, not here — the
loop imports it like any other consumer, which is what lets a capability ship in
its own package.

A capability may also contribute an `OutputTokenBudget`. The loop wraps the selected provider once
at the model-call boundary, so the same reservation covers ordinary completions, transport retries,
context-compaction summaries and vision calls; manager sub-agents inherit it through normal
capability composition. Exhaustion returns the ordinary `budget_exhausted` result before another
provider call instead of escaping as a generic failure. The run's existing local budget still owns
iterations/time/input accounting; the shared port adds an outer output ceiling rather than replacing
that policy.

Capability grants are anonymous engine vocabulary. Each capability declares its grant names
statically; `executeRun` copies the host registry, adds those declarations for this run, and validates
profiles against the copy. A lead can spawn by shape; a non-lead entry is spawn-capable only when it
carries a grant declared with `entryCanSpawn: true`. That result alone decides whether the run gets a
supervision registry and its five tools — there is no feature-name switch or request boolean.

The engine publishes that registry under `AGENT_REGISTRY_PORT` on the run's generic
`CapabilityServices` before `forRun` begins. Capabilities consume it through `ctx.services`; the old
special `RunCapabilityContext.agents` channel is gone. Other capability-to-capability ports are read
at `attach` time, after providers have activated, so registration order cannot hide a peer.

The standard kernel additionally registers `@clarvis/plan/capability` over the
same owner-scoped store factory its plans control-plane service uses.

Feature capabilities whose implementations depend on optional Clarvis packages
are reached through separate entrypoints, so importing `@clarvis/loop` carries
no static runtime dependency on any of them:

```ts
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import { createSkillsCapability } from "@clarvis/skills/capability";
import { createWorkspaceHooksCapability } from "@clarvis/hooks/capability";
```

Only the tools adapter is still the engine's own subpath — it imports the
built-in toolset and the convergence guards, which are the engine's policy on
when a tool call counts as progress. It also owns monitor cleanup, so disabling
the tools built-in avoids loading tools entirely; generic spill cleanup remains
on the main path through `@clarvis/paths`. The skills and hooks adapters ship with
their feature packages instead, each behind that package's `./capability` entry;
`@clarvis/loop` no longer exports a subpath for any of them. `@clarvis/memory`
also ships one, but it is not on this list: the engine does not load it at all.

Run teardown removes each registered temporary root and then prunes its now-empty execution and
`runs/` containers. The global paths sweeper separately reclaims stale empty containers left by a
crash, so a normal run does not accumulate directory-only scratch state.

Stagnation is a consecutive streak, not a run-wide frequency count. The same tool call must return
the same successful result repeatedly with nothing different in between; another call, a changed
result, or an error resets the streak. Re-running a clean lint or test after editing files therefore
cannot terminate an otherwise productive run merely because that verification also passed earlier.

## Host responsibilities

A host supplies or builds:

- an `LLMProvider` — the engine no longer talks to a provider itself;
  `@clarvis/llm` is the Vercel AI SDK implementation of that port, and
  `buildExecuteRunDeps` wires it by default;
- a workspace root;
- trace persistence;
- downstream MCP connections;
- whether a server's discovered tools are host-composed into every agent for this run through
  `McpServerConfig.auto_tools`; the loop applies that union only after the connection succeeds and
  never rewrites the request's or operator's persisted profiles;
- optional persistent browser authorization for remote MCP connections; the host owns both the
  private store path and whether it can open a browser;
- optional event, steering, explicit-compaction, elicitation and cancellation channels;
- any additional capabilities.

A host may also supply `HostRunDeps.hostMetadata`, an opaque snapshot evaluated once per run and
carried into its journal and final execution record. The loop does not inspect the value. The file
kernel uses it for extension Environment identity and supplies only already-resolved skill roots, so
Environment discovery and trust remain host policy. See
[`hosts/environments.md`](../../specs/hosts/environments.md).

`buildExecuteRunDeps` provides the standard local wiring. `executeRun` returns
the execution ID and final response while emitting detailed trace events during
the run.

A host that owns multiple kernels creates one `createHostModelCallAdmission(env)` and injects it as
`modelCallAdmission` into each `buildExecuteRunDeps` call. The default is four physical calls active
and eight queued across the host. A standalone builder creates and closes its own controller.
`CLARVIS_MODEL_ABORT_SETTLE_MS` (250 ms by default) controls how long an aborted physical transport
may take to settle before the model-call gate quarantines it. Separately,
`CLARVIS_RUN_ABORT_SETTLE_MS` (2 s) bounds how long timeout or caller cancellation may wait for the
whole agent loop to unwind; a tool that ignores abort is observed and detached after that grace so
it cannot pin run persistence, owner leases or the UI indefinitely.

Host capabilities are bounded at the same trust boundary. `forRun` activation and `seedBlock`
generation run concurrently under `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS` (5 s by default); lifecycle
tool/observer hooks use a 5 s per-hook wall budget, rare policy gates use 30 s, and
`finalizeRun`/`onRunEnd` use
`CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` (2 s by default). A timed-out extension loses only its own
contribution, while the rest of the run can settle and release its resources. The logical timeout
does not release the host's physical extension permit: non-cooperative promises retain one of 32
ordinary slots (at most four per stable capability/phase) until they really settle, so repeated runs
stop invoking the offender instead of accumulating detached work. Finalizers and both run-end
observer surfaces use an independent eight-slot reserve, preserving cancelled-run cleanup when an
ordinary hook has saturated its class. Hosts spanning multiple workspace kernels share this gate via
`createHostExtensionAdmission`, just as they share model-call admission.

Plugin agent discovery is likewise a bounded trust boundary. One plugin may expose at most 256
Markdown agent files, 2,048 inspected directory entries, 128 traversed directories and eight levels
of nesting. Each file is capped at 256 KiB and the complete retained agent source at 8 MiB. Reads use
one descriptor plus a byte of lookahead, so sparse files, replacement and growth races cannot bypass
the ceiling; crossing any ceiling rejects the whole agent surface rather than returning a usable
prefix.

Inline media is charged by payload size, not as a constant-size message. One tool result retains at
most four images and 8 million characters per image; the live context retains at most 12 million
characters of tool-image payload across results, releasing older images with an explicit marker.
Incoming multimodal history has a 16-million-character aggregate ceiling across the complete request,
so many individually valid data URLs cannot multiply into an unbounded continuation or final snapshot.

Profiles and transport descriptors are bounded before they become retained run state: profile prose
shares an 8 MiB aggregate character budget, individual base prompts cap at 256 KiB, and tool/grant/
spawn lists have finite fanout. MCP argv, header/env maps, command-guard patterns and sandbox path
lists likewise have per-item and collection ceilings in both `settings.json` and direct requests.
One child-spawn brief is limited to 32,768 Unicode characters in both advertised tool schemas and
the programmatic handler. A tracked exit condition shares that same final prompt budget, so task
augmentation cannot bypass the tool boundary.
Caller-supplied structured-output schemas are inspected iteratively before AJV compilation: depth,
node count, container width and string storage have hard ceilings, and cyclic/accessor-backed graphs
are rejected. This bounds the compiler working set even for direct embedders that bypass HTTP's body
limit.

The standard builder also applies the process-level resource ceilings instead of leaving them as
library-only defaults: `CLARVIS_PROVIDER_MAX_RESPONSE_BYTES` (32 MiB),
`CLARVIS_PROVIDER_MAX_SSE_EVENT_BYTES` (4 MiB), `CLARVIS_MCP_STDIO_MAX_FRAME_BYTES` (16 MiB),
`CLARVIS_MCP_HTTP_MAX_RESPONSE_BYTES` (16 MiB), `CLARVIS_MCP_HTTP_MAX_SSE_EVENT_BYTES` (4 MiB),
`CLARVIS_MCP_MAX_SERVERS_PER_RUN` (16), `CLARVIS_MCP_MAX_CONNECTIONS` (32),
`CLARVIS_MCP_MAX_PARALLEL_CONNECTS` (4), and `CLARVIS_MCP_MAX_IDLE_CONNECTIONS` (8). The per-run MCP
server ceiling cannot exceed the process connection ceiling; an incoherent environment fails at
startup, and a request over the configured per-run ceiling fails before opening transports.

An explicit `CompactionSource` is drained before model calls. It forces selection below the normal
high-water mark while preserving the configured recent tail. Optional user text is an additive,
bounded summarizer contribution; if that instructed summary fails or cannot shrink the context, the
manual request is reported as skipped instead of falling back to blind eviction. Scheduled passes use
the active agent model and normally disable reasoning so the bounded output remains available to the
summary. Subscription-backed Responses models are the exception: their entitled effort list may not
include `none`, so compaction omits the override and lets the provider choose a supported default
instead of turning a rejected internal call into an ordinary eviction fallback.

Caller-supplied execution IDs are unique per owner. The loop reserves an ID
while its run is in flight, so concurrent retries with the same `execution_id`
fail with `execution_id_conflict` before model or tool work is performed.

## Public entrypoints

The list below is the whole of `package.json`'s `exports` map:

- `@clarvis/loop` — stable engine and host-facing types, including `VERSION` sourced from the root
  Clarvis product manifest.
- `@clarvis/loop/capabilities/tools` — coding tools and guard integration.
- `@clarvis/loop/host` — the narrow host-composition surface for config,
  provider, plugin and sandbox policy that `@clarvis/kernel` programs against, including dependency
  construction, logger/version bindings and their host-facing types without importing the full
  execution entry.
- `@clarvis/loop/workflows` — the engine-owned elicitation serializer a workflow
  implementation needs; shared contracts come directly from `@clarvis/capability`.
- `@clarvis/loop/testing` — engine-owned `MockLLM`/`MockMCP` doubles plus fresh MCP/trace
  infrastructure for downstream tests that execute a real loop without depending directly on the
  engine's execution-service implementations.

## Test ownership

- `tests/unit` owns isolated engine policy and pure state transitions.
- `tests/component` composes engine modules through injected ports, including
  the `executeRun` and internal-facade contracts.
- `tests/contract` owns the public request, response and structured-output wire
  shapes.
- `tests/integration` retains intentional cross-package and real-effect seams,
  including filesystem persistence, subprocesses, provider SDKs and MCP.
- `tests/architecture` owns static graph, optional-package, entrypoint and wire
  vocabulary guards that runtime behavior tests cannot observe.
- Shared fixtures live in `tests/helpers`; pure helpers are imported directly so a
  unit or component test never reaches through the integration tier.

The integration harness starts with the engine's hard dependencies only. A case
that exercises a feature must opt into `agentTools`, `askUser`, `skills` or
`hooks` explicitly; a contract-only capability fake can be supplied through
`capabilities`. This keeps an integration test from inheriting unrelated feature
behavior merely because it used the shared harness.

Coding-tool policy units bind a narrow adapter fake and a `TracePort` fake; the
three cases in `tests/integration/tools.test.ts` own the real filesystem, image,
diff and monitor-cleanup wiring. Lifecycle verdict/observer policy is unit-tested
with minimal `LifecycleHook` values, while component cases use a fake
`Capability` to verify that the engine reaches those hooks.

The suite deliberately uses Bun's shared-global default rather than `--isolate`. During the Bun
1.4.0 qualification, five isolated runs had a 20.62 s median against 11.15 s on Bun 1.3.11, while
five shared-global Bun 1.4 runs all passed in 10.07–10.15 s. The suite bans `mock.module()`, restores
fake timers in `afterEach`, and passed the complete 1,606-test inventory repeatedly, so paying an
84.9% per-file isolation penalty protected no observed state leak. The explicit 60-second timeout,
test-home preload and package-local coverage boundary remain unchanged.

## What it logs

Diagnostics go to the `Logger` port from `@clarvis/capability`, never to `process.stderr`, and never
to the trace: a trace entry records what the _run_ did, a log line records what the engine's
machinery did about it. Nothing here duplicates a `TraceKind` — iteration boundaries, stop reasons,
budgets, guard trips, tool calls, delegation, steering, elicitation and vision are all the trace's,
and the requested-compaction path already records `compaction_skipped`.

Every scheduled or requested pass first emits live-only `compaction_started`, before pre-compaction
hooks or summary-model work. The durable outcome stays `compaction` or `compaction_skipped`; an
eviction produced only because an attempted summary failed or did not shrink the span carries
`fallback_reason`. Summary calls use a 120-second default timeout so large contexts are not silently
downgraded by the shorter ordinary-control timeout.

For guarded coding tools, the terminal `tool_call` also carries the final review
metadata returned by the dispatcher. This is execution history, not a diagnostic:
it is persisted and later projected to clients alongside the shell result.

Every record carries a stable `event` field; the message is prose that names the consequence and is
free to change. Three correlation scopes are bound with `bind()`: the run
(`execution_id`, `owner_key_name`, `mode`) in `executeRun`, the agent (`agent`,
`subagent_instance_id`) in `runAgent`, and `iteration` as a plain field — a child logger per
iteration would allocate per iteration for nothing.

| Level   | `event`                                   | Fields                                                                                            |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `warn`  | `context.prefix_break`                    | `index`, `entries`, `char_offset`, `chars_recharged`, `cause`                                     |
| `warn`  | `compaction.summarizer_failed`            | `mode`, `reason`, `fell_back`, `cause`                                                            |
| `warn`  | `compaction.unreachable`                  | `declared_window_tokens`, `high_water_tokens`, `observed_tokens`                                  |
| `warn`  | `tool.args_validation_failed_open`        | `tool`, `reason`                                                                                  |
| `warn`  | `iteration.cache` (escalated)             | `iteration`, `input_tokens`, `cached_tokens`, `ratio`                                             |
| `info`  | `run.composed`                            | `capabilities`, `builtins`, `tools`, `mcp_servers`, `entry_agent`, `model`, `mode`, `seed_blocks` |
| `debug` | `capability.activated`                    | `capability`, `duration_ms`, `tools`, `has_seed_block`                                            |
| `debug` | `gate.nudged` / `gate.force_tool_applied` | `gate`, `mode`, `force_tool_next`, `nudge_count`                                                  |
| `debug` | `iteration.cache`                         | as above                                                                                          |
| `debug` | `optional_package`                        | `package`, `feature`, `outcome`                                                                   |
| `debug` | `skills.roots_unavailable`                | `cause`                                                                                           |

Plus the degradation warnings the engine already emitted, now named:
`mcp.connect.failed`, `vision.capability_missing`, `vision.call_failed`, `trace.ingest_failed`,
`trace.emit_failed`, `skills.discovery_failed`, `skills.discovery_warning`,
`capability.extension_saturated`, `capability.setup_timeout`, `capability.finalize_timeout`,
`capability.finalize_failed`, `capability.run_end_failed`, `capability.run_end_timeout`,
`hook.verdict_failed`, `hook.observer_failed`, `hook.pre_compact_failed`,
`run.teardown_detached`, `steer.drain_failed`, `tool.spill_failed`, `tool.handler_failed`,
`tool.deferred_handler_failed`, and the one `error`: `run.persist_failed`.

`context.prefix_break` is the reason this section exists. `specs/cross-cutting/prompt-cache.md` prices a single
in-place mid-transcript rewrite at **2,929,430 tokens — 35.7% of one session's uncached input**, and
until now that invariant was enforced only by a build-time test. Every mutation of the live
transcript funnels through `LiveEntryStore`, which reports one when the mutation lands **before** the
trailing volatile run; `cause: "compaction"` and `cause: "summary_anchor"` drop to `debug`, because
eviction and summarization rebuild the transcript knowingly — `replaceSpanWithSummary` is reachable
only from `attemptCompaction`, so warning on its anchor rewrite reported every rolling
summarization as a defect and drowned the causes that are one. The character prefix-sum is computed
only inside the break branch, and `appendDurable` — the path every tool result takes — reports
nothing at all, by construction.

Two of these warnings are decided from provider-reported evidence rather than from a threshold, and
the distinction is the whole point. `iteration.cache` escalates when `cached_tokens` falls below
what the provider served **last** iteration — never on the cache-read _ratio_, which one large
`read_file` moves by 0.63 with the prefix perfectly intact — and it re-arms as soon as an iteration
stops losing ground, so no single trip can hide a later break. `compaction.unreachable` fires only
when the provider **refuses** a prompt that is still below compaction's high-water mark: that
rejection is the one observation proving a declared `context_window_tokens` is wider than the
model's real window. The engine holds no independent knowledge of a model's window, so comparing the
declared one against a default constant said nothing — and warned on every correctly declared 200k
model.

## Development

Run commands from the monorepo root:

```bash
bun --filter @clarvis/loop build
bun --filter @clarvis/loop typecheck
bun --filter @clarvis/loop test
bun --filter @clarvis/loop test:unit
bun --filter @clarvis/loop test:component
bun --filter @clarvis/loop test:contract
bun --filter @clarvis/loop test:integration
bun --filter @clarvis/loop test:architecture
bun --filter @clarvis/loop lint
bun --filter @clarvis/loop format:check
```

The package requires Bun 1.4.0 or newer, matching `engines.bun`.
