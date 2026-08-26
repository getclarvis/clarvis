/**
 * How a plan surface names a failure to an operator.
 *
 * A plan document is model- and human-authored prose, and
 * `specs/cross-cutting/observability.md` §3.5 puts it on the list of things that are never
 * logged at any level. The hazard is not hypothetical: `parsePlan` surfaces the
 * `yaml` package's `YAMLParseError`, whose message *quotes the offending source
 * lines*, and two of the format's own errors interpolate the line they
 * rejected. Every diagnostic that carries a parse or read failure into a log
 * record therefore goes through {@link boundedPlanReason} rather than reading
 * `error.message`.
 */
import { sanitizeErrorMessage } from "@clarvis/capability";

/**
 * Character ceiling for one logged failure reason.
 *
 * @remarks The same 500 `@clarvis/tasks` caps a provider-authored refusal at,
 * which is `@clarvis/trace`'s `SUMMARY_MAX` — the bound this repository already
 * puts on a short degradation reason. The value is restated rather than
 * imported because `@clarvis/plan` depends on the capability contract alone.
 */
export const MAX_PLAN_LOG_REASON_CHARS = 500;

/** Marker kept inside {@link MAX_PLAN_LOG_REASON_CHARS}, so re-capping is a no-op. */
const TRUNCATION_MARKER = "…";

/**
 * Normalize, redact and bound the reason a plan file could not be used.
 *
 * @param error - whatever the read or parse threw.
 * @returns a single-line, sanitized, length-bounded sentence.
 * @remarks Whitespace is collapsed first, so a parser that answers with a
 *   multi-line excerpt stays one line of record instead of becoming several
 *   that no longer carry the record's own fields; then
 *   {@link sanitizeErrorMessage}, which is the redaction pass every other
 *   `warn` site in the repository applies; then the cap. The cap bounds the
 *   exposure a quoted excerpt represents — it does not license one, so a new
 *   diagnostic should still prefer a reason it composed itself.
 */
export function boundedPlanReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = sanitizeErrorMessage(raw.replace(/\s+/gu, " ")).trim();
  if (text.length <= MAX_PLAN_LOG_REASON_CHARS) return text;
  return text.slice(0, MAX_PLAN_LOG_REASON_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
