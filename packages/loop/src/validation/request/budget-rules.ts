import type { EnvConfig } from "@clarvis/capability";
import { ValidationError } from "@clarvis/capability";
import type { ParsedRunRequest } from "./request-schema.ts";
import type { RunShape } from "./run-shape.ts";

export function enforceBudgetMode(data: ParsedRunRequest, shape: RunShape): void {
  const { entry, isLead } = shape;
  const canSpawn = entry.can_spawn ?? [];
  const spawnable = data.profiles.filter((p) => canSpawn.includes(p.name));
  const runningAgents = isLead ? [entry, ...spawnable] : [entry];
  const tokenLimit = data.budget.total_token_limit;

  if (data.budget.on_exceed === "stop") {
    if (tokenLimit === undefined) {
      throw new ValidationError(
        "invalid_token_limit",
        "budget.total_token_limit is required when on_exceed='stop'.",
      );
    }
    for (const agent of runningAgents) {
      if (agent.iteration_limit === undefined) {
        throw new ValidationError(
          "invalid_iteration_limit",
          `profile '${agent.name}'.iteration_limit is required when on_exceed='stop'.`,
        );
      }
    }
    if (data.budget.max_escalations !== undefined) {
      throw new ValidationError(
        "invalid_budget_mode",
        "budget.max_escalations is only valid when on_exceed='escalate'.",
      );
    }
  } else {
    if (tokenLimit === undefined && entry.iteration_limit === undefined) {
      throw new ValidationError(
        "invalid_budget_mode",
        "on_exceed='escalate' needs an escalatable bound on the entry (the finalizer): set " +
          "budget.total_token_limit or the entry's iteration_limit.",
      );
    }
  }
}

/**
 * Reject any request bound that exceeds its configured env ceiling (MCP
 * servers, token, iteration, timeout, escalation).
 *
 * @param env - the resolved {@link EnvConfig} holding the `CLARVIS_*_CEILING` caps.
 * @throws {@link ValidationError} (`invalid_server_config`, `invalid_token_limit`,
 *   `invalid_iteration_limit`, `invalid_timeout`, or `invalid_max_escalations`)
 *   on the first over-ceiling value.
 */
export function enforceEnvCeilings(data: ParsedRunRequest, env: EnvConfig): void {
  if (data.servers.length > env.CLARVIS_MCP_MAX_SERVERS_PER_RUN) {
    throw new ValidationError(
      "invalid_server_config",
      `servers contains ${String(data.servers.length)} entries, exceeding CLARVIS_MCP_MAX_SERVERS_PER_RUN (${String(env.CLARVIS_MCP_MAX_SERVERS_PER_RUN)})`,
    );
  }
  const tokenLimit = data.budget.total_token_limit;
  if (tokenLimit !== undefined && tokenLimit > env.CLARVIS_TOKEN_CEILING) {
    throw new ValidationError(
      "invalid_token_limit",
      `total_token_limit (${tokenLimit}) exceeds CLARVIS_TOKEN_CEILING (${env.CLARVIS_TOKEN_CEILING})`,
    );
  }
  for (const agent of data.profiles) {
    if (
      agent.iteration_limit !== undefined &&
      agent.iteration_limit > env.CLARVIS_ITERATION_CEILING
    ) {
      throw new ValidationError(
        "invalid_iteration_limit",
        `profile '${agent.name}'.iteration_limit (${agent.iteration_limit}) exceeds CLARVIS_ITERATION_CEILING (${env.CLARVIS_ITERATION_CEILING})`,
      );
    }
  }
  if (
    data.budget.timeout_ms !== undefined &&
    data.budget.timeout_ms > env.CLARVIS_TIMEOUT_CEILING_MS
  ) {
    throw new ValidationError(
      "invalid_timeout",
      `timeout_ms (${data.budget.timeout_ms}) exceeds CLARVIS_TIMEOUT_CEILING_MS (${env.CLARVIS_TIMEOUT_CEILING_MS})`,
    );
  }
  if (
    data.budget.max_escalations !== undefined &&
    data.budget.max_escalations > env.CLARVIS_ESCALATION_CEILING
  ) {
    throw new ValidationError(
      "invalid_max_escalations",
      `max_escalations (${data.budget.max_escalations}) exceeds CLARVIS_ESCALATION_CEILING (${env.CLARVIS_ESCALATION_CEILING})`,
    );
  }
}

/**
 * Rejects a `headers`/`body` pair that would fail invisibly at request time.
 *
 * @param name - the provider, for the diagnostic.
 * @param where - `undefined` for the provider's own maps, else the model id.
 * @param kind - the provider kind, which decides whether `body` is honoured.
 * @param used - whether this run resolves any model against this provider; see
 *   {@link referencedProviders}, which counts more than the profiles.
 * @throws {@link ValidationError} `invalid_provider_config` on the first
 *   violation.
 * @remarks Three rules. A malformed `${` in a header would reach the wire
 *   verbatim, looking exactly like a resolved value. A forbidden `body` key
 *   breaks something with no error and no symptom — `messages` and `tools`
 *   *are* the cached prefix, and the rest are resolved per call. And `body` on
 *   a kind whose SDK has no request-body seam is refused rather than dropped,
 *   because a silently ignored routing block is worse than one that fails loudly.
 *
 *   The last rule fires **only for a provider this run resolves a model
 *   against** ({@link referencedProviders}). `providers` is
 *   a whole-workspace registry, so rejecting a `body` on an entry nothing in
 *   this run uses would fail every run in the workspace over a setting that can
 *   never affect any of them — and `settings.json` validates it as well-formed
 *   on save, so the user has no diagnostic tying the two together. The two
 *   rules above stay unconditional because they describe a value that is
 *   malformed or destructive wherever it is used.
 */
