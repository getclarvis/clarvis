import type {
  BuiltinTraceKind,
  TraceDetailFor,
  TraceDetailMap,
  TraceKind,
} from "@clarvis/capability";
import { DELEGATE_TASK_MAX_CHARS, isBuiltinTraceKind } from "@clarvis/capability";

/** The marker appended by {@link truncate} to a string it shortened. */
export const TRUNCATED_SUFFIX = "...[truncated]";

/**
 * Character cap for ordinary free text: tool results, steering, errors and
 * reasoning.
 *
 * @remarks The reference point the rest of this table is set against, so the
 * ordering carries more meaning than any of the magnitudes. A trace entry is a
 * *record of what happened*, not a copy of what was said: what has to survive
 * is enough of the text to recognise the event and to reconstruct the run's
 * shape, and the full text always exists somewhere else — the tool spilled it,
 * the transcript kept it, or the provider was paid for it.
 *
 * The relations, in the order they were reasoned about:
 *
 * - {@link ARGS_MAX} is twice this, because an argument is what the agent *did*
 *   and a result is only what it was told.
 * - {@link SUMMARY_MAX} is a tenth of it, because a question or a degradation
 *   reason that needs more than a couple of sentences is not a summary.
 * - {@link DIFF_MAX} is four times it, because a diff is the one payload whose
 *   value is exactly its completeness.
 * - {@link MODEL_RESPONSE_MAX} leaves the table entirely and is pinned to the
 *   TUI's own retention ceiling, for the reason given there.
 *
 * Their absolute sizes are bracketed rather than derived: large enough that an
 * ordinary entry is never cut, small enough that a pathological one cannot make
 * the record unreadable or the file unbounded.
 */
export const RESULT_MAX = 5000;

/**
 * Character cap for an iteration's authoritative final model response.
 *
 * Kept separate from {@link RESULT_MAX}: the final response is user-facing transcript prose, not
 * a compact trace summary. Two MiB matches the TUI's per-node retention ceiling, so persistence
 * preserves everything the transcript can retain while still bounding pathological providers.
 */
export const MODEL_RESPONSE_MAX = 2 * 1024 * 1024;

/** Character cap for short summaries: questions, degradation reasons. */
export const SUMMARY_MAX = 500;

/** Character cap for a unified diff attached to a tool call. */
export const DIFF_MAX = 20000;

/** Character cap for one live output/stream chunk, kept as a tail. */
export const LIVE_CHUNK_MAX = 8192;

/**
 * Character cap applied to each individual string inside a tool call's
 * `arguments`.
 *
 * @remarks This is the per-leaf fidelity cap. {@link ARGS_TOTAL_MAX},
 *   {@link DETAIL_MAX_ENTRIES} and {@link DETAIL_MAX_DEPTH} independently bound
 *   an extremely wide/deep object; without both layers many individually small
 *   strings can retain more than one giant mutation body. Larger than
 *   {@link RESULT_MAX} on purpose: an argument is what the agent *did*.
 */
export const ARGS_MAX = 10000;

/** Aggregate string/key budget for one tool-argument projection. */
export const ARGS_TOTAL_MAX = 64 * 1024;

/**
 * Structural ceilings shared by tool arguments and contributed trace detail.
 *
 * @remarks These bound the *shape* rather than the size, which is why they sit
 * beside the byte budget instead of replacing it: {@link ARGS_TOTAL_MAX} already
 * stops a large object, but neither it nor {@link ARGS_MAX} stops a cheap one
 * that is pathological to walk or to render. Both are set where no
 * hand-authored or model-authored payload reaches them and only a generated or
 * cyclic structure does — the depth in particular is far past anything a tool
 * schema describes, so it functions as a recursion stop rather than as a
 * fidelity limit.
 */
export const DETAIL_MAX_ENTRIES = 4096;
export const DETAIL_MAX_DEPTH = 32;
export const DETAIL_TRUNCATED_KEY = "__clarvis_truncated__";

/**
 * Cap a string to `max` characters, appending a `"...[truncated]"` marker when
 * it was shortened.
 *
 * @param value - the string to bound.
 * @param max - the maximum kept length before the suffix is added.
 * @returns `value` unchanged when within `max`, otherwise its first `max`
 *   characters plus the truncation suffix.
 * @remarks Idempotent at a *fixed* `max`: a value this produced is `max +
 *   TRUNCATED_SUFFIX.length` long, so re-applying it re-slices the identical
 *   prefix and re-appends one suffix. It is **not** idempotent across differing
 *   caps — capping at `n` and then at some `m` in `(n, n + TRUNCATED_SUFFIX.length)`
 *   cuts into the first suffix and leaves a mangled marker. That is the whole
 *   reason {@link capDetail} owns the bounds and the persistence mapper calls it
 *   instead of declaring a second cap table.
 */
export function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + TRUNCATED_SUFFIX : value;
}

/**
 * Cap a string to its last `max` characters, keeping the tail rather than the head.
 *
 * @param value - the string to bound.
 * @param max - the maximum number of trailing characters to keep.
 * @returns `value` unchanged when within `max`, otherwise its final `max` characters.
 * @remarks Used for live output chunks, where the newest bytes are the
 *   interesting ones. No marker is added: a delta is a fragment already.
 */
export function truncateTail(value: string, max: number): string {
  return value.length > max ? value.slice(-max) : value;
}

/** Keep one bounded Unicode prefix plus a marker inside the same total ceiling. */
function truncateUnicodeTotal(value: string, max: number): string {
  if (value.length <= max) return value;
  const prefixChars = Math.max(0, max - TRUNCATED_SUFFIX.length);
  let chars = 0;
  let offset = 0;
  let prefixEnd = 0;
  while (offset < value.length) {
    if (chars === prefixChars) prefixEnd = offset;
    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    chars += 1;
    if (chars > max) return value.slice(0, prefixEnd) + TRUNCATED_SUFFIX;
  }
  return value;
}

/**
 * Cap every reachable string plus the aggregate width/depth of `value`,
 * preserving reference identity wherever nothing was shortened.
 *
 * @param value - an arbitrary JSON-shaped value (tool arguments).
 * @param max - the per-string character cap.
 * @returns `value` itself when no string exceeded `max`, otherwise a structural
 *   copy with the oversized strings capped.
 * @remarks Returning the original reference on the common path is what lets
 *   {@link capDetail} promise not to allocate for a detail it did not change.
 */
function capStrings(value: unknown, max: number, totalMax = ARGS_TOTAL_MAX): unknown {
  const state = {
    remainingChars: totalMax,
    remainingEntries: DETAIL_MAX_ENTRIES,
    seen: new WeakSet<object>(),
  };

  const marker = (): string => {
    const remaining = Math.max(0, state.remainingChars);
    const out = TRUNCATED_SUFFIX.slice(0, remaining);
    state.remainingChars -= out.length;
    return out;
  };

  const boundedString = (input: string): { value: string; incomplete: boolean } => {
    const perLeaf = truncate(input, max);
    if (perLeaf.length <= state.remainingChars) {
      state.remainingChars -= perLeaf.length;
      return { value: perLeaf, incomplete: false };
    }
    const remaining = Math.max(0, state.remainingChars);
    if (remaining === 0) return { value: "", incomplete: true };
    if (remaining <= TRUNCATED_SUFFIX.length) return { value: marker(), incomplete: true };
    const prefix = input.slice(0, remaining - TRUNCATED_SUFFIX.length);
    state.remainingChars = 0;
    return { value: prefix + TRUNCATED_SUFFIX, incomplete: true };
  };

  const visit = (
    input: unknown,
    depth: number,
  ): { value: unknown; changed: boolean; incomplete: boolean } => {
    if (typeof input === "string") {
      const next = boundedString(input);
      return {
        value: next.value,
        changed: next.value !== input,
        incomplete: next.incomplete,
      };
    }
    if (input === null || typeof input !== "object")
      return { value: input, changed: false, incomplete: false };
    if (depth >= DETAIL_MAX_DEPTH || state.seen.has(input))
      return { value: marker(), changed: true, incomplete: true };
    state.seen.add(input);

    if (Array.isArray(input)) {
      const limit = Math.min(input.length, state.remainingEntries);
      const out: unknown[] = [];
      let changed = limit !== input.length;
      let incomplete = limit !== input.length;
      for (let index = 0; index < limit; index += 1) {
        state.remainingEntries -= 1;
        if (!Object.hasOwn(input, index)) {
          out.length += 1;
          continue;
        }
        const projected = visit(input[index], depth + 1);
        out.push(projected.value);
        if (projected.changed) changed = true;
        if (projected.incomplete) incomplete = true;
        if (state.remainingChars <= 0 || state.remainingEntries <= 0) {
          if (index + 1 < input.length) {
            changed = true;
            incomplete = true;
          }
          break;
        }
      }
      if (changed && out.length < input.length) out.push(marker());
      return { value: changed ? out : input, changed, incomplete };
    }

    const out: Record<string, unknown> = {};
    let changed = false;
    let incomplete = false;
    let visited = 0;
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      if (
        state.remainingEntries <= 0 ||
        state.remainingChars < key.length ||
        visited >= DETAIL_MAX_ENTRIES
      ) {
        changed = true;
        incomplete = true;
        break;
      }
      state.remainingEntries -= 1;
      state.remainingChars -= key.length;
      visited += 1;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        changed = true;
        incomplete = true;
        continue;
      }
      const projected = visit(descriptor.value, depth + 1);
      out[key] = projected.value;
      if (projected.changed) changed = true;
      if (projected.incomplete) incomplete = true;
      if (state.remainingChars <= 0 || state.remainingEntries <= 0) {
        changed = true;
        incomplete = true;
        break;
      }
    }
    if (incomplete) out[DETAIL_TRUNCATED_KEY] = true;
    return { value: changed ? out : input, changed, incomplete };
  };

  return visit(value, 0).value;
}

type KindedDetail = {
  [K in BuiltinTraceKind]: { kind: K; detail: TraceDetailMap[K] };
}[BuiltinTraceKind];

function capKinded(e: KindedDetail): unknown {
  switch (e.kind) {
    case "lead_iteration": {
      const d = e.detail;
      const response = truncate(d.response, MODEL_RESPONSE_MAX);
      return response === d.response ? d : { ...d, response };
    }
    case "subagent_iteration": {
      const d = e.detail;
      const response = truncate(d.response, MODEL_RESPONSE_MAX);
      return response === d.response ? d : { ...d, response };
    }
    case "tool_call": {
      const d = e.detail;
      const result = truncate(d.result, RESULT_MAX);
      const args = capStrings(d.arguments, ARGS_MAX);
      const diff = d.diff === undefined ? undefined : truncate(d.diff, DIFF_MAX);
      if (result === d.result && args === d.arguments && diff === d.diff) return d;
      return { ...d, result, arguments: args, ...(diff === undefined ? {} : { diff }) };
    }
    case "tool_call_started": {
      const d = e.detail;
      const args = capStrings(d.arguments, ARGS_MAX);
      return args === d.arguments ? d : { ...d, arguments: args };
    }
    case "tool_output_delta": {
      const d = e.detail;
      const chunk = truncateTail(d.chunk, LIVE_CHUNK_MAX);
      return chunk === d.chunk ? d : { ...d, chunk };
    }
    case "delegation_completed":
    case "delegation_failed": {
      const d = e.detail;
      const result = truncate(d.result, RESULT_MAX);
      return result === d.result ? d : { ...d, result };
    }
    case "delegation_created": {
      const d = e.detail;
      const task = truncateUnicodeTotal(d.task, DELEGATE_TASK_MAX_CHARS);
      return task === d.task ? d : { ...d, task };
    }
    case "user_question": {
      const d = e.detail;
      const question = truncate(d.question, SUMMARY_MAX);
      const answer = d.answer === undefined ? undefined : truncate(d.answer, RESULT_MAX);
      if (question === d.question && answer === d.answer) return d;
      return { ...d, question, ...(answer === undefined ? {} : { answer }) };
    }
    case "user_steering": {
      const d = e.detail;
      const message = truncate(d.message, RESULT_MAX);
      return message === d.message ? d : { ...d, message };
    }
    case "model_call_error": {
      const d = e.detail;
      const message = truncate(d.message, RESULT_MAX);
      return message === d.message ? d : { ...d, message };
    }
    case "model_reasoning": {
      const d = e.detail;
      const text = truncate(d.text, RESULT_MAX);
      return text === d.text ? d : { ...d, text };
    }
    case "model_stream_delta": {
      const d = e.detail;
      const text = truncate(d.text, RESULT_MAX);
      return text === d.text ? d : { ...d, text };
    }
    case "convergence_warning": {
      const d = e.detail;
      const message = truncate(d.message, SUMMARY_MAX);
      return message === d.message ? d : { ...d, message };
    }
    case "elicitation_requested": {
      const d = e.detail;
      const question = truncate(d.question, SUMMARY_MAX);
      return question === d.question ? d : { ...d, question };
    }
    case "mcp_degraded": {
      const d = e.detail;
      let changed = false;
      const servers = d.servers.map((s) => {
        const reason = truncate(s.reason, SUMMARY_MAX);
        if (reason === s.reason) return s;
        changed = true;
        return { ...s, reason };
      });
      return changed ? { ...d, servers } : d;
    }
    default:
      return e.detail;
  }
}

/**
 * Bound the free-text fields of a trace detail at the moment it enters
 * retention or persistence.
 *
 * @param kind - the {@link TraceKind} discriminating `detail`.
 * @param detail - the payload about to be recorded or signalled.
 * @returns `detail` itself when every field was already within its cap,
 *   otherwise a shallow copy carrying the capped fields.
 * @remarks Two properties this must never lose.
 *
 *   It is **non-mutating**. A tool call's `arguments` is the very object the
 *   model's conversation holds; capping it in place would rewrite the run's
 *   input, not just its record.
 *
 *   It is the **only cap table**. `mapEntryRaw` calls this function before it
 *   projects a detail, as defence in depth for entries that bypassed
 *   `createTrace`; it does not restate any per-kind cap.
 *
 *   Kinds with no free-text field fall through the `default` and are returned
 *   untouched. A new {@link TraceKind} carrying unbounded text has to be added
 *   here, or it is retained whole for the length of the run — which is precisely
 *   the defect this function exists to close.
 *
 *   A **contributed** kind — one a capability declared, whose `detail` is
 *   `unknown` to this package — cannot be capped field by field, so every string
 *   reachable from it is bounded at {@link RESULT_MAX} instead. Without that
 *   pass a capability writes an unbounded payload straight into the persisted
 *   record and back out over rehydration, while the engine's own events stay
 *   capped: the branch that carries a contributed detail through verbatim is
 *   precisely the one that skips every bound above it.
 */
export function capDetail<K extends TraceKind>(
  kind: K,
  detail: TraceDetailFor<K>,
): TraceDetailFor<K> {
  if (!isBuiltinTraceKind(kind)) return capStrings(detail, RESULT_MAX) as TraceDetailFor<K>;
  return capKinded({ kind, detail } as KindedDetail) as TraceDetailFor<K>;
}
