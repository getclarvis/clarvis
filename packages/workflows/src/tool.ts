/**
 * The `run_leader` tool: the manager's sole lever for spawning leader runs. Its
 * schema is a small, curated surface (short title + full prompt + optional profile
 * + optional result schema) — the leader's grants, budget and topology are the
 * host's to assemble, never the model's.
 */
import { TASK_TITLE_MAX, type NamespacedTool } from "@clarvis/capability";
import { WORKFLOW_LIMITS } from "./limits.ts";

/** The `run_leader` wire/tool name. */
export const RUN_LEADER_TOOL_NAME = "run_leader";

/**
 * How long a leader's display `title` may be.
 *
 * @remarks Bounded because the title is what a human reads in the agent list and
 *   the transcript, where it shares a row with a status glyph and a model name.
 *   Invalid or missing titles are rejected instead of falling back to the prompt;
 *   the prompt is what a leader used to be *registered* under in full, so such a
 *   fallback would make a fan-out unreadable again.
 */
export const LEADER_TITLE_MAX = TASK_TITLE_MAX;

/** One manager-selectable leader profile, used to populate the `run_leader`
 * tool's `profile` enum and catalogue. */
export interface LeaderProfileInfo {
  name: string;
  description?: string;
}

const RUN_LEADER_DESCRIPTION =
  "Spawn a full, autonomous leader run to handle a sub-goal. Each leader has its own fresh " +
  "context and token budget and can delegate sub-agents of its own, but cannot spawn further " +
  "leaders. Prefer one leader per independent sub-goal; issue several run_leader calls in one turn " +
  "to run them in parallel. Each call answers immediately with the leader's agent handle and the " +
  "leader runs on in the background; collect it with await_agents or agent_poll. When you already " +
  "have a decomposition into work items, prefer run_work_items, which schedules the whole batch.";

/**
 * Build the `run_leader` tool, enumerating the manager-selectable leader profiles.
 *
 * @param profiles - the registered profiles a leader may run as; when non-empty,
 *   adds a `profile` selector property with an enum and a `name: description`
 *   catalogue.
 * @returns the {@link NamespacedTool} describing `run_leader`.
 */
export function buildRunLeaderTool(profiles?: readonly LeaderProfileInfo[]): NamespacedTool {
  const properties: Record<string, unknown> = {
    title: {
      type: "string",
      minLength: 1,
      maxLength: LEADER_TITLE_MAX,
      description:
        'A short label for this leader, a few words naming what it is doing (e.g. "migrate the ' +
        'storage schema"). It is what a human sees in the agent list and the transcript while the ' +
        "leader runs, so write it for them, not for yourself.",
    },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.textChars,
      description:
        "The full task for this leader — be specific about the goal, the constraints, and what a " +
        "successful result looks like. The leader runs autonomously and cannot ask you follow-ups.",
    },
  };
  if (profiles !== undefined && profiles.length > 0) {
    properties.profile = {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.identifierChars,
      enum: profiles.map((p) => p.name),
      description:
        "OPTIONAL — the agent profile this leader runs as. Each profile has its own model, base " +
        "prompt and tool scope; pick the one whose specialty fits the sub-goal. Omit to use the " +
        "default profile. Available profiles — " +
        profiles.map((p) => `${p.name}: ${p.description ?? "(no description)"}`).join("; "),
    };
  }
  properties.expect_schema = {
    type: "object",
    description:
      "OPTIONAL — a JSON Schema; when set, the leader is required to return a structured result " +
      "matching it instead of free text.",
  };
  return {
    fullName: RUN_LEADER_TOOL_NAME,
    wireName: RUN_LEADER_TOOL_NAME,
    mcpName: "",
    toolName: RUN_LEADER_TOOL_NAME,
    description: RUN_LEADER_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required: ["title", "prompt"],
    },
  };
}
