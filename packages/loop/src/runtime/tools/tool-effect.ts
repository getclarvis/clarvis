/**
 * The engine's classification of its own tool vocabulary by workspace effect,
 * published on the run's port registry so a capability can gate on what a tool
 * *does* instead of on a list of names it had to be told.
 */
import type { ToolEffect, ToolEffectPort } from "@clarvis/capability";
import {
  AGENT_SUPERVISION_WIRE_NAMES,
  AGENT_TOOL_WIRE_NAMES,
  ASK_USER_TOOL_NAME,
  READ_ONLY_AGENT_TOOL_WIRE_NAMES,
  SPAWN_SUBAGENT_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
} from "./wire-names.ts";
import { DELEGATE_TASK_TOOL_NAME } from "../subagents/lead-tools.ts";

const READ = new Set(READ_ONLY_AGENT_TOOL_WIRE_NAMES);
const CODING = new Set(AGENT_TOOL_WIRE_NAMES);

/**
 * Engine-owned tools that drive the run rather than the workspace: finishing,
 * asking the human, delegating, and supervising children. Feature capabilities
 * classify their own tools through `Capability.toolEffects`.
 *
 * @remarks The child-spawn tools are here rather than under `mutate` because spawning a
 * child is a control action; whatever that child then does is gated by the
 * child's own toolset, not by this classification.
 */
const CONTROL = new Set<string>([
  SUBMIT_RESULT_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  SPAWN_SUBAGENT_TOOL_NAME,
  ...AGENT_SUPERVISION_WIRE_NAMES,
]);

/**
 * Build the engine's {@link ToolEffectPort}.
 *
 * @param declared - what each registered capability says its own tools do, keyed
 *   by wire name (the union of every `Capability.toolEffects`).
 * @returns a port classifying a known name and reporting `unknown` for anything
 *   else — which is what makes an MCP tool refused by construction rather than
 *   by enumeration.
 * @remarks The engine's coding toolset is split by its eagerly available wire
 *   vocabulary, whose drift test is pinned to `@clarvis/tools`' actual surface.
 *   Everything the engine knows and is not read-only or control is `mutate`;
 *   `shell` and the monitors land there deliberately, since they observe and
 *   mutate through one entry point and no caller can treat them as safe without
 *   running the command.
 * @remarks The engine's own vocabulary is consulted **first**, so a capability
 *   can classify the tools it contributes but can never reclassify `shell` as
 *   `read`. A name a capability merely *reserved* without classifying is not in
 *   `declared` and lands on `unknown` — reservation and effect are two different
 *   questions, and answering both from the reservation list is what would let a
 *   workspace-mutating capability tool pass a gate that exists to refuse
 *   exactly that.
 */
export function createToolEffectPort(
  declared: Readonly<Record<string, ToolEffect>> = {},
): ToolEffectPort {
  return {
    effect(wireName: string): ToolEffect {
      if (CONTROL.has(wireName)) return "control";
      if (READ.has(wireName)) return "read";
      if (CODING.has(wireName)) return "mutate";
      return declared[wireName] ?? "unknown";
    },
  };
}
