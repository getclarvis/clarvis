# @clarvis/supervision

The run-scoped registry a parent observes and controls its spawned children through: agent ids, the
per-child activity buffer, the trace→activity projection, the steer queue, background registration,
and the effective limits.

Private, unversioned workspace in the [Clarvis](https://github.com/getclarvis/clarvis) stack. The
root manifest owns the product version; this API may change during the beta period.

## Contract

The registry and limits are specified in
[`foundations/supervision.md`](../../specs/foundations/supervision.md). The engine policy and tools
built over that registry are specified separately in
[`engine/delegation-and-subagents.md`](../../specs/engine/delegation-and-subagents.md).

## Why it is its own package

Two producers register into the same id space — `@clarvis/loop`'s `delegate_task` (a sub-agent) and
`@clarvis/workflows`' `run_leader` (a leader). Before this package, `workflows` reached the
registry through a seam published on the engine, so the upper package depended on an internal of
the lower one. As a leaf both depend on, the edge is explicit and one-way.

## What it is not

The five supervision tools — `agent_list`, `agent_poll`, `agent_stop`, `agent_steer`,
`await_agents` — are **not** here. They live in `@clarvis/loop`, for the same reason the trace store
does not own _when_ to record and the MCP client does not own _when_ to call: the registry is
substrate, the tools over it are engine policy.

## Capability service

`AGENT_REGISTRY_PORT` is the typed service key for this run-scoped registry. When the entry can spawn,
the engine creates the registry and publishes it on `RunCapabilityContext.services` **before any
capability's `forRun` executes**. A producer such as workflows retrieves the shared registry through
that key; there is no feature-specific `agents` field on the capability context. If the run cannot
spawn, the port is absent and a capability that requires it stays inactive.

## Usage

`registerBackgroundChild` is the skeleton both producers share: build the control plumbing,
register, bail on `null`, record `agent_registered`. It takes the registry and the agent's trace
positionally, and everything about the child in a `BackgroundChildSpec` — `nativeId` is required,
because it is the child's own id in its native space (a `subagent_instance_id` for a sub-agent, a
`run_id` for a leader) and the registry maps its trace back through it.

An optional fourth `onRegistered` callback commits producer-owned accounting at the exact registry
acceptance boundary, before the trace is published. If that callback or the trace sink throws, the
helper aborts, settles and closes the accepted child before rethrowing; a producer can never lose a
live, unadopted handle between registration and `agents.adopt`.

```ts
import {
  createAgentRegistry,
  registerBackgroundChild,
  resolveAgentsLimits,
} from "@clarvis/supervision";

const agents = createAgentRegistry({ limits: resolveAgentsLimits(request, env) });

const spawned = registerBackgroundChild(agents, trace, {
  kind: "subagent",
  nativeId: subagentInstanceId,
  title: "review the diff",
  profile: "reviewer",
});

// null means the registry declined — it is sealed, or at its live-children
// ceiling. Answer the model with a plain refusal; never spawn anyway.
if (spawned !== null) {
  const { handle, controller, steerQueue } = spawned;

  const task = (async () => {
    try {
      const text = await runTheChild(controller.signal, steerQueue);
      handle.settled({ status: "completed", result: text });
    } catch (err) {
      handle.settled({ status: "failed", result: String(err) });
    } finally {
      steerQueue.close();
    }
  })();

  // Hand the promise over rather than awaiting it, or the spawn stops being
  // background; teardown is what waits on it.
  agents.adopt(handle.id, task);
}
```

## Activity-buffer budget

`buffer_bytes` is the requested ceiling for one child, while
`max_total_buffer_bytes` is the aggregate payload ceiling for the complete run-scoped registry. The
aggregate setting defaults to, and can never exceed, 32 MiB. At construction the registry reserves
slots for both `max_live_children` and `max_retained_children` and derives the effective per-child
ceiling as the smaller of `buffer_bytes` and
`floor(max_total_buffer_bytes / (max_live_children + max_retained_children))`. Consequently no order
of registrations and settlements can make the retained activity buffers exceed the aggregate
budget.

An individual projected line is subject to the same hard bound. If it is larger than its child's
effective ceiling, the buffer retains the newest UTF-8-safe tail and advances its absolute head by
the bytes it dropped. Poll offsets and `truncated_head` therefore continue to describe the original
stream honestly; a single line is never an escape hatch around the memory limit.

## What it reports to an operator

`createAgentRegistry` takes an optional `logger`; the loop passes
`logger.child({ component: "agents" })`. The per-child hot paths deliberately stay silent —
`ingestTraceEntry` runs on every trace entry of every child, and `buffer` and `projection` run per
line.

| Level | `event`                     | Says                                                                                   |
| ----- | --------------------------- | -------------------------------------------------------------------------------------- |
| debug | `agents.spawn_refused`      | a registration was turned away, `sealed` or `at_capacity`, with `live` and the ceiling |
| debug | `agents.steer_refused`      | a steer never reached its child and was dropped                                        |
| debug | `agents.stop_port_threw`    | a control port threw, in `phase` `stop` or `teardown`; the child settles anyway        |
| warn  | `agents.teardown_abandoned` | the run finished on top of live children — one line, only when there were any          |

`at_capacity` is the arm that matters: a fan-out that keeps hitting the live ceiling and therefore
runs its children one at a time is, from the outside, indistinguishable from one that chose to.

## Dependencies

`@clarvis/capability` (the contract) and `zod` (the settings block only). Nothing else beyond
`node:crypto`.

## Test ownership

The suite is split by effect boundary, with no flat test files:

- `tests/unit/` owns the complete local matrices for the activity buffer, agent-id minting and
  shape, effective limits, trace-to-activity projection, the settings block, the per-child steer
  queue and the capability service port. ID uniqueness/shape and filtered pagination are asserted
  only here. These tests exercise one policy or state machine and use only pure collaborators or
  narrow in-memory values.
- `tests/component/registry.test.ts` owns the composed registry lifecycle: registration, scoping,
  stop/steer, trace ingestion, one representative poll-page projection, waits, notices, retention,
  teardown and producer handles. It composes the package's real registry internals with in-memory
  control ports; deferred signals and an injected grace scheduler make lifecycle tests independent
  of elapsed wall time.
- `tests/component/spawn-child.test.ts` owns the package-level background-child registration seam:
  registry admission, trace recording and the controller/steer plumbing returned to a producer.

The tier commands are `test:unit` and `test:component`. The default `test` and `test:coverage`
commands run both tiers together, so classification does not change the supported suite or its LCOV
inventory.

## License

MIT
