import { parseModelRef, PLANS_DEFAULTS } from "@clarvis/kernel/config";
import type { SettingsFile } from "./settings.ts";
import type { GuardMode } from "./guard-mode.ts";
import type { MemoryMode } from "./memory-mode.ts";
import type { RuntimeStatus } from "@clarvis/protocol";

/** User-facing execution boundary, independent from command review. */
export type IsolationMode = "host" | "sandbox" | "docker" | "podman";

/** Actual active native placement overrides next-run preferences; an idle native host does not. */
export function effectiveRunIsolation(
  configured: IsolationMode,
  runtime: RuntimeStatus | undefined,
  active: boolean,
): IsolationMode {
  if (runtime?.kind === "native" && (active || runtime.lifecycle === "fallback"))
    return runtime.isolation;
  if (runtime?.kind === "container") return runtime.engine;
  return configured;
}

/** Effective safety, memory and planning state consumed by the shell and Run Controls. */
export interface RunControlsState {
  isolation: IsolationMode;
  sandboxEnabled: boolean;
  sandboxRequired: boolean;
  filesystem: "workspace-write" | "workspace-read-only";
  network: "host" | "none" | "internet" | "outbound";
  guardMode: GuardMode;
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

/** Resolve the configured execution boundary without folding command review into it. */
export function deriveIsolation(settings: SettingsFile): IsolationMode {
  if (settings.runtime?.backend === "docker") return "docker";
  if (settings.runtime?.backend === "podman") return "podman";
  const sandbox = settings.sandbox;
  return sandbox !== undefined && sandbox.enabled !== false ? "sandbox" : "host";
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
  const isolation = deriveIsolation(settings);
  const runtimeNetwork =
    settings.runtime?.backend === "docker" || settings.runtime?.backend === "podman"
      ? (settings.runtime.network ?? "outbound")
      : undefined;

  return {
    isolation,
    sandboxEnabled,
    sandboxRequired: (sandbox?.availability ?? "required") === "required",
    filesystem: sandbox?.filesystem ?? "workspace-write",
    network: runtimeNetwork ?? sandbox?.network ?? "host",
    guardMode,
    memory: memoryState(settings, memoryMode),
    plans: plansState(settings),
  };
}

/** Plain-language lines describing what the current sandbox/guard state means for a run. */
export function safetyDescription(state: RunControlsState): string[] {
  const lines: string[] = [];
  if (state.isolation === "docker" || state.isolation === "podman") {
    lines.push(
      `Agent tools run inside a Linux ${state.isolation === "docker" ? "Docker" : "Podman"} container.`,
    );
    lines.push(
      "The selected workspace is mounted directly; changes appear on the host immediately.",
    );
    lines.push(
      state.network === "none"
        ? "Container network access is disabled."
        : "Outbound network access is enabled; guest services can be exposed to the host.",
    );
    lines.push(
      state.guardMode === "off"
        ? "Commands run without command review."
        : state.guardMode === "auto"
          ? "Commands use model review; uncertain actions ask you."
          : "Risky commands ask before running.",
    );
    return lines;
  }
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

/** Plain-language consequences of the completed-plan retention default. */
export function planRetentionDescription(retention: PlanRetention): string[] {
  return retention === "keep"
    ? ["Completed plans remain available in the selected provider."]
    : [
        "Successful runs delete their plan after the result is recorded.",
        "Failed, cancelled or interrupted runs keep their plan.",
      ];
}
