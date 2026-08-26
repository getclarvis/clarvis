# Token/iteration budgets, compute clocks, admission control and convergence guards

> Implemented at
> `packages/loop/src/runtime/{budget,guards,usage,usage-accounting,extension-admission}*` and
> `packages/capability/src/{compute-clock,output-budget,extension-admission,semaphore,convergence-guards}.ts`.
> Every claim below is anchored to a file and line. Open questions are collected in the final
> section.

## 1. Purpose

This subsystem is the run's set of self-defence mechanisms: the things that keep one run, or a tree of
runs, from consuming unbounded tokens, iterations, wall time, or host resources, and from looping
forever without making progress.

It is five largely independent mechanisms that happen to compose at the same seam (one agent's
iteration):

- A **hard/soft token-and-iteration budget** (`packages/loop/src/runtime/budget/*`): a shared
  `TokenLedger` capping net token spend across a whole run tree, a per-agent `IterationCounter`, and an
  optional escalation path (`SoftBudget`) that asks a human before a crossed checkpoint becomes fatal.
- A **compute clock** (`packages/capability/src/compute-clock.ts`): a pausable wall-clock timeout that
  only counts down while the run is actually doing work, so a human approval or elicitation does not
  burn the run's `timeout_ms`.
- A **shared output-token ceiling** (`packages/capability/src/output-budget.ts`, exercised by
  `packages/loop/src/runtime/loop/output-budget.ts`): a concurrency-safe reservation object that closes
  the check-then-call race between agents that might call a provider concurrently, with a settlement
  rule for what a *failed* call is billed.
- **Physical extension admission** (`packages/capability/src/extension-admission.ts`,
  `packages/loop/src/runtime/extension-admission.ts`): a process-wide ceiling on how many capability
  callbacks (hooks, `seedBlock`, `finalizeRun`, …) may be physically in flight at once, independent of
  any per-call timeout race.
- **Convergence guards** (`packages/loop/src/runtime/guards/*`,
  `packages/capability/src/convergence-guards.ts`): a doom-loop guard (repeated/consecutive tool
  failures) and a stagnation guard (an unproductive but non-failing loop), each with a soft warning tier
  before it trips, and an optional human escalation before a trip is treated as fatal.

None of these five talk to each other directly; they are folded into one agent's iteration by
`runAgent` (`packages/loop/src/runtime/loop/run-agent.ts`) and the iteration driver
(`packages/loop/src/runtime/loop/loop.ts`), which is documented here only at the seam — the driver
itself belongs to [loop-run-lifecycle](loop-run-lifecycle.md).

## 2. Surface

### 2.1 `packages/loop/src/runtime/budget/*` (barrel `index.ts`)

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `TokenLedger` | interface | `remaining()`, `wouldExceed(projected)`, `consume(u: LLMUsage)`, `consumed()`, `totals(): TokenCounts` | `packages/loop/src/runtime/budget/budget.ts:24-35` |
| `createTokenLedger(maxTokens)` | factory | `(maxTokens: number) => TokenLedger` | `packages/loop/src/runtime/budget/budget.ts:43-67` |
| `IterationCounter` | interface | `start()`, `atCap()`, `count()` | `packages/loop/src/runtime/budget/budget.ts:70-77` |
| `createIterationCounter(maxIterations)` | factory | `(maxIterations: number) => IterationCounter` | `packages/loop/src/runtime/budget/budget.ts:86-99` |
| `checkLimits(counter, ledger)` | function | `=> BudgetCheckResult` (`{terminal:false}` or `{terminal:true, reason:"iterations"\|"tokens"}`) | `packages/loop/src/runtime/budget/budget.ts:110-118` |
| `CheckpointOutcome` | type | `{kind:"continue"}\|{kind:"declined"}\|{kind:"exhausted"}\|{kind:"cancelled"}` | `packages/loop/src/runtime/budget/budget-checkpoint.ts:11-12` |
| `runBudgetCheckpoint(args)` | function | one per-iteration check; soft path short-circuits hard `checkLimits` | `packages/loop/src/runtime/budget/budget-checkpoint.ts:32-62` |
| `SoftBudgetConfig` | interface | `{softTokenLimit?, softIterationLimit?, maxEscalations?}` | `packages/loop/src/runtime/budget/soft-budget.ts:11-15` |
| `SoftBudget` | interface | `crossed(usedTokens, usedIterations)`, `advance(dimension)`, `escalationsExhausted()`, `escalations()` | `packages/loop/src/runtime/budget/soft-budget.ts:28-39` |
| `createSoftBudget(config)` | factory | `=> SoftBudget \| undefined` (undefined when neither limit is set) | `packages/loop/src/runtime/budget/soft-budget.ts:48-98` |
| `buildSoftLimitAsk(elicit, clock, signal?, waitBoundMs?)` | function | `=> SoftLimitAsk` (adapts `Elicit` to the soft-budget prompt) | `packages/loop/src/runtime/budget/soft-budget.ts:141-164` |
| `evaluateSoftBudget(args)` | function | `=> Promise<SoftEvalOutcome>` (`continue`\|`declined`\|`cancelled`) | `packages/loop/src/runtime/budget/soft-budget.ts:192-243` |

The barrel is nine lines and holds no logic: three unconditional `export *` re-exports of `budget.js`,
`budget-checkpoint.js` and `soft-budget.js` (`packages/loop/src/runtime/budget/index.ts:7-9`), named in
its own module comment as the hard-limit ledger and iteration counter, the per-iteration checkpoint, and
the soft-limit escalation machinery (`packages/loop/src/runtime/budget/index.ts:1-6`). **No `src/`
module in any package imports it.** Production code reaches past it to the concrete file every time —
`checkLimits` from `budget.js` (`packages/loop/src/runtime/loop/run-agent.ts:11`), `runBudgetCheckpoint`
from `budget-checkpoint.js` (`packages/loop/src/runtime/loop/run-agent.ts:17`), `SoftBudget` and
`SoftLimitAsk` from `soft-budget.js` (`packages/loop/src/runtime/loop/loop-shared.ts:4`) — so the barrel's
only importers are this package's own suites, which use it as the single handle on the layer
(`packages/loop/tests/unit/budget.test.ts:6`, `packages/loop/tests/unit/budget-checkpoint.test.ts:7`,
`packages/loop/tests/unit/soft-budget.test.ts:7`).

### 2.2 `packages/loop/src/runtime/guards/*` (barrel `index.ts`)

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `GuardTrip` | interface | `{code:"tool_failure_loop"\|"stagnation_detected", message}` | `packages/loop/src/runtime/guards/convergence-guards.ts:9-12` |
| `GuardWarning` | interface | `{code: GuardTrip["code"], message}` | `packages/loop/src/runtime/guards/convergence-guards.ts:18-21` |
| `ConvergenceGuards` | interface | `record(sig, resultText, isError)`, `takeSoft()`, `tripped()`, `reset()` | `packages/loop/src/runtime/guards/convergence-guards.ts:27-48` |
| `createConvergenceGuards(opts?)` | factory | fans `record` out to a doom-loop guard and a stagnation guard | `packages/loop/src/runtime/guards/convergence-guards.ts:61-92` |
| `createDoomLoopGuard(opts?)` | factory | `DoomLoopGuardOptions` = `{identicalThreshold?, errorThreshold?, identicalSoft?, errorSoft?}` | `packages/loop/src/runtime/guards/doom-loop-guard.ts:24-70` |
| `createStagnationGuard(opts?)` | factory | `StagnationGuardOptions` = `{threshold?, soft?}` | `packages/loop/src/runtime/guards/stagnation-guard.ts:4-77` |
| `hashResult(text)` | function | FNV-1a 32-bit hash, `=> number` | `packages/loop/src/runtime/guards/stagnation-guard.ts`, `hashResult` |
| `GuardDecision` | type | `"continue"\|"decline"\|"no_response"` | `packages/loop/src/runtime/guards/guard-escalation.ts:19` |
| `buildGuardEscalationAsk(elicit, clock, signal?, waitBoundMs?)` | function | `=> GuardEscalationAsk` | `packages/loop/src/runtime/guards/guard-escalation.ts:38-75` |
| `escalateGuardTrip(args)` | function | `=> Promise<GuardEscalationOutcome>` (`continue`\|`declined`\|`cancelled`) | `packages/loop/src/runtime/guards/guard-escalation.ts:99-131` |

`hashResult` is applied to both the tool **result** text and the call **signature**. The stagnation
guard retains only the active signature's hash, not the raw string, so a large tool argument (for
example a big `write_file` body) does not sit in memory. A signature collision still needs the
independent result hash to collide before it can affect the consecutive streak. Production:
`createStagnationGuard` and `hashResult` in
`packages/loop/src/runtime/guards/stagnation-guard.ts`.

This barrel is twelve lines with the same shape as §2.1's: four `export *` re-exports, of
`convergence-guards.js`, `doom-loop-guard.js`, `guard-escalation.js` and `stagnation-guard.js`
(`packages/loop/src/runtime/guards/index.ts:9-12`). Its module comment states the layering the four
files make — the combined guard, its two members (doom-loop for tool failures, stagnation for identical
results), and the opt-in escalation that lets a human wave a hard trip through
(`packages/loop/src/runtime/guards/index.ts:1-8`) — which is the only place that relationship is written
down in the package rather than inferred from `createConvergenceGuards`. As with the budget barrel, no
`src/` module imports it: `run-agent.ts` takes `createConvergenceGuards` from `convergence-guards.js`
(`packages/loop/src/runtime/loop/run-agent.ts:13`) and `escalateGuardTrip` from `guard-escalation.js`
(`packages/loop/src/runtime/loop/run-agent.ts:14`), and the two member guards are imported through the
barrel only by their unit tests (`packages/loop/tests/unit/doom-loop-guard.test.ts:2`,
`packages/loop/tests/unit/stagnation-guard.test.ts:2`).

### 2.3 `packages/capability/src/compute-clock.ts`

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `ComputeClock` | interface | `race(loop)`, `pause()`, `resume()`, `enter()`, `leave()`, `pauseCompute()`, `enterBackground()`, `poke()` | `packages/capability/src/compute-clock.ts:20-45` |
| `ComputeRegion` | interface | `pause(): () => void`, `leave(): void` | `packages/capability/src/compute-clock.ts:56-61` |
| `ClockHolder` | interface | `{clock?: ComputeClock, signal?: AbortSignal}` | `packages/capability/src/compute-clock.ts:65-68` |
| `createComputeClock(timeoutMs, logger?)` | factory | `=> ComputeClock`, armed immediately | `packages/capability/src/compute-clock.ts:84-239` |

### 2.4 `packages/capability/src/output-budget.ts`

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `OutputTokenReservation` | interface | `{amount, settle(used), release()}` | `packages/capability/src/output-budget.ts:11-18` |
| `OutputTokenBudget` | interface | `{remaining(), reserveOutput(requested): OutputTokenReservation \| null}` | `packages/capability/src/output-budget.ts:28-33` |

No factory lives in this file — it is vocabulary only. The one production implementation reachable
from an ordinary (non-workflow) run's capability contribution is `WorkflowLedger`
(`packages/workflows/src/ledger.ts:42-64`, owned by [workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md)); an ordinary run
that never carries the workflow grant contributes no `outputBudget` at all (§4.4, §7).

`packages/loop/src/runtime/loop/output-budget.ts` (not literally under `runtime/budget/`, but the file
this document's scope description names explicitly as owning "the reserve/release rule keyed on
`streamStarted`"):

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `OutputBudgetExhaustedError` | class | thrown pre-call when there is no headroom | `packages/loop/src/runtime/loop/output-budget.ts:10-15` |
| `withOutputTokenBudget(llm, budget)` | function | `=> LLMProvider`, wraps every `.call` with a reservation | `packages/loop/src/runtime/loop/output-budget.ts:67-138` |

### 2.5 `packages/capability/src/extension-admission.ts`

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `DEFAULT_MAX_ACTIVE_EXTENSION_CALLS` | const | `32` | `packages/capability/src/extension-admission.ts:6` |
| `DEFAULT_MAX_ACTIVE_EXTENSION_RUN_END_CALLS` | const | `8` | `packages/capability/src/extension-admission.ts:8` |
| `DEFAULT_MAX_ACTIVE_EXTENSION_CALLS_PER_OPERATION` | const | `4` | `packages/capability/src/extension-admission.ts:10` |
| `ExtensionCallClass` | type | `"normal"\|"run_end"` | `packages/capability/src/extension-admission.ts:12` |
| `ExtensionCallUnavailableReason` | type | `"operation_busy"\|"capacity_full"\|"closed"` | `packages/capability/src/extension-admission.ts:13` |
| `ExtensionAdmissionSnapshot` | interface | `{state, active, activeNormal, activeRunEnd, maxActiveNormal, maxActiveRunEnd, maxActivePerOperation}` | `packages/capability/src/extension-admission.ts:15-23` |
| `ExtensionAdmissionOptions` | interface | `{maxActiveNormal?, maxActiveRunEnd?, maxActivePerOperation?, onStateChange?, logger?}` | `packages/capability/src/extension-admission.ts:25-39` |
| `ExtensionCallUnavailableError` | class | `(operation, reason)`, `.name === "ExtensionCallUnavailableError"` | `packages/capability/src/extension-admission.ts:41-56` |
| `ExtensionAdmissionController` | class | `.snapshot()`, `.close()`, `.call(operation, callClass, invoke)` | `packages/capability/src/extension-admission.ts:76-217` |
| `createExtensionAdmissionController(options?)` | factory | `=> ExtensionAdmissionController` | `packages/capability/src/extension-admission.ts:219-223` |

`packages/loop/src/runtime/extension-admission.ts` (the loop-side binding):

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `admittedRunCapability(capabilityName, activated, admission, logger?)` | function | wraps every lifecycle hook + `seedBlock`/`onRunEnd`/`finalizeRun` of one `RunCapability` in admission calls | `packages/loop/src/runtime/extension-admission.ts:122-180` |
| `isExtensionAdmissionRefusal(error)` | type guard | `=> error is ExtensionCallUnavailableError` | `packages/loop/src/runtime/extension-admission.ts:182-186` |
| `capabilityActivationOperation(name)` | function | `=> \`capability:${name}:forRun\`` | `packages/loop/src/runtime/extension-admission.ts:188-190` |

### 2.6 `packages/capability/src/semaphore.ts`

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `Semaphore` | interface | `acquire(signal?): Promise<void>`, `release(): void` | `packages/capability/src/semaphore.ts:9-25` |
| `createSemaphore(limit)` | factory | `=> Semaphore`, FIFO, `limit` coerced to `max(1, floor(limit))` | `packages/capability/src/semaphore.ts:39-79` |

Two independent bounds are built over this one factory: `packages/loop/src/runtime/orchestrator.ts:591`
(`createSemaphore(deps.env.CLARVIS_MAX_PARALLEL_SUBAGENTS)`, the run's `delegate_task` fan-out limit —
consumed in `packages/loop/src/runtime/delegation.ts`, owned by [loop-delegation-and-subagents](delegation-and-subagents.md)) and the
workflow leader-concurrency semaphore (`packages/workflows/src/*`, owned by
[workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md)).

### 2.7 `packages/capability/src/convergence-guards.ts`

Types only — the guard implementations stay in `@clarvis/loop` (`packages/capability/src/convergence-guards.ts:1-5`):
`GuardTrip`, `GuardWarning`, `ConvergenceGuards` (`packages/capability/src/convergence-guards.ts:7-51`), structurally identical
to their loop-side counterparts in §2.2.

### 2.8 Environment variables consumed by this subsystem

All defined in `packages/capability/src/env.ts`; validation of the *request* fields against these
ceilings (`enforceEnvCeilings`, `enforceBudgetMode`) belongs to [loop-request-and-settings-schema](request-and-settings-schema.md) and
is only cited here as the wiring that reaches this subsystem's constructors.

| Variable | Default | File:line | Consumed by |
|---|---|---|---|
| `CLARVIS_TOKEN_CEILING` | `200_000_000` | `packages/capability/src/env.ts:57` | request-validation ceiling on `total_token_limit` |
| `CLARVIS_ITERATION_CEILING` | `100` | `packages/capability/src/env.ts:58` | request-validation ceiling on `iteration_limit` |
| `CLARVIS_TIMEOUT_CEILING_MS` | `600000` (max `2_147_483_647`) | `packages/capability/src/env.ts:59` | ceiling on `budget.timeout_ms` / `call_timeout_ms` |
| `CLARVIS_ESCALATION_CEILING` | `20` | `packages/capability/src/env.ts:60` | ceiling on `budget.max_escalations` |
| `CLARVIS_DEFAULT_TIMEOUT_MS` | `300000` | `packages/capability/src/env.ts:64` | `resolveConfig`'s `timeout_ms` fallback (`packages/loop/src/runtime/run-shape.ts:21`), which seeds `createComputeClock` |
| `CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT` | `40_000_000` | `packages/capability/src/env.ts:65` | request-validation default |
| `CLARVIS_DEFAULT_MAX_ESCALATIONS` | `5` | `packages/capability/src/env.ts:67` | `SoftBudget`'s `maxEscalations` fallback (`packages/loop/src/runtime/entry-inputs.ts:141`) |
| `CLARVIS_DEFAULT_ELICIT_WAIT_MS` | `1_800_000` | `packages/capability/src/env.ts:68` | wait bound passed to `buildSoftLimitAsk`/`buildGuardEscalationAsk` |
| `CLARVIS_DEFAULT_ITERATION_LIMIT` | `50` | `packages/capability/src/env.ts:69` | `IterationCounter` cap fallback |
| `CLARVIS_DEFAULT_STAGNATION_THRESHOLD` | `3` | `packages/capability/src/env.ts:71` | `createStagnationGuard`'s hard `threshold` fallback |
| `CLARVIS_DEFAULT_STAGNATION_SOFT_THRESHOLD` | `2` | `packages/capability/src/env.ts:77` | `createStagnationGuard`'s `soft` fallback |
| `CLARVIS_GUARD_MAX_ESCALATIONS` | `2` | `packages/capability/src/env.ts:95` (doc `packages/capability/src/env.ts:78-94`) | `escalateGuardTrip`'s `maxEscalations`, deliberately separate from `CLARVIS_DEFAULT_MAX_ESCALATIONS` (comment, `packages/capability/src/env.ts:82-85`) |
| `CLARVIS_MAX_PARALLEL_SUBAGENTS` | `4` | `packages/capability/src/env.ts:199` | the `delegate_task` fan-out `Semaphore` (`packages/loop/src/runtime/orchestrator.ts:591`) |
| `CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS` | `32` | `packages/capability/src/env.ts:167` (referenced `126-128`) | `ExtensionAdmissionController.maxActiveNormal` fallback |
| `CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS` | `8` | `packages/capability/src/env.ts:168` | `.maxActiveRunEnd` fallback |
| `CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION` | `4` | `packages/capability/src/env.ts:169` | `.maxActivePerOperation` fallback |
| `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS` | `5000` (max `60000`) | `packages/capability/src/env.ts:153` | the wall bound wrapping `capability.forRun` in `orchestrator.ts`, independent of admission |
| `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` | `2000` | `packages/capability/src/env.ts:165` | the shorter wall bound for run-end capability work |

### 2.9 Request fields this subsystem is configured from

Owned and validated by [loop-request-and-settings-schema](request-and-settings-schema.md); listed here only as the inputs this
subsystem's constructors read.

| Field | Shape | File:line | Feeds |
|---|---|---|---|
| `budget.on_exceed` | `"stop"\|"escalate"` | `packages/loop/src/validation/request/request-schema.ts:98-105` | selects hard vs. soft mode (`packages/loop/src/runtime/run-shape.ts:23-26`, `deriveRequestShape`) |
| `budget.total_token_limit` | positive int, optional | `packages/loop/src/validation/request/request-schema.ts:106-116` | `TokenLedger` cap (hard mode) or `SoftBudget.softTokenLimit` (soft mode) |
| `budget.timeout_ms` | positive int, optional | `packages/loop/src/validation/request/request-schema.ts:117-121` | `createComputeClock`'s `timeoutMs` |
| `budget.max_escalations` | positive int, optional | `packages/loop/src/validation/request/request-schema.ts:122-127` | `SoftBudget.maxEscalations` |
| `profiles[].iteration_limit` | non-negative int | `profile-schemas.ts:~195` | per-agent `IterationCounter` cap |
| `profiles[].stagnation_threshold` | non-negative int, optional | `packages/loop/src/validation/request/profile-schemas.ts:197`, `packages/capability/src/api.ts:331` | `createStagnationGuard`'s hard `threshold` (per-profile override) |
| `guard_escalation` | boolean, optional | `packages/loop/src/validation/request/request-schema.ts:215-217`, `packages/capability/src/api.ts:405` | whether `escalateGuardTrip`'s `ask` is wired at all (`packages/loop/src/runtime/entry-inputs.ts:259-262`) |

> `packages/loop/src/validation` holds **two** files both named `request-schema.ts`: the barrel at
> `packages/loop/src/validation/request-schema.ts` (50 lines, only re-exports, and does not itself
> contain `on_exceed`/`total_token_limit`/`guard_escalation`) and the one actually defining
> `budgetSchema` and the request-level fields above, `packages/loop/src/validation/request/request-schema.ts`
> — every citation in this table uses the full path to keep the two apart.

### 2.10 `packages/loop/src/runtime/usage.ts`

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `addUsage(acc, usage)` | function | folds one call's `LLMUsage` into a `TokenAccumulator` in place | `packages/loop/src/runtime/usage.ts:11-16` |
| `accumulateSubagentUsage(byModel, modelRef, delta)` | function | adds one finished sub-agent's totals into the per-model `SubagentAggregate` map, bumping `instances` by exactly 1 per call | `packages/loop/src/runtime/usage.ts:28-44` |
| `perAgentFromAggregate(model, agg)` | function | projects a `SubagentAggregate` into a `type: "subagent"` `PerAgentUsage` row | `packages/loop/src/runtime/usage.ts:54-65` |
| `LeadSubagentUsageInput` | interface | `{leadModel, primarySubagentModel, leadUsage, leadIterations, subagentsByModel, elapsedMs, warnings?, vision?}` | `packages/loop/src/runtime/usage.ts:75-85` |
| `VisionUsage` | interface | `{model, tokens: TokenAccumulator}` — the vision pre-pass's spend | `packages/loop/src/runtime/usage.ts:88-91` |
| `perAgentFromVision(vision)` | function | projects a `VisionUsage` into a `type: "vision"` `PerAgentUsage` row | `packages/loop/src/runtime/usage.ts:94-103` |
| `finalizeLeadSubagentUsage(input)` | function | assembles a lead run's full `Usage`: one `lead` row, one `subagent` row per model (or a zeroed placeholder when none ran), plus an optional `vision` row | `packages/loop/src/runtime/usage.ts:119-162` |
| `finalizeUsage(raw, model, elapsedMs)` | function | assembles a non-lead (single-agent) run's `Usage`: one `subagent` row for the entry model | `packages/loop/src/runtime/usage.ts:176-190` |

### 2.11 `packages/loop/src/runtime/usage-accounting.ts`

| Export | Kind | Signature / shape | File:line |
|---|---|---|---|
| `UsageAccounting` | interface | `{entryUsage, counter, subagentAggByModel, warnings, vision: {current?}, finalize()}` — the run's whole mutable usage-tracking surface | `packages/loop/src/runtime/usage-accounting.ts:25-40` |
| `createUsageAccounting(a)` | factory | `(a: {shape, deps, entryMax, startedAt}) => UsageAccounting` | `packages/loop/src/runtime/usage-accounting.ts:79-121` |

## 3. Data and formats

### 3.1 `TokenCounts` / ledger arithmetic

`TokenLedger.totals()` returns `{input, output, cached, cache_write}` (`packages/loop/src/runtime/budget/budget.ts:63-65`), accumulated
verbatim from every `LLMUsage` folded in (`packages/loop/src/runtime/budget/budget.ts:56-61`). `consumed()` is
`max(0, input - cached) + output` (`packages/loop/src/runtime/budget/budget.ts:48`) — cache **writes** are tracked in `totals()` but never
added to or subtracted from `consumed()`; cache **reads** (`cached`) are subtracted back out. Example
(`packages/loop/tests/unit/budget.test.ts:21-26`): consuming `{input:800, output:10, cached:800, cache_write:0}` against a
1000-token cap leaves `consumed()===10`, `remaining()===990`.

### 3.2 Trace entries this subsystem records (`packages/capability/src/trace-kinds.ts`)

| Kind | Detail shape | File:line | Recorded from |
|---|---|---|---|
| `budget_check` | `{tokens_used, tokens_remaining}` | `packages/capability/src/trace-kinds.ts:247-249` | `runBudgetCheckpoint` (hard path, `packages/loop/src/runtime/budget/budget-checkpoint.ts:56-60`) and the pre-loop check (`packages/loop/src/runtime/loop/run-agent.ts:341-345`) |
| `soft_limit_check` | `{agent, dimension, used, limit, outcome, new_checkpoint?, escalations}` | `packages/capability/src/trace-kinds.ts:371-378` | `evaluateSoftBudget` (`packages/loop/src/runtime/budget/soft-budget.ts:212-241`) |
| `convergence_warning` | `{agent, subagent_instance_id?, code, message}` | `packages/capability/src/trace-kinds.ts:500-505` | the iteration driver after each soft-tier warning (`packages/loop/src/runtime/loop/loop.ts:1021-1028`) |
| `guard_escalation` | `{agent, subagent_instance_id?, code, outcome, escalations}` | `packages/capability/src/trace-kinds.ts:514-520` | `run-agent.ts`'s `onGuardTrip` (`packages/loop/src/runtime/loop/run-agent.ts:242-249`) |
| `terminate` | `unknown` (observed `{reason: string}`) | `packages/capability/src/trace-kinds.ts:631` | multiple call sites, incl. `packages/loop/src/runtime/loop/run-agent.ts:349` and `:590` (no_progress), `packages/loop/src/runtime/loop/loop.ts:1047` (`trip.code`) |

`outcome` on both `soft_limit_check` and `guard_escalation` is one of
`"continued"|"declined"|"no_response"|"escalations_exhausted"` (`packages/capability/src/trace-kinds.ts:376,519`) — the two
events deliberately share vocabulary (comment, `packages/capability/src/trace-kinds.ts:510-513`: "Mirrors `soft_limit_check`").

### 3.3 Run-ended classification

`GUARD_TRIP_CODES` (`packages/loop/src/runtime/run-trace.ts:26-32`) is the set of `ErrorCode`s a
terminated run's `run_ended` record classifies as `reason: "guard_trip"` rather than a plain error:
`no_progress`, `tool_failure_loop`, `stagnation_detected`, `agents_unfinished`,
`background_children_failing`, `all_tools_unavailable`, `empty_response`. Only the first three are
produced by this document's own guards; the rest are produced elsewhere (delegation, tool dispatch)
and classified by the same set.

### 3.4 `Usage` / `PerAgentUsage` (produced by `usage.ts` / `usage-accounting.ts`)

`Usage.by_agent` is an array of rows tagged `type: "lead" | "subagent" | "vision"`
(`packages/loop/src/runtime/usage.ts:126-161`). A lead row example (`packages/loop/tests/unit/usage.test.ts:23-33`):

```json
{
  "type": "lead", "model": "anthropic/claude-opus-4-5",
  "input_tokens": 150, "output_tokens": 30, "cached_tokens": 8, "cache_write_tokens": 0,
  "iterations": 5, "subagents_spawned": 3
}
```

followed by one `subagent` row per distinct model that ran, sorted by model name
(`packages/loop/src/runtime/usage.ts:150-152`); when no sub-agent ever ran, a single zeroed placeholder row for
`primarySubagentModel` is emitted instead so the shape always names the sub-agent model
(`packages/loop/src/runtime/usage.ts:137-149`, test: `packages/loop/tests/unit/usage.test.ts:75-91`). `iterations_used` is the lead's own iterations plus
every sub-agent's (`packages/loop/src/runtime/usage.ts:154`, test: `packages/loop/tests/unit/usage.test.ts:21,72`).

`UsageAccounting.warnings` is a mutable array and `UsageAccounting.vision.current` a mutable single
slot — both are appended/set **after** construction (by the loop and delegation machinery, per the
interface's own `@remarks`) and `finalize()` reads their *live* state each time it is called, so
calling `finalize()` more than once reflects whatever was appended in between
(`packages/loop/src/runtime/usage-accounting.ts:21-23,33-37,90-118`). This is directly pinned by
`packages/loop/tests/unit/usage-accounting.test.ts:22-57`, which appends the string
`"2 child agent(s) abandoned when the run finished: ag_a, ag_b"` after construction and asserts it
reaches `finalize()`'s output, on both a lead and a non-lead run.

A lead run's usage additionally carries up to two **static** warnings, attached at construction by
`collectLeadWarnings` from the spawnable sub-agent profiles: `subagent_has_no_tools` (no spawnable
profile has tools or an active built-in) and `subagent_ask_user_ignored` (a spawnable profile grants
`ask_user`, which sub-agents cannot use). Production: `packages/loop/src/runtime/usage-accounting.ts:48-58`. Test:
`packages/loop/tests/unit/usage.test.ts:93-104` pins `subagent_has_no_tools`'s presence in the finalized `Usage`.

A `type: "vision"` row (`perAgentFromVision`, `packages/loop/src/runtime/usage.ts:94-103`) reports what a vision pre-pass spent.
It is kept in `UsageAccounting.vision.current`, a mutable slot **deliberately separate** from
`subagentAggByModel`: folding it into the sub-agent aggregate previously reported a spawned sub-agent
that never existed and inflated the lead's `subagents_spawned` (`packages/loop/src/runtime/usage-accounting.ts:33-37`). The
vision row therefore contributes no iteration to `iterations_used` and no instance to
`subagents_spawned`. Test: `packages/loop/tests/integration/subagent-only-prepass-usage.test.ts:58-75` — a comment in the test calls
this out directly as "the defect this pins" — asserts the pre-pass row's `type` is `"vision"` (not
`"subagent"`), that `iterations_used` is `1` (the entry agent's own iteration, not the pre-pass), and
that the sole `subagent` row present is the entry agent, not the pre-pass.

## 4. Behavior

### 4.1 The per-iteration checkpoint order (`packages/loop/src/runtime/loop/loop.ts`)

Within one iteration of `runAgentLoop`, after a model call and tool dispatch, the fixed order is
(`packages/loop/src/runtime/loop/loop.ts:1001-1060`):

1. Fast-accept a `submit_result` if the finalize gate already takes it (`packages/loop/src/runtime/loop/loop.ts:1001-1002`).
2. Dispatch tool calls (`runDispatch`), which is where `guards.record(...)` is fed per call (delegated
   to [loop-tool-dispatch-and-results](tool-dispatch.md); call sites `packages/loop/src/runtime/tools/mcp-dispatch.ts:229`
   and `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts:95,146`).
3. `d.guards.takeSoft()` — any pending soft warnings from either guard are joined into **one**
   `[runtime: …]` note (both replace the same note kind, so a second warning does not erase the first —
   comment, `packages/loop/src/runtime/loop/loop.ts:1009-1014`) and each is separately traced as `convergence_warning`
   (`packages/loop/src/runtime/loop/loop.ts:1021-1028`).
4. `d.guards.tripped()` — if either guard has tripped, `onGuardTrip` is offered the trip; a `"continue"`
   outcome (escalation accepted) falls through to the **next** step rather than looping immediately, so
   the iteration still counts against progress and the budget checkpoint (comment, `packages/loop/src/runtime/loop/loop.ts:1031-1036`).
   Any other outcome ends the loop with `d.results.guardTrip(trip)`, or with the escalation's own
   cancellation result if the abort raced the prompt (`packages/loop/src/runtime/loop/loop.ts:1037-1048`).
5. The no-progress tracker is bumped (`d.progress.bump`); a stuck run ends here
   (`packages/loop/src/runtime/loop/loop.ts:1052-1055`).
6. `checkpoint()` — the budget checkpoint runs last in the iteration (`packages/loop/src/runtime/loop/loop.ts:1059-1060`), via
   `runBudgetCheckpoint` (`packages/loop/src/runtime/loop/run-agent.ts:261-274`).

An `OutputBudgetExhaustedError` thrown from inside the model call is caught immediately around the model
call itself (`packages/loop/src/runtime/loop/loop.ts:942-945`) and again around the whole iteration loop (`packages/loop/src/runtime/loop/loop.ts:1063`), both
converting it to `d.results.budgetExhausted()` rather than letting it propagate as an ordinary thrown
error.

### 4.2 `runAgent` setup (`packages/loop/src/runtime/loop/run-agent.ts`)

`runAgent` (`packages/loop/src/runtime/loop/run-agent.ts:123-...`) builds, once per agent run:

- `guards = createConvergenceGuards({stagnationThreshold, stagnationSoftThreshold})`
  (`packages/loop/src/runtime/loop/run-agent.ts:150-157`), from the per-profile `stagnation_threshold` request field and the env
  soft-tier default.
- `checkpoint` — a closure over `runBudgetCheckpoint` bound to the shared `budget.ledger`/`counter` and
  the run's `softBudget`/`softLimitAsk` if in soft mode (`packages/loop/src/runtime/loop/run-agent.ts:261-274`).
- `onGuardTrip` — a closure over `escalateGuardTrip`, only wired into the loop driver's options when
  both `guardAsk !== undefined` **and** `guardMaxEscalations > 0` (`packages/loop/src/runtime/loop/run-agent.ts:514`); otherwise a trip
  is unconditionally terminal.
- A **pre-loop** check (`packages/loop/src/runtime/loop/run-agent.ts:339-345`): `checkLimits(budget.counter, budget.ledger).terminal ||
  (folded.outputBudget?.remaining() ?? 1) < 1` returns `budgetStop("exhausted")` before the loop issues
  even one model call — the hard ledger/counter check and the (optional) output-token headroom check
  are evaluated together at this single gate.
- If a capability contribution supplied an `outputBudget`, the entry agent's `LLMProvider` is wrapped
  with `withOutputTokenBudget` (`packages/loop/src/runtime/loop/run-agent.ts:494-501`); otherwise the raw provider is used unmodified
  and the output-budget mechanism never engages for that agent (§4.4).

### 4.3 Wiring the request into these objects (`packages/loop/src/runtime/entry-inputs.ts`, owned by
[loop-run-lifecycle](loop-run-lifecycle.md) — cited here only as the construction site)

- A single `TokenLedger` is created once **per run** (`packages/loop/src/runtime/orchestrator.ts:585`,
  `createTokenLedger(config.max_tokens)`), and `config.max_tokens` is
  `Number.POSITIVE_INFINITY` unless `on_exceed === "stop"` (`packages/loop/src/runtime/run-shape.ts:20-27`)
  — so a soft-mode ("escalate") run has an unbounded hard ledger and relies entirely on `SoftBudget` to
  ever stop. This one ledger is shared by the lead **and every sub-agent it spawns**
  (`packages/loop/src/runtime/entry-inputs.ts:186` threads the same `ledger` into `createDelegationRunCapability`), so the
  hard cap (when set) bounds the whole tree's token spend, not one agent's.
- **The lead's own iteration-cap formula differs textually across hard/soft mode, but this is not a
  behavioral inversion — the hard-mode branch is unreachable through any real run.** `entryMax` for a
  lead is `entryResolved.iterationLimit ?? Number.POSITIVE_INFINITY` in **hard** mode
  (`on_exceed: "stop"`) and `entryResolved.iterationLimit ?? deps.env.CLARVIS_DEFAULT_ITERATION_LIMIT`
  in **soft** mode (`packages/loop/src/runtime/orchestrator.ts:586-590`). `runOrchestrator` has exactly
  one production call site — `executeRun` (`packages/loop/src/runtime/execute-run.ts:380`), always
  downstream of `validateBody` (`execute-run.ts:314`) — and `enforceBudgetMode` requires an
  `iteration_limit` on every "running agent" whenever `on_exceed === "stop"`: `runningAgents` is
  `isLead ? [entry, ...spawnable] : [entry]`, so **the entry is included unconditionally, lead or not**
  (`packages/loop/src/validation/request/budget-rules.ts:10`), and the loop at
  `budget-rules.ts:20-27` throws `invalid_iteration_limit` the moment any of them lacks one. A request
  therefore never reaches `runOrchestrator` with `on_exceed: "stop"` and an entry `iteration_limit` left
  unset — `packages/loop/tests/unit/request-budget-rules.test.ts:29-34` pins this for a plain entry, and
  `:55-61` pins the parallel requirement on a lead's spawnable profiles; the check itself
  (`budget-rules.ts:10`) makes no distinction between a lead entry and any other, so the same throw
  covers a lead's own missing `iteration_limit` too. So for every hard-mode lead that actually runs,
  `entryResolved.iterationLimit` is always defined, `entryMax` always resolves to that value, and the
  `?? Number.POSITIVE_INFINITY` fallback never fires — a hard-mode lead is never left with no iteration
  cap. **This invariant is owned by `request-and-settings-schema.md` §4.4**; that is the document to
  consult for the validation rule, this one only for how the resulting `entryMax` is used. The fallback
  is reachable at all only by calling `runOrchestrator` directly, skipping `validateBody` — the three
  test files that do so
  (`packages/loop/tests/integration/orchestrator.test.ts`,
  `packages/loop/tests/integration/soft-default-iteration-limit.test.ts`,
  `packages/loop/tests/component/lifecycle-observers-wiring.test.ts`) are the only call sites outside
  `execute-run.ts:398` in the whole tree. But even there, no test constructs a hard-mode
  (`on_exceed: "stop"`) profile with `iteration_limit` left unset: `orchestrator.test.ts` and
  `lifecycle-observers-wiring.test.ts` set an explicit `iteration_limit` on every profile in every hard-
  mode request they build, and `soft-default-iteration-limit.test.ts` exercises the *soft*-mode default
  (`CLARVIS_DEFAULT_ITERATION_LIMIT`) only. So the `Infinity` branch is untested as well as unreached in
  production; it should be read as defensive code for an input shape validation already forecloses, not
  as a documented behavior.

  The soft-mode default cap is moot for an unrelated reason: per INV-4 the checkpoint always takes the
  soft path and never enforces it, which is what the runtime note's `"unbounded"` reporting under
  `softMode` reflects (`packages/loop/src/runtime/subagents/build-lead-input.ts:63-72`,
  `packages/loop/tests/integration/orchestrator.test.ts:631-670`) — a soft-mode property, not evidence
  of an uncapped hard-mode lead. A non-lead entry always resolves through `resolveIterationCap`
  (`packages/loop/src/runtime/orchestrator.ts:590`,
  `packages/loop/src/runtime/subagents/subagent-profiles.ts:67-72`), which never substitutes `Infinity`
  either.
- Each agent (lead, and separately each delegated sub-agent instance) gets its **own**
  `IterationCounter` (`orchestrator.ts` via `createUsageAccounting` →
  `packages/loop/src/runtime/usage-accounting.ts:89`; `packages/loop/src/runtime/subagents/run-subagent.ts:149`).
- `buildFinalizerSoftBudget` (`packages/loop/src/runtime/entry-inputs.ts:128-146`) builds the entry agent's `SoftBudget` only in
  soft mode, from `request.budget.total_token_limit` and the resolved iteration limit, requiring
  `deps.elicit` to be present (asserted with `!` at `packages/loop/src/runtime/entry-inputs.ts:146`).
- `request.guard_escalation === true && deps.elicit !== undefined` is the sole gate for wiring
  `guardEscalationAsk`/`guardMaxEscalations` at all (`packages/loop/src/runtime/entry-inputs.ts:259-262`); its absence means a
  guard trip is unconditionally terminal regardless of `CLARVIS_GUARD_MAX_ESCALATIONS`.

### 4.4 The output-token reservation (`packages/loop/src/runtime/loop/output-budget.ts`)

`withOutputTokenBudget(llm, budget)` wraps every `.call`:

1. If `budget.remaining() === Infinity` (unbounded), the call runs unmodified and any usage or
   accumulated/partial failure usage is folded back into the budget only for bookkeeping — no
   `OutputBudgetExhaustedError` is possible on this path (`packages/loop/src/runtime/loop/output-budget.ts:70-86`).
2. Otherwise: if `remaining() < 1`, throw `OutputBudgetExhaustedError` immediately
   (`packages/loop/src/runtime/loop/output-budget.ts:87`). Else compute `requested = min(remaining, desiredPerAttempt *
   configuredAttempts)` (`packages/loop/src/runtime/loop/output-budget.ts:89-95`), reserve it, and if the granted `reservation.amount <
   1`, release and throw the same error (`packages/loop/src/runtime/loop/output-budget.ts:96-100`).
3. The outgoing call is rebuilt with `maxOutputTokens = perAttempt` and `maxRetries = attempts - 1`
   explicitly set (`packages/loop/src/runtime/loop/output-budget.ts:102-111`) — so an inner retry decorator can never apply an unseen
   default and silently escape the reservation (comment, `packages/loop/src/runtime/loop/output-budget.ts:63-66`).
4. On success, `reservation.settle(outputUsed(result))` — the sum of the winning attempt's and any
   retried attempt's `output_tokens` (`packages/loop/src/runtime/loop/output-budget.ts:22-26,115`).
5. On failure, in order:
   - real accumulated/partial usage present on the `ProviderError` → settle exactly that amount
     (`packages/loop/src/runtime/loop/output-budget.ts:118-124`);
   - else `producedNoBillableOutput(err)` — `!streamStarted && no accumulatedUsage && no
     partialUsage` (`packages/loop/src/runtime/loop/output-budget.ts:49-56`) → release the whole reservation, charging nothing
     (`packages/loop/src/runtime/loop/output-budget.ts:125-126`);
   - else (streaming had genuinely begun, or an error the provider layer never classified at all) →
     settle the **entire** reservation (`packages/loop/src/runtime/loop/output-budget.ts:127-133`), because this is "the genuinely
     uncertain case" (comment, `packages/loop/src/runtime/loop/output-budget.ts:128-131`).

### 4.5 The run timeout / `ComputeClock` interaction

`runWithClockAndTimeout` (`packages/loop/src/runtime/run-timeout.ts:66-155`, owned by
[loop-run-lifecycle](loop-run-lifecycle.md), cited here for the clock contract it exercises):

1. Creates one `ComputeClock` from `config.timeout_ms` (`packages/loop/src/runtime/run-timeout.ts:78`), armed immediately.
2. Races the built loop promise against the clock (`clock.race(observedLoop)`, `packages/loop/src/runtime/run-timeout.ts:102`) —
   `ComputeClock.race` is single-shot (§5, INV-13).
3. On a timeout winner, aborts an internal `AbortController`, gives the loop `settleGraceMs` to unwind,
   and detaches (rather than awaits) a non-cooperative teardown past the grace, logging
   `run.teardown_detached` (`packages/loop/src/runtime/run-timeout.ts:103-120`).
4. The clock is **poked** — its remaining budget reset to the full `timeoutMs` — on every trace entry
   via `traceBridge` (`packages/loop/src/runtime/run-trace.ts:138-149`, `clockHolder.clock?.poke()` at
   line 149), on every sub-agent registry activity event
   (`packages/loop/src/runtime/orchestrator.ts:210`, `onActivity: () => clockHolder.clock?.poke()`), and
   on every model-call retry (`packages/loop/src/runtime/loop/loop.ts:422`, inside `onRetry`). So
   `timeout_ms` measures **inactivity**, not run wall time (comment, `packages/loop/src/runtime/run-timeout.ts:44-46`): a run that
   keeps producing trace entries, sub-agent activity, or retries never trips it, however long it runs.
5. `soft-budget.ts`'s `buildSoftLimitAsk` and `guard-escalation.ts`'s `buildGuardEscalationAsk` both
   bracket their human wait in `clock.pause()`/`clock.resume()` — **not** `pauseCompute()`/release,
   which is a distinct mechanism for claiming an active *compute region* rather than a plain pause
   (`packages/loop/src/runtime/capabilities/agents.ts:319-324` states explicitly why `await_agents`'s own wait uses `pause()` for the same
   reason: `pauseCompute` would wrongly claim the region belonging to a still-spending background
   child). Both adapters reach the wait through the one shared helper,
   `elicitWithClockPause` (`packages/capability/src/elicit.ts:126-155` — `clock.pause()` at line 127,
   `clock.resume()` in its `finally` at line 141), via
   `packages/loop/src/runtime/tools/ask-user-tool.ts`'s re-export (`packages/loop/src/runtime/budget/soft-budget.ts:141-164`,
   `packages/loop/src/runtime/guards/guard-escalation.ts:38-75`), owned by [elicitation-and-user-interaction](../cross-cutting/elicitation.md) — so time spent waiting on
   a soft-limit or guard-escalation answer does not count against the run's compute timeout, but *does*
   still count against the token/iteration ledger (it is not paused).

### 4.6 Extension admission wiring (`packages/loop/src/runtime/orchestrator.ts`)

`extensionAdmissionFor` (`packages/loop/src/runtime/extension-admission.ts:216-228`, called at `packages/loop/src/runtime/orchestrator.ts:234`) resolves one `ExtensionAdmissionController` per run
— either the caller-supplied `deps.extensionAdmission`, or a fallback memoized per `deps` object via a
`WeakMap` and constructed from the three `CLARVIS_MAX_CONCURRENT_EXTENSION_*` env vars
(`packages/loop/src/runtime/extension-admission.ts:220-225`). Every capability's activation (`capability.forRun(capabilityCtx)`) is
itself run through this same controller, under operation key
`capabilityActivationOperation(capability.name)` (`packages/loop/src/runtime/orchestrator.ts:244-251`), **and** independently
bounded by a wall-clock `boundPromise(..., {timeoutMs: setupTimeoutMs})`
(`packages/loop/src/runtime/orchestrator.ts:246-262`, `setupTimeoutMs = deps.env.CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS`) — these are
two separate ceilings (physical concurrency vs. wall time) applied to the same call. A refusal from the
admission gate is caught and turned into a `capability.extension_saturated` warning log plus `null`
activation (i.e. the capability contributes nothing this run) rather than propagating
(`packages/loop/src/runtime/orchestrator.ts:263-273`). Once activated, every capability's lifecycle hooks and `finalizeRun`/
`onRunEnd` are re-wrapped by `admittedRunCapability` (`packages/loop/src/runtime/orchestrator.ts:301`), which is what routes their
*subsequent* per-call invocations (not just the one-time `forRun`) through the same admission gate.
If an admitted `forRun` exceeds its wall timeout, the logical wait ends but the physical admission
permit remains held until the underlying invocation settles; `ExtensionAdmissionController.call`
releases permits only from the physical promise's fulfillment/rejection observer
(`packages/capability/src/extension-admission.ts:156-169`). Controllers created by
`buildExecuteRunDeps` close during that returned object's `dispose()`; caller-supplied controllers
remain caller-owned (`packages/loop/src/runtime/build-run-deps.ts:570-574`). The fallback controller
used when `runOrchestrator` is driven directly is memoized in a `WeakMap` and has no separate teardown
path (`packages/loop/src/runtime/extension-admission.ts:201-227`).

## 5. Invariants

Numbered, declarative, falsifiable. All are derived directly from this document's own source and tests.

1. **`TokenLedger.consumed()` is net-new spend**: `max(0, input − cached) + output`; `cache_write` is
   tracked in `totals()` but never added to or subtracted from `consumed()`.
   Production: `packages/loop/src/runtime/budget/budget.ts:14-23,48`. Test: `packages/loop/tests/unit/budget.test.ts:9-26` ("meters NET-NEW tokens", "a
   fully-cached re-read costs the budget nothing but its output").
2. **`checkLimits` reports `"iterations"` before `"tokens"`** when both hard limits are simultaneously
   breached, and two agents' counters sharing one ledger are independent.
   Production: `packages/loop/src/runtime/budget/budget.ts:110-118`. Test: `packages/loop/tests/unit/budget.test.ts:56-80`.
3. **An iteration cap of `0` is already at capacity** — `createIterationCounter(0).atCap() === true`
   with zero calls to `start()`. Production: `packages/loop/src/runtime/budget/budget.ts:86-99`. Test: `packages/loop/tests/unit/budget.test.ts:51-53`.
4. **`runBudgetCheckpoint` short-circuits to the soft path** whenever both `softBudget` and
   `softLimitAsk` are supplied, and only ever runs the hard `checkLimits` path otherwise — the two
   checks are mutually exclusive per call. Production: `packages/loop/src/runtime/budget/budget-checkpoint.ts:42-61`. Test: unpinned (no
   test exercises both a configured soft budget and a simultaneously-exhausted hard ledger to confirm
   the hard path never also runs; `budget-checkpoint.test.ts` only covers the cancelled-under-abort
   soft path).
5. **A soft checkpoint's cadence is fixed-interval** (`S, 2S, 3S, …`), tokens are tested before
   iterations at the same usage snapshot, and `advance` on an unset dimension is a no-op returning `0`
   without spending an escalation. Production: `packages/loop/src/runtime/budget/soft-budget.ts:57-90`. Test:
   `packages/loop/tests/unit/soft-budget.test.ts:20-42,60-66`.
6. **`escalationsExhausted()` requires `maxEscalations` to be set**; an unbounded soft budget (no
   `maxEscalations`) never exhausts, however many times it advances.
   Production: `packages/loop/src/runtime/budget/soft-budget.ts:91-93`. Test: `packages/loop/tests/unit/soft-budget.test.ts:43-57`.
7. **A crossing with escalations already exhausted declines without ever calling `softLimitAsk`**
   (records `escalations_exhausted`). Production: `packages/loop/src/runtime/budget/soft-budget.ts:212-215`. Test:
   `packages/loop/tests/unit/soft-budget.test.ts:216-244` (`asked` stays `1`, not `2`).
8. **An abort mid-ask is `cancelled`, distinct from an ordinary ask failure (`declined`/`no_response`)**:
   `evaluateSoftBudget` and `escalateGuardTrip` both check `signal?.aborted` inside their `catch` before
   falling back to `declined`. Production: `packages/loop/src/runtime/budget/soft-budget.ts:217-224`, `packages/loop/src/runtime/guards/guard-escalation.ts:115-122`. Test:
   `packages/loop/tests/unit/soft-budget.test.ts:246-279`, `packages/loop/tests/unit/guard-soft-tier.test.ts:257-289`.
9. **The doom-loop guard trips on 3 identical-signature failures in a row OR 6 consecutive failures of
   any signature** (defaults), and a single non-error result resets both streaks entirely — repeated
   *successful* identical calls never trip it. Production: `packages/loop/src/runtime/guards/doom-loop-guard.ts:70-125` (thresholds at
   `packages/loop/src/runtime/guards/doom-loop-guard.ts:1-2`). Test: `packages/loop/tests/unit/doom-loop-guard.test.ts:5-39`.
10. **Doom-loop soft tiers default to one below the identical threshold and two below the error
    threshold**, warn exactly once per streak (re-arming only after a success clears it), and `0`
    disables a tier. Production: `packages/loop/src/runtime/guards/doom-loop-guard.ts:63-64,80-90,116-128`. Test:
    `packages/loop/tests/unit/guard-soft-tier.test.ts:10-62`.
11. **`reset()` on either guard clears the trip latch AND every counter behind it** — leaving the
    latch alone (or the active stagnation observation alone) would re-trip on the very next
    observation. Production: each guard's `reset` implementation. Test:
    `packages/loop/tests/unit/guard-soft-tier.test.ts:64-77,109-119`.
12. **The stagnation guard trips only when the same call signature returns the same successful
    result `threshold` times consecutively (default 3).** A different call, changed result, or error
    resets the active streak. Re-running a clean verification after an edit is productive activity,
    even when the verification output matches an earlier pass. Production: `createStagnationGuard`
    in `packages/loop/src/runtime/guards/stagnation-guard.ts`. Test:
    `packages/loop/tests/unit/stagnation-guard.test.ts` (`"does not accumulate identical
    verification results across intervening activity"`, `"does not call an edit→test→edit→test
    workflow stagnant"`, and the back-to-back trip case).
13. **`ConvergenceGuards.tripped()` reports the doom-loop guard before stagnation** when both have
    tripped. Production: `packages/loop/src/runtime/guards/convergence-guards.ts:82-85`. Test: unpinned — no test constructs a scenario
    where both guards are simultaneously tripped and asserts which `code` `tripped()` returns. **The
    priority is reachable, not merely a theoretical tie-break**: `record()` is called once per
    dispatched tool call inside `runDispatch`'s per-call loop
    (`packages/loop/src/runtime/tools/mcp-dispatch.ts:229`, `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts:95,146`),
    while `tripped()` is queried exactly once per *iteration*, after the whole batch of that
    iteration's tool calls has been dispatched (`packages/loop/src/runtime/loop/loop.ts:1037`, reached from the single
    `runDispatch` call at `:982`). A model turn that batches several tool calls can therefore make
    *both* underlying guards latch within one iteration — e.g. three identical failing calls first
    (tripping `doom`), then three consecutive identical successful calls (tripping `stag`) — before
    `tripped()` is ever consulted. An error resets the stagnation streak and a success clears the doom
    counters, but neither operation clears a latch that already tripped. In that reachable
    case the fixed `if (doom.tripped()) … ; if (stag.tripped()) …` order
    (`packages/loop/src/runtime/guards/convergence-guards.ts:82-85`) is what decides which `code` the run terminates with — so the
    priority is load-bearing whenever it matters, even though no test exercises the scenario.
14. **`escalateGuardTrip` declines without ever calling `ask`** when `ask` is `undefined`, when
    `maxEscalations <= 0`, or when `escalations >= maxEscalations` (recording
    `escalations_exhausted`); a `"continue"` answer resets the guards and a `"decline"`/timeout answer
    leaves the trip standing. Production: `packages/loop/src/runtime/guards/guard-escalation.ts:99-131`. Test:
    `packages/loop/tests/unit/guard-soft-tier.test.ts:164-289` (six scenarios).
15. **`ComputeClock` is effectively paused only when `pauseDepth > 0` AND every active ordinary compute
    region is itself paused (`activeCompute <= computePaused`) AND every active background region is
    itself paused (`bgActive <= bgPaused`)** — a single unpaused region of either kind keeps the
    deadline armed regardless of an outstanding `pause()`. Production: `packages/capability/src/compute-clock.ts:97-98`. Test:
    `packages/capability/tests/unit/compute-clock.test.ts:73-183` (ordinary regions), `:326-413` (background regions;
    "a parent's pauseCompute cannot claim a background child's work").
16. **`ComputeClock.race` is single-shot** — a second call throws
    `"ComputeClock.race() is single-shot and was already consumed."`. Production:
    `packages/capability/src/compute-clock.ts:139-143`. Test: `packages/capability/tests/unit/compute-clock.test.ts:278-286`.
17. **`poke()` resets the remaining budget to the full original `timeoutMs` and re-arms**, but is a
    no-op once the deadline has already fired — it cannot revive a dead run. Production:
    `packages/capability/src/compute-clock.ts:232-238`. Test: `packages/capability/tests/unit/compute-clock.test.ts:204-221`.
18. **A `Semaphore`'s `limit` is coerced to `max(1, floor(limit))`**, so `0` and fractional limits both
    behave as their floored/clamped positive-integer equivalent, never as "unlimited" or "zero
    concurrency". Production: `packages/capability/src/semaphore.ts:40`. Test: `packages/capability/tests/unit/semaphore.test.ts:34-55`.
19. **A queued `acquire` whose signal aborts before a slot is granted rejects and is removed from the
    queue without ever occupying or leaking a slot**; an immediate (already-under-limit) grant always
    resolves even against an already-aborted signal. Production: `packages/capability/src/semaphore.ts:45-68`. Test:
    `packages/capability/tests/unit/semaphore.test.ts:89-135`.
20. **A `release()` with no waiter and no active holder clamps `active` at zero** rather than banking a
    credit for a future `acquire`. Production: `packages/capability/src/semaphore.ts:70-77`. Test: `packages/capability/tests/unit/semaphore.test.ts:57-69`.
21. **`ExtensionAdmissionController` enforces three independent ceilings** — `maxActiveNormal`,
    `maxActiveRunEnd` (a class each), and `maxActivePerOperation` keyed by `(callClass, operation)` —
    and checks the per-operation ceiling before the class ceiling. Production:
    `packages/capability/src/extension-admission.ts:131-149`. Test: `packages/capability/tests/unit/extension-admission.test.ts:52-95` (both packages).
22. **A permit is held until the *physical* invocation promise settles**, not until the logical
    caller stops waiting on it — an operation that never settles permanently occupies its slot up to
    `maxActivePerOperation`, bounding but not eliminating the damage of a stuck extension.
    Production: `packages/capability/src/extension-admission.ts:156-169`. Test: `extension-admission.test.ts` (capability)
    `:27-50,52-78` ("bounds iterative never-settling calls while healthy sibling operations continue").
23. **`run_end` calls have an independent capacity reserve from `normal` calls**, so cancellation and
    finalizers can still be admitted after ordinary extension work has saturated its own class.
    Production: `packages/capability/src/extension-admission.ts:145-149`. Test: `extension-admission.test.ts` (capability)
    `:80-95`.
24. **A throwing `onStateChange` observer is swallowed and logged (`capability.admission_observer_failed`)
    and never leaks the permit it was reporting on.** Production: `packages/capability/src/extension-admission.ts:204-216`.
    Test: `extension-admission.test.ts` (capability) `:121-130,172-186`.
25. **Every asynchronous extension surface of a `RunCapability` is routed through the same admission
    gate** — every `LifecycleHook` method, `seedBlock`, `onRunEnd`, `finalizeRun` — **and only
    `seedBlock` degrades gracefully on saturation**, catching `ExtensionCallUnavailableError` and
    returning `undefined` with a `capability.extension_saturated` warning; every other admitted surface
    propagates the refusal to its caller unhandled. Production: `packages/loop/src/runtime/extension-admission.ts:24-180`
    (the `seedBlock` try/catch at `:137-155` has no counterpart on any other wrapped method). Test:
    `packages/loop/tests/unit/extension-admission.test.ts:15-130` (routes every surface),
    `:132-185` ("omits a saturated seed before invocation and rethrows ordinary failures").
26. **Activation admission is keyed by the capability's stable registration *name*, not the returned
    object's identity** — so a host that constructs a fresh `RunCapability` object per run still bounces
    off the same per-operation ceiling. Production: `packages/loop/src/runtime/extension-admission.ts:114-121`
    (remark) and `capabilityActivationOperation` (`:188-190`). Test: partially pinned —
    `packages/loop/tests/unit/extension-admission.test.ts:187-192` confirms the stable key *format*
    (`capability:x:forRun`), but no test exercises reusing a fresh object across runs against the same
    controller to prove the ceiling still bites; that specific scenario is unpinned.
27. **`withOutputTokenBudget` reserves `min(remaining, desiredPerAttempt * (maxRetries+1))` and forces
    `maxRetries` explicitly onto the outgoing call**, so an inner retry decorator's own default cannot
    exceed what was reserved. **The `attempts`/`perAttempt` actually sent are then recomputed from the
    granted `reservation.amount`, not from the request**: `attempts = max(1, min(configuredAttempts,
    floor(reservation.amount)))` and `perAttempt = max(1, min(desiredPerAttempt,
    floor(reservation.amount / attempts)))` (`packages/loop/src/runtime/loop/output-budget.ts:102-106`) — so a partial grant (the
    `OutputTokenBudget.reserveOutput` interface itself documents it "may grant less than requested",
    `packages/capability/src/output-budget.ts:23`) shrinks both below what was requested; `perAttempt` does not always equal
    `desiredPerAttempt` capped only by the request. Production: `packages/loop/src/runtime/loop/output-budget.ts:89-111`. Test:
    `packages/loop/tests/unit/output-budget.test.ts:52-95`.
28. **Reservation settlement on failure has exactly three outcomes, in this priority order**: (a) real
    accumulated/partial usage present → settle that amount regardless of error kind; (b)
    `producedNoBillableOutput` (`!streamStarted && no accumulatedUsage && no partialUsage`) → release in
    full; (c) otherwise → settle (charge) the *entire* reservation. Production: `packages/loop/src/runtime/loop/output-budget.ts:49-56,
    117-134`. Test: `packages/loop/tests/unit/output-budget.test.ts:97-228` (five scenarios, including the historical-regression
    case "a rate limit does not consume a shared tree ceiling").
29. **An unbounded (`Infinity`) output budget never throws `OutputBudgetExhaustedError`** and takes a
    lighter accounting-only path that never calls `reserveOutput`. Production: `packages/loop/src/runtime/loop/output-budget.ts:69-86`.
    Test: `packages/loop/tests/unit/output-budget.test.ts:52-93` pins successful accounting, measured
    failed output, and preservation of an unmeasured failure against an unbounded budget.
30. **At most one `AgentLoopContribution` per agent may supply `outputBudget`** (also true of `anchor`
    and `forcedChoice`); `foldContributions` throws on a second. Production: `packages/capability/src/compose.ts:122-126`. Test:
    `packages/capability/tests/unit/compose.test.ts:72-74`.
31. **A run's pre-loop budget gate is a single combined check**: `checkLimits(...).terminal ||
    (folded.outputBudget?.remaining() ?? 1) < 1` — a capability-contributed output-token ceiling that
    is already exhausted stops the agent before its first model call, exactly like an exhausted hard
    ledger or iteration cap. Production: `packages/loop/src/runtime/loop/run-agent.ts:339-345`. Test: unpinned within this document's own
    suite (no `packages/loop` test constructs a pre-exhausted `outputBudget` contribution and asserts the
    pre-loop `budget_exhausted` short-circuit fires before any model call; workflow-level ceiling
    exhaustion is covered instead by [workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md)'s own tests).
32. **The compute clock is poked on every trace entry, every sub-agent registry activity event, and
    every model-call retry** — `timeout_ms` measures inactivity, not wall time. Production:
    `packages/loop/src/runtime/run-trace.ts:138-149`, `packages/loop/src/runtime/orchestrator.ts:210`,
    `packages/loop/src/runtime/loop/loop.ts:422`. Test:
    `packages/loop/tests/integration/retry-pokes-stall-clock.test.ts:13-39` (retry path only; the trace
    and agent-activity poke paths are exercised only indirectly by every passing long-running
    integration test, not by a test that isolates them).
33. **A soft-limit or guard-escalation human wait pauses the compute clock via plain `clock.pause()`/
    `clock.resume()` — never `pauseCompute()` — but does not pause the token ledger.**
    `buildSoftLimitAsk`/`buildGuardEscalationAsk` both delegate the bracketing to the shared
    `elicitWithClockPause`; nothing in either function touches `TokenLedger`/`IterationCounter`.
    Production: `packages/capability/src/elicit.ts:126-155` (`clock.pause()` at :127, `clock.resume()`
    in its `finally` at :141), `packages/loop/src/runtime/budget/soft-budget.ts:141-164`, `packages/loop/src/runtime/guards/guard-escalation.ts:38-75`. Test:
    `packages/loop/tests/unit/soft-budget.test.ts:69-91` pins the `pause`/`resume` bracketing (its own title: "brackets the wait
    in pause()/resume()") against a fake clock whose `pauseCompute` is a distinct no-op stub; no test
    independently asserts the ledger is untouched during the wait (the negative claim — that nothing
    else pauses — is unpinned).
34. **`createStagnationGuard({threshold: 0 or negative})` returns a fully inert no-op guard** —
    `record`/`takeSoft`/`tripped`/`reset` all become no-ops — a distinct *whole-guard* disable path,
    not merely "0 disables a soft tier" (which INV-10 already covers for the doom-loop guard's soft
    tiers). The doom-loop guard has no equivalent whole-guard disable. Production:
    `packages/loop/src/runtime/guards/stagnation-guard.ts:60-76` (documented in the factory's own `@remarks` at line 48). Test:
    `packages/loop/tests/integration/stagnation-subagent-profile.test.ts:73-103` (a spawned sub-agent's `stagnation_threshold: 0`
    tolerates identical results indefinitely; the describe block's own title calls this "finding 9").
35. **A convergence-guard trip is scoped to the agent it belongs to.** `createConvergenceGuards` is
    constructed fresh per `runAgent` call (`packages/loop/src/runtime/loop/run-agent.ts:150-156`), so when a delegated sub-agent's own
    guard trips, only that sub-agent's inner run terminates; the trip surfaces to the lead through
    delegation's own completion channel (`delegation_completed`/`delegation_failed` with
    `status: "error"` and a result containing `stagnation_detected`), while the lead's overall run
    status stays `"completed"`. Test: `packages/loop/tests/integration/stagnation-subagent-profile.test.ts:104-133`.
36. **Within one `DoomLoopGuard.record()` call, the identical-failure soft warning and the any-failure
    soft warning are mutually exclusive** — `identicalSoft` is tested first with an `if`, `errorSoft`
    only in the `else if`, so a call that simultaneously crosses both soft thresholds emits only the
    identical-failure warning. Production: `packages/loop/src/runtime/guards/doom-loop-guard.ts:126-138`. Test: unpinned — no test
    constructs a call crossing both soft thresholds at once to confirm only one warning is emitted.
37. **The shared hard `TokenLedger`'s overshoot across a lead and its sub-agent is bounded, not
    unbounded**, because the checkpoint that would stop the tree runs only after dispatch (§4.1 step 6)
    — a concrete, test-pinned bound is `total <= cap + 2 * (max single-call usage)` for one lead plus
    one concurrently-spending sub-agent sharing a cap of 100 with calls sized up to 50 tokens.
    Production: the checkpoint-after-dispatch ordering already cited at `packages/loop/src/runtime/loop/loop.ts:1001-1060`. Test:
    `packages/loop/tests/integration/shared-budget.test.ts:12-84` (`total > 100`, `total <= 100 + 2*50`).
38. **Only `seedBlock` among a `RunCapability`'s admitted surfaces degrades gracefully on saturation
    (INV-25); `forAgent`, `systemSection`, `order` and `guardTripCodes` are never admission-gated at
    all** — `admittedRunCapability` passes them straight through unwrapped, so a saturated admission
    controller never affects tool dispatch (which runs through `forAgent`) even though every
    `LifecycleHook` method and `seedBlock`/`onRunEnd`/`finalizeRun` are gated. Separately, a capability
    contributing multiple `LifecycleHook` objects gets an **independent** admission lane per hook, keyed
    by that hook's array index (`` `lifecycle:${hookIndex}:${method}` ``) — two hooks calling the same
    method do not share one ceiling. Production: `packages/loop/src/runtime/extension-admission.ts:16-23`
    (hook-index keying), `:153-157,174` (un-admitted surfaces).

## 6. Failure modes and degradation

| Trigger | Handling | Cite |
|---|---|---|
| Hard token or iteration cap reached (no soft budget configured) | `checkLimits` returns terminal; the checkpoint reports `budgetStop("exhausted")` → `status: "budget_exhausted"`, firing `onBudgetExhausted` lifecycle observers first | `packages/loop/src/runtime/budget/budget.ts:110-118`, `packages/loop/src/runtime/loop/run-agent.ts:198-215`; test `budget-iteration-cap.test.ts`, `budget-token-cap.test.ts` |
| Soft checkpoint crossed and the user declines / times out / gives no answer | `evaluateSoftBudget` returns `declined`; the checkpoint reports `budgetStop("declined")` → `status: "soft_limit_declined"` | `packages/loop/src/runtime/budget/budget-checkpoint.ts:52-55`, `packages/loop/src/runtime/loop/run-agent.ts:198-215` |
| Soft or guard-escalation ask throws for a reason other than the signal aborting | Treated as `no_response` → `declined`, never left hanging | `packages/loop/src/runtime/budget/soft-budget.ts:217-224`, `packages/loop/src/runtime/guards/guard-escalation.ts:115-122` |
| Guard trips with no escalation configured | Unconditionally terminal: `status: "error"`, `error.code` = the guard's own code (`tool_failure_loop`/`stagnation_detected`) | `packages/loop/src/runtime/loop/run-agent.ts:514` (no `onGuardTrip` wired), `packages/loop/src/runtime/loop/loop.ts:1047-1048`; test `packages/loop/tests/integration/guard-escalation.test.ts:85-99` |
| Guard trips, escalation configured, user declines | Same terminal outcome as above, but a `guard_escalation` trace entry records `outcome: "declined"` first | `packages/loop/tests/integration/guard-escalation.test.ts:124-134` |
| Guard escalation cap spent | Further trips decline without ever asking again | `packages/loop/src/runtime/guards/guard-escalation.ts:110-113`; test `packages/loop/tests/integration/guard-escalation.test.ts:136-153` |
| `ComputeClock` deadline fires | `runWithClockAndTimeout` returns `errorResponse(..., "timeout", ...)`; loop teardown is given `settleGraceMs` then detached (not awaited) if it does not cooperate, logging `run.teardown_detached` | `packages/loop/src/runtime/run-timeout.ts:103-120` |
| A run's loop promise rejects **after** the clock already declared `"timeout"` | The rejection is observed and logged at `debug` (`capability.compute_clock.loop_rejected`) rather than becoming an unhandled rejection | `packages/capability/src/compute-clock.ts:151-163`; test `packages/capability/tests/unit/compute-clock.test.ts:288-323` |
| Output-token budget has no headroom before a call | `OutputBudgetExhaustedError` thrown synchronously before the provider is ever called | `packages/loop/src/runtime/loop/output-budget.ts:87,96-100` |
| A model call fails after streaming had genuinely begun, or with an unclassified error carrying no usage evidence | The **entire** reservation is charged, deliberately erring toward exhausting the shared ceiling rather than under-charging an uncertain case | `packages/loop/src/runtime/loop/output-budget.ts:127-134`, comment `:128-131` |
| A model call fails with provably no billable output (`producedNoBillableOutput`) | The reservation is released in full — this is the fix for the historical 429-drains-the-tree defect | `packages/loop/src/runtime/loop/output-budget.ts:49-56,125-126`; test `packages/loop/tests/unit/output-budget.test.ts:216-228` |
| A capability's `forRun` activation exceeds `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS` | Logged as `capability.setup_timeout`; the capability contributes nothing (`activated === null`), the run proceeds without it | `packages/loop/src/runtime/orchestrator.ts:263-278` (timeout branch) |
| A capability's `forRun`/lifecycle call is refused by the extension admission gate | Logged as `capability.extension_saturated`; the activation (or, for `seedBlock` specifically, the seed) is treated as absent rather than the run failing | `packages/loop/src/runtime/orchestrator.ts:263-273` (forRun), `packages/loop/src/runtime/extension-admission.ts:142-155` (seedBlock only) |
| A `LifecycleHook` method (not `seedBlock`) is refused by the admission gate | The `ExtensionCallUnavailableError` propagates unhandled to whatever awaited that hook | `packages/loop/src/runtime/extension-admission.ts:24-111` (no catch on any of these branches); test `packages/loop/tests/unit/extension-admission.test.ts:15-130` shows every one of these is a direct passthrough with no degradation path exercised |
| A queued `Semaphore.acquire` whose caller aborts | Rejects with the abort reason (or a generic `Error("aborted")` for a non-Error reason); no slot is ever granted or leaked | `packages/capability/src/semaphore.ts:55-68`; test `packages/capability/tests/unit/semaphore.test.ts:89-135` |
| An `ExtensionAdmissionController` is `.close()`d and something calls `.call()` afterward | Throws `ExtensionCallUnavailableError` with reason `"closed"`, synchronously, before invoking anything; `close()` itself still fires `onStateChange` | `packages/capability/src/extension-admission.ts:119-123,137-139`; test `packages/capability/tests/unit/extension-admission.test.ts:107-110,158-169` (capability) |
| `ExtensionAdmissionController`'s constructor is given a non-positive-integer ceiling, or `.call()` is given an empty operation name | Both throw `TypeError` synchronously (constructor: `maxActiveNormal`/`maxActiveRunEnd`/`maxActivePerOperation` validated by a shared `positiveInteger` helper; `.call`: `"operation must be non-empty."`) | `packages/capability/src/extension-admission.ts:58-64,88-102,136`; test `packages/capability/tests/unit/extension-admission.test.ts:111-118` (capability) |

## 7. Coupling

**Depends on** (runtime edges, this document → elsewhere):

- `@clarvis/capability`'s `LLMUsage`, `TokenCounts`, `TracePort`, `AgentRole`, `ComputeClock`,
  `OutputTokenBudget`, `ExtensionAdmissionController`, `Semaphore`, `GuardTrip`/`GuardWarning` types —
  the loop-side guard/budget code imports these as vocabulary and, for the clock/admission/semaphore,
  as the concrete factories too (`packages/loop/src/runtime/budget/budget-checkpoint.ts:3`, `packages/loop/src/runtime/budget/soft-budget.ts:1-4`,
  `convergence-guards.ts` type imports, `packages/loop/src/runtime/extension-admission.ts:1-14`). This is a hard package
  dependency (`@clarvis/loop` → `@clarvis/capability`), enforced structurally by the workspace graph,
  not by a test in this document.
- `../tools/ask-user-tool.ts`'s `Elicit`/`ElicitParams`/`elicitWithClockPause` — both
  `buildSoftLimitAsk` and `buildGuardEscalationAsk` are adapters over this port
  (`packages/loop/src/runtime/budget/soft-budget.ts:3`, `packages/loop/src/runtime/guards/guard-escalation.ts:2-3`); the port itself belongs to
  [elicitation-and-user-interaction](../cross-cutting/elicitation.md).
- `@clarvis/trace`'s `TracePort.record`/`.now()` — every budget/guard event above is written through
  it; the store/format is [trace-recording-and-persistence](../foundations/trace.md)'s.

**Depended on by** (what this document forces into the rest of the engine):

- `packages/loop/src/runtime/loop/run-agent.ts` and `loop.ts` (owned by [loop-run-lifecycle](loop-run-lifecycle.md)) **must**
  call `checkpoint()` and consult `guards.tripped()`/`takeSoft()` in the fixed order documented in §4.1
  — the ordering comment at `packages/loop/src/runtime/loop/loop.ts:1031-1036` states explicitly what breaks if a waived guard trip
  were made to `continue` immediately instead of falling through: "the iteration still counts against
  the no-progress tracker and still hits the budget checkpoint. Skipping both would make 'continue past
  the guard' quietly exempt that turn from two unrelated stop conditions."
- `packages/loop/src/runtime/tools/mcp-dispatch.ts` and
  `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts` (owned by
  [loop-tool-dispatch-and-results](tool-dispatch.md)) construct the guard-record *signature* string per call
  (`` `${call.name}:${safeStringify(call.arguments)}` `` at `packages/loop/src/runtime/tools/mcp-dispatch.ts:226-229`, mirrored at
  `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts:145-147`) and feed it into `guards.record` — a coupling this document does
  not control but whose shape (name + stringified args) determines what the doom-loop/stagnation guards
  perceive as "the same call".
- `packages/workflows/src/ledger.ts`'s `WorkflowLedger` (owned by [workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md)) is
  the **only** production implementation of `OutputTokenBudget` reachable through an ordinary run's
  capability contributions (`packages/workflows/src/run-leader.ts:24-31`,
  `packages/workflows/src/capability.ts:107,128`). Nothing in `@clarvis/loop` or `@clarvis/capability`
  constructs one for a non-workflow run — a plain lead-and-subagents run never has `folded.outputBudget`
  set, so `withOutputTokenBudget` is never engaged and the reserve/release rule of §4.4/INV-28 is dormant
  code outside a workflow. This is a real, structural coupling: this document's central mechanism has
  exactly one caller, and that caller is owned by a different document.
- `packages/loop/src/runtime/delegation.ts` (owned by [loop-delegation-and-subagents](delegation-and-subagents.md)) is the sole
  consumer of the fan-out `Semaphore` built at `packages/loop/src/runtime/orchestrator.ts:591` — it calls `.acquire()`/`.release()`
  around each `delegate_task` dispatch; this document owns only the `createSemaphore` factory and its FIFO/
  abort contract, not the fan-out policy built over it.
- `packages/loop/src/runtime/run-trace.ts`'s `GUARD_TRIP_CODES` (owned by [loop-run-lifecycle](loop-run-lifecycle.md)) is what
  turns `tool_failure_loop`/`stagnation_detected` into `run_ended.reason: "guard_trip"` — this document
  produces the codes; the classification of them into the terminal record belongs elsewhere.

## 8. Open questions

- **Delegated in full, not re-described here per the document's own scope**: the LLM-side admission
  controller construction (owned by [llm-provider-layer](../foundations/llm.md)), finalize gates and nudges (owned by
  [loop-capability-composition](capability-composition.md)), and workflow fan-out budgets/ledger semantics (owned by
  [workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md), including `WorkflowLedger`'s own reservation-sizing formula at
  `packages/workflows/src/ledger.ts:56` and its concurrency tests).
- **Terminology collision worth flagging for any future reader**: `packages/loop/tests/integration/command-guard-wiring.test.ts`
  is *not* about the convergence guards this document owns — it exercises the shell **command-approval**
  guard (`Guard`/`GuardContext`/`GuardDecision` from `packages/loop/src/lib.js`, the kernel's
  `createShellGuard`/`createGuardResolver` machinery), an entirely different "guard" concept belonging to
  tool-dispatch/kernel policy. It was deliberately excluded from this spec's evidence after inspection;
  a keyword search on "guard" in `packages/loop/tests` will otherwise surface it as if it belonged here.
- **A second, analogous terminology collision**: `packages/loop/tests/component/max-output-tokens-clamp.test.ts`
  is named after "output budget" but tests an entirely different mechanism — clamping a run's configured
  `max_output_tokens` to fit inside the model's context window (prompt + completion), exercised through
  `executeRun` directly, with no `OutputTokenBudget`/`withOutputTokenBudget`/reservation involved at all.
  A keyword search on "output budget" in `packages/loop/tests` will surface it as if it belonged to this
  document's reservation mechanism (§4.4). Cite: `packages/loop/tests/component/max-output-tokens-clamp.test.ts:29-61`.
