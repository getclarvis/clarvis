/**
 * Deciding whether a tool-scoped hook applies to the tool call in front of it.
 *
 * @remarks
 * Every rule here is a narrowing: when the filter cannot be evaluated the hook
 * does not fire. That direction is deliberate and is stated again at each rule,
 * because the opposite default turns one malformed filter into a hook that
 * fires on everything — and a `deny` hook that fires on everything bricks the
 * workspace.
 */
import { globToRegExp } from "@clarvis/capability";
import type { HookLogger, HookMatch, ToolCandidate } from "./types.ts";

export { globToRegExp };

/**
 * Longest prefix of an argument value that {@link matchesCandidate} tests.
 *
 * @remarks
 * The patterns are operator-authored and the values are model-authored, so an
 * unbounded test is a denial-of-service against whichever thread runs the
 * regex. Clamping the input is not a cure for a catastrophically backtracking
 * pattern — only a step-budgeted engine would be — but it bounds the exposure to
 * something a filter has no legitimate reason to exceed.
 */
export const ARG_MATCH_MAX_CHARS = 8192;

/** A {@link HookMatch} with its patterns compiled once, ahead of the fire point. */
export interface CompiledMatch {
  readonly tool: readonly RegExp[] | undefined;
  readonly args: readonly (readonly [key: string, re: RegExp])[] | undefined;
  /** A pattern failed to compile; the filter then never matches. */
  readonly broken: boolean;
}

/**
 * Compiles a hook's filter once, so a fire point costs no regex construction.
 *
 * @param match - the configured filter, or `undefined` for an unfiltered hook.
 * @param log - receives a warning naming any pattern that failed to compile.
 * @returns `undefined` when there is nothing to filter on, otherwise a
 *   {@link CompiledMatch} - possibly `broken`.
 * @remarks
 * Patterns are compiled without the `g` and `y` flags on purpose: both make
 * `RegExp.prototype.test` stateful through `lastIndex`, which would let one tool
 * call's result depend on the previous one's.
 *
 * The loop's schema already rejects an uncompilable `args` pattern at config
 * read time, so `broken` is reachable only for an embedder that skipped
 * validation. It still fails closed rather than throwing, because the
 * alternative at a fire point is an exception on a path whose whole contract is
 * that it produces a value.
 */
export function compileMatch(
  match: HookMatch | undefined,
  log?: HookLogger,
): CompiledMatch | undefined {
  if (match === undefined) return undefined;
  const patterns =
    match.tool === undefined
      ? undefined
      : typeof match.tool === "string"
        ? [match.tool]
        : match.tool;
  if ((patterns === undefined || patterns.length === 0) && match.args === undefined)
    return undefined;

  let broken = false;
  const tool = patterns?.map((p) => globToRegExp(p));
  const args: (readonly [string, RegExp])[] = [];
  for (const [key, pattern] of Object.entries(match.args ?? {})) {
    try {
      args.push([key, new RegExp(pattern)]);
    } catch {
      broken = true;
      log?.warn(
        { match_arg: key, pattern },
        "hook match.args pattern is not a valid regular expression; the hook will never fire",
      );
    }
  }
  return {
    tool: tool === undefined || tool.length === 0 ? undefined : tool,
    args: match.args === undefined ? undefined : args,
    broken,
  };
}

/**
 * Reads one argument field as the text a {@link HookMatch.args} pattern is tested against.
 *
 * @param args - the tool call's arguments, of unknown shape.
 * @param key - the argument field name from the filter.
 * @returns the field's text, or `undefined` when it cannot be read - which the
 *   caller treats as "does not match".
 * @remarks
 * Four rules that are easy to get wrong and each have a test:
 *
 * - **Own properties only.** Without the `hasOwnProperty` check a filter keyed
 *   `constructor` or `toString` would resolve through the prototype chain and
 *   match on every single tool call.
 * - **A non-object `arguments` never matches**, rather than falling back to
 *   stringifying the whole value. A filter is a narrowing; failing to read the
 *   field is failing to narrow.
 * - **Non-strings go through `JSON.stringify`**, exactly as the schema
 *   documents. `null` becomes the literal `"null"`, numbers `"42"`, and objects
 *   compact JSON in insertion-key order - so a pattern against a structured
 *   argument is order-dependent.
 * - **Unserializable values do not match.** A circular object or a `BigInt`
 *   throws, and a function or symbol yields `undefined`.
 */
export function argText(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(args, key)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Whether a compiled filter selects this tool call.
 *
 * @param compiled - the filter, or `undefined` for an unfiltered hook.
 * @param candidate - the pending tool call, or `undefined` at a fire point that
 *   has none.
 * @returns `true` when the hook should fire.
 * @remarks
 * An unfiltered hook always fires, including where there is no candidate - that
 * is what makes the same runner usable for the events that carry no tool. A
 * filtered hook at a candidate-less fire point never fires, because its
 * narrowing cannot be evaluated; the loop's schema rejects that combination at
 * config time, so this only shields an embedder.
 *
 * `tool` patterns are alternatives (any may match) while `args` entries are
 * conjunctive (all must match), as the schema states. Matching is
 * case-sensitive, consistent with tool wire names everywhere else, and the
 * `args` patterns are **unanchored** - `"rm -rf"` matches anywhere in the value,
 * and anchoring is the operator's job.
 */
export function matchesCandidate(
  compiled: CompiledMatch | undefined,
  candidate: ToolCandidate | undefined,
): boolean {
  if (compiled === undefined) return true;
  if (compiled.broken || candidate === undefined) return false;
  if (compiled.tool !== undefined && !compiled.tool.some((re) => re.test(candidate.tool))) {
    return false;
  }
  for (const [key, re] of compiled.args ?? []) {
    const text = argText(candidate.arguments, key);
    if (text === undefined || !re.test(text.slice(0, ARG_MATCH_MAX_CHARS))) return false;
  }
  return true;
}
