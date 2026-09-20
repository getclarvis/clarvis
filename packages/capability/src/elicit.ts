import type { ComputeClock } from "./compute-clock.ts";
import { NOOP_LOGGER } from "./log.ts";
import type { Logger } from "./ports.ts";

/**
 * The elicitation vocabulary: how a run asks the human a question and reads the
 * answer back. Types only — the engine owns the transport and the `ask_user`
 * tool that drives it.
 */

/**
 * How the human closed an elicitation: `accept` (answered), `decline` (refused
 * or timed out) or `cancel` (dismissed without answering).
 */
export type ElicitationAction = "accept" | "decline" | "cancel";

/**
 * Why a question ended without an answer: a host-side interactive decision
 * window elapsed, or the operational wait bound did.
 *
 * @remarks The two are different facts about the same silence and a caller must
 *   not conflate them. `window_elapsed` means a human had the question on
 *   screen for its whole window and did not answer it, so the decision returns
 *   to the model. `wait_bound_elapsed` means the run's operational ceiling
 *   (`elicit_wait_ms`) elapsed first, so the run never learned whether anyone
 *   ever saw the question. Only the first carries the continuation guidance.
 */
export type ElicitNoResponseReason = "window_elapsed" | "wait_bound_elapsed";

/**
 * The normalized result of asking the human: the {@link ElicitationAction},
 * the `answer` text when accepted, and `noResponse` set when a `decline` was
 * synthesized from an elapsed wait window rather than an explicit refusal.
 */
export interface ElicitationOutcome {
  action: ElicitationAction;
  answer?: string;
  /**
   * True when nobody answered. Carries no authority: an unanswered question is
   * never an approval, and {@link ElicitationOutcome.noResponseReason} says
   * which clock ran out.
   */
  noResponse?: boolean;
  /** Set together with `noResponse`; see {@link ElicitNoResponseReason}. */
  noResponseReason?: ElicitNoResponseReason;
}

/**
 * The JSON-Schema-shaped request schema carried on an {@link ElicitParams}: an
 * object whose properties describe each expected answer field (with an optional
 * `enum` when the answer is constrained).
 */
export interface ElicitRequestedSchema {
  type: "object";
  properties: Record<string, { type: "string"; enum?: string[]; description?: string }>;
  required: string[];
}

/**
 * The transport-facing elicitation request: the human-readable `message`, the
 * {@link ElicitRequestedSchema} the answer must satisfy, and an optional `kind`
 * hint for how a UI should frame the prompt.
 */
export interface ElicitParams {
  message: string;
  requestedSchema: ElicitRequestedSchema;
  /**
   * What kind of question this is, so a UI can frame it appropriately: a
   * security-styled "command approval" for `guard_confirm`, a plan-approval
   * gate for `plan_review`, a workflow preflight for `workflow_review`, or a
   * neutral "agent asks" for `ask_user`. Defaults
   * to a plain user question when omitted; the kernel forwards it verbatim as
   * the protocol elicit `kind`.
   */
  kind?: "ask_user" | "guard_confirm" | "plan_review" | "workflow_review" | (string & {});
  /**
   * Trusted provenance of the request, set by whoever raised it.
   *
   * @remarks Host policy keys on this field and never on {@link ElicitParams.kind}:
   *   `kind` travels verbatim for the UI and an external MCP server can name any
   *   kind it likes, while `origin` is written only by the engine's own
   *   `ask_user` tool (`"model"`) or by the host's relay layer (`"external"`).
   *   Omit it for anything else; an unmarked request must be treated as
   *   external, and no host may hand a question window to a request it cannot
   *   attribute.
   */
  origin?: ElicitOrigin;
}

/**
 * Who raised an elicitation, as a claim only the engine or the host's own
 * relay layer can make.
 *
 * - `model`: the engine's `ask_user` tool, raised by the model itself.
 * - `external`: a question an MCP server relayed to this host.
 */
export type ElicitOrigin = "model" | "external";

/**
 * The elicitation `kind` identifying a plan-approval request, so a UI frames it
 * as one instead of as a generic agent question.
 *
 * @remarks Named here rather than in `@clarvis/plan` because the string travels
 * out of the capability that raises it: `@clarvis/plan` sets it, the kernel
 * forwards it verbatim onto the protocol elicit `kind`, and `@clarvis/code`
 * branches on it. This package is the only one every producer already depends
 * on.
 */
export const PLAN_REVIEW_ELICIT_KIND = "plan_review";

/**
 * The raw result returned by an {@link Elicit} transport before normalization:
 * the {@link ElicitationAction} and, on `accept`, the answer `content` keyed by
 * the request schema's property names.
 */
export interface ElicitRawResult {
  action: ElicitationAction;
  content?: Record<string, unknown>;
  /**
   * Set when the host closed the question itself because an interactive
   * decision window elapsed, without any human answer.
   *
   * @remarks Host-internal and never forwarded: a relayed external request has
   *   no window, and the relay builds its own `{action, content}` reply, so no
   *   MCP server can observe this. It exists to let the engine distinguish a
   *   window expiry from an explicit refusal, from a cancellation, and from the
   *   operational wait bound — a boundary that must not be guessed from the
   *   `action` alone.
   */
  windowElapsed?: boolean;
}

/**
 * The low-level transport that delivers an {@link ElicitParams} to the human and
 * resolves with the {@link ElicitRawResult}, honoring an abort `signal` and an
 * optional `timeoutMs` wait bound.
 */
export type Elicit = (
  params: ElicitParams,
  opts: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<ElicitRawResult>;

/**
 * Raised when an elicitation's wait bound elapsed before the human answered.
 *
 * @remarks Distinct from an abort: the run is still live and the caller decides
 * what "no answer" means for it, which is why {@link elicitWithClockPause}
 * swallows this one specifically and lets every other rejection through.
 */
export class ElicitTimeoutError extends Error {
  constructor(message = "Elicitation wait bound elapsed with no response.") {
    super(message);
    this.name = "ElicitTimeoutError";
  }
}

/**
 * Run an elicitation with the compute clock paused for its duration, so time
 * spent waiting on the human is never billed against the run's compute budget.
 *
 * @param clock - the {@link ComputeClock} paused around the wait and always
 *   resumed in `finally`.
 * @param signal - abort signal; a pre-aborted or mid-wait abort rethrows the
 *   abort reason.
 * @param doElicit - performs the actual elicitation and resolves the raw result.
 * @param map - `onResult` maps a delivered {@link ElicitRawResult}; `onNoResponse`
 *   supplies the value when the wait bound elapsed.
 * @param opts - `logger` receives `capability.elicit_no_response` when the wait
 *   bound elapses; defaults to {@link NOOP_LOGGER}.
 * @returns the mapped value of type `T`.
 * @throws the abort reason when `signal` is or becomes aborted, or any non-timeout
 *   error thrown by `doElicit`.
 * @remarks An {@link ElicitTimeoutError} is swallowed into `map.onNoResponse()`;
 *   every other rejection propagates. It lives in the contract rather than the
 *   engine because every capability that asks the human — planning's review gate
 *   among them — needs the pause, and a capability outside the engine cannot
 *   reach an engine helper.
 */
export async function elicitWithClockPause<T>(
  clock: ComputeClock,
  signal: AbortSignal | undefined,
  doElicit: () => Promise<ElicitRawResult>,
  map: { onResult: (raw: ElicitRawResult) => T; onNoResponse: () => T },
  opts: { logger?: Logger } = {},
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Run aborted before the elicitation started.");
  }
  const startedAt = Date.now();
  clock.pause();
  try {
    return map.onResult(await doElicit());
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof ElicitTimeoutError) {
      (opts.logger ?? NOOP_LOGGER).info(
        { event: "capability.elicit_no_response", waited_ms: Date.now() - startedAt },
        "nobody answered the question within its wait bound; the run proceeds on the caller default",
      );
      return map.onNoResponse();
    }
    throw err;
  } finally {
    clock.resume();
  }
}
