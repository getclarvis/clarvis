import type { TracePort } from "@clarvis/capability";
import {
  ProviderError,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
  type ToolChoice,
} from "@clarvis/capability";
import type { CompactionEvent } from "../context/context-compaction.ts";
import { MAX_OVERFLOW_RECOVERIES } from "./loop-iteration.ts";
import type { AgentResult } from "./loop-shared.ts";

/**
 * The result of {@link callModelWithRecovery}: `ok` with the completed
 * {@link LLMCallResult}, or not-`ok` carrying the terminal `cancelled`
 * {@link AgentResult} when the run was aborted during the call.
 */
export type ModelCallOutcome =
  { ok: true; result: LLMCallResult } | { ok: false; cancelled: AgentResult };

/**
 * Inputs to {@link callModelWithRecovery}.
 *
 * @remarks `forcedChoice`, when set, overrides the base call's tool choice for
 *   the first attempt. `evict` frees context on overflow (returning the
 *   compaction event, or `undefined` when nothing more can be evicted).
 *   `rebuild` re-derives the call after an eviction — see below. `trace`
 *   records compaction events, `maybeCancelled` probes for abort after a throw,
 *   `recordError` traces each provider error, and `overflowDiagnostic` renders
 *   the terminal message when overflow can no longer be recovered.
 */
export interface ModelCallArgs {
  llm: LLMProvider;
  baseCall: LLMCallParams;
  forcedChoice?: ToolChoice;
  /**
   * Free context after the provider refused the prompt for length.
   *
   * @returns the compaction event, or `undefined` when nothing more can be
   *   evicted.
   * @remarks Invoked on a `context_overflow` error and on nothing else, which is
   *   what makes it the one place a caller can observe that a prompt was refused
   *   — `recordError` never sees a recovered overflow. `@clarvis/loop`'s caller
   *   relies on that to decide whether compaction's trigger was reachable at all.
   */
  evict: () => CompactionEvent | undefined;
  /**
   * Re-derive the call after `evict` changed the context.
   *
   * @remarks Load-bearing for anything in the call derived from the transcript's
   *   *shape* rather than its contents. `baseCall.messages` is the context's own
   *   live array, so an eviction is visible in the retry for free — but
   *   `cacheBreakpoints` are **indices into it**, captured before the eviction
   *   removed entries. Reusing them lands the provider's cache breakpoint on
   *   whatever now sits at that position, which after an eviction is typically
   *   the runtime note the breakpoint logic exists to avoid: a cache write at
   *   1.25x-2x price that the next request can never read, since that note is
   *   spliced out and re-appended every iteration. A wide enough eviction pushes
   *   the indices out of range entirely and the request loses every breakpoint.
   *   Omitted only by callers with no shape-derived fields.
   */
  rebuild?: () => LLMCallParams;
  trace: TracePort;
  maybeCancelled: () => AgentResult | null;
  recordError: (err: ProviderError) => void | Promise<void>;
  overflowDiagnostic?: (original: ProviderError) => string;
}

/**
 * Call the model, transparently recovering from context overflow and from a
 * forced-tool-choice rejection.
 *
 * @param args - the call parameters and recovery hooks; see {@link ModelCallArgs}.
 * @returns the successful {@link ModelCallOutcome}, or a cancelled outcome when an
 *   abort is observed after a throw.
 * @throws {@link ProviderError} the original (or, on unrecoverable overflow with
 *   an `overflowDiagnostic`, a synthesized) error, after recording it.
 * @remarks On `context_overflow` it calls `evict` and retries up to
 *   {@link MAX_OVERFLOW_RECOVERIES} times; when nothing can be evicted it throws
 *   the diagnostic overflow error (if a renderer was given). When a forced tool
 *   choice yields a `client` error, it records that error and retries once with
 *   the unforced base call before giving up.
 */
export async function callModelWithRecovery(args: ModelCallArgs): Promise<ModelCallOutcome> {
  const forced = args.forcedChoice !== undefined;
  const withChoice = (call: LLMCallParams): LLMCallParams =>
    forced ? { ...call, toolChoice: args.forcedChoice } : call;
  let activeCall = withChoice(args.baseCall);
  let overflowRecoveries = 0;
  for (;;) {
    try {
      return { ok: true, result: await args.llm.call(activeCall) };
    } catch (err) {
      const c = args.maybeCancelled();
      if (c) return { ok: false, cancelled: c };
      if (
        err instanceof ProviderError &&
        err.kind === "context_overflow" &&
        overflowRecoveries < MAX_OVERFLOW_RECOVERIES
      ) {
        const ev = args.evict();
        if (ev) {
          args.trace.record("compaction", ev);
          overflowRecoveries += 1;
          if (args.rebuild) activeCall = withChoice(args.rebuild());
          continue;
        }
        if (args.overflowDiagnostic) {
          const diag = new ProviderError(args.overflowDiagnostic(err), {
            kind: "context_overflow",
            ...(err.status !== undefined ? { status: err.status } : {}),
          });
          await args.recordError(diag);
          throw diag;
        }
      }
      if (forced && err instanceof ProviderError && err.kind === "client") {
        await args.recordError(err);
        try {
          return { ok: true, result: await args.llm.call(args.baseCall) };
        } catch (retryErr) {
          const cRetry = args.maybeCancelled();
          if (cRetry) return { ok: false, cancelled: cRetry };
          if (retryErr instanceof ProviderError) await args.recordError(retryErr);
          throw retryErr;
        }
      }
      if (err instanceof ProviderError) await args.recordError(err);
      throw err;
    }
  }
}
