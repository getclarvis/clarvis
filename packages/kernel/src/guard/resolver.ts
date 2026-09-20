import { judgeRequestConfig, type EffectReviewConfig } from "@clarvis/judge/settings";
import {
  NOOP_LOGGER,
  OPERATOR_AUTHORITY_PORT,
  PLANS_REVIEW_CONTEXT_PORT,
  type RunCapabilityContext,
} from "@clarvis/capability";
import type {
  Guard,
  GuardElicit,
  GuardMode,
  GuardResolution,
  GuardResolver,
  Logger,
  ProviderConfig,
} from "@clarvis/loop";
import { defaultGuardMode, type GuardConfig, type SandboxSettings } from "@clarvis/loop/host";
import { sandboxWouldApply } from "@clarvis/tools/sandbox";
import type { GuardPlacement } from "@clarvis/tools/guard";
import { createShellGuard, type ShellGuardDecision } from "./shell-guard.ts";
import { createGuardSessionAllowlist, type GuardSessionAllowlist } from "./guard-elicit.ts";
import { createGuardHumanApproval, type GuardHumanApproval } from "./human-approval.ts";
import { JUDGE_PORT } from "@clarvis/judge";
import { createCommandReview } from "./command-review.ts";

/** Snapshot of settings fields needed to resolve a run-time tool guard. */
export interface GuardSettings {
  /** Already scope-resolved shared reviewer configuration. */
  effect_review?: EffectReviewConfig;
  /** Guard mode, command allow/deny lists, and judge config. */
  guard?: GuardConfig;
  /** Providers available for resolving an auto-mode judge model. */
  providers?: ProviderConfig[];
  /** Settings-level default model, the judge's fallback when it names none. */
  defaultModel?: string;
  /** Effective native policy, including any host-resolved fail-closed fallback. */
  sandbox?: SandboxSettings;
  /** Host-selected container placement; never read from tool arguments. */
  runtime?: { backend: "native" | "docker" | "podman"; network?: "none" | "internet" | "outbound" };
}

/** Loads current {@link GuardSettings} (typically from merged config). */
export type GuardSettingsLoader = () => GuardSettings;

/** Dependencies for {@link createGuardResolver}. */
export interface GuardResolverDeps {
  /** Reads the live {@link GuardSettings}, re-invoked on every resolution. */
  loadSettings: GuardSettingsLoader;
  /** Optional logger passed down to the judge (falls back to the run's logger). */
  logger?: Logger;
  /**
   * Where command-approval decisions are recorded.
   *
   * @remarks Deliberately *not* {@link GuardResolverDeps.logger}. A guard ruling
   * is an audit record, not a diagnostic: `CLARVIS_LOG_LEVEL=warn` is a
   * legitimate production setting and it must not silence the record of what a
   * run was allowed to execute. The host supplies a level-pinned sibling of its
   * own logger, sharing its destination — see `createAuditLogger`.
   */
  audit?: Logger;
  /**
   * Resolve volatile consent on each command by the host's current controller. Returning undefined
   * disables session approval; omitting the port preserves the ordinary resolver-local lifetime.
   */
  sessionAllowlistFor?: (run: {
    executionId: string;
    owner: string;
  }) => GuardSessionAllowlist | undefined;
  /** Remote human authority for guests; a missing authority never creates a local consent cache. */
  humanApprovalFor?: (run: {
    executionId: string;
    owner: string;
  }) => GuardHumanApproval | undefined;
}

/** Run fields required to resolve command review outside the loop capability lifecycle. */
export type GuardRuntimeContext = Pick<
  RunCapabilityContext,
  | "request"
  | "requestParam"
  | "owner"
  | "env"
  | "workspaceRoot"
  | "llm"
  | "elicit"
  | "logger"
  | "signal"
  | "executionId"
> &
  Partial<Pick<RunCapabilityContext, "services">>;

/**
 * Picks effective guard mode: explicit request param, else settings default.
 *
 * @param param - the per-run `guard_mode` request override, if any.
 * @param guard - the guard settings block whose default applies when `param` is
 *   absent.
 * @returns the request override when set, otherwise `defaultGuardMode(guard)`.
 */
export function resolveGuardMode(
  param: GuardMode | undefined,
  guard: GuardConfig | undefined,
): GuardMode {
  return param ?? defaultGuardMode(guard);
}

/**
 * Whether a run's effective guard mode routes bash confirmations to a *human*.
 *
 * @param param - the per-run `guard_mode` request override, if any.
 * @param guard - the guard settings block supplying the default.
 * @param judgeConfigured - whether the effective reviewer model/provider resolves.
 * @param onUnsure - whether unavailable automatic review explicitly falls back to a human.
 * @returns `true` only for mode `on`. Auto never parks on a human.
 * @remarks Approval asks a person only for the grey zone that is neither an
 *   allow-list match nor a dangerous match. Auto denies unsure and never elicits.
 */
export function guardParksOnHuman(
  param: GuardMode | undefined,
  guard: GuardConfig | undefined,
  _judgeConfigured?: boolean,
  _onUnsure?: "ask" | "deny",
): boolean {
  return resolveGuardMode(param, guard) === "on";
}

/**
 * Builds the bash {@link Guard} for a resolved mode.
 *
 * @param guardConfig - the guard settings supplying the allow/deny command lists.
 * @param mode - the effective guard mode.
 * @param onDecision - observer notified of every ruling.
 * @param placement - host-attested run placement.
 * @param network - native networking policy, when one applies.
 * @returns `undefined` when `mode` is `"off"` (no guarding); otherwise a
 *   {@link createShellGuard} wired with the configured allow/deny lists.
 * @remarks The policy decides alone: `allow` runs, `deny` refuses, and `ask`
 *   reaches whoever may answer it under the mode. No later step reclassifies a
 *   deterministic ruling.
 */
function buildGuard(
  guardConfig: GuardConfig | undefined,
  mode: GuardMode,
  onDecision: (decision: ShellGuardDecision) => void,
  placement: GuardPlacement,
  network: "none" | "host" | undefined,
): Guard | undefined {
  if (mode === "off") return undefined;
  const guard = createShellGuard({
    ...(guardConfig?.allowed_commands !== undefined
      ? { allowedCommands: guardConfig.allowed_commands }
      : {}),
    ...(guardConfig?.denied_commands !== undefined
      ? { deniedCommands: guardConfig.denied_commands }
      : {}),
    onDecision,
    allowHostJudge: mode === "auto",
    placement,
    ...(network !== undefined ? { network } : {}),
  });
  return async (ctx) => ({ ...(await guard(ctx)), mode });
}

/**
 * Record one ruling on the audit channel.
 *
 * @param audit - the run-bound audit logger.
 * @param mode - the run's effective guard mode.
 * @param decision - the ruling, as {@link createShellGuard} reported it.
 * @remarks Extracted rather than inlined as a closure so it has a coverage
 * counter of its own; a callback body folded into its enclosing function is
 * counted against that function's lines whether or not it ever ran.
 */
function recordDecision(audit: Logger, mode: GuardMode, decision: ShellGuardDecision): void {
  audit.info(
    {
      event: "guard.decision",
      verdict: decision.verdict,
      matched: decision.matched,
      mode,
      tool: decision.tool,
      ...(decision.escalate !== undefined ? { escalate: decision.escalate } : {}),
      ...(decision.commandDigest !== undefined ? { command_digest: decision.commandDigest } : {}),
    },
    "the command guard ruled on a tool call; an 'ask' still needs an answer before the call runs",
  );
}

/**
 * Who answered an `ask`, and how.
 *
 * @param audit - the run-bound audit logger.
 * @param answerer - which channel produced the answer.
 * @param allowed - whether the call was permitted.
 * @param persisted - whether the answer also widened the session allow list.
 */
function recordAnswer(
  audit: Logger,
  answerer: "human" | "judge" | "session_allowlist",
  allowed: boolean,
  persisted: boolean,
): void {
  audit.info(
    {
      event: "guard.elicit.answered",
      answer: allowed ? (persisted ? "allow_session" : "allow") : "deny",
      answerer,
    },
    "a guarded command was answered; the tool call proceeds only on an allow",
  );
}

/**
 * Refuse an escalated ask that has nowhere to go, and say so.
 *
 * @param audit - the run-bound audit logger.
 * @param runId - the run whose command was refused.
 * @returns `false`, always — `applyGuard` reads that as a denial.
 * @remarks This is the one denial a user can neither see nor answer: the
 * command needed host-only human authority, and this
 * host configured no human channel. Failing closed is right; failing closed in
 * silence is what this removes.
 */
function noHumanChannel(audit: Logger, runId: string): { allowed: false; answerer: "unavailable" } {
  audit.warn(
    { event: "guard.escalation.no_channel", run_id: runId },
    "a command needed a human decision and this run has no channel to ask on; it is denied and cannot be appealed",
  );
  return { allowed: false, answerer: "unavailable" };
}

/**
 * Builds the shared guard runtime resolver: bash allow/deny lists, human elicit for `on`, optional LLM judge for `auto`.
 *
 * @param deps - the settings loader and optional logger; see
 *   {@link GuardResolverDeps}.
 * @returns a resolver that, per run, reads settings, computes the mode, and
 *   returns `undefined` in mode `off` (no guard). Otherwise it returns a guard
 *   plus an elicit: `on` uses the human prompt for grey-zone asks; `auto` routes
 *   every `ask` without applicable session consent straight to the LLM judge and
 *   never elicits a person. The chosen elicit is wrapped so a command already
 *   covered by the session allowlist passes without prompting.
 * @remarks The default {@link GuardSessionAllowlist} is shared across this resolver's runs.
 *   A persistent host supplies `sessionAllowlistFor` to bind consent to live interactive control.
 *   Each human question captures its current list, so late responses cannot authorize a new scope.
 *   The review model falls back to `CLARVIS_DEFAULT_MODEL` from the run env when settings
 *   name none.
 *
 *   Auto has exactly two outcomes for an `ask`: session consent already covers it, or the Judge
 *   decides the complete call. Nothing between the policy and the Judge classifies the command
 *   again — no effect catalogue, operation rule, probe or compiled grant — so a recognised
 *   operation cannot be refused before review and an unclassified composition cannot reach it by
 *   accident.
 */
function createGuardRuntimeResolver(
  deps: GuardResolverDeps,
): (ctx: GuardRuntimeContext) => GuardResolution | undefined {
  const defaultAllowlist =
    deps.sessionAllowlistFor === undefined && deps.humanApprovalFor === undefined
      ? createGuardSessionAllowlist()
      : undefined;
  const auditRoot = deps.audit ?? NOOP_LOGGER;
  return (ctx): GuardResolution | undefined => {
    const settings = deps.loadSettings();
    const judgeConfig = judgeRequestConfig(ctx);
    const guardMode = resolveGuardMode(ctx.request.guard_mode, settings.guard);
    const audit = auditRoot.child?.({ run_id: ctx.executionId, owner: ctx.owner }) ?? auditRoot;
    const container =
      settings.runtime?.backend === "docker" || settings.runtime?.backend === "podman";
    const placement: GuardPlacement =
      container || sandboxWouldApply(settings.sandbox) ? "contained" : "host";
    const network = container
      ? settings.runtime?.network === "none"
        ? "none"
        : undefined
      : sandboxWouldApply(settings.sandbox)
        ? settings.sandbox?.network
        : undefined;
    const guard = buildGuard(
      settings.guard,
      guardMode,
      (decision) => recordDecision(audit, guardMode, decision),
      placement,
      network,
    );
    if (guard === undefined) return undefined;
    const sessionAllowlist = (): GuardSessionAllowlist | undefined =>
      deps.sessionAllowlistFor === undefined ? defaultAllowlist : deps.sessionAllowlistFor(ctx);
    const approval =
      deps.humanApprovalFor !== undefined
        ? deps.humanApprovalFor(ctx)
        : ctx.elicit === undefined
          ? undefined
          : createGuardHumanApproval({
              elicit: ctx.elicit,
              allowlist: sessionAllowlist,
              workspaceRoot: ctx.workspaceRoot,
              signal: ctx.signal,
            });
    const humanElicit: GuardElicit | undefined =
      approval === undefined
        ? undefined
        : async (req) => {
            const answer = await approval.ask(
              req.matched === "host_command" ? { ...req, escalate: "human" } : req,
            );
            recordAnswer(audit, "human", answer.allowed, answer.persisted);
            return { allowed: answer.allowed, answerer: "human" };
          };
    const judgeElicit =
      guardMode === "auto"
        ? createCommandReview(
            {
              judge: () => ctx.services?.get(JUDGE_PORT),
              authority: ctx.services?.get(OPERATOR_AUTHORITY_PORT),
              reviewContext: () => ctx.services?.get(PLANS_REVIEW_CONTEXT_PORT),
              signal: ctx.signal,
            },
            { ...settings.effect_review, ...judgeConfig, on_unsure: "deny" },
          )
        : undefined;
    const chosenHuman = guardMode === "on" ? humanElicit : undefined;
    audit.info(
      {
        event: "guard.resolved",
        mode: guardMode,
        source: ctx.request.guard_mode !== undefined ? "request" : "settings",
        judge_configured: judgeConfig !== undefined,
        human_channel: chosenHuman !== undefined,
      },
      "the run's command guard is resolved; every guarded call is ruled on under this mode",
    );
    /**
     * Approval reviews grey-zone asks on the human channel and never falls through to the Judge.
     * Auto routes every ask the policy did not deterministically resolve, and that applicable
     * session consent does not already cover, straight to the Judge for the complete call. Only the
     * allow/deny lists decide without review, and a `deny` never becomes an `ask`.
     */
    const elicit: GuardElicit | undefined =
      chosenHuman !== undefined || judgeElicit !== undefined
        ? async (req) => {
            if (guardMode !== "auto" && req.escalate === "human") {
              if (humanElicit === undefined) return noHumanChannel(audit, ctx.executionId);
              return humanElicit(req);
            }
            const afterCoverage = (covered: boolean): ReturnType<GuardElicit> => {
              if (covered) {
                recordAnswer(audit, "session_allowlist", true, false);
                return { allowed: true, answerer: "session_allowlist" };
              }
              if (judgeElicit !== undefined)
                return judgeElicit(req).then((answer) => {
                  if (answer.answerer === "judge")
                    recordAnswer(audit, "judge", answer.allowed, false);
                  return answer;
                });
              if (chosenHuman === undefined) return noHumanChannel(audit, ctx.executionId);
              return chosenHuman(req);
            };
            const covered =
              req.matched === "host_command" ? false : (approval?.covers(req) ?? false);
            return typeof covered === "boolean"
              ? afterCoverage(covered)
              : covered.then(afterCoverage);
          }
        : undefined;
    return { guard, ...(elicit !== undefined ? { elicit } : {}) };
  };
}

/** Build the loop capability resolver over the shared host guard implementation. */
export function createGuardResolver(deps: GuardResolverDeps): GuardResolver {
  return createGuardRuntimeResolver(deps);
}
