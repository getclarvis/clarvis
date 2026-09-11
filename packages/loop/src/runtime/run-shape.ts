import type { EnvConfig } from "@clarvis/capability";
import type { RunRequest } from "@clarvis/capability";
import type { ResolvedConfig } from "@clarvis/capability";
import { deriveRunShape as deriveRequestShape } from "../validation/request-schema.ts";
import { sharedPromptForRun } from "./prompts/shared-agent-prompt.ts";
import type {
  ResolvedSubagentProfile,
  SubagentProfileRegistry,
} from "./subagents/subagent-profiles.ts";

/**
 * Resolve the run's hard {@link ResolvedConfig} from the request budget and env
 * defaults.
 *
 * @returns a config whose `max_tokens` is bounded only when `on_exceed` is
 *   `"stop"` with a token limit (otherwise unbounded); `timeout_ms` falls back
 *   to the env default.
 * @remarks Iteration and non-`stop` token limits are enforced elsewhere (per-agent
 *   caps, soft budgets), not by this hard config.
 */
export function resolveConfig(request: RunRequest, env: EnvConfig): ResolvedConfig {
  const timeoutMs = request.budget.timeout_ms ?? env.CLARVIS_DEFAULT_TIMEOUT_MS;
  return {
    max_tokens:
      request.budget.on_exceed === "stop"
        ? (request.budget.total_token_limit ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY,
    timeout_ms: timeoutMs,
  };
}

/**
 * The derived shape of a run: which entry profile runs and whether it is a lead,
 * the elicitation and soft-budget flags,
 * and the subagent profile registries (spawnable subset and full).
 *
 * @remarks A read-only summary computed once by {@link deriveRunShape} from the
 *   request and profile registry; every downstream builder (seed, entry input,
 *   accounting) reads its role and settings from here rather than re-deriving them.
 */
export interface RunShape {
  entryProfile: RunRequest["profiles"][number];
  entryResolved: ResolvedSubagentProfile;
  isLead: boolean;
  userInputEnabled: boolean;
  askUserGranted: boolean;
  softMode: boolean;
  spawnableRegistry: SubagentProfileRegistry;
  fullRegistry: SubagentProfileRegistry;
  primarySubagentModel: string;
  /**
   * Fleet-wide shared prompt snapshotted for this run.
   *
   * @remarks Resolved once from {@link RunRequest.shared_prompt}. `undefined`
   * means the shared layer is disabled for this run. Entry and every child
   * reuse this value rather than re-reading files.
   */
  sharedPrompt?: string;
}

/**
 * Derive the {@link RunShape} for a request: resolve its entry profile and role,
 * carry the elicitation/soft-budget flags from {@link deriveRunShape}, and
 * build the spawnable-profile registry from the entry profile's `can_spawn` list.
 *
 * @param request - the validated run request.
 * @param registry - the resolved subagent profiles, keyed by name.
 * @param capabilityNeedsHuman - whether any registered capability answered
 *   `requiresUserInput` for this request; folded into `userInputEnabled`, which
 *   is what gates the run's elicitation relay and prompt serializer.
 * @returns the run's {@link RunShape}.
 * @remarks `primarySubagentModel` is the lead's `default_spawn` (or the first
 *   spawnable profile) for a lead, else the entry profile's own model — it names
 *   the model surfaced in run-started telemetry.
 */
export function deriveRunShape(
  request: RunRequest,
  registry: SubagentProfileRegistry,
  capabilityNeedsHuman = false,
): RunShape {
  const {
    entry: entryProfile,
    isLead,
    userInputEnabled,
    askUserGranted,
    softMode,
  } = deriveRequestShape(request, capabilityNeedsHuman)!;
  const canSpawn = entryProfile.can_spawn ?? [];
  const spawnableProfiles = request.profiles.filter((p) => canSpawn.includes(p.name));
  const spawnableRegistry: SubagentProfileRegistry = new Map(
    spawnableProfiles.map((p) => [p.name, registry.get(p.name)!]),
  );
  const primarySubagentProfile = isLead
    ? (spawnableProfiles.find((p) => p.name === entryProfile.default_spawn) ??
      spawnableProfiles[0]!)
    : entryProfile;
  const sharedPrompt = sharedPromptForRun(request.shared_prompt);
  return {
    entryProfile,
    entryResolved: registry.get(entryProfile.name)!,
    isLead,
    userInputEnabled,
    askUserGranted,
    softMode,
    spawnableRegistry,
    fullRegistry: registry,
    primarySubagentModel: primarySubagentProfile.model,
    ...(sharedPrompt !== undefined ? { sharedPrompt } : {}),
  };
}
