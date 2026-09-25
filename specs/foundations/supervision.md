# Run-scoped child supervision

## Purpose and ownership

`@clarvis/supervision` owns a run-scoped registry of children, their bounded activity buffers, completion notices, steer queues, and effective limits. `@clarvis/loop` registers sub-agents and `@clarvis/workflows` registers workflow leaders in the same id space. Model-facing tools live in the loop. Production: `createAgentRegistry` in `packages/supervision/src/registry.ts`, `registerBackgroundChild` in `packages/supervision/src/spawn-child.ts`, and `AGENT_REGISTRY_PORT` in `packages/supervision/src/agent-registry-port.ts`. Test: `packages/supervision/tests/component/registry.test.ts` and `packages/supervision/tests/unit/agent-registry-port.test.ts`.

## Surface and formats

`AgentRegistryPort` in `packages/capability/src/agents-port.ts` gives producers `register`, `adopt`, and `liveCount`. A registered handle accepts activity, waiting state, and settlement. `AgentRegistry` in `packages/supervision/src/registry.ts` additionally exposes `list`, `has`, `poll`, `stop`, `steer`, `liveIds`, `ingestTraceEntry`, `takeNotices`, failure-streak queries, `seal`, and `teardown`. IDs follow `AGENT_ID_PATTERN` and are minted by `mintAgentId` in `packages/supervision/src/ids.ts`. Test: `packages/supervision/tests/component/registry.test.ts` and `packages/supervision/tests/unit/agent-registry-port.test.ts`.

The `agents` settings block and per-run override share the fields `buffer_lines`, `buffer_bytes`, `max_total_buffer_bytes`, `poll_max_bytes`, `max_live_children`, `max_retained_children`, `max_notices_per_iteration`, `max_consecutive_failed_children`, and `finish_nudges`. Settings are strict; unknown keys fail validation. `resolveAgentsLimits` folds request values over defaults. Production: `AGENTS_DEFAULTS`, `AGENTS_SETTINGS_FIELDS`, and `AGENTS_REQUEST_PARAMS` in `packages/supervision/src/settings.ts`; `resolveAgentsLimits` in `packages/supervision/src/limits.ts`. Test: `packages/supervision/tests/unit/settings.test.ts` and `packages/supervision/tests/unit/limits.test.ts`.

`AgentBuffer` in `packages/supervision/src/buffer.ts` stores bounded lines and returns a page with offsets and truncation metadata. `projectAgentEvent` in `packages/supervision/src/projection.ts` converts child trace events into readable activity lines. `AgentListEntry`, `AgentPollResult`, `AgentStopResult`, and `AgentNotice` are defined by `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.

## Behavior

Registration refuses a sealed registry or a full live-child limit. The registry maps native child ids to its run-scoped handles. Activity can arrive through the child handle or through `ingestTraceEntry`. Settlement records status, result, usage, a bounded completion notice, and the consecutive technical failure streak. A completed child resets that streak; a failed child advances it; limited or cancelled children do neither. Production: `register`, `ingestTraceEntry`, and `settled` in `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.

`poll` returns a page of one child's activity. `stop` cancels a live child and retains its readable tail. `steer` queues an instruction for a live child. `list` and `liveIds` expose the registry's current view. A parent obtains these behaviors through `agent_list`, `agent_poll`, `agent_stop`, and `agent_steer` in the loop. Production: `AgentRegistry` in `packages/supervision/src/registry.ts` and `createAgentsRunCapability` in `packages/loop/src/runtime/capabilities/agents.ts`. Test: `packages/supervision/tests/component/registry.test.ts` and `packages/loop/tests/unit/agents-capability.test.ts`.

The registry budgets live and retained buffers across children, evicts settled records when needed, and bounds notices per iteration. `seal` closes admission. `teardown` cancels and drains registered children within its grace period and reports children that did not settle. Production: `createAgentRegistry` in `packages/supervision/src/registry.ts` and `createAgentBuffer` in `packages/supervision/src/buffer.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.

## Invariants

1. A child handle belongs to one run and cannot control another run's child. Production: `createAgentRegistry` in `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.
2. Buffer and child limits bound retained state while live child records remain addressable. Production: `createAgentRegistry` in `packages/supervision/src/registry.ts` and `createAgentBuffer` in `packages/supervision/src/buffer.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.
3. A limited or cancelled child does not count as a technical failure. Production: `settled` and `failingStreakExceeded` in `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.

## Coupling

The package depends on `@clarvis/capability` for shared ports and trace types. The loop owns model-facing policy; workflows owns leader policy. See [sub-agent spawning](../engine/delegation-and-subagents.md) and [workflow scheduling](../capabilities/workflows-scheduling.md).
