# `@clarvis/workflows`

The agentic workflow layer over the Clarvis loop: a **manager** run whose spawn tools start full,
isolated **leader** runs, each of which may delegate to sub-agents of its own.

```text
manager run  ──┬─> leader run ──> sub-agents
               ├─> leader run ──> sub-agents
               └─> leader run ──> sub-agents
```

It is packaged as a **loop capability**, so `@clarvis/loop` gains it by registration rather than by
knowing about it. Dependencies: `@clarvis/capability`, `@clarvis/loop` and `@clarvis/supervision`,
plus `yaml` + `zod`.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> is not published independently.

## Contract

Manager-to-leader execution, waves, rounds, limits, and the shared ledger are specified in
[`workflows-scheduling.md`](../../specs/capabilities/workflows-scheduling.md). Workflow documents,
result schemas, persistence, tree projection, and routing are specified in
[`workflows-service.md`](../../specs/capabilities/workflows-service.md).

## Entry points

| Entry                         | Contents                                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@clarvis/workflows`          | `createWorkflowsCapability`, `WORKFLOW_GRANT`, `BUILTIN_WORKFLOWS`, `resolveWorkflowDefinitions`, the ledger, cumulative leader counter, semaphore, elicit mux, `runLeader`, workflow trace detail/projector/narrowing APIs, `workflowsSettingsSpec` |
| `@clarvis/workflows/schemas`  | the zod schemas for the workflow document and the discovery/result payloads                                                                                                                                                                          |
| `@clarvis/workflows/artifact` | `loadWorkflows` and the `WORKFLOW.md` loader                                                                                                                                                                                                         |

## The workflow tools

In ascending order of how much structure they assume:

| Tool              | Effect                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `run_leader`      | starts one ad-hoc leader                                            |
| `run_work_items`  | starts a whole decomposition, scheduled into internal waves         |
| `run_round`       | starts the first round of a manager-controlled round sequence       |
| `workflow_status` | inspects the active or latest sequence without starting work        |
| `workflow_decide` | explicitly continues its exact proposed round or stops the sequence |
| `run_workflow`    | reviews, then starts a built-in or operator-authored round sequence |

`run_workflow` is **not contributed at all** when the host supplies no definitions, so the model never
sees a tool whose only argument has no legal value. Clarvis's kernel always supplies the built-in
`audit`, `implement` and `research` definitions, plus any valid operator overrides. Its
`explain: true` prints the rounds and what the fan-out costs without running anything — and says
plainly that an `each` round's cost is not knowable in advance rather than inventing a number.

## Scheduling is derived from data, not re-decided by the model

`DISCOVERY_SCHEMA.work_items[]` carries a short `title`, the complete `goal`, `dependencies`, `files`
and `mutation` — a human label plus a dependency graph with a write-conflict declaration.
`src/schedule.ts` derives the waves from it: topological layers by `dependencies`, then first-fit
packing that separates any two items whose `files` overlap when either mutates. The scheduler and
registry display the authored `title`; the leader receives the complete `goal` in its brief.

For a long time none of that was read, and the shipped manager prompt asked in prose for the
invariant instead ("never dispatch two mutating leaders whose files overlap"). A workspace-integrity
rule guaranteed by persuasion is not guaranteed.

The derived rule is deliberately **stronger** than the prose it replaced:

- **Reader-writer, not writer-writer** — a read concurrent with a write is torn, not merely stale.
- **Path comparison is case-insensitive**, because macOS and Windows are.
- **A mutating item that declares no files is treated as writing everything.**
- **Packing walks the items in the order the model emitted them**, so the same `work_items[]` always
  yields the same waves.

## Rounds

A round declares **what it consumes**, and the barrier follows from that:

| Selector                | Leaders                | Waits for the producing round? |
| ----------------------- | ---------------------- | ------------------------------ |
| `once`                  | one                    | —                              |
| `each(<round>.<field>)` | one per item           | no                             |
| `all(<round>.<field>)`  | one over the whole set | yes, necessarily               |

There is no `parallel` and no `pipeline` argument, so neither can be chosen wrongly: the class of
error is unrepresentable rather than discouraged.

The selector grammar (`src/rounds.ts`) is a **fixed set of call shapes, not an expression language**.
`where <field>` and `where <field> = <literal>` are the whole filter vocabulary, and the standing
answer to "it needs more" is that the producing round should emit the list already filtered.

Rounds read each other by name, with array fields concatenated across a round's leaders — which is
what makes `each(review.findings where needs_verification)` route on the judgement of the leader that
held the evidence, rather than on the manager re-reading five reports twenty iterations later.

Only the first round starts from `run_round` or an approved `run_workflow`. When its internal waves
finish, the sequence becomes `awaiting_manager`; the Admiral must inspect the checkpoint and call
`workflow_decide` with the current `session_id` and `revision`. A matching `continue` starts exactly
the proposed round, while `stop`, a stale revision, a duplicate decision, or ordinary finalization
starts none. Only one round sequence may be active for a manager at a time.

This boundary is deliberately different from a wave boundary. Dependency waves _inside one already
authorized round_ drain automatically. Authored next rounds and repeat passes never do. The
compare-and-set revision makes retries safe: a repeated delivery cannot launch the same round twice.

Two more round mechanics:

- **`fanout` + `accept`** is adversarial verification as a mechanism. A replica that died counts
  **against** the rule and stays in the denominator — otherwise "two of three verifiers crashed"
  reads as unanimous confirmation.
- **`repeat`** computes whether another pass is useful, deduplicating against **everything seen**
  rather than against what survived verification. Every candidate pass is still only a checkpoint
  proposal; the Admiral decides whether it runs.

## Hard shape bounds

Workflow admission is bounded before selector resolution, scheduling or registry calls. The shared
`WORKFLOW_LIMITS` constants drive the artifact's zod schema, every workflow tool/result JSON Schema,
and the programmatic parsers, so a caller cannot bypass a schema by invoking the library directly.

| Dimension                       |  Hard limit |
| ------------------------------- | ----------: |
| rounds in one sequence          |          16 |
| replicas (`fanout`)             |           8 |
| repeat passes / dry passes      |       8 / 8 |
| work items or selected results  |          64 |
| files / dependencies per item   |     64 / 64 |
| argument names                  |          64 |
| identifier / path characters    |  256 / 1024 |
| prose characters                |      32,768 |
| workflow document / brief bytes | 256K / 128K |
| catalogue roots / workflows     |    16 / 256 |
| catalogue entries examined      |       2,048 |
| catalogue aggregate source      |      16 MiB |

These are safety ceilings, not fan-out tuning. `max_concurrency` controls how many admitted leaders
run at once; `max_total_leaders` controls how many leaders the manager may register cumulatively
across every tool call and round (default 32, configurable to 255). An ad-hoc leader reserves one
slot; a work-item batch and a round reserve their complete leader count atomically. If the complete
unit does not fit, it registers zero children and leaves an awaiting checkpoint unchanged. Once the
supervision registry accepts a leader, that registration is counted before its trace is published;
a trace failure settles the accepted handle but never refunds its lifetime slot.

Catalogue discovery uses directory handles and examines entries incrementally; it never asks the
filesystem to materialize a complete root. The entry, workflow and aggregate-source ceilings are
shared across all roots in one scan. Crossing any catalogue ceiling is atomic: discovery returns one
explicit resource-limit diagnostic and no executable workflows, rather than exposing an apparently
complete partial catalogue whose contents depend on directory order.

## Built-ins and workflow documents

Clarvis ships `audit`, `implement` and `research` as TypeScript `WorkflowDefinition` values under
`src/builtin-workflows/`; it does not copy their source into a user's configuration directories.
`resolveWorkflowDefinitions` starts with that catalogue and replaces a definition only when a valid
operator-authored workflow has the same name.

An optional `<root>/<name>/WORKFLOW.md` mirrors `SKILL.md` exactly (`src/artifact.ts`): YAML
frontmatter validated by zod, plus a Markdown body that is the synthesis brief. The kernel loads the
global root first and the workspace root second, so precedence is `workspace > global > built-in`.
An override replaces the complete definition; it is not merged round by round. A malformed document
is diagnosed and contributes no override, leaving a same-named built-in available.

Every round declares both `title` and `brief`. The title is an interpolated, single-line label for the
leader roster; the brief is the complete task prompt. A title is required, cannot exceed 60 Unicode
code points, and is never synthesized from or clipped out of the brief.

One divergence is deliberate: `@clarvis/skills` only _warns_ when a name disagrees with its
directory, and here it is a **hard load error**, because a workflow is dispatched **by name** — the
disagreement would otherwise surface as the wrong thing running.

Roots are resolved by the **kernel**, not here. `@clarvis/paths` owns the directory vocabulary and
the kernel already depends on it, so `loadWorkflows(roots)` takes them as an argument and this
package gains no dependency edge.

## Persisted leader-run edges

This package owns the complete trace contract for a leader's three durable lifecycle edges:
`workflow_run_started`, `workflow_run_completed` and `workflow_run_failed`. `recordWorkflowTrace`
keeps their detail payloads statically checked at every producer even though contributed
`TracePort` kinds are open in the base contract. `WORKFLOW_PERSISTED_TRACE_PROJECTORS` validates the
opaque recorded detail and projects the canonical flat persisted objects; the workflows capability
registers that list through `Capability.persistedTraceProjectors`.

The start edge persists `title` and `task` separately. New producers require both. Rehydration still
accepts a legacy start edge without `title`; the kernel derives a bounded first-line compatibility
label at that boundary only, without changing the stored historical bytes.

Hosts must narrow replayed events with `isWorkflowPersistedTraceEvent` before reading these fields.
The guard checks the full shape rather than the discriminator alone because journal parsing is
forward-compatible and deliberately retains unknown objects. The kernel uses this public narrowing
for both the live trace path and rehydration, so it needs neither casts nor a private duplicate of
the workflow detail vocabulary.

## Invariants a change must not break

- **The topology is fixed structurally, with no depth counter**, at three independent points: only an
  _entry_ agent gets `run_leader`; only one carrying the `workflow` grant gets it; and a host injects
  the capability into the manager's `executeRun` only, never a leader's — whose request also has the
  grant stripped and both `plans` and `memory` forced off.
- **`run_leader` is background-only, and there is no synchronous escape hatch.** A `deferred` verdict
  would be joined by `runDispatch`'s own `finally` before the manager's iteration could end, which is
  exactly the "manager goes dark for the length of its fan-out" defect. The absence of a synchronous
  path is deliberate: a model offered a working one keeps choosing it.
- **The semaphore admits a leader before the ledger reserves for it.** A leader waiting in the FIFO
  queue holds no token headroom, so serial batches can reuse the unused share returned by each
  predecessor. The admitted set still reserves before any model call, keeping concurrent dispatch
  atomic against the leader budget. The manager/Admiral is deliberately absent from that ledger and
  remains on the primary run budget. An ordinary in-process child of the manager receives a lazy,
  per-call fair-share adapter rather than the raw tree ledger; a
  capless provider call in one child therefore cannot make concurrently spawned siblings fail
  before their first iteration.
- **Every batched tool holds a baton across wave boundaries inside one authorized dispatch**
  (`src/dispatch.ts`, the one implementation both `run_work_items` and `run_round` run on). The loop's finish gate accepts a lone
  `submit_result` whenever `registry.liveCount() === 0`, so a driver that lets its live-child count
  touch zero between internal waves lets the manager finish on top of a half-run graph — and the
  `registry.seal()` that follows then refuses every remaining registration **silently**. The session
  settles all but one handle of a finished batch, registers the next batch, then settles the last;
  peak overlap against the live-child ceiling is exactly one handle. There is one implementation
  rather than two because getting it wrong is invisible. The baton is deliberately released when a
  semantic round ends: zero live leaders at `awaiting_manager` is the control checkpoint, not a hole
  the engine may fill automatically. Ending a session before its driver starts also settles every
  already-registered pending handle, so a failed running-state publication cannot strand the
  manager behind an invisible child.
- **A batch wider than the registry is queued, never dropped.** A round allocates `items × fanout`
  units, which reaches the hundreds, while the live-child ceiling is a couple of dozen — so the
  session registers what the registry admits and holds the rest in a backlog, registering and
  starting one more each time a unit settles. Dropping the excess was a silent defect of exactly the
  kind the baton exists to prevent: an audit round asking for fifteen verifiers got seven, and the
  eight missing verdicts still counted in `applyAccept`'s denominator as `(unavailable)` — which is
  how a finding nobody verified comes to look like one that survived verification. A batch's outcome
  count now always equals its unit count. A unit still queued when the dispatch is cancelled is
  reported `cancelled` rather than started.
- **A deliberate leader cancellation stops automatic scheduling for that dispatch.** The current
  wave may finish unwinding, but no later wave is registered and the round sequence becomes
  terminal rather than proposing a replacement. A control-plane stop
  must reduce work; silently replacing cancelled leaders with a fresh batch contradicts the user's
  action and can make an otherwise complete manager run fail with `agents_unfinished`.
- **Elicitation is muxed tree-wide** (`src/elicit-mux.ts`). The loop serializes prompts per run, but
  concurrent leaders would otherwise prompt at once. A queued prompt whose signal aborts settles
  immediately as `cancel` and is skipped when its turn comes — otherwise `agent_stop` on a child
  parked behind someone else's question would free neither its registry slot nor its semaphore permit
  until an unrelated human answered.
- **A leader's title is what a human reads.** `run_leader` requires a short `title` alongside the
  complete `prompt`; work items require `title` alongside `goal`; rounds require `title` alongside
  `brief`. All three use `@clarvis/capability`'s shared title parser, so missing, multiline or
  over-60-code-point labels are actionable errors rather than prompts silently promoted to labels or
  oversized labels silently clipped. A leader used to be registered under its entire prompt, so a
  fan-out listed several children each labelled with a full task brief.
- **Cumulative admission is tree-wide and atomic.** `WorkflowLeaderCount` belongs to one manager
  run and is shared by all workflow tools. It counts successful supervision registrations for the
  lifetime of that manager; completion does not refund a slot. Whole batches and rounds reserve
  before their first registration, so exhaustion cannot create a half-spawned semantic unit.
- **The three leader lifecycle trace kinds are contributed here, not built into the engine.** Their
  projectors preserve the established persisted property order and shape, and invalid detail fails
  explicitly rather than producing a malformed typed event.

## Settings

The `workflows:` block is pure fan-out tuning — `max_concurrency` (default `4`, maximum `20`, the
leader-wide cap on concurrently running leaders), `max_total_leaders` (default `32`, maximum `255`,
the cumulative registration cap for one manager), and `budget_tokens` (default `640000000`, with explicit
`null` as the opt-out, an output-token ceiling summed across all auxiliary workflow agents). Its
640-million-token default is four times the manager's independent 160-million-token primary run
budget. That ceiling
covers the manager's in-process child agents plus every leader and leader sub-agent, including their
compaction, vision and billable retry attempts. Only the manager/Admiral uses the independent
primary run budget. `runManagerWorkflow` constructs both budgets anew for every execution; neither
one is a session-lifetime accumulator. Every top-level auxiliary claim divides current headroom
across the maximum simultaneous leaders plus manager subagents. A leader holds that claim only after
semaphore admission, then each model call inside its isolated run divides the leader's headroom
across the root plus its possible subagents. Manager-child calls use the same per-call adapter
directly over the tree ledger. Unused call headroom returns at settlement, so a capless call cannot
reserve the complete tree and later calls can reuse what siblings did not spend.

Workflow leaders are auxiliary runs: the kernel forces `memory: "off"` and removes the memory
capability from their execution deps. The primary manager remains the workflow's single
memory-producing run, so one workflow produces one index job rather than one per leader.

**`max_concurrency` needs a matching supervision ceiling, and the host applies it.** A running leader
holds a live-child slot in `@clarvis/supervision`'s registry for as long as it runs, so a
concurrency above `agents.max_live_children` admits leaders the registry then refuses to register.
`managerLiveChildrenFloor(max_concurrency)` is that coupling — the kernel raises the manager run's
`agents.max_live_children` to it, keeping an operator's own higher value. At the default concurrency
it returns exactly the supervision default, so an unconfigured workspace is unaffected; the headroom
above the leaders covers each dispatch session's baton and an ad-hoc `run_leader` waiting for a
permit. Raising `max_concurrency` without it buys a longer queue and no extra parallelism.

**Manager designation is not a field here**: a run is a workflow when its entry agent profile carries
the `workflow` grant. There is no separate on/off switch, and the capability exposes **no per-run
request param** — it is constructed by the host's workflow service, never by the loop from a
run-request field.

The kernel registers `workflowsSettingsSpec` at module load, **before** any `settings.json` is read;
a block registered afterwards reads as an unrecognized key.

## What it says to an operator

Fan-out is the hardest thing in the product to debug, because failure is distributed: a stalled
manager, a leader that never started and a round that quietly selected nothing all look the same from
outside. The package therefore emits the events below through the `Logger` port it already holds on
`WorkflowCtx.deps` — it **never constructs a logger**, because one built here would write to a fixed
descriptor and bypass a TUI host's silencing.

| Level        | `event`                                                   | Says                                                                          |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| warn/debug   | `workflow.capability_inactive`                            | which topology gate refused an agent the workflow tools                       |
| info         | `workflow.dispatch_begun`                                 | a batch's width, ceiling, budget and queue                                    |
| warn         | `workflow.dispatch_refused`                               | the registry admitted none of a batch                                         |
| warn         | `workflow.leader_limit_refused`                           | a complete batch/round exceeded cumulative leader capacity                    |
| debug        | `workflow.wave_advanced`                                  | the next wave registered, and whether the baton was released                  |
| warn         | `workflow.dispatch_halted`                                | a cancellation stopped all later scheduling, and what was dropped             |
| debug / info | `workflow.capacity_wait` / `workflow.capacity_stalled`    | the deadline-free wait on a foreign child, sampled, then named once after 5 s |
| debug        | `workflow.leader_started`                                 | a leader's brief **size**, budget reservation and capability list             |
| info/warn    | `workflow.leader_settled`                                 | what the trace edge omits: output tokens and wall time                        |
| error        | `workflow.leader_faulted`                                 | a leader fault, with the stack that exists nowhere else                       |
| error        | `workflow.trace_sink_failed`                              | the durable record is missing an edge                                         |
| warn         | `workflow.budget_exhausted`                               | the tree ceiling stopped an admitted leader before model dispatch             |
| info         | `workflow.round_planned`                                  | a round's whole fan-out before it costs anything                              |
| warn         | `workflow.round_skipped`                                  | a round that never ran, and why                                               |
| debug        | `workflow.round_folded`                                   | the folded result's shape, and how many replicas missed it                    |
| debug/warn   | `workflow.schedule_derived` / `workflow.schedule_refused` | the waves, the unscoped writers, or the graph that cannot run                 |
| debug/warn   | `workflow.elicit_queued` / `workflow.elicit_skipped`      | the tree-wide prompt queue, and a prompt abandoned with its agent             |
| info         | `workflow.review_resolved`                               | the workflow preflight outcome and human wait duration                        |

A workflow preflight uses the manager run's effective `elicit_wait_ms` and a timeout also emits the
shared `capability.elicit_no_response` event. Its tool result distinguishes an explicit decline, a
dismissed review, an invalid answer and a genuine no-response timeout, so persisted context does not
collapse all four into “was not started”.

Correlation is bound coarsest-first with `bind()`: the kernel binds `component` and `workflow_id`
(`= managerRunId`, since `record.id === record.root_run_id === managerRunId`), `beginDispatch` binds
`dispatch_id` (the session's `anchorId` — two concurrent `run_round` calls in one manager turn are
otherwise indistinguishable), and each unit binds `unit_key`, `round_id`, `pass`, `item_index`,
`replica`, plus **both** `leader_run_id` and `agent_id`, because supervision's activity projection and
the persisted `workflow_run_*` edges key on different ones. A leader's own engine deps carry that
bound logger, so everything the leader run says is attributable to its wave.

Two rules a change here must not break:

- **No model-authored prose is ever a field value.** A leader brief, a work-item goal, a round result
  and a tool's arguments are logged as `*_chars` counts and shapes, never as text —
  `capability/src/sanitize.ts` covers key-shaped strings, not prose.
- **The ledger's `reserveOutput`/`settle`, `interpolate`, `selectItems`, `pathsOverlap` and
  `itemsConflict` get no log line at any level.** They run per model call per agent, or inside an
  O(n²) comparison; the bindings object is allocated before any backend sees the level, so `debug` is
  not cheap enough there.

`artifact.ts` is deliberately the one exception to "the logger is already in scope": it is a pure
filesystem loader with no run context, so an unreadable catalogue root is pushed onto
`WorkflowRegistry.errors` instead, which the kernel already logs. Before that, an unreadable root
yielded zero workflows and zero diagnostics, `buildRunWorkflowTool` then returned `null`, and
`run_workflow` **vanished from the tool list** with nothing anywhere saying why. A _missing_ root
stays silent — that is the ordinary case.

There is no logging field in the `workflows:` settings block, and there will not be one: it is
`.strict()` and registered before `settings.json` is read. Verbosity is environment- and CLI-only
(`CLARVIS_LOG_LEVEL`, `CLARVIS_LOG=workflows=debug`). See [`specs/cross-cutting/observability.md`](../../specs/cross-cutting/observability.md).

## Where the rest lives

`WorkflowCtx` — the tree-wide semaphore, token `WorkflowLedger`, cumulative `WorkflowLeaderCount`,
leader-request assembler, elicit mux, sequence-state callback and narrow `WorkflowRunDeps`
execution port — is built by the kernel in
`packages/kernel/src/workflows/workflows-service.ts`. The kernel binds that port to the loop's real
`executeRun` and `generateExecutionId`; tests bind a per-context fake instead of replacing the
process-wide loop module.

The only engine adapter this package consumes from `@clarvis/loop/workflows` is
`createElicitSerializer`. Agent, run, tool, compute-clock, trace and elicitation contracts come
directly from `@clarvis/capability`; they are not consumed through loop re-exports. The child
registry both this package and `delegate_task` register into is `@clarvis/supervision`; it was
extracted precisely so this package would stop reaching into a loop internal.

## Test ownership

The suite is classified by its primary effect boundary:

- `tests/unit/` owns the complete pure matrices: interpolation and placeholders, ledger accounting,
  round selection/filtering/acceptance/repetition, work-item scheduling and conflicts, result
  schemas, work-item parsing/brief construction, tool/catalogue construction, workflow cost
  explanation, and persisted trace projection/narrowing.
- `tests/component/` owns workflow orchestration over real package internals with per-context fakes
  for `WorkflowRunDeps`: capability activation, `run_leader`, `run_work_items`, `run_round` and
  `run_workflow`. Those cases prove representative composition, argument/result propagation, ledger
  and registry reservation, cumulative admission, Admiral checkpoints/CAS decisions, failure
  propagation, and the load-bearing wave baton; they do not replay
  the pure selector, acceptance, repetition or conflict matrices.
  Component workflow definitions come from `tests/helpers/definitions.ts`; `unit/builtin-workflows.test.ts`
  owns the shipped catalogue and override-resolution contract.
- `tests/contract/` owns the concurrency and elicitation drivers: semaphore ordering/cancellation
  and tree-wide prompt serialization/cancellation.
- `tests/integration/` owns real-effect and cross-package seams. `artifact.test.ts` exercises the
  optional filesystem override loader; `downstream-capability.test.ts` proves the public capability-extension seam against
  `@clarvis/loop/host`.
- `tests/helpers/` contains typed, per-context execution and registry fakes plus local authored
  workflow definitions. Helpers are not test entrypoints and own no behavior matrix.

The default `test` and `test:coverage` commands run all four tiers in one isolated Bun invocation,
so classification preserves the supported suite and its LCOV inventory. Each tier also has a
targeted `test:<level>` command.

Bun 1.4 attributes a separate LCOV line to a multiline `catch` token even when the handler body is
exercised. The two defensive directory-read guards in `artifact.ts` therefore keep each `try` and
handler on one source line; this preserves the 100% source-line floor without removing either fault
path or weakening the package threshold.

## Development

```bash
bun --filter @clarvis/workflows build
bun --filter @clarvis/workflows typecheck
bun --filter @clarvis/workflows test
bun --filter @clarvis/workflows lint
bun --filter @clarvis/workflows format:check
```

The package requires Bun 1.4.0 or newer.
