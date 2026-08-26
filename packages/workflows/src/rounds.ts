/**
 * Round semantics: what a round consumes, how replicas are judged, and when a
 * repeat block has converged.
 *
 * @remarks Everything here is pure. The point of the round model is that the
 * *barrier* is not a choice the author makes — it is derived from what the round
 * declares it consumes. `each` flows: one leader per item, dispatched as items
 * become available. `all` is a barrier, because a round that consumes the whole
 * set genuinely cannot start before the set is complete. There is no `parallel`
 * and no `pipeline` to get wrong.
 *
 * The little `each(...)` / `threshold(...)` grammar below is deliberately a fixed
 * set of call shapes, **not** an expression language. If a round seems to need
 * more than a field's truth or a field's equality, the answer is that the
 * producing round should have emitted the list already filtered.
 */

/** Which shipped result schema a round's leaders are held to. */
export type RoundType = "discovery" | "findings" | "verdict" | "free";

/** The minimal filter a selector may carry: a field's truth, or its equality. */
export interface FieldFilter {
  field: string;
  equals?: string | number | boolean;
}

/** What a round consumes, and therefore whether it is a barrier. */
export type Selector =
  | { kind: "once" }
  | { kind: "each"; source: string; where?: FieldFilter }
  | { kind: "all"; source: string };

/** How a round's `fanout` replicas are folded into a single accept/reject. */
export type AcceptRule =
  | { kind: "all"; field: string; value: string }
  | { kind: "any"; field: string; value: string }
  | { kind: "majority"; field: string; value: string }
  | { kind: "threshold"; field: string; value: string; count: number };

/** A block of rounds re-run until it stops producing anything new. */
export interface RepeatSpec {
  rounds: readonly string[];
  until: "no_new" | "budget";
  dedupe_by: readonly string[];
  dry_rounds?: number;
  max_rounds: number;
}

/** Everything a workflow has produced so far, keyed by round id. */
export interface WorkflowState {
  rounds: Record<string, unknown>;
}

/** The default number of consecutive empty rounds that ends a repeat block. */
const DEFAULT_DRY_ROUNDS = 2;

/** The bucket a replica that failed or came back malformed is tallied under. */
export const UNAVAILABLE = "(unavailable)";

/**
 * Read a dotted path out of a value, or `undefined` when any step is missing.
 *
 * @param root - the value the first segment is read from.
 * @param path - the already-split segments, in order.
 * @remarks Literal segments only — no indices, no wildcards. Exported because
 *   brief interpolation resolves `{{item.field}}` by exactly this rule, and two
 *   copies of "what a dotted path means" is one too many for a package this
 *   small.
 */
export function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolve a selector `source` — `<round>.<field>` — against the accumulated state.
 *
 * @returns the array found there, or `null` when the path names nothing or names
 *   something that is not an array.
 * @remarks Literal field access only: no indices, no wildcards. A round that
 *   needs an element picked out should have been handed that element by `each`.
 */
export function resolveSource(state: WorkflowState, source: string): unknown[] | null {
  const [roundId, ...rest] = source.split(".");
  if (roundId === undefined || roundId.length === 0) return null;
  if (!Object.hasOwn(state.rounds, roundId)) return null;
  const value = readPath(state.rounds[roundId], rest);
  return Array.isArray(value) ? value : null;
}

/** True when an item satisfies a {@link FieldFilter}. */
export function matchesFilter(item: unknown, filter: FieldFilter): boolean {
  const value = readPath(item, filter.field.split("."));
  return filter.equals === undefined ? Boolean(value) : value === filter.equals;
}

/**
 * True when a round's `when` guard is satisfied — its source resolves to a
 * non-empty array.
 *
 * @remarks A guard on a missing round is `false`, not an error: a completeness
 *   round guarded on `review.coverage_gaps` should simply not run when the review
 *   never happened.
 */
export function whenSatisfied(state: WorkflowState, source: string): boolean {
  return (resolveSource(state, source) ?? []).length > 0;
}

/**
 * Work out the items a round will be run over.
 *
 * @returns one entry per leader the round will start — a single `undefined` for
 *   `once`, the filtered members for `each`, the whole array as one entry for
 *   `all` — or an error naming the source that could not be resolved.
 */
export function selectItems(
  selector: Selector,
  state: WorkflowState,
): { items: readonly unknown[] } | { error: string } {
  if (selector.kind === "once") return { items: [undefined] };
  const source = resolveSource(state, selector.source);
  if (source === null) {
    return {
      error:
        `'${selector.source}' did not resolve to an array in the workflow state; ` +
        `rounds available so far: ${Object.keys(state.rounds).join(", ") || "(none)"}`,
    };
  }
  if (selector.kind === "all") return { items: [source] };
  const where = selector.where;
  return { items: where === undefined ? source : source.filter((i) => matchesFilter(i, where)) };
}

/**
 * Fold a round's replicas into an accept/reject plus the score behind it.
 *
 * @param rule - the rule declared on the round.
 * @param replicas - one entry per replica; a failed or malformed leader belongs
 *   here too, as a non-object.
 * @remarks A replica that failed counts as **not** satisfying the rule and stays
 *   in the denominator. Dropping it is what turns "two of three verifiers died"
 *   into "confirmed unanimously". `majority` is strictly more than half, so a tie
 *   is not a majority.
 */
export function applyAccept(
  rule: AcceptRule,
  replicas: readonly unknown[],
): { accepted: boolean; tally: Record<string, number> } {
  const tally: Record<string, number> = {};
  let hits = 0;
  for (const replica of replicas) {
    const raw = readPath(replica, rule.field.split("."));
    const key = typeof raw === "string" ? raw : UNAVAILABLE;
    tally[key] = (tally[key] ?? 0) + 1;
    if (key === rule.value) hits += 1;
  }
  const total = replicas.length;
  const accepted =
    rule.kind === "all"
      ? total > 0 && hits === total
      : rule.kind === "any"
        ? hits > 0
        : rule.kind === "majority"
          ? hits * 2 > total
          : hits >= rule.count;
  return { accepted, tally };
}

/** Normalize one value for a dedupe key: order-insensitive for arrays. */
function normalizeForKey(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value)) return [...value.map(normalizeForKey)].sort().join(",");
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

/**
 * Build the identity of an item for repeat deduplication.
 *
 * @remarks The separator is a `\0` **escape**, never a literal NUL byte in the
 *   source — a raw NUL makes git treat the file as binary, which is a defect this
 *   repository has already paid for once.
 */
export function dedupeKey(item: unknown, fields: readonly string[]): string {
  return fields.map((field) => normalizeForKey(readPath(item, field.split(".")))).join("\0");
}

/**
 * Split a round's output into the items never seen before and the updated set.
 *
 * @remarks Deduplication is against **everything seen so far**, not against what
 *   survived verification. Deduplicating against the survivors makes a rejected
 *   finding reappear on every pass, and the block never converges.
 */
export function admitNew(
  items: readonly unknown[],
  fields: readonly string[],
  seen: ReadonlySet<string>,
): { fresh: readonly unknown[]; seen: ReadonlySet<string> } {
  const next = new Set(seen);
  const fresh: unknown[] = [];
  for (const item of items) {
    const key = dedupeKey(item, fields);
    if (next.has(key)) continue;
    next.add(key);
    fresh.push(item);
  }
  return { fresh, seen: next };
}

/** Why a repeat block stopped. */
export type RepeatStop = "dry_rounds" | "max_rounds" | "budget";

/**
 * Decide whether a repeat block runs another pass.
 *
 * @param spec - the block's declaration.
 * @param progress - passes already run, consecutive empty passes, and whether the
 *   token ledger has refused.
 * @remarks `max_rounds` has no default on purpose: it is the backstop, and a
 *   backstop the author did not choose is not one. `until` selects which of the
 *   other two stopping rules applies: `no_new` gives up after `dry_rounds` empty
 *   passes, while `budget` keeps going until the ledger refuses or `max_rounds`
 *   is reached. A field that is parsed and then ignored is worse than one that
 *   does not exist, because the caller believes it asked for something.
 */
export function nextRepeat(
  spec: RepeatSpec,
  progress: { roundsRun: number; dryRounds: number; budgetExhausted: boolean },
): { done: false } | { done: true; reason: RepeatStop } {
  if (progress.budgetExhausted) return { done: true, reason: "budget" };
  if (progress.roundsRun >= spec.max_rounds) return { done: true, reason: "max_rounds" };
  if (spec.until === "no_new" && progress.dryRounds >= (spec.dry_rounds ?? DEFAULT_DRY_ROUNDS)) {
    return { done: true, reason: "dry_rounds" };
  }
  return { done: false };
}

const SELECTOR_RE =
  /^(each|all)\(\s*([^\s)]+)\s*(?:where\s+([^\s)=]+)\s*(?:=\s*([^)]+?)\s*)?)?\)$/u;
const ACCEPT_RE =
  /^(all|any|majority|threshold)\(\s*([^,)]+?)\s*,\s*([^,)]+?)\s*(?:,\s*(\d+)\s*)?\)$/u;

/** Read a `where … = x` right-hand side as a boolean, a number, or a string. */
function literal(raw: string): string | number | boolean {
  const text = raw.trim().replace(/^["'](.*)["']$/u, "$1");
  if (text === "true") return true;
  if (text === "false") return false;
  const numeric = Number(text);
  return text.length > 0 && !Number.isNaN(numeric) ? numeric : text;
}

/**
 * Parse the compact selector form used in a workflow document.
 *
 * @param text - `once`, `each(<source>)`, `each(<source> where <field>)`,
 *   `each(<source> where <field> = <literal>)`, or `all(<source>)`.
 * @returns the {@link Selector}, or `null` when it is not one of those shapes.
 */
export function parseSelector(text: string): Selector | null {
  const trimmed = text.trim();
  if (trimmed === "once") return { kind: "once" };
  const match = SELECTOR_RE.exec(trimmed);
  if (match === null) return null;
  const [, kind, source, field, value] = match;
  if (kind === "all") return field === undefined ? { kind: "all", source: source! } : null;
  if (field === undefined) return { kind: "each", source: source! };
  return {
    kind: "each",
    source: source!,
    where: { field, ...(value === undefined ? {} : { equals: literal(value) }) },
  };
}

/**
 * Parse the compact accept form used in a workflow document.
 *
 * @param text - `all(<field>, <value>)`, `any(…)`, `majority(…)` or
 *   `threshold(<field>, <value>, <count>)`.
 * @returns the {@link AcceptRule}, or `null` when it is not one of those shapes.
 */
export function parseAcceptRule(text: string): AcceptRule | null {
  const match = ACCEPT_RE.exec(text.trim());
  if (match === null) return null;
  const [, kind, field, value, count] = match;
  if (kind === "threshold") {
    return count === undefined
      ? null
      : { kind: "threshold", field: field!, value: value!, count: Number(count) };
  }
  if (count !== undefined) return null;
  return { kind: kind as "all" | "any" | "majority", field: field!, value: value! };
}
