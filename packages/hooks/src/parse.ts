/**
 * Turning a hook's stdout into a verdict.
 *
 * @remarks
 * Parsing is strict over the whole of stdout: a hook that prints one stray log
 * line alongside its JSON is a failure, not a best-effort rescue. Salvaging the
 * last non-empty line would make "JSON followed by a log line" behave
 * differently from "log line followed by JSON" for no stated reason, and a hook
 * author cannot debug a rule they cannot predict. **Logs go to stderr**, which
 * is captured and logged for exactly that purpose.
 */
import type { HookOutcome } from "./types.ts";

/**
 * Longest message or context text accepted from a hook.
 *
 * @remarks
 * A `deny` message is placed verbatim into the model's context by the host, so
 * an unbounded one is a context-flooding vector reachable from a config file.
 */
export const HOOK_MESSAGE_MAX_CHARS = 4_000;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

/** The result of reading one hook's stdout. */
export type ParsedHookOutput =
  | { readonly ok: true; readonly outcome: HookOutcome }
  | { readonly ok: false; readonly reason: string };

/** Options controlling which outcomes are representable at this fire point. */
export interface ParseOptions {
  /** stdout hit its cap; the text cannot be complete JSON. */
  readonly truncated: boolean;
  /**
   * Whether a `context` outcome is meaningful here.
   *
   * @remarks
   * False at a gate, where there is no context channel at all - the host's
   * verdict type can only pass, deny or advise - so a `context` there is a
   * misconfigured hook and is reported as bad output rather than silently
   * behaving like something else.
   */
  readonly allowContext: boolean;
  /**
   * Whether a `rewrite` outcome is meaningful here.
   *
   * @remarks False everywhere but the pending-tool-call event. A hook that asks
   * to replace arguments where nothing will act on them is reported as bad
   * output, never silently passed: the whole hazard of a rewrite channel is an
   * author who believes a call was changed when it was not.
   */
  readonly allowRewrite: boolean;
}

/**
 * Normalize a string a hook produced into one safe to place in the model's
 * context: control characters removed, clamped to
 * {@link HOOK_MESSAGE_MAX_CHARS}, trimmed.
 *
 * @param value - any value read out of a hook's stdout or stderr.
 * @returns the cleaned text, or `""` when `value` is not a string.
 * @remarks Exported because the runner needs the same treatment for the stderr
 *   it turns into a deny message on the exit-code blocking form, and a second
 *   copy of the control-character rule is a copy that can drift.
 */
export function cleanHookMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, "").slice(0, HOOK_MESSAGE_MAX_CHARS).trim();
}

const clean = cleanHookMessage;

/** A JSON object, excluding arrays and null — the only shape replacement arguments may take. */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The nested `hookSpecificOutput` object, or an empty record. */
function specific(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.hookSpecificOutput;
  return typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : {};
}

/**
 * Read a verdict written in the dialect other agent hosts use, which carries no
 * `kind`.
 *
 * @param body - the parsed stdout object, known to have no `kind`.
 * @param allowContext - whether a context outcome is representable here.
 * @returns the equivalent {@link HookOutcome}, or `undefined` when the object
 *   says nothing this host acts on (which stays a pass).
 * @remarks
 * Without this, a hook that decided to **block** would be read as an empty
 * object and pass — the one failure direction that must never be silent. The
 * three blocking spellings all map to `deny`; `ask`, which has no Clarvis
 * counterpart at a hook, degrades to `advise` so its reason still reaches the
 * model rather than being dropped or escalated into a block it did not ask for.
 *
 * Context is read **before** an allow is honoured, because the source dialect
 * lets one body carry both: a `permissionDecision` of `allow` alongside an
 * `additionalContext`. Returning the pass first would drop text the hook
 * deliberately offered.
 *
 * A blocking decision is read **before** any replacement arguments, and that
 * precedence is load-bearing rather than incidental: refusing a body that both
 * denies and carries `updatedInput` would make it bad output, which
 * `on_failure` then resolves to a **pass** by default. The contradiction would
 * turn a block into an allow. A deny that also asks for a rewrite simply denies.
 *
 * **Replacement arguments carry their own intent.** A body offering
 * `updatedInput` and naming no decision at all is read as the rewrite it plainly
 * is, rather than refused for the missing `allow` the source dialect pairs it
 * with. Refusing it made it bad output, and bad output resolves through
 * `on_failure` to a **pass** — so the call ran with the model's original
 * arguments while its author had every reason to believe it had been changed,
 * which is the one outcome a rewrite channel must never produce. A decision that
 * is present and is *not* an allow is a genuine contradiction and stays bad
 * output; a deny never reaches here at all, having short-circuited above.
 *
 * At a gate that text becomes an `advise` rather than being discarded.
 * `additionalContext` is the source dialect's *documented* way to annotate a
 * pending tool call without blocking it, so a gate is the fire point it is most
 * often written for — and a gate does have a channel for it, the `[advisor]`
 * note. Gating the read on `allowContext` silently dropped exactly the payload
 * the field exists to carry.
 */
function translateForeignOutcome(
  body: Record<string, unknown>,
  opts: ParseOptions,
): HookOutcome | { readonly bad: string } | undefined {
  const nested = specific(body);
  const decision = nested.permissionDecision ?? body.decision;
  const reason = clean(nested.permissionDecisionReason ?? body.reason ?? body.stopReason);

  if (decision === "deny" || decision === "block" || body.continue === false) {
    return { kind: "deny", message: reason || "denied by hook (no reason given)" };
  }
  const allows = decision === "allow" || decision === "approve";
  const updated = nested.updatedInput ?? body.updatedInput;

  if (updated !== undefined && decision !== undefined && !allows) {
    const named = typeof decision === "string" ? `a '${decision}'` : "that";
    return { bad: `replacement arguments cannot accompany ${named} decision` };
  }

  if (decision === "ask") {
    return reason === "" ? { kind: "pass" } : { kind: "advise", message: reason };
  }

  const offered = clean(
    nested.additionalContext ?? body.additionalContext ?? body.additional_context,
  );

  if (updated !== undefined) {
    if (!opts.allowRewrite) return { bad: "arguments cannot be replaced at this event" };
    const replacement = plainObject(updated);
    if (replacement === undefined) return { bad: "replacement arguments are not an object" };
    return {
      kind: "rewrite",
      arguments: replacement,
      ...(offered === "" ? {} : { message: offered }),
    };
  }

  if (offered !== "") {
    return opts.allowContext
      ? { kind: "context", text: offered }
      : { kind: "advise", message: offered };
  }

  if (allows) return { kind: "pass" };
  return undefined;
}

/**
 * Reads a hook's stdout as a verdict.
 *
 * @param stdout - everything the hook wrote, already clamped by the runner.
 * @param opts - what this fire point can represent.
 * @returns the outcome, or a one-line reason the output was unusable.
 * @remarks
 * Order matters and encodes three decisions:
 *
 * - **Truncated output is never parsed.** Truncated JSON cannot be valid, and
 *   attempting it would report a confusing syntax error instead of the real
 *   cause.
 * - **Empty stdout passes.** The overwhelmingly common hook runs a checker and
 *   says nothing; that path must cost nothing and must never be a failure.
 * - **A body with no `kind` is read again in the external dialect** before it is
 *   allowed to pass; see {@link translateForeignOutcome}.
 * - **A `deny` with no message still denies**, carrying a placeholder. Failing
 *   closed beats pedantry: a hook that has decided to block and merely forgot to
 *   explain itself must not be upgraded to an allow. An `advise` with no message
 *   is the opposite case - it has nothing to say, so it degrades to a pass.
 */
export function parseHookStdout(stdout: string, opts: ParseOptions): ParsedHookOutput {
  if (opts.truncated) return { ok: false, reason: "stdout exceeded the capture limit" };
  if (stdout.trim() === "") return { ok: true, outcome: { kind: "pass" } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "stdout is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "stdout JSON is not an object" };
  }

  const body = parsed as Record<string, unknown>;
  if (body.kind === undefined) {
    const foreign = translateForeignOutcome(body, opts);
    if (foreign !== undefined && "bad" in foreign) return { ok: false, reason: foreign.bad };
    return { ok: true, outcome: foreign ?? { kind: "pass" } };
  }
  if (typeof body.kind !== "string") return { ok: false, reason: "stdout 'kind' is not a string" };

  switch (body.kind) {
    case "pass":
      return { ok: true, outcome: { kind: "pass" } };
    case "deny":
      return {
        ok: true,
        outcome: {
          kind: "deny",
          message: clean(body.message) || "denied by hook (no reason given)",
        },
      };
    case "advise": {
      const message = clean(body.message);
      return { ok: true, outcome: message === "" ? { kind: "pass" } : { kind: "advise", message } };
    }
    case "rewrite": {
      if (!opts.allowRewrite) {
        return { ok: false, reason: "arguments cannot be replaced at this event" };
      }
      const replacement = plainObject(body.arguments);
      if (replacement === undefined) {
        return { ok: false, reason: "replacement arguments are not an object" };
      }
      const message = clean(body.message);
      return {
        ok: true,
        outcome: {
          kind: "rewrite",
          arguments: replacement,
          ...(message === "" ? {} : { message }),
        },
      };
    }
    case "context": {
      if (!opts.allowContext) {
        return { ok: false, reason: "a 'context' outcome is not valid at this event" };
      }
      const text = clean(body.text);
      return { ok: true, outcome: text === "" ? { kind: "pass" } : { kind: "context", text } };
    }
    default:
      return { ok: false, reason: `unknown kind '${clean(String(body.kind)).slice(0, 80)}'` };
  }
}
