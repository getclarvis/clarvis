import type {
  Elicit,
  ElicitNoResponseReason,
  ElicitOrigin,
  ElicitParams,
  ElicitRawResult,
  ElicitRequestedSchema,
  ElicitationAction,
  ElicitationOutcome,
} from "@clarvis/capability";

export type {
  Elicit,
  ElicitNoResponseReason,
  ElicitOrigin,
  ElicitParams,
  ElicitRawResult,
  ElicitRequestedSchema,
  ElicitationAction,
  ElicitationOutcome,
};

import type { NamespacedTool } from "@clarvis/capability";
import type { ComputeClock } from "@clarvis/capability";
import { safeStringify } from "../support/stringify.ts";
import { boundPromise } from "../support/bounded.ts";

import { ASK_USER_TOOL_NAME } from "./wire-names.ts";

export { ASK_USER_TOOL_NAME };

/**
 * The single property name under which an elicitation answer is carried in the
 * request schema and the raw result `content` — see {@link buildElicitParams}
 * and {@link extractAnswer}.
 */
export const ELICIT_RESPONSE_FIELD = "response";

/**
 * The no-response reason a host reports when it closed the question's own
 * interactive decision window; see {@link ElicitNoResponseReason}.
 */
const WINDOW_ELAPSED: ElicitNoResponseReason = "window_elapsed";

/**
 * What the model reads when a decision window elapsed with no answer.
 *
 * @remarks Silence is only the fact that the question closed. Saying so plainly
 *   — and telling the model to decide with what it has, without treating the
 *   silence as approval or repeating the same question — is the whole point of
 *   the window: the run continues on the model's judgment instead of blocking
 *   on a human who is not there.
 */
export const WINDOW_ELAPSED_GUIDANCE =
  "User did not answer within the decision window. Choose the most reasonable option with the " +
  "information available, and continue within the authorized scope. Do not read the silence as " +
  "approval, and do not immediately repeat the same question.";

/**
 * The built-in `ask_user` tool descriptor: a bare-wire-named
 * {@link NamespacedTool} that lets the model put a question to the human and
 * block on their answer.
 */
export const askUserTool: NamespacedTool = {
  fullName: ASK_USER_TOOL_NAME,
  wireName: ASK_USER_TOOL_NAME,
  mcpName: "",
  toolName: ASK_USER_TOOL_NAME,
  description:
    "Ask the human a question and wait for their answer. Use when an instruction is " +
    "ambiguous, a choice must be made, or a risky action needs confirmation. Returns the " +
    "user's answer, or a note that they declined, dismissed or left the question unanswered.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        minLength: 1,
        description: "The question to put to the human.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional fixed set of allowed answers (constrained answer).",
      },
    },
    required: ["question"],
  },
};

/**
 * Validated arguments to the `ask_user` tool: the `question` to put to the
 * human and an optional fixed `options` set that constrains the answer.
 */
export interface AskUserArgs {
  question: string;
  options?: string[];
}

/**
 * The port that surfaces a question to the human and resolves with their
 * {@link ElicitationOutcome}; see {@link buildAskUser} for the standard wiring.
 */
export type AskUser = (args: AskUserArgs) => Promise<ElicitationOutcome>;

import { ElicitTimeoutError, elicitWithClockPause } from "@clarvis/capability";

export { ElicitTimeoutError, elicitWithClockPause };

/**
 * Extra grace added to a caller's `timeoutMs` by {@link withElicitWaitBound} so
 * the outer bound fires slightly after the transport's own deadline, never
 * before it.
 */
const ELICIT_WAIT_GRACE_MS = 1_000;

/**
 * Wrap an {@link Elicit} so it rejects with {@link ElicitTimeoutError} once the
 * caller's `timeoutMs` (plus `graceMs`) elapses, and with the abort reason if
 * the `signal` fires first.
 *
 * @param elicit - the transport to bound.
 * @param graceMs - grace added to the caller's timeout; defaults to
 *   {@link ELICIT_WAIT_GRACE_MS}.
 * @returns an `Elicit` that enforces the wait bound via {@link boundPromise}.
 * @remarks A `timeoutMs` of `0` is passed through as `0` (no bound); an omitted
 *   `timeoutMs` also leaves the wait unbounded.
 */
export function withElicitWaitBound(elicit: Elicit, graceMs = ELICIT_WAIT_GRACE_MS): Elicit {
  return (params, opts) => {
    const { timeoutMs, signal } = opts;
    return boundPromise<ElicitRawResult>(() => elicit(params, opts), {
      signal,
      timeoutMs: timeoutMs === undefined ? undefined : timeoutMs === 0 ? 0 : timeoutMs + graceMs,
      onTimeout: () => {
        throw new ElicitTimeoutError();
      },
      onAbort: () => {
        throw signal?.reason instanceof Error
          ? signal.reason
          : new Error("Run aborted while waiting for the elicitation.");
      },
    });
  };
}

/**
 * Build the {@link ElicitParams} for an `ask_user` question: the question text
 * as the `message` and a single required answer field, constrained to an `enum`
 * when the caller supplied a non-empty `options` list.
 *
 * @param args - the question and optional constrained options.
 * @returns the transport-facing elicitation request, marked `origin: "model"`
 *   so a host can tell the model's own question from a relayed one.
 */
export function buildElicitParams(args: AskUserArgs): ElicitParams {
  const field: { type: "string"; enum?: string[]; description?: string } = {
    type: "string",
    description: "Your answer.",
  };
  if (args.options && args.options.length > 0) field.enum = args.options;
  return {
    kind: "ask_user",
    origin: "model",
    message: args.question,
    requestedSchema: {
      type: "object",
      properties: { [ELICIT_RESPONSE_FIELD]: field },
      required: [ELICIT_RESPONSE_FIELD],
    },
  };
}

/**
 * Extract the human's answer string from an {@link ElicitRawResult}'s `content`.
 *
 * @param content - the raw answer object, keyed by {@link ELICIT_RESPONSE_FIELD}.
 * @returns the response string when present; the whole `content` serialized when
 *   the response field is missing; `""` when there is no content at all.
 */
export function extractAnswer(content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  const v = content[ELICIT_RESPONSE_FIELD];
  if (typeof v === "string") return v;
  if (v === undefined) return JSON.stringify(content);
  return safeStringify(v);
}

/**
 * Render an {@link ElicitationOutcome} as the one-line, model-facing tool result
 * describing what the human did.
 *
 * @param outcome - the normalized elicitation result.
 * @returns the answer on `accept`, a declined/no-response note on `decline`, or
 *   a dismissed note on `cancel`; a window expiry returns the continuation
 *   guidance instead of the wait-window note, because those are different facts
 *   about the silence.
 */
export function mapOutcomeToText(outcome: ElicitationOutcome): string {
  switch (outcome.action) {
    case "accept":
      return `User answered: ${outcome.answer ?? ""}`;
    case "decline":
      if (outcome.noResponseReason === WINDOW_ELAPSED) return WINDOW_ELAPSED_GUIDANCE;
      return outcome.noResponse
        ? "User did not respond within the wait window."
        : "User declined to answer the question.";
    case "cancel":
      return "User dismissed the question without answering.";
  }
}

/**
 * Compose the standard {@link AskUser} port from a low-level {@link Elicit}: it
 * builds the request via {@link buildElicitParams}, pauses the clock during the
 * wait ({@link elicitWithClockPause}), and normalizes the raw result into an
 * {@link ElicitationOutcome}.
 *
 * @param elicit - the transport that delivers questions to the human.
 * @param clock - the compute clock paused while waiting.
 * @param signal - optional abort signal threaded into the elicitation.
 * @param waitBoundMs - optional wait bound forwarded as the transport `timeoutMs`.
 * @returns an `AskUser` that yields `accept` with the extracted answer, the raw
 *   `decline`/`cancel` action, a `noResponse` decline when the transport's wait
 *   bound elapsed, or the same decline marked `window_elapsed` when the host
 *   closed the question's own decision window.
 */
export function buildAskUser(
  elicit: Elicit,
  clock: ComputeClock,
  signal?: AbortSignal,
  waitBoundMs?: number,
): AskUser {
  return (args: AskUserArgs): Promise<ElicitationOutcome> =>
    elicitWithClockPause<ElicitationOutcome>(
      clock,
      signal,
      () =>
        elicit(buildElicitParams(args), {
          signal,
          ...(waitBoundMs !== undefined ? { timeoutMs: waitBoundMs } : {}),
        }),
      {
        onResult: (raw) =>
          raw.action === "accept"
            ? { action: "accept", answer: extractAnswer(raw.content) }
            : raw.windowElapsed === true
              ? { action: "decline", noResponse: true, noResponseReason: WINDOW_ELAPSED }
              : { action: raw.action },
        onNoResponse: () => ({
          action: "decline",
          noResponse: true,
          noResponseReason: "wait_bound_elapsed",
        }),
      },
    );
}
