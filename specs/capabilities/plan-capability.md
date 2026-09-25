# Planning capability

## Purpose and ownership

`@clarvis/plan` stores one active plan for a run, exposes plan tools, publishes canonical plan state to the model, optionally asks for human review, and enforces pending-task completion before finalization. It does not run child agents or change task state when a child is spawned. Production: `createPlansCapability` in `packages/plan/src/capability/index.ts`, `PlanSession` in `packages/plan/src/capability/session.ts`, and `buildPlansOrchestration` in `packages/plan/src/capability/orchestration.ts`. Test: `packages/plan/tests/component/plan-orchestration.test.ts` and `packages/plan/tests/component/plan-catalog.test.ts`.

## Format and storage

A plan is a Markdown document with validated frontmatter, objective, context, tasks, validation, and notes. `parsePlan`, `renderPlan`, and `newPlan` in `packages/plan/src/format.ts` own the format; schemas and bounds live in `packages/plan/src/schemas.ts` and `packages/plan/src/limits.ts`. Task ids and task statuses are plan data. A task transitions only through explicit plan mutation with the allowed state transitions. Production: `transitionTask` and `canCompletePlan` in `packages/plan/src/transitions.ts`; `PlanSession.transition` in `packages/plan/src/capability/session.ts`. Test: `packages/plan/tests/unit/plan-format.test.ts`, `packages/plan/tests/component/plan-orchestration.test.ts`, and `packages/plan/tests/component/plan-orchestration.test.ts`.

The plan store uses revision and spec-digest compare-and-swap values so stale edits fail without overwriting a concurrent change. The active session reconciles the backing record before mutation. A missing backing record invalidates cached state and publishes a tombstone. Production: `createPlanStore` in `packages/plan/src/store.ts`, `PlanSession.reconcile` in `packages/plan/src/capability/session.ts`, and `missingPlanCanonicalState` in `packages/plan/src/capability/canonical-state.ts`. Test: `packages/plan/tests/component/plan-observability.test.ts` and `packages/plan/tests/unit/plan-canonical-state.test.ts`.

## Model-facing tools

The capability advertises `create_plan`, `read_plan`, `list_plans`, `revise_plan`, and `transition_plan_task`. `revise_plan` accepts bounded batch operations; `transition_plan_task` accepts task status changes with the current compare-and-swap values. The tool catalog and input schemas live in `packages/plan/src/tools.ts`; dispatch and validation live in `packages/plan/src/capability/runtime-tools.ts`. Test: `packages/plan/tests/component/plan-catalog.test.ts` and `packages/plan/tests/component/plan-orchestration.test.ts`.

The canonical context contains a bounded volatile header with current revision, digest, review posture, and every task status, followed by a stable plan document block. Updates append a new publication so earlier prompt content remains unchanged. Production: `planCasHeader`, `planCanonicalState`, and `planSpecBlock` in `packages/plan/src/capability/canonical-state.ts`. Test: `packages/plan/tests/unit/plan-canonical-state.test.ts`.

## Review, spawn gate, and finalization

When review is requested, plan content must be approved before execution proceeds. The plan contributes a `SpawnGatePort` through `SPAWN_GATE_PORT`; `beforeSpawn` can present the review gate, refuse a spawn after rejection, or return a terminal result. The gate does not add fields to `spawn_subagent`. Production: `createPlansCapability` in `packages/plan/src/capability/index.ts`, `buildPlansOrchestration` in `packages/plan/src/capability/orchestration.ts`, and `PLAN_SPAWN_PORT` in `packages/plan/src/capability/spawn-port.ts`. Test: `packages/plan/tests/component/plan-orchestration.test.ts` and `packages/loop/tests/component/lifecycle-delegation-wiring.test.ts`.

An attempt to finalize with open tasks produces a bounded nudge and eventually a terminal unfinished result when the lead makes no progress. A checkpoint can pause without closing those tasks. A plan stays by default and is deleted only through the configured explicit discard path after terminal completion. Production: `pendingTaskGate` and `reviewGate` in `packages/plan/src/capability/orchestration.ts`, `DEFAULT_PLAN_RETENTION` in `packages/plan/src/schemas.ts`, and `PlanService` in `packages/plan/src/service.ts`. Test: `packages/plan/tests/component/plan-orchestration.test.ts` and `packages/plan/tests/component/plan-observability.test.ts`.

## Invariants

1. Spawning a child does not claim, complete, or fail a plan task. The lead records task outcomes through `transition_plan_task`. Production: `beforeSpawn` in `packages/plan/src/capability/orchestration.ts` and `handlePlanRuntimeCall` in `packages/plan/src/capability/runtime-tools.ts`. Test: `packages/plan/tests/component/plan-orchestration.test.ts`.
2. Review gates remain tied to the current plan specification; revising the specification revokes prior approval. Production: `buildPlansOrchestration` in `packages/plan/src/capability/orchestration.ts`. Test: `packages/plan/tests/component/plan-orchestration.test.ts`.
3. The backing store is authoritative over the session cache. Production: `PlanSession.reconcile` in `packages/plan/src/capability/session.ts`. Test: `packages/plan/tests/component/plan-observability.test.ts`.
4. Task ids identify plan tasks only and do not bind a child run. Production: `planTaskSchema` in `packages/plan/src/schemas.ts` and `buildSpawnSubagentTool` in `packages/loop/src/runtime/subagents/lead-tools.ts`. Test: `packages/plan/tests/component/plan-catalog.test.ts` and `packages/loop/tests/unit/lead-tools.test.ts`.

## Coupling

`@clarvis/plan` uses the neutral spawn gate from `@clarvis/capability`; `@clarvis/loop` consumes that port without importing planning. The kernel supplies plan storage and review callbacks. Plan task ids are not part of the child-spawn tool. See [capability](../foundations/capability.md), [sub-agent spawning](../engine/delegation-and-subagents.md), and [kernel runs](../hosts/kernel-runs.md).
