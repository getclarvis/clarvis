/**
 * The elicitation vocabulary the UI renders from — a local type so code carries
 * no @modelcontextprotocol/sdk dependency. It covers what the elicit form/URL
 * logic reads (message + a JSON-schema-ish `requestedSchema`, or a URL prompt)
 * and the answer the UI produces. The kernel-run-client bridges the kernel's
 * protocol ElicitationRequest/Response to these.
 */
/**
 * The elicitation `kind` that identifies a plan-approval request.
 *
 * @remarks A deliberate duplicate of `@clarvis/capability`'s
 * `PLAN_REVIEW_ELICIT_KIND`: `code` depends on `@clarvis/kernel`,
 * `@clarvis/protocol` and `@clarvis/kernel` only, so the value cannot be
 * imported. `packages/kernel/tests/architecture/elicit-kind.test.ts` pins the
 * two together.
 */
export const PLAN_REVIEW_ELICIT_KIND = "plan_review";

export interface ElicitRequestParams {
  message: string;
  /** What raised this question, so the UI can frame it: a plan-approval gate for
   * `plan_review`, or a neutral question for `ask_user`. Mirrors the protocol
   * `ElicitationRequest.kind`. */
  kind?: "ask_user" | "plan_review" | "workflow_review" | (string & {});
  /** Form variant: a JSON-schema object describing the requested fields. */
  requestedSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** URL variant. */
  mode?: "form" | "url";
  url?: string;
  /** The kernel's identity for this question. Present when the host tracks it
   * and expects the frontend to confirm it is on screen; the confirmation and
   * the answer both name this id. Mirrors the protocol
   * `ElicitationRequest.id`. */
  id?: string;
  /** Milliseconds the question stays open after this frontend confirms it is on
   * screen — present only when a host window policy applies to the question.
   * Absent for plan/workflow reviews, relayed MCP
   * questions and headless runs, which keep the operational wait ceiling and
   * render no countdown. Mirrors the protocol `ElicitationRequest.window_ms`. */
  windowMs?: number;
}

/**
 * Confirms to the kernel that the pending question is really on screen.
 *
 * @returns milliseconds left in the question's decision window, or `undefined`
 *   when no window applies (plan/workflow reviews, relayed
 *   questions, headless runs) or the kernel already settled the question.
 */
export type ElicitPresenter = () => Promise<number | undefined>;

/**
 * Countdown copy for a presented question whose decision window is running.
 *
 * @param remainingMs - milliseconds left, as projected by the kernel.
 * @remarks The countdown is decorative: the kernel decides when the window
 *   ends, and the model reads no response, never a synthetic answer.
 */
export function elicitCountdownText(remainingMs: number): string {
  return `The model decides in ${Math.max(0, Math.ceil(remainingMs / 1000))} s.`;
}

/** Copy for a question the kernel closed because its decision window elapsed. */
export const ELICIT_NO_RESPONSE_TEXT = "No response in time; decision returned to the model.";

type ElicitAction = "accept" | "decline" | "cancel";

/** The user's answer to an elicitation: accept (with `content`), decline, or cancel. */
export interface ElicitResult {
  action: ElicitAction;
  content?: Record<string, unknown>;
  /**
   * Set when the kernel retired the question itself, so this is not a human
   * answer.
   *
   * @remarks Host-internal and never sent on the wire: it travels only from
   *   `ElicitSlot.settle` to the run client, which must not answer an id the
   *   kernel has already settled. It is not an authority of any kind — a
   *   question nobody answered is never an approval — and only names why the
   *   frontend stopped showing a prompt.
   */
  settled?: true;
}
