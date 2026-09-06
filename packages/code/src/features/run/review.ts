import type { Scope } from "@clarvis/protocol";
import type { GuardMode, GuardModeStore } from "../../adapters/guard-mode.ts";
import { guardAutoResolves } from "../../adapters/guard-mode.ts";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";

export interface ReviewChoice {
  value: GuardMode;
  label: string;
  detail: string;
}

export const REVIEW_CHOICES: readonly ReviewChoice[] = [
  { value: "off", label: "Off", detail: "no command review or approval prompts" },
  { value: "on", label: "Approval", detail: "ask before unlisted or risky commands" },
  { value: "auto", label: "Auto", detail: "an LLM reviews risk and asks when unsure" },
];

function scopedGuardPolicy(
  settings: SettingsAdapter,
  scope: Scope,
): Partial<NonNullable<SettingsFile["guard"]>> {
  const local = settings.read(scope)?.guard;
  const inherited = scope === "workspace" ? settings.read("global")?.guard : undefined;
  const allowed = local?.allowed_commands ?? inherited?.allowed_commands;
  const denied = local?.denied_commands ?? inherited?.denied_commands;
  return {
    ...(allowed === undefined ? {} : { allowed_commands: [...allowed] }),
    ...(denied === undefined ? {} : { denied_commands: [...denied] }),
  };
}

/** Apply the independent command-review axis while preserving allow/deny policy. */
export async function applyReviewMode(
  requested: GuardMode,
  deps: { settings: SettingsAdapter; guard: GuardModeStore; scope: Scope },
): Promise<{ mode: GuardMode; degraded: boolean }> {
  const degraded = requested === "auto" && !guardAutoResolves(deps.settings);
  const mode: GuardMode = degraded ? "on" : requested;
  await deps.settings.write(deps.scope, {
    guard: { type: "shell", ...scopedGuardPolicy(deps.settings, deps.scope), mode },
  });
  deps.guard.setMode(mode);
  return { mode, degraded };
}
