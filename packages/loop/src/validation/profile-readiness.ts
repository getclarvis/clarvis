import { parseModelRef } from "@clarvis/capability";
import { modelField } from "./request-schema.ts";

/**
 * A single problem found when checking whether one agent profile could start a
 * run, pairing a machine-readable {@link ReadinessCode} with a human message.
 *
 * @remarks Advisory only — these mirror the hard {@link validateBody} rules so a
 *   UI can flag an unrunnable Agent Profile ahead of time, without duplicating the
 *   loop's error codes.
 */
export interface ReadinessIssue {
  code: ReadinessCode;
  message: string;
}

/** Discriminator for the profile-level readiness problems this module detects. */
export type ReadinessCode =
  | "missing_model"
  | "invalid_model"
  | "unknown_provider"
  | "budget_needs_limit"
  | "unknown_spawn_target"
  | "default_spawn_not_in_can_spawn"
  | "orchestration_needs_can_spawn"
  | "unknown_grant"
  | "malformed_frontmatter";

/**
 * The subset of an agent profile the readiness rules inspect — a loose,
 * settings-shaped view (all fields optional) rather than the strict
 * request-schema profile, so a partial or in-progress config can be checked.
 */
export interface ReadinessProfile {
  model?: string;
  grants?: readonly string[];
  can_spawn?: readonly string[];
  default_spawn?: string;
  orchestration?: object;
  budget?: { on_exceed?: string; total_token_limit?: number };
}

/** The profile under test plus the surrounding facts each rule needs to judge it. */
export interface ReadinessContext {
  profile: ReadinessProfile;
  /** Names of every known agent profile; spawn targets are checked against it. */
  registryNames: readonly string[];
  /** Declared provider names (providers[].name in settings). */
  providerNames: readonly string[];
  /** Entry-model fallback: settings.default_model ?? CLARVIS_DEFAULT_MODEL. */
  defaultModel?: string;
  /**
   * Every grant the run this profile would start will accept: the engine's
   * built-ins plus whatever the host's capability registry declares.
   *
   * @remarks Optional, and the `unknown_grant` rule is skipped when it is
   *   absent — a caller that cannot see the host's registry must not report a
   *   capability-owned grant as unknown. Supplying it is what makes readiness
   *   agree with `requireKnownGrants`, which throws at run-request time: a
   *   profile naming a grant no capability declares was reported "runnable" by
   *   every UI while every run in the workspace died in milliseconds.
   */
  knownGrants?: readonly string[];
}

/**
 * One readiness check: a {@link ReadinessCode}, the {@link validateBody} rule it
 * mirrors, and a `check` that returns any {@link ReadinessIssue}s it finds.
 *
 * @remarks `mirrors` names the hard-validation counterpart so the two stay in
 *   lockstep and a parity test can anchor on it.
 */
export interface ReadinessRule {
  code: ReadinessCode;
  /** The validateBody counterpart this rule mirrors (documentation + parity test anchor). */
  mirrors: string;
  check: (ctx: ReadinessContext) => ReadinessIssue[];
}

/** The effective model: the profile's own, falling back to `ctx.defaultModel`. */
function resolvedModel(ctx: ReadinessContext): string | undefined {
  return ctx.profile.model ?? ctx.defaultModel;
}

/**
 * The ordered set of profile-readiness checks, each mirroring a hard
 * {@link validateBody} rule: model presence/format, provider declaration,
 * budget bound, spawn-target validity, `default_spawn` membership, and
 * lead-only `orchestration`.
 *
 * @remarks Iterated by {@link profileReadinessIssues}; keeping them as data (not
 *   inline code) lets a parity test enumerate them against the loop's rules.
 */
export const PROFILE_READINESS_RULES: readonly ReadinessRule[] = [
  {
    code: "missing_model",
    mirrors: "runRequestSchema: profiles[].model is required",
    check: (ctx) =>
      resolvedModel(ctx) === undefined
        ? [
            {
              code: "missing_model",
              message: "no model (agent, default_model, or CLARVIS_DEFAULT_MODEL)",
            },
          ]
        : [],
  },
  {
    code: "invalid_model",
    mirrors: "runRequestSchema: modelField '<provider>/<name>' format",
    check: (ctx) => {
      const model = resolvedModel(ctx);
      if (model === undefined || modelField.safeParse(model).success) return [];
      return [{ code: "invalid_model", message: `model '${model}' is not provider/modelId` }];
    },
  },
  {
    code: "unknown_provider",
    mirrors: "requireResolvableModelProviders",
    check: (ctx) => {
      const model = resolvedModel(ctx);
      if (model === undefined || !modelField.safeParse(model).success) return [];
      const provider = parseModelRef(model).provider;
      if (ctx.providerNames.includes(provider)) return [];
      return [
        {
          code: "unknown_provider",
          message: `model '${model}' → undeclared provider '${provider}'`,
        },
      ];
    },
  },
  {
    code: "budget_needs_limit",
    mirrors: "enforceBudgetMode: on_exceed='stop' requires total_token_limit",
    check: (ctx) => {
      const budget = ctx.profile.budget;
      if (budget?.on_exceed !== "stop" || budget.total_token_limit != null) return [];
      return [
        {
          code: "budget_needs_limit",
          message: "budget on_exceed=stop needs total_token_limit",
        },
      ];
    },
  },
  {
    code: "unknown_spawn_target",
    mirrors: "requireKnownSpawnTargets: can_spawn names",
    check: (ctx) =>
      (ctx.profile.can_spawn ?? [])
        .filter((t) => !ctx.registryNames.includes(t))
        .map((t) => ({
          code: "unknown_spawn_target" as const,
          message: `can_spawn '${t}' is not a known agent`,
        })),
  },
  {
    code: "default_spawn_not_in_can_spawn",
    mirrors: "requireKnownSpawnTargets: default_spawn ∈ can_spawn",
    check: (ctx) => {
      const d = ctx.profile.default_spawn;
      if (d === undefined || (ctx.profile.can_spawn ?? []).includes(d)) return [];
      return [
        {
          code: "default_spawn_not_in_can_spawn",
          message: `default_spawn '${d}' not in can_spawn`,
        },
      ];
    },
  },
  {
    code: "unknown_grant",
    mirrors: "requireKnownGrants: profile grants are engine- or capability-declared",
    check: (ctx) => {
      const known = ctx.knownGrants;
      if (known === undefined) return [];
      const vocabulary = new Set(known);
      return (ctx.profile.grants ?? [])
        .filter((grant) => !vocabulary.has(grant))
        .map((grant) => ({
          code: "unknown_grant" as const,
          message: `grant '${grant}' is not declared by the engine or any capability`,
        }));
    },
  },
  {
    code: "orchestration_needs_can_spawn",
    mirrors: "enforcePerProfileRules: orchestration is lead-only",
    check: (ctx) => {
      if (ctx.profile.orchestration === undefined || (ctx.profile.can_spawn?.length ?? 0) > 0)
        return [];
      return [
        {
          code: "orchestration_needs_can_spawn",
          message: "orchestration is lead-only (set a non-empty can_spawn)",
        },
      ];
    },
  },
];

/**
 * Run every {@link PROFILE_READINESS_RULES | readiness rule} against a profile
 * and collect all issues.
 *
 * @param ctx - the profile and its surrounding registry/provider context.
 * @returns the flattened list of {@link ReadinessIssue}s (empty when the profile
 *   looks runnable); advisory, not a substitute for {@link validateBody}.
 */
export function profileReadinessIssues(ctx: ReadinessContext): ReadinessIssue[] {
  return PROFILE_READINESS_RULES.flatMap((rule) => rule.check(ctx));
}
