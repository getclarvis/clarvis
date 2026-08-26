/**
 * `@clarvis/supervision` — the run-scoped registry a parent observes and
 * controls its spawned children through.
 *
 * @remarks
 * This is substrate shared by two producers that would otherwise reach into
 * each other: `@clarvis/loop`'s `delegate_task` registers a sub-agent, and
 * `@clarvis/workflows`' `run_leader` registers a leader, both into the same id
 * space. Owning it here makes that edge explicit and one-way — `loop →
 * supervision` and `workflows → supervision` — where `workflows` used to reach
 * the delegation registry through a seam published on the engine itself.
 *
 * The line against `@clarvis/loop` is the one `@clarvis/trace` and
 * `@clarvis/mcp-client` already draw: **the registry is substrate, the tools
 * over it are engine policy.** This package knows how to mint an id, buffer a
 * child's activity, project its trace into a readable line, queue a steer and
 * register a background child; the loop decides what a model may ask of any of
 * that, and `agent_list` / `agent_poll` / `agent_stop` / `agent_steer` /
 * `await_agents` stay there.
 *
 * It depends on `@clarvis/capability` and — for the settings block alone —
 * `zod`, and on nothing else beyond `node:crypto`.
 */
export { createAgentBuffer } from "./buffer.ts";
export type { AgentBufferRead, AgentBufferLimits, AgentBuffer } from "./buffer.ts";
export { AGENT_REGISTRY_PORT } from "./agent-registry-port.ts";
export { AGENT_ID_PATTERN, mintAgentId } from "./ids.ts";
export { resolveAgentsLimits } from "./limits.ts";
export { fromTraceEntry, fromTraceEvent, projectAgentEvent, waitAgeSeconds } from "./projection.ts";
export type { ProjectionSource, ProjectionState } from "./projection.ts";
export { createAgentRegistry, UnknownAgentError } from "./registry.ts";
export type {
  AgentsLimits,
  AgentListEntry,
  AgentPollResult,
  AgentStopResult,
  AgentNotice,
  AgentSettledInfo,
  AgentWait,
  AgentTeardownReport,
  AgentRegistryOptions,
  AgentRegistry,
} from "./registry.ts";
export {
  AGENTS_CAPABILITY_NAME,
  AGENTS_DEFAULTS,
  AGENTS_MAX_BUFFER_BYTES,
  AGENTS_MAX_BUFFER_LINES,
  AGENTS_MAX_LIVE_CHILDREN,
  AGENTS_MAX_TOTAL_BUFFER_BYTES,
  AGENTS_SETTINGS_FIELDS,
  AGENTS_REQUEST_PARAMS,
  agentsSettingsSpec,
} from "./settings.ts";
export { registerBackgroundChild } from "./spawn-child.ts";
export type { BackgroundChildSpec, BackgroundChildSpawn } from "./spawn-child.ts";
export { createSteerQueue } from "./steer-queue.ts";
export type { SteerQueue } from "./steer-queue.ts";
