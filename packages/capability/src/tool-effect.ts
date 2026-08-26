/**
 * What a tool does to the workspace, so a capability can gate on *effect* rather
 * than on a list of names it had to be told.
 */
import { portKey } from "./services.ts";

/**
 * A tool's effect on the workspace: `read` observes, `mutate` can change it,
 * `control` drives the run itself (finishing, asking the human, supervising a
 * child) without touching the workspace, `spawn_run` starts an **independent
 * run** whose own toolset the caller does not bound, and `unknown` is a tool
 * whose effect nobody declared.
 *
 * @remarks `unknown` is the load-bearing member. An MCP server's tool can do
 * anything, and a gate that must refuse "everything that could change the
 * workspace" has to refuse it by construction. Any classification that made
 * `unknown` default to `read` would turn a closed rule into an open one and
 * nothing would report it.
 *
 * `spawn_run` exists because `control` carries a promise that only some spawns
 * keep. Both child-spawn tools are `control` on the stated grounds that "whatever
 * the child then does is gated by the child's own toolset" — true, because a
 * sub-agent's toolset comes from the parent run's own profile graph. A workflow
 * leader is not that: it is a separate `executeRun`, with a profile the caller
 * chooses and its own capability set, and hosts deliberately force `plans` off
 * inside it. Classifying those as `control` let a run under human plan review
 * fan out ten leaders before any plan existed — the manager could not write a
 * file itself, but could spawn something that would. A gate must be able to tell
 * the two apart, and effect is where it asks.
 */
export type ToolEffect = "read" | "mutate" | "control" | "spawn_run" | "unknown";

/** Classifies a tool by wire name. */
export interface ToolEffectPort {
  effect(wireName: string): ToolEffect;
}

/**
 * The registry key {@link ToolEffectPort} is published under.
 *
 * @remarks Absent when nothing published one, in which case every tool reads as
 * `unknown` — the safe direction for a gate, and the reason a consumer should
 * fall back to `unknown` rather than to `read`.
 */
export const TOOL_EFFECT_PORT = portKey<ToolEffectPort>("tools.effect");
