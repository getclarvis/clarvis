import { sanitizeErrorMessage } from "@clarvis/capability";
import type {
  AgentRole,
  CompactionContribution,
  GateVerdict,
  HookVerdict,
  LifecycleHook,
  PreCompactContext,
  PreFinalizeContext,
} from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { FinalizeGate, GateOutcome } from "./loop-contract.ts";
import { boundPromise } from "../support/bounded.ts";

/** Hard wall for extension code invoked inside an agent loop. */
const LIFECYCLE_HOOK_TIMEOUT_MS = 5_000;
/** Gate events are rare and may deliberately perform a slower policy check. */
export const LIFECYCLE_GATE_HOOK_TIMEOUT_MS = 30_000;

export interface HookTimeoutOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const timeoutMessage = (timeoutMs: number): string => `hook timed out after ${String(timeoutMs)}ms`;

/** Invoke extension code with finite wall time and run cancellation. */
function boundedHookCall<T>(
  invoke: () => Promise<T> | T,
  options: HookTimeoutOptions | undefined,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? LIFECYCLE_HOOK_TIMEOUT_MS;
  return boundPromise(() => Promise.resolve().then(invoke), {
    timeoutMs,
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    onTimeout: () => {
      throw new Error(timeoutMessage(timeoutMs));
    },
    onAbort: () => {
      throw options?.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("hook cancelled");
    },
  });
}

/**
 * The names of the fire-and-forget observer methods a {@link LifecycleHook} may
 * implement, dispatched by {@link fireObservers}.
 *
 * @remarks `onPreCompact` is deliberately **not** a member: it returns
 *   contributions, and {@link fireObservers} discards what a method returns. Its
 *   absence here is what makes routing it through the observer path a compile
 *   error instead of a compaction that silently ignored every contribution.
 *   Use {@link collectCompactionContributions}.
 */
type ObserverMethod =
  | "onRunStart"
  | "onRunEnd"
  | "onSubagentComplete"
  | "onModelCallError"
  | "onBudgetExhausted"
  | "onUserSteer";

/**
 * The message a hook earns by returning a `rewrite` at a fire point that has no
 * rewritable action.
 *
 * @remarks Exported so every gate that refuses one reports the same sentence,
 * and so a test can assert the refusal without restating it. It names the
 * channel that does work, because the capability is not missing: a
 * `pre_tool_use` hook matching either child-spawn tool replaces its brief and
 * profile through the ordinary tool dispatch, where the replacement is validated
 * by the tool's own schema, met by the command guard, reported to the model as
 * an `[advisor]` line, and carried beside the arguments the model actually sent
 * rather than over them.
 */
export const UNSUPPORTED_REWRITE_MESSAGE =
  "the hook returned replacement arguments at a fire point with no rewritable action; " +
  "only a pre-tool-use hook may replace a call's arguments";

/**
 * The aggregate result of sweeping a set of verdict-returning hooks: the first
 * `denied` verdict (with `fromThrow` marking a denial synthesized from a hook
 * that failed rather than ruled — a throw, or output this fire point cannot
 * act on), or `null` when none denied, plus every `advise` message collected
 * along the way.
 */
export interface VerdictSweep {
  denied: { message: string; fromThrow: boolean } | null;
  advise: string[];
  /**
   * The replacement arguments, when at least one hook rewrote the action.
   *
   * @remarks Absent when nothing rewrote, and absent on a denial too — a call
   * that does not run has no arguments worth reporting. Later hooks see the
   * replacement, so this is the last writer's value, not the first's.
   *
   * **Only a caller that actually replaces the action's arguments may leave
   * `opts.rewritable` unset.** Every other fire point must pass
   * `rewritable: false`, or a rewrite it has nothing to act on lands here and is
   * dropped without the hook's author ever learning the action did not change.
   */
  rewritten?: { arguments: unknown };
}

/**
 * Run a verdict-returning lifecycle hook across a hook list, short-circuiting on
 * the first denial.
 *
 * @param hooks - the hooks to sweep; `undefined` is treated as empty.
 * @param select - maps each hook to its relevant invocation, or `undefined` to
 *   skip that hook. Its second argument carries the arguments an earlier hook
 *   substituted, so a caller whose action is rewritable threads them forward and
 *   every later hook rules on what its predecessors actually left.
 * @param opts.onThrow - `"deny"` fails closed (a thrown hook becomes a denial
 *   with `fromThrow: true`); `"ignore"` skips the thrower and continues. A
 *   `rewrite` arriving where `opts.rewritable` is `false` resolves the same way:
 *   output this fire point cannot act on is a hook that failed to rule, not a
 *   ruling.
 * @param opts.onThrowWarn - the warning message logged when a hook throws.
 * @param opts.logger - optional logger for the throw warning.
 * @param opts.logFields - extra fields merged into the throw warning log.
 * @param opts.rewritable - whether this fire point has an action a `rewrite`
 *   verdict can replace. Omit it **only** where the caller genuinely substitutes
 *   the arguments; `false` everywhere else. The default is permissive because
 *   the alternative — silently dropping a replacement the hook's author believes
 *   took effect — is the failure this parameter exists to make impossible, and a
 *   caller that means to act on one should not have to opt in to being heard.
 * @returns a {@link VerdictSweep}: the first `deny` verdict (or a synthesized
 *   throw-denial), or `null` denial with all `advise` messages accumulated.
 */
export async function runVerdictHooks(
  hooks: readonly LifecycleHook[] | undefined,
  select: (
    hook: LifecycleHook,
    rewritten: unknown,
  ) => (() => Promise<HookVerdict> | HookVerdict) | undefined,
  opts: {
    onThrow: "deny" | "ignore";
    onThrowWarn: string;
    logger?: Logger | undefined;
    logFields?: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
    rewritable?: boolean;
  },
): Promise<VerdictSweep> {
  const advise: string[] = [];
  let rewritten: { arguments: unknown } | undefined;
  for (const hook of hooks ?? []) {
    const invoke = select(hook, rewritten?.arguments);
    if (invoke === undefined) continue;
    let verdict: HookVerdict;
    try {
      verdict = await boundedHookCall(invoke, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger?.warn(
        { event: "hook.verdict_failed", ...opts.logFields, err: sanitizeErrorMessage(msg) },
        opts.onThrowWarn,
      );
      if (opts.onThrow === "deny") {
        return { denied: { message: `the hook itself failed (${msg})`, fromThrow: true }, advise };
      }
      continue;
    }
    if (verdict.kind === "deny") {
      return { denied: { message: verdict.message, fromThrow: false }, advise };
    }
    if (verdict.kind === "advise") advise.push(verdict.message);
    if (verdict.kind === "rewrite") {
      if (opts.rewritable === false) {
        opts.logger?.warn(
          { event: "hook.rewrite_unsupported", ...opts.logFields },
          "hook returned replacement arguments where nothing can act on them; treated as a hook failure",
        );
        if (opts.onThrow === "deny") {
          return { denied: { message: UNSUPPORTED_REWRITE_MESSAGE, fromThrow: true }, advise };
        }
        continue;
      }
      rewritten = { arguments: verdict.arguments };
      if (verdict.message !== undefined) advise.push(verdict.message);
    }
  }
  return { denied: null, advise, ...(rewritten === undefined ? {} : { rewritten }) };
}

/**
 * Build a {@link FinalizeGate} that consults every hook's `preFinalize` before an
 * agent is allowed to finalize.
 *
 * @param p.hooks - the lifecycle hooks whose `preFinalize` rulings gate the
 *   finalize; `fastAcceptOk` reports `true` only when none define one.
 * @param p.agent - the agent identity passed into the hook context.
 * @param p.subagentInstanceId - the subagent instance, omitted for the lead.
 * @param p.appendNote - sink for `advise` messages, prefixed `[advisor]`.
 * @param p.logger - optional logger for a thrown hook.
 * @returns a gate whose `check` fails closed: a denial — explicit, synthesized
 *   from a thrown hook, or synthesized from a `rewrite` this fire point has no
 *   arguments to replace — becomes an unbounded `nudge` with a `[runtime: …]`
 *   note, while advice is appended and the gate passes.
 * @remarks A finalize attempt is not a call whose arguments anything
 *   substitutes, so the sweep is run with `rewritable: false`: a hook that asks
 *   for one is reported rather than passed through as though it had ruled
 *   `pass`.
 */
export function buildPreFinalizeGate(p: {
  hooks: readonly LifecycleHook[];
  agent: AgentRole;
  subagentInstanceId?: string;
  appendNote: (note: string) => void;
  logger?: Logger;
  timeoutMs?: number;
  signal?: AbortSignal;
}): FinalizeGate {
  return {
    fastAcceptOk: (): boolean => !p.hooks.some((h) => h.preFinalize),
    async check(attempt): Promise<GateOutcome> {
      const context: PreFinalizeContext = {
        agent: p.agent,
        ...(p.subagentInstanceId !== undefined ? { subagentInstanceId: p.subagentInstanceId } : {}),
        mode: attempt.mode,
        ...(attempt.text !== undefined ? { text: attempt.text } : {}),
        ...(attempt.mode === "submit" ? { value: attempt.value } : {}),
      };
      const sweep = await runVerdictHooks(
        p.hooks,
        (h) =>
          h.preFinalize
            ? (): Promise<GateVerdict> | GateVerdict => h.preFinalize!(context)
            : undefined,
        {
          onThrow: "deny",
          onThrowWarn: "preFinalize hook threw; failing closed — finalize nudged",
          logger: p.logger,
          timeoutMs: p.timeoutMs ?? LIFECYCLE_GATE_HOOK_TIMEOUT_MS,
          rewritable: false,
          ...(p.signal !== undefined ? { signal: p.signal } : {}),
        },
      );
      if (sweep.denied !== null) {
        return {
          kind: "nudge",
          unbounded: true,
          note: sweep.denied.fromThrow
            ? `[runtime: finalize rejected — ${sweep.denied.message}]`
            : `[runtime: finalize rejected by a workspace hook: ${sweep.denied.message}]`,
        };
      }
      for (const m of sweep.advise) p.appendNote(`[advisor] ${m}`);
      return { kind: "pass" };
    },
  };
}

/**
 * Fire a fire-and-forget observer method across a hook list, isolating failures.
 *
 * @param hooks - the hooks to notify; `undefined` is treated as empty.
 * @param method - the observer method to invoke on each hook that defines it
 *   (see {@link ObserverMethod}).
 * @param context - the context argument passed to the observer.
 * @param logger - optional logger; a thrown observer is warned and swallowed so
 *   one hook's failure never blocks the others or the run.
 */
export async function fireObservers<M extends ObserverMethod>(
  hooks: readonly LifecycleHook[] | undefined,
  method: M,
  context: Parameters<NonNullable<LifecycleHook[M]>>[0],
  logger?: Logger,
  options?: HookTimeoutOptions,
): Promise<void> {
  for (const hook of hooks ?? []) {
    const fn = hook[method];
    if (!fn) continue;
    try {
      await boundedHookCall(
        () => (fn as (c: typeof context) => Promise<void>).call(hook, context),
        options,
      );
    } catch (err) {
      logger?.warn(
        {
          event: "hook.observer_failed",
          hook_event: method,
          err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "observer hook threw; ignored",
      );
    }
  }
}

/**
 * Fire `onPreCompact` across a hook list and gather what each offers for the
 * pending compaction's summarization prompt.
 *
 * @param hooks - the hooks to ask; `undefined` is treated as empty.
 * @param context - which agent is compacting and how large its context is.
 * @param logger - optional logger for a hook that threw.
 * @returns every contribution offered, in hook order — which is the settings
 *   merge's order, so operator hooks precede plugin ones.
 * @remarks
 * **Failure is always open.** A hook that throws contributes nothing and the
 * compaction proceeds regardless: it fires because the context is over budget,
 * so letting a hook prevent it would convert a recoverable state into a hard
 * failure at the next model call. Nothing a hook returns can reach the base
 * prompt — the caller passes that to `runCompaction` as a separate argument.
 */
export async function collectCompactionContributions(
  hooks: readonly LifecycleHook[] | undefined,
  context: PreCompactContext,
  logger?: Logger,
  options?: HookTimeoutOptions,
): Promise<CompactionContribution[]> {
  const out: CompactionContribution[] = [];
  for (const hook of hooks ?? []) {
    const fn = hook.onPreCompact;
    if (!fn) continue;
    try {
      const offered = await boundedHookCall(() => fn.call(hook, context), options);
      if (Array.isArray(offered)) out.push(...offered);
    } catch (err) {
      logger?.warn(
        {
          event: "hook.pre_compact_failed",
          hook_event: "onPreCompact",
          err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "pre-compact hook threw; it contributes nothing",
      );
    }
  }
  return out;
}
