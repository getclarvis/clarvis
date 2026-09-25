import { TASK_BRIEF_MAX_CHARS, TASK_TITLE_MAX, type NamespacedTool } from "@clarvis/capability";
import type { SubagentProfileRegistry } from "./subagent-profiles.ts";

import { SPAWN_SUBAGENT_TOOL_NAME } from "../tools/wire-names.ts";

/** Re-exports the canonical child-spawn wire/tool names for convenience. */
export { SPAWN_SUBAGENT_TOOL_NAME };

/**
 * Builds the `profile` input-schema property, enumerating the
 * registered profile names and appending a catalogue of `name: description`
 * pairs so the model can pick the right specialty.
 */
function buildProfileProperty(profiles: SubagentProfileRegistry): Record<string, unknown> {
  const names = [...profiles.keys()];
  const catalogue = [...profiles.values()]
    .map((p) => `${p.name}: ${p.description ?? "(no description)"}`)
    .join("; ");
  return {
    type: "string",
    enum: names,
    description:
      "Choose a profile for its role and tools; omit for the default. Available profiles: " +
      catalogue,
  };
}

/**
 * The base independent-spawn tool with the minimal `{ title, task }` schema.
 *
 * @remarks {@link buildSpawnSubagentTool} extends this with `profile`, `image_refs`,
 *   and `background` properties as the run's features require. The schema
 *   deliberately permits unknown properties so provider-added metadata or a
 *   model's harmless surplus argument cannot invalidate an otherwise correct call.
 */
export const spawnSubagentTool: NamespacedTool = {
  fullName: SPAWN_SUBAGENT_TOOL_NAME,
  wireName: SPAWN_SUBAGENT_TOOL_NAME,
  mcpName: "",
  toolName: SPAWN_SUBAGENT_TOOL_NAME,
  description:
    "Spawn a leaf for independent work. It receives your brief, not " +
    "your conversation, and shares the workspace and run token budget. Keep concurrent scopes " +
    "independent. Returns its result or error inline, or a handle when backgrounded; inspect " +
    "the outcome before treating the work as complete.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: TASK_TITLE_MAX,
        description: "Short single-line label for the operator; put full instructions in task.",
      },
      task: {
        type: "string",
        minLength: 1,
        maxLength: TASK_BRIEF_MAX_CHARS,
        description:
          "Self-contained brief: goal, needed context, file scope, constraints and expected result. " +
          "The child cannot ask you follow-up questions.",
      },
    },
    required: ["title", "task"],
  },
};

/**
 * Builds the `background` input-schema property.
 *
 * @remarks Opt-in rather than the default, unlike `run_leader`: a sub-agent is
 *   usually short and sequential, and an inline result costs the model nothing
 *   to read and no poll cycle to collect. Backgrounding is what a *wide* or
 *   *slow* fan-out needs — where the alternative is the lead going dark.
 */
function buildBackgroundProperty(): Record<string, unknown> {
  return {
    type: "boolean",
    description:
      "Default false: wait for the result. True: return a handle; inspect it with agent_poll " +
      "or read its completion notice; without background supervision, waits inline.",
  };
}

/**
 * Builds the `image_refs` input-schema property — a
 * non-empty array of unique turn-image indices, receivable only by a profile
 * with a vision-capable model.
 */
function buildImageRefsProperty(): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "integer", minimum: 0 },
    uniqueItems: true,
    description:
      "Turn-image indices from the [image #k] markers. The receiving profile needs a " +
      "vision-capable model.",
  };
}

/**
 * Assembles the independent `spawn_subagent` schema tailored to the run's features.
 *
 * @param profiles - the registered sub-agent profiles; when non-empty, adds the
 *   `profile` selector property.
 * @param imageRefsAllowed - when true, adds the `image_refs` property.
 * @returns the base {@link spawnSubagentTool} with whichever of the features
 *   apply folded into its input schema.
 */
export function buildSpawnSubagentTool(
  profiles?: SubagentProfileRegistry,
  imageRefsAllowed = false,
): NamespacedTool {
  const base = spawnSubagentTool.inputSchema as {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  const profileProp =
    profiles && profiles.size > 0 ? { profile: buildProfileProperty(profiles) } : {};
  const imageRefsProp = imageRefsAllowed ? { image_refs: buildImageRefsProperty() } : {};
  const backgroundProp = { background: buildBackgroundProperty() };

  return {
    ...spawnSubagentTool,
    inputSchema: {
      type: "object",
      properties: {
        title: base.properties.title,
        task: base.properties.task,
        ...profileProp,
        ...imageRefsProp,
        ...backgroundProp,
      },
      required: [...base.required],
    },
  };
}
