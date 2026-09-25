import { parseModelRef, PLANS_DEFAULTS } from "@clarvis/kernel/config";
import type { SettingsFile } from "./settings.ts";
import type { MemoryMode } from "./memory-mode.ts";

/** Effective memory and planning state consumed by the shell and Run Controls. */
export interface RunControlsState {
  memory: MemoryState;
  plans: PlansState;
}

/** Canonical memory tri-state; see {@link memoryState} for how it's derived. */
export type MemoryState = "off" | "inert" | "on";

/** Effective planning mode consumed by `/plan`, Doctor and the run host. */
export type PlanMode = "off" | "on" | "review";

/** What happens to a plan record once its run finishes cleanly. */
export type PlanRetention = "keep" | "discard";

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
  retention: PlanRetention;
  configured: boolean;
}

/** Plan retention named by its consequence, so every surface that shows it —
 * Run Controls, the Plan overlay, the doctor — uses one vocabulary. */
export function planRetentionLabel(retention: PlanRetention): string {
  return retention === "keep" ? "keep" : "delete after success";
}

/** The single "what will planning do on the next run" rule — Run Controls, the
 * header chip and the doctor gate must never disagree on it. */
export function plansState(settings: SettingsFile): PlansState {
  const block = settings.plans;
  if (block === undefined)
    return { mode: PLANS_DEFAULTS.mode, retention: PLANS_DEFAULTS.retention, configured: false };
  return {
    mode: block.mode ?? PLANS_DEFAULTS.mode,
    retention: block.retention ?? PLANS_DEFAULTS.retention,
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
 * Derives the full {@link RunControlsState} from workspace settings plus the
 * session's current memory mode.
 */
export function deriveRunControls(
  settings: SettingsFile,
  memoryMode: MemoryMode,
): RunControlsState {
  return {
    memory: memoryState(settings, memoryMode),
    plans: plansState(settings),
  };
}

/** A plain-language line describing what the current memory state means for a run. */
export function memoryDescription(state: RunControlsState): string {
  return state.memory === "on"
    ? "Reads memory before the run and learns from it afterward."
    : state.memory === "inert"
      ? "Configured, but no extraction model resolves."
      : "Disabled for this session; runs neither read nor update memory.";
}

/** Plain-language consequences of the completed-plan retention default. */
export function planRetentionDescription(retention: PlanRetention): string[] {
  return retention === "keep"
    ? ["Completed plans remain available in the selected provider."]
    : [
        "Successful runs delete their plan after the result is recorded.",
        "Failed, cancelled or interrupted runs keep their plan.",
      ];
}
