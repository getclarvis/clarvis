import {
  DELEGATE_TASK_MAX_CHARS,
  TASK_TITLE_MAX,
  type DelegateTaskAugmentation,
  type NamespacedTool,
} from "@clarvis/capability";
import type { SubagentProfileRegistry } from "./subagent-profiles.ts";

import { DELEGATE_TASK_TOOL_NAME, SPAWN_SUBAGENT_TOOL_NAME } from "../tools/wire-names.ts";

/** Re-exports the canonical child-spawn wire/tool names for convenience. */
export { DELEGATE_TASK_TOOL_NAME, SPAWN_SUBAGENT_TOOL_NAME };

/**
 * Builds the `profile` input-schema property for either child-spawn tool, enumerating the
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
      "OPTIONAL — select a specialized Sub-agent profile by name. Each profile has its own model, base prompt (identity), and tool scope; pick the one whose specialty fits the sub-task. Omit to use the default profile. Available profiles — " +
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
    "Spawn an independent Sub-agent with a focused sub-task. This tool has no task_id and does not require a tracked work item. The Sub-agent has its own iteration budget and returns a text result or an error. Use parallel calls for independent sub-tasks. Sub-agents cannot spawn further sub-agents.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: TASK_TITLE_MAX,
        description:
          "Short label for this Sub-agent (a few words) shown to the operator on the sub-agent panel; `task` carries the full instruction.",
      },
      task: {
        type: "string",
        minLength: 1,
        maxLength: DELEGATE_TASK_MAX_CHARS,
        description: `The focused sub-task description for the Sub-agent. Be specific about what success looks like and what strategy to use. Keep the complete brief within ${String(DELEGATE_TASK_MAX_CHARS)} characters.`,
      },
    },
    required: ["title", "task"],
  },
};

/**
 * Builds the `background` input-schema property for either child-spawn tool.
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
      "OPTIONAL — run this Sub-agent in the background. The call returns a handle immediately " +
      "instead of the result, so you keep working (and stay reachable) while it runs; follow it " +
      "with await_agents / agent_poll. Use it for slow or wide fan-out; leave it off for a quick " +
      "sub-task whose answer you need right now.",
  };
}

/**
 * Builds the `image_refs` input-schema property for either child-spawn tool — a
 * non-empty array of unique turn-image indices, receivable only by a profile
 * with the `image` grant and a vision-capable model.
 */
function buildImageRefsProperty(): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "integer", minimum: 0 },
    uniqueItems: true,
    description:
      "OPTIONAL — indices of the turn's images (see the numbered `[image #k …]` markers in the conversation) to hand to this Sub-agent. Only a profile whose model declares the 'vision' capability may receive them.",
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

/**
 * Assembles the tracked `delegate_task` schema.
 *
 * @param profiles - the registered sub-agent profiles.
 * @param imageRefsAllowed - when true, adds the `image_refs` property.
 * @param augmentation - the task tracker's `task_id` property and description.
 * @returns a tolerant schema that requires `task_id` and ignores surplus fields.
 */
export function buildDelegateTaskTool(
  profiles: SubagentProfileRegistry | undefined,
  imageRefsAllowed: boolean,
  augmentation: DelegateTaskAugmentation,
): NamespacedTool {
  const independent = buildSpawnSubagentTool(profiles, imageRefsAllowed);
  const base = independent.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  return {
    ...independent,
    fullName: DELEGATE_TASK_TOOL_NAME,
    wireName: DELEGATE_TASK_TOOL_NAME,
    toolName: DELEGATE_TASK_TOOL_NAME,
    description: augmentation.description,
    inputSchema: {
      type: "object",
      properties: {
        ...augmentation.properties,
        ...base.properties,
      },
      required: [...base.required, "task_id"],
    },
  };
}
