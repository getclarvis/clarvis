import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import type { BindingFieldContext } from "@opentui/keymap";

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;

/** The keymap data keys a binding's `when` clause may reference. */
export type ContextKey = "overlay" | "autocomplete";

const CONTEXT_KEYS: readonly ContextKey[] = ["overlay", "autocomplete"];

/** A parsed `when` expression: a truthy check, equality, or a bounded value set. */
export type Clause =
  | { kind: "truthy"; key: ContextKey }
  | { kind: "eq"; key: ContextKey; value: string }
  | { kind: "oneOf"; key: ContextKey; values: readonly string[] };

function assertKey(key: string): ContextKey {
  if (!(CONTEXT_KEYS as readonly string[]).includes(key)) {
    throw new Error(`when: unknown context key "${key}" (allowed: ${CONTEXT_KEYS.join(", ")})`);
  }
  return key as ContextKey;
}

/**
 * Parses a `when` expression (`key`, `key==value`, or `key in (a, b)`) into a
 * {@link Clause}.
 *
 * @throws {@link Error} if the expression is empty, malformed, or references
 *   a key outside {@link ContextKey}.
 */
export function parseWhen(input: string): Clause {
  const s = input.trim();
  if (s.length === 0) throw new Error("when: empty expression");

  const eqMatch = /^([A-Za-z]\w*)\s*==\s*(\S+)$/.exec(s);
  if (eqMatch) return { kind: "eq", key: assertKey(eqMatch[1]!), value: eqMatch[2]! };

  const oneOfMatch = /^([A-Za-z]\w*)\s+in\s+\(([^()]*)\)$/.exec(s);
  if (oneOfMatch) {
    const values = oneOfMatch[2]!.split(",").map((value) => value.trim());
    if (values.length === 0 || values.some((value) => !/^[^\s,()]+$/.test(value)))
      throw new Error(`when: bad expression "${s}"`);
    return { kind: "oneOf", key: assertKey(oneOfMatch[1]!), values };
  }

  if (!/^[A-Za-z]\w*$/.test(s)) throw new Error(`when: bad expression "${s}"`);
  return { kind: "truthy", key: assertKey(s) };
}

/**
 * Whether a context value counts as "on" for a bare truthy `when` clause.
 *
 * @remarks `"none"` and `""` are treated as falsy alongside `null`/`undefined`/
 * `false`, since context values default to sentinels like `overlay: "none"`
 * rather than being absent.
 */
export function isTruthy(v: unknown): boolean {
  return v === true || (v != null && v !== false && v !== "none" && v !== "");
}

/** Evaluates a parsed {@link Clause} against the current context values. */
export function evalClause(c: Clause, get: (k: ContextKey) => unknown): boolean {
  if (c.kind === "truthy") return isTruthy(get(c.key));
  if (c.kind === "eq") return get(c.key) === c.value;
  return c.values.includes(String(get(c.key)));
}

/**
 * Compiles a binding/layer's `when` field into the keymap's own gating: an
 * equality clause becomes a static `ctx.require`, a truthy clause becomes a
 * live `ctx.activeWhen` predicate.
 *
 * @throws {@link Error} if `value` is not a string, or fails {@link parseWhen}.
 */
export function compileWhen(
  value: unknown,
  ctx: BindingFieldContext,
  get: (k: ContextKey) => unknown,
): void {
  if (typeof value !== "string") throw new Error("when: expected a string expression");
  const clause = parseWhen(value);
  if (clause.kind === "eq") {
    ctx.require(clause.key, clause.value);
    return;
  }
  if (clause.kind === "oneOf") {
    ctx.activeWhen(() => evalClause(clause, get));
    return;
  }
  ctx.activeWhen(() => evalClause(clause, get));
}

/** Registers `when` as a recognized binding and layer field on the given keymap. */
export function registerWhenField(keymap: OpenTuiKeymap): () => void {
  const get = (k: ContextKey): unknown => keymap.getData(k);
  const offBindings = keymap.registerBindingFields({
    when: (value, ctx) => compileWhen(value, ctx, get),
  });
  const offLayers = keymap.registerLayerFields({
    when: (value, ctx) => compileWhen(value, ctx, get),
  });
  return () => {
    offLayers();
    offBindings();
  };
}
