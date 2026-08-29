import type { Scope } from "@clarvis/protocol";
import type { GuardModeStore } from "../../adapters/guard-mode.ts";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import {
  settingsForPreset,
  type CanonicalSafetyPreset,
  type SafetyPreset,
} from "../../adapters/execution-safety.ts";

/** Product vocabulary shared by every safety-preset selector. */
export interface SafetyPresetChoice {
  value: SafetyPreset;
  label: string;
  detail: string;
}

/** The six canonical execution postures a user can select. */
export const SAFETY_PRESET_CHOICES: readonly SafetyPresetChoice[] = [
  { value: "free", label: "free", detail: "direct, no approval" },
  { value: "judged", label: "judged", detail: "direct, LLM judge reviews risk" },
  { value: "approval", label: "approval", detail: "direct, always asks" },
  { value: "isolated", label: "isolated", detail: "sandboxed, autonomous" },
  { value: "reviewed", label: "reviewed", detail: "sandboxed, model reviews risk" },
  { value: "protected", label: "protected", detail: "sandboxed, always asks" },
];

/** Read-only row used when effective settings do not match a named posture. */
export const CUSTOM_SAFETY_PRESET_CHOICE: SafetyPresetChoice = {
  value: "custom",
  label: "custom",
  detail: "current settings do not match a preset",
};

/** Confirmation copy returned before a preset can discard containment or custom sandbox tuning. */
export interface SafetyPresetConfirmation {
  message: string;
  danger?: boolean;
  detail?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
}

function resetsCustomSandbox(sandbox: SettingsFile["sandbox"]): boolean {
  return (
    sandbox !== undefined &&
    ((sandbox.pass_env?.length ?? 0) > 0 ||
      (sandbox.availability ?? "required") !== "required" ||
      (sandbox.filesystem ?? "workspace-write") !== "workspace-write" ||
      (sandbox.network ?? "host") !== "host")
  );
}

/** Derives the single confirmation needed before applying a named preset. */
export function safetyPresetConfirmation(
  preset: CanonicalSafetyPreset,
  sandbox: SettingsFile["sandbox"],
): SafetyPresetConfirmation | null {
  const detail: string[] = [];
  if (preset === "free") {
    detail.push("Commands bypass both the native sandbox and command approval.");
  } else if (preset === "judged") {
    detail.push("Commands bypass the native sandbox; the LLM judge decides risky actions.");
    detail.push("If the judge cannot resolve, Clarvis asks you instead.");
  }
  if (resetsCustomSandbox(sandbox)) {
    detail.push("Custom pass_env, availability, filesystem, and network tuning will be reset.");
  }
  if (detail.length === 0) return null;
  const direct = preset === "free" || preset === "judged";
  return {
    message: direct
      ? `${preset === "free" ? "Free" : "Judged"} mode runs commands directly on the host. Use ${preset === "free" ? "Free" : "Judged"} mode?`
      : `The ${preset} preset resets the sandbox to its defaults.`,
    danger: direct,
    detail,
    confirmLabel: "use preset",
    cancelLabel: "keep current",
  };
}

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

/** Persists one canonical preset while retaining command policy and sandbox toolchain discovery. */
export async function applySafetyPreset(
  preset: CanonicalSafetyPreset,
  deps: {
    settings: SettingsAdapter;
    guard: GuardModeStore;
    scope: Scope;
  },
): Promise<void> {
  const currentSandbox = deps.settings.effective().sandbox;
  const patch = settingsForPreset(preset);
  patch.guard = {
    ...scopedGuardPolicy(deps.settings, deps.scope),
    ...patch.guard,
    type: "shell",
  };
  if (patch.sandbox && currentSandbox?.toolchains) {
    patch.sandbox.toolchains = currentSandbox.toolchains;
  }
  await deps.settings.write(deps.scope, patch);
  deps.guard.setMode(patch.guard.mode!);
}
