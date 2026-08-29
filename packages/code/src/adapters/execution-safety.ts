import { parseModelRef, PLANS_DEFAULTS } from "@clarvis/kernel/config";
import type { SettingsFile } from "./settings.ts";
import type { GuardMode } from "./guard-mode.ts";
import type { MemoryMode } from "./memory-mode.ts";

/**
 * A named sandbox/guard combination Run Controls offers, or `"custom"` when
 * the current settings don't match any named preset.
 */
export type SafetyPreset =
  "free" | "judged" | "approval" | "isolated" | "reviewed" | "protected" | "custom";
/** The presets a user can actually select — every {@link SafetyPreset} but `"custom"`. */
export type CanonicalSafetyPreset = Exclude<SafetyPreset, "custom">;

/** The effective safety/memory/planning policy Run Controls displays and edits. */
export interface RunControlsState {
  preset: SafetyPreset;
  sandboxEnabled: boolean;
  sandboxRequired: boolean;
  filesystem: "workspace-write" | "workspace-read-only";
  network: "host" | "none";
  guardMode: GuardMode;
  memory: MemoryState;
  plans: PlansState;
}

/** Canonical memory tri-state; see {@link memoryState} for how it's derived. */
export type MemoryState = "off" | "inert" | "on";

/** Planning mode as the UI names it. Mirrors the settings block's `mode`. */
export type PlanMode = "off" | "on" | "review";

/** What happens to a plan record once its run finishes cleanly. */
export type PlanHistory = "keep" | "discard";

/**
 * The effective planning policy for the next run.
 *
 * @remarks
 * `configured` records whether a `plans` block exists at all, which is what the
 * doctor and the first-use seed key off. An unconfigured workspace still
 * reports the product defaults for `mode`/`history`, because that is what a run
 * started right now would use.
 */
export interface PlansState {
  mode: PlanMode;
  history: PlanHistory;
  configured: boolean;
}

/** Plan retention named by its consequence, so every surface that shows it —
 * Run Controls, the Plan overlay, the doctor — uses one vocabulary. */
export function planHistoryLabel(history: PlanHistory): string {
  return history === "keep" ? "keep" : "delete after success";
}

/** The single "what will planning do on the next run" rule — Run Controls, the
 * header chip and the doctor gate must never disagree on it. */
export function plansState(settings: SettingsFile): PlansState {
  const block = settings.plans;
  if (block === undefined)
    return { mode: PLANS_DEFAULTS.mode, history: PLANS_DEFAULTS.retention, configured: false };
  return {
    mode: block.mode ?? PLANS_DEFAULTS.mode,
    history: block.retention ?? PLANS_DEFAULTS.retention,
    configured: true,
  };
}

/** The single "does this model token reach a declared provider" rule — the
 * doctor, the memory panel and the header chip must never disagree on it. */
export function modelResolves(model: string | undefined, settings: SettingsFile): boolean {
  if (!model) return false;
  try {
    const ref = parseModelRef(model);
    const provider = (settings.providers ?? []).find((p) => p.name === ref.provider);
    if (provider === undefined) return false;
    /**
     * A provider that declares models must declare *this* one.
     *
     * @remarks Matching the provider name alone reported `local/ghost` as
     * resolving whenever a provider named `local` existed, whatever models it
     * actually offered — so a broken `default_model` passed Doctor's gate and
     * was discovered by the first run instead. An absent or empty `models` map
     * is a provider that has not enumerated its catalogue, and there the
     * question is unanswerable from settings alone: resolving is the honest
     * answer, since the alternative is warning about every model on a provider
     * that simply did not list any.
     */
    const models = provider.models;
    return models === undefined || Object.keys(models).length === 0
      ? true
      : Object.hasOwn(models, ref.modelId);
  } catch {
    return false;
  }
}

/** Canonical memory tri-state: `off` (no block / disabled / session off),
 * `inert` (enabled but the extraction model — memory.model, else
 * default_model — does not resolve to a usable provider, so runs will not
 * learn), `on`. Every "memory: on" surface derives from here. */
export function memoryState(settings: SettingsFile, sessionMode: MemoryMode = "on"): MemoryState {
  const memory = settings.memory;
  if (memory === undefined || memory.enabled === false || sessionMode === "off") return "off";
  return modelResolves(memory.model ?? settings.default_model, settings) ? "on" : "inert";
}

/**
 * Classify the sandbox/guard pair as one of the six canonical safety presets.
 *
 * @param settings - the effective settings, read for its `sandbox` block.
 * @param guardMode - the session's guard mode.
 * @returns the preset, or `"custom"` when the combination is not canonical.
 * @remarks A preset is reported only when the sandbox and guard settings
 *   exactly match its canonical shape (see {@link settingsForPreset}); any
 *   other combination reports `"custom"` rather than guessing the closest one.
 *   This describes what is *configured* — whether the sandbox can actually run
 *   on this host is a separate question, and a caller that shows the preset to a
 *   user owes them that second answer too.
 */
export function deriveSafetyPreset(settings: SettingsFile, guardMode: GuardMode): SafetyPreset {
  const sandbox = settings.sandbox;
  const sandboxEnabled = sandbox !== undefined && sandbox.enabled !== false;
  const canonicalSandbox =
    sandboxEnabled &&
    (sandbox.availability ?? "required") === "required" &&
    (sandbox.filesystem ?? "workspace-write") === "workspace-write" &&
    (sandbox.network ?? "host") === "host";
  if (!sandboxEnabled && guardMode === "off") return "free";
  if (!sandboxEnabled && guardMode === "auto") return "judged";
  if (!sandboxEnabled && guardMode === "on") return "approval";
  if (canonicalSandbox && guardMode === "off") return "isolated";
  if (canonicalSandbox && guardMode === "auto") return "reviewed";
  if (canonicalSandbox && guardMode === "on") return "protected";
  return "custom";
}

/**
 * Derives the full {@link RunControlsState} from workspace settings plus the
 * session's current guard/memory mode.
 */
export function deriveRunControls(
  settings: SettingsFile,
  guardMode: GuardMode,
  memoryMode: MemoryMode,
): RunControlsState {
  const sandbox = settings.sandbox;
  const sandboxEnabled = sandbox !== undefined && sandbox.enabled !== false;

  return {
    preset: deriveSafetyPreset(settings, guardMode),
    sandboxEnabled,
    sandboxRequired: (sandbox?.availability ?? "required") === "required",
    filesystem: sandbox?.filesystem ?? "workspace-write",
    network: sandbox?.network ?? "host",
    guardMode,
    memory: memoryState(settings, memoryMode),
    plans: plansState(settings),
  };
}

/** Plain-language lines describing what the current sandbox/guard state means for a run. */
export function safetyDescription(state: RunControlsState): string[] {
  const lines: string[] = [];
  if (state.sandboxEnabled) {
    lines.push(
      !state.sandboxRequired
        ? "Commands use the native sandbox when available and may fall back to the host."
        : state.guardMode === "off"
          ? "Commands run autonomously inside the native sandbox."
          : state.guardMode === "auto"
            ? "Commands stay contained; the model escalates actions it judges risky."
            : "Risky actions ask first; approved commands remain contained.",
    );
    lines.push(
      state.filesystem === "workspace-read-only"
        ? "Shell commands see the workspace read-only."
        : "Shell commands may change this workspace.",
    );
    lines.push(
      state.network === "none"
        ? "Shell network access is disabled."
        : "Host network access is enabled.",
    );
  } else {
    lines.push(
      state.guardMode === "off"
        ? "Commands run directly without approval."
        : state.guardMode === "auto"
          ? "Commands run directly on the host after model review; uncertain actions ask you."
          : "Risky actions ask before running directly on the host.",
    );
  }
  return lines;
}

/** A plain-language line describing what the current memory state means for a run. */
export function memoryDescription(state: RunControlsState): string {
  return state.memory === "on"
    ? "Reads memory before the run and learns from it afterward."
    : state.memory === "inert"
      ? "Configured, but no extraction model resolves."
      : "Disabled for this session; runs neither read nor update memory.";
}

/** The consequence of the current planning policy, in the user's terms. */
export function plansDescription(state: RunControlsState): string[] {
  const { mode, history } = state.plans;
  const lines = [
    mode === "off"
      ? "The lead gets no plan tools and works without a written plan."
      : mode === "review"
        ? "The lead may explore first, but waits for your approval before executing its plan."
        : "The lead writes a plan and executes it without waiting for you.",
  ];
  if (mode !== "off")
    lines.push(
      history === "keep"
        ? "Plans stay available in the selected provider's history."
        : "Plans are deleted from the selected provider once the run's result is recorded; a crash always leaves them.",
    );
  return lines;
}

/** The canonical `guard`/`sandbox` settings shape for a given named preset. */
export function settingsForPreset(
  preset: CanonicalSafetyPreset,
): Pick<SettingsFile, "guard" | "sandbox"> {
  const sandboxOn = preset === "isolated" || preset === "reviewed" || preset === "protected";
  const guardMode: GuardMode =
    preset === "judged" || preset === "reviewed"
      ? "auto"
      : preset === "approval" || preset === "protected"
        ? "on"
        : "off";
  return {
    guard: { type: "shell", mode: guardMode },
    sandbox: {
      type: "native",
      enabled: sandboxOn,
      availability: "required",
      filesystem: "workspace-write",
      network: "host",
      toolchains: { mode: "auto" },
    },
  };
}
