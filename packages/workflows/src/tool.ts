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
  "Start one background leader with fresh context, a shared workspace and a share of the " +
  "auxiliary token budget. It may delegate if its profile permits, but cannot start leaders. " +
  "Returns a handle, not a result; collect with await_agents or agent_poll. Keep ad-hoc scopes " +
  "independent; use run_work_items for dependency/file-aware scheduling of a batch.";

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
      description: "Short single-line label for the operator; put full instructions in prompt.",
    },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.textChars,
      description:
        "Self-contained goal, needed context, file scope, constraints and expected result. " +
        "The leader does not inherit your conversation.",
    },
  };
  if (profiles !== undefined && profiles.length > 0) {
    properties.profile = {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.identifierChars,
      enum: profiles.map((p) => p.name),
      description:
        "Choose a profile for its role and tools; omit for the default. Available profiles: " +
        profiles.map((p) => `${p.name}: ${p.description ?? "(no description)"}`).join("; "),
    };
  }
  properties.expect_schema = {
    type: "object",
    description:
      "JSON Schema for the leader's result; omit for free text. Failure may yield no matching result.",
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
