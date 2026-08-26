/**
 * How many characters of a malformed tool-argument payload are kept for the
 * model-facing message and the trace.
 *
 * @remarks Enough to show a human (and the model) exactly where the payload was
 *   cut, without letting a large mangled blob back into the context.
 */
export const MALFORMED_ARGUMENTS_PREVIEW_CHARS = 200;

/**
 * The outcome of {@link normalizeToolArguments}: either a usable argument
 * object, or the raw payload that could not be decoded into one.
 */
export type NormalizedToolArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; preview: string; reason: "unparsable" | "not_an_object" };

/** Whether `value` is a plain, non-array object usable as an argument record. */
function isArgumentRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render the first {@link MALFORMED_ARGUMENTS_PREVIEW_CHARS} characters of a
 * payload, marking a truncation this function performed with a trailing
 * ellipsis so it is not confused with the provider's own cut.
 */
function preview(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > MALFORMED_ARGUMENTS_PREVIEW_CHARS
    ? `${text.slice(0, MALFORMED_ARGUMENTS_PREVIEW_CHARS)}…`
    : text;
}

/**
 * Decide what a provider's raw {@link LLMToolCall.arguments} actually is.
 *
 * @param raw - the value the provider layer produced, which is `unknown` by
 *   contract and in practice may be an object, a JSON string, a truncated JSON
 *   string, or nothing at all.
 * @returns `{ ok: true }` with the argument record, or `{ ok: false }` with a
 *   bounded `preview` of what arrived and why it was rejected.
 * @remarks Absent arguments are **accepted as `{}`**, because a tool whose
 *   schema requires nothing is legitimately called that way and several are
 *   (`list_dir`, `list_memories`, `monitor_list`). An empty or whitespace-only
 *   string is the same case: the AI SDK itself treats `""` as `{}`.
 *
 *   A string that parses to an object is accepted, because a provider handing
 *   back already-serialized arguments is a real shape and silently dispatching
 *   `{}` for it would lose a perfectly good call.
 *
 *   Everything else is a **failure, never a silent `{}`**. Substituting an empty
 *   object makes the tool answer with a schema error naming a property the model
 *   did send, which is a false statement about what happened — and it is what
 *   made a truncated payload take a full investigation to diagnose.
 */
export function normalizeToolArguments(raw: unknown): NormalizedToolArguments {
  if (raw === undefined || raw === null) return { ok: true, args: {} };
  if (isArgumentRecord(raw)) return { ok: true, args: raw };
  if (typeof raw === "string") {
    if (raw.trim().length === 0) return { ok: true, args: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, preview: preview(raw), reason: "unparsable" };
    }
    return isArgumentRecord(parsed)
      ? { ok: true, args: parsed }
      : { ok: false, preview: preview(raw), reason: "not_an_object" };
  }
  return { ok: false, preview: preview(raw), reason: "not_an_object" };
}

/**
 * The message a model is given when its tool call's arguments did not survive
 * the provider round-trip.
 *
 * @param toolName - the tool the model was calling.
 * @param norm - the rejected outcome from {@link normalizeToolArguments}.
 * @returns text that states what arrived rather than what a schema wanted.
 * @remarks The preview is the point. Told only "invalid arguments", a model
 *   re-sends the identical call and the run dies in the convergence guard; shown
 *   where its payload was cut, it can re-issue a command that avoids the
 *   sequence that triggered the cut.
 */
export function malformedArgumentsMessage(
  toolName: string,
  norm: Extract<NormalizedToolArguments, { ok: false }>,
): string {
  const cause =
    norm.reason === "unparsable"
      ? "arrived truncated or malformed and could not be parsed as JSON"
      : "did not decode to a JSON object";
  return (
    `The arguments for '${toolName}' ${cause}, so the call was not run. ` +
    `This is a transport fault, not a mistake in what you asked for: the payload was cut ` +
    `before it reached the tool. What arrived was: ${norm.preview}\n` +
    `Re-issue the call. If it is cut at the same place again, rewrite the arguments to avoid ` +
    `the character sequence where the payload ends.`
  );
}
