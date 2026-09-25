import { parseModelRef, PLANS_DEFAULTS } from "@clarvis/kernel/config";
import type { SettingsFile } from "./settings.ts";
import type { MemoryMode } from "./memory-mode.ts";

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

/** Plan retention named by its consequence for the Plan overlay and doctor. */
export function planRetentionLabel(retention: PlanRetention): string {
  return retention === "keep" ? "keep" : "delete after success";
}

/** The single "what will planning do on the next run" rule shared by the
 * header chip and doctor gate. */
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

/** Whether a model token reaches a declared provider. */
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

/** Canonical memory tri-state for the next run. */
export function memoryState(
  settings: SettingsFile,
  mode: MemoryMode = "off",
  runModel = settings.default_model,
): MemoryState {
  if (mode === "off") return "off";
  return modelResolves(runModel, settings) ? "on" : "inert";
}
