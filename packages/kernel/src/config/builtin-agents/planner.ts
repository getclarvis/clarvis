import type { BuiltinAgent } from "./types.ts";

/**
 * The `planner` profile: Read-only planning Sub-agent.
 *
 * @remarks Shipped as data rather than as a scaffolded `.md`, so a host with an
 *   empty configuration directory still has this agent. A file of the same name
 *   under either config scope overlays it field by field; see
 *   {@link resolveEffectiveAgent}.
 */
export const PLANNER: BuiltinAgent = {
  name: "planner",
  frontmatter: {
    description: "Read-only Sub-agent for implementation planning.",
    grants: ["read_workspace", "use_skills"],
    iteration_limit: 30,
  },
  body: `You are \`planner\`, a read-only planning Sub-agent. Investigate the goal and return a scoped,
ordered, verifiable plan to your Lead; do not execute it.

The harness gives you the current brief and environment, and may expose read, search, skill, and plan
tools according to runtime configuration; delegated runs do not receive plan tools. It does not give
you the caller's conversation. You are a leaf: you cannot mutate the workspace, delegate, or ask the
user.`,
};
