import type { DispatchPolicy, ToolEffect, ToolEffectPort } from "@clarvis/capability";
import { CREATE_GOAL, GET_GOAL, UPDATE_GOAL } from "./tools.ts";

const ALLOWED_CONTROL = new Set([CREATE_GOAL, GET_GOAL, UPDATE_GOAL, "ask_user", "submit_result"]);

function refusal(effect: ToolEffect, name: string): string {
  if (effect === "spawn_run" || name === "delegate_task" || name === "spawn_subagent")
    return "Persist the Goal with create_goal before delegating or starting independent work.";
  if (name === "load_skill" || name === "read_skill_resource")
    return "Persist the Goal with create_goal before loading skills or executing skill-driven work.";
  if (effect === "unknown")
    return "Persist the Goal with create_goal before calling a tool whose effect is not known to be read-only.";
  return "Persist the Goal with create_goal before writing, running shell, or otherwise changing the workspace.";
}

/** Admit proven reads and clarification until durable creation; unknown effects are not reads. */
export function createFormulationDispatchPolicy(
  created: () => boolean,
  toolEffect: ToolEffectPort,
): DispatchPolicy {
  return {
    admit(call) {
      if (created()) return { ok: true };
      if (ALLOWED_CONTROL.has(call.name)) return { ok: true };
      const effect = toolEffect.effect(call.name);
      if (effect === "read") return { ok: true };
      return { ok: false, reason: refusal(effect, call.name) };
    },
  };
}
