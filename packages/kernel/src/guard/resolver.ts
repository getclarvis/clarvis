import { NOOP_LOGGER, type RunCapabilityContext } from "@clarvis/capability";
import type {
  Guard,
  GuardElicit,
  GuardMode,
  GuardResolution,
  GuardResolver,
  Logger,
  ProviderConfig,
} from "@clarvis/loop";
import { defaultGuardMode, type GuardConfig } from "@clarvis/loop/host";
import { createShellGuard, type ShellGuardDecision } from "./shell-guard.ts";
import { createGuardSessionAllowlist, type GuardSessionAllowlist } from "./guard-elicit.ts";
import { createJudgeElicit } from "./judge.ts";
import { createGuardHumanApproval, type GuardHumanApproval } from "./human-approval.ts";

/** Snapshot of settings fields needed to resolve a run-time tool guard. */
export interface GuardSettings {
  /** Guard mode, command allow/deny lists, and judge config. */
  guard?: GuardConfig;
  /** Providers available for resolving an auto-mode judge model. */
  providers?: ProviderConfig[];
  /** Settings-level default model, the judge's fallback when it names none. */
  defaultModel?: string;
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
  | "owner"
  | "env"
  | "workspaceRoot"
  | "llm"
  | "elicit"
  | "logger"
  | "signal"
  | "executionId"
>;

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
 * @param judgeConfigured - whether the run carries a `guard_judge`.
 * @returns `true` for mode `on`, and for mode `auto` with no judge configured.
 * @remarks Mode `auto` builds the judge only when a `guard_judge` is present and
 *   otherwise falls back to the human prompt (see {@link createGuardResolver}),
 *   so "auto without a judge" is behaviourally identical to `on` here. Such runs
 *   park repeatedly mid-conversation, which is what makes the extended
 *   prompt-cache TTL worth its higher write price; the loop cannot derive this
 *   itself because guard mode is resolved from host settings it never sees.
 */
export function guardParksOnHuman(
  param: GuardMode | undefined,
  guard: GuardConfig | undefined,
  judgeConfigured: boolean,
): boolean {
  const mode = resolveGuardMode(param, guard);
  return mode === "on" || (mode === "auto" && !judgeConfigured);
}

/**
 * Builds the bash {@link Guard} for a resolved mode.
 *
 * @param guardConfig - the guard settings supplying the allow/deny command lists.
 * @param mode - the effective guard mode.
 * @returns `undefined` when `mode` is `"off"` (no guarding); otherwise a
 *   {@link createShellGuard} wired with the configured allow/deny lists.
 */
function buildGuard(
  guardConfig: GuardConfig | undefined,
  mode: GuardMode,
  onDecision: (decision: ShellGuardDecision) => void,
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
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
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
 * command was unanalyzable, so no automatic answerer may rule on it, and this
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
 *   plus an elicit: `on` uses the human prompt; `auto` uses the LLM judge when a
 *   `guard_judge` request param is present and a model resolves, else falls back
 *   to the human prompt. The chosen elicit is wrapped so a command already
 *   covered by the session allowlist passes without prompting.
 * @remarks The default {@link GuardSessionAllowlist} is shared across this resolver's runs.
 *   A persistent host supplies `sessionAllowlistFor` to bind consent to live interactive control.
 *   Each human question captures its current list, so late responses cannot authorize a new scope. The
 *   judge's default model falls back to `CLARVIS_DEFAULT_MODEL` from the run
 *   env when settings name none.
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
    const guardMode = resolveGuardMode(ctx.request.guard_mode, settings.guard);
    const audit = auditRoot.child?.({ run_id: ctx.executionId, owner: ctx.owner }) ?? auditRoot;
    const guard = buildGuard(settings.guard, guardMode, (decision) =>
      recordDecision(audit, guardMode, decision),
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
            const answer = await approval.ask(req);
            recordAnswer(audit, "human", answer.allowed, answer.persisted);
            return { allowed: answer.allowed, answerer: "human" };
          };
    const judgeElicit =
      guardMode === "auto" && ctx.request.guard_judge !== undefined
        ? createJudgeElicit(
            {
              llm: ctx.llm,
              providers: settings.providers ?? [],
              defaultModel:
                settings.defaultModel ??
                (ctx.env as { CLARVIS_DEFAULT_MODEL?: string }).CLARVIS_DEFAULT_MODEL,
              logger: deps.logger ?? ctx.logger,
              signal: ctx.signal,
            },
            ctx.request.guard_judge,
            humanElicit,
          )
        : undefined;
    const chosenHuman =
      guardMode === "on" || (guardMode === "auto" && judgeElicit === undefined)
        ? humanElicit
        : undefined;
    audit.info(
      {
        event: "guard.resolved",
        mode: guardMode,
        source: ctx.request.guard_mode !== undefined ? "request" : "settings",
        judge_configured: ctx.request.guard_judge !== undefined,
        human_channel: humanElicit !== undefined,
      },
      "the run's command guard is resolved; every guarded call is ruled on under this mode",
    );
    /**
     * A request the guard marked `escalate: "human"` bypasses both automatic
     * answerers: the LLM judge, and the session allow list. It reached `ask`
     * because the command could not be analyzed, and neither of those can answer
     * a question of that shape — the judge would be guessing at text the static
     * analyzer already refused to bound, and a session approval keyed on an
     * opaque command extends to whatever that command turns out to mean. With
     * no human channel configured it resolves to no elicit at all, which
     * `applyGuard` treats as a denial.
     */
    const elicit: GuardElicit | undefined =
      chosenHuman !== undefined || judgeElicit !== undefined || humanElicit !== undefined
        ? (req) => {
            if (req.escalate === "human") {
              if (humanElicit === undefined) return noHumanChannel(audit, ctx.executionId);
              return humanElicit(req);
            }
            const afterCoverage = (covered: boolean): ReturnType<GuardElicit> => {
              if (covered) {
                recordAnswer(audit, "session_allowlist", true, false);
                return { allowed: true, answerer: "session_allowlist" };
              }
              if (judgeElicit !== undefined) {
                return judgeElicit(req).then((answer) => {
                  if (answer.answerer === "judge")
                    recordAnswer(audit, "judge", answer.allowed, false);
                  return answer;
                });
              }
              if (chosenHuman === undefined) return noHumanChannel(audit, ctx.executionId);
              return chosenHuman(req);
            };
            const covered = approval?.covers(req) ?? false;
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
