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
 * `@clarvis/protocol` and `@clarvis/paths` only, so the value cannot be
 * imported. `packages/kernel/tests/architecture/elicit-kind.test.ts` pins the
 * two together.
 */
export const PLAN_REVIEW_ELICIT_KIND = "plan_review";

export interface ElicitRequestParams {
  message: string;
  /** What raised this question, so the UI can frame it: a security-styled
   * command approval for `guard_confirm`, a plan-approval gate for
   * `plan_review`, or a neutral question for `ask_user`. Mirrors the protocol
   * `ElicitationRequest.kind`. */
  kind?: "ask_user" | "guard_confirm" | "plan_review" | "workflow_review" | (string & {});
  /** Structured command context on a `guard_confirm` — when present the UI
   * renders it (highlighted command + cwd) instead of the plain `message`,
   * which stays the human-readable fallback. Mirrors the protocol
   * `ElicitationCommandDetail`. */
  detail?: ElicitCommandDetail;
  /** Form variant: a JSON-schema object describing the requested fields. */
  requestedSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** URL variant. */
  mode?: "form" | "url";
  url?: string;
}

/** Structured command context of a guard confirmation. */
export interface ElicitCommandDetail extends EffectReviewDetail {
  /** The literal command awaiting approval, exactly as the agent wants to run it. */
  command: string;
  /** Absolute directory the command would run in. */
  cwd: string;
  /** Why the guard is asking — rendered alongside the command. */
  reason: string;
  /** Analyzer caveat (e.g. undecidable expansions) rendered as a warning. */
  warning?: string;
}

import type { EffectReviewDetail } from "@clarvis/protocol";

type ElicitAction = "accept" | "decline" | "cancel";

/** The user's answer to an elicitation: accept (with `content`), decline, or cancel. */
export interface ElicitResult {
  action: ElicitAction;
  content?: Record<string, unknown>;
}
