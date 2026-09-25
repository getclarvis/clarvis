# Sub-agent spawning and supervision

## Purpose

The lead can call `spawn_subagent` to run independent work in a registered profile. An inline call returns the child's result. A background call returns a handle, and the lead can inspect or control that child through four supervision tools. A child receives a self-contained brief, selected turn images when allowed, the shared run budget, and a profile-scoped tool registry. Production: `buildDelegationContribution` in `packages/loop/src/runtime/delegation.ts`, `prepareSpawn` and `runPreparedSubagent` in `packages/loop/src/runtime/subagents/spawn-subagent.ts`. Test: `packages/loop/tests/unit/delegation-handler.test.ts` and `packages/loop/tests/integration/subagent-only-regression.test.ts`.

## Tool surface

`buildSpawnSubagentTool` in `packages/loop/src/runtime/subagents/lead-tools.ts` advertises required `title` and `task` fields. It adds `profile`, `image_refs`, and `background` when the run can use them. `validateSpawnArgs` in `packages/loop/src/runtime/subagents/spawn-subagent.ts` resolves the profile, validates the title and brief, and validates image indices against the turn and the target model's vision capability. Extra fields do not create plan associations. Test: `packages/loop/tests/unit/lead-tools.test.ts`, `packages/loop/tests/unit/spawn-subagent.test.ts`, and `packages/loop/tests/unit/image-routing.test.ts`.

The run-scoped supervision capability in `packages/loop/src/runtime/capabilities/agents.ts` advertises `agent_list`, `agent_poll`, `agent_stop`, and `agent_steer` when a registry exists. `agent_poll` requires a child id and reads a bounded page of its activity log. `agent_stop` cancels a child; `agent_steer` queues an instruction for its next iteration. The registry retains bounded settled records and completion notices. Production: `createAgentsRunCapability` in `packages/loop/src/runtime/capabilities/agents.ts` and `AgentRegistry` in `packages/supervision/src/registry.ts`. Test: `packages/loop/tests/unit/agents-capability.test.ts` and `packages/supervision/tests/component/registry.test.ts`.

## Spawn lifecycle

`buildDelegationContribution` applies the optional `SpawnGatePort.beforeSpawn` ruling before preparing a child. A refusal returns a plain tool result; a terminal ruling ends the lead. `prepareSpawn` runs the pre-spawn lifecycle hook and creates a profile-scoped registry. A hook rewrite is refused at this stage; `pre_tool_use` can rewrite the original tool call before validation. Production: `spawnHandler` in `packages/loop/src/runtime/delegation.ts`, `prepareSpawn` in `packages/loop/src/runtime/subagents/spawn-subagent.ts`, and `SPAWN_GATE_PORT` in `packages/capability/src/spawn-gate-port.ts`. Test: `packages/loop/tests/unit/delegation-handler.test.ts`, `packages/loop/tests/component/spawn-subagent-pre-tool-use-rewrite.test.ts`, and `packages/loop/tests/unit/tool-hooks.test.ts`.

Inline execution takes a semaphore slot and returns the result in the tool response. Background execution registers the child and returns its handle immediately; the child acquires its slot inside the registered task. The lead observes completion through a notice or `agent_poll`. A finish gate nudges a lead with live children before finalization. Production: `buildDelegationContribution` in `packages/loop/src/runtime/delegation.ts` and `registerBackgroundChild` in `packages/supervision/src/spawn-child.ts`. Test: `packages/loop/tests/unit/delegation-handler.test.ts` and `packages/loop/tests/unit/agents-capability.test.ts`.

Child outcomes remain distinct: completed, limited, cancelled, and failed. A limit does not count as a technical failure. The run records delegation trace events and publishes live capability events; the registry records child status, activity, usage, and notices. Production: `settlementStatusOf` and `runPreparedSubagent` in `packages/loop/src/runtime/subagents/spawn-subagent.ts`, and `AgentRegistry.settled` in `packages/supervision/src/registry.ts`. Test: `packages/loop/tests/unit/spawn-subagent.test.ts` and `packages/supervision/tests/component/registry.test.ts`.

## Invariants

1. `spawn_subagent` is the only child-spawn wire name. Production: `BUILTIN_WIRE_NAMES` in `packages/loop/src/runtime/tools/wire-names.ts` and `buildDelegationContribution` in `packages/loop/src/runtime/delegation.ts`. Test: `packages/loop/tests/unit/lead-tools.test.ts` and `packages/loop/tests/unit/tool-effect.test.ts`.
2. A background child must be observed before the lead treats its work as complete. Production: `registerBackgroundChild` in `packages/supervision/src/spawn-child.ts` and `createAgentsRunCapability` in `packages/loop/src/runtime/capabilities/agents.ts`. Test: `packages/loop/tests/unit/agents-capability.test.ts`.
3. The child runs with its target profile's grants and the shared run budget. Production: `prepareSpawn` in `packages/loop/src/runtime/subagents/spawn-subagent.ts` and `runSubagent` in `packages/loop/src/runtime/subagents/run-subagent.ts`. Test: `packages/loop/tests/unit/spawn-subagent.test.ts` and `packages/loop/tests/integration/subagent-only-regression.test.ts`.
4. Supervision handles are run scoped and cannot address an unknown child. Production: `AgentRegistry` in `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.

## Coupling

`@clarvis/loop` owns the model-facing tools and dispatch. `@clarvis/supervision` owns child records, buffers, notices, control, and teardown. `@clarvis/capability` defines shared ports, events, and types. `@clarvis/plan` may provide a spawn gate for its review policy; it does not augment the spawn schema. `@clarvis/workflows` registers leaders in the same supervision registry. See [supervision](../foundations/supervision.md), [capability](../foundations/capability.md), [planning](../capabilities/plan-capability.md), and [grants](../cross-cutting/grants.md).
