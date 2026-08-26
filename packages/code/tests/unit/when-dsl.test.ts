import { expect, test } from "bun:test";
import type { BindingFieldContext } from "@opentui/keymap";
import {
  compileWhen,
  evalClause,
  isTruthy,
  parseWhen,
  type ContextKey,
} from "../../src/keys/when-dsl.ts";

test("parseWhen handles truthy, equality, and bounded-set forms", () => {
  expect(parseWhen("autocomplete")).toEqual({ kind: "truthy", key: "autocomplete" });
  expect(parseWhen("overlay == none")).toEqual({ kind: "eq", key: "overlay", value: "none" });
  expect(parseWhen("overlay==none")).toEqual({ kind: "eq", key: "overlay", value: "none" });
  expect(parseWhen("overlay in (none, plan)")).toEqual({
    kind: "oneOf",
    key: "overlay",
    values: ["none", "plan"],
  });
});

test("parseWhen rejects unknown keys, dropped grammar and junk (fail-closed)", () => {
  expect(() => parseWhen("bogus")).toThrow(/unknown context key/);
  expect(() => parseWhen("overlay == ")).toThrow();
  expect(() => parseWhen("")).toThrow(/empty/);
  expect(() => parseWhen("!autocomplete")).toThrow();
  expect(() => parseWhen("overlay != none")).toThrow();
  expect(() => parseWhen("overlay in ()")).toThrow();
  expect(() => parseWhen("overlay in (none,,plan)")).toThrow();
  expect(() => parseWhen("overlay == none && autocomplete")).toThrow();
});

test("isTruthy: bool true or enum != none/''", () => {
  expect(isTruthy(true)).toBe(true);
  expect(isTruthy("active")).toBe(true);
  expect(isTruthy(false)).toBe(false);
  expect(isTruthy("none")).toBe(false);
  expect(isTruthy("")).toBe(false);
  expect(isTruthy(undefined)).toBe(false);
});

test("evalClause reads getData for all forms", () => {
  const data: Record<string, unknown> = { overlay: "none", autocomplete: false };
  const get = (k: ContextKey): unknown => data[k];
  expect(evalClause(parseWhen("overlay == none"), get)).toBe(true);
  expect(evalClause(parseWhen("autocomplete"), get)).toBe(false);
  data.autocomplete = true;
  data.overlay = "plan";
  expect(evalClause(parseWhen("overlay == none"), get)).toBe(false);
  expect(evalClause(parseWhen("autocomplete"), get)).toBe(true);
  expect(evalClause(parseWhen("overlay in (none, plan)"), get)).toBe(true);
  data.overlay = "diff";
  expect(evalClause(parseWhen("overlay in (none, plan)"), get)).toBe(false);
});

function fakeCtx(): BindingFieldContext & {
  requires: [string, unknown][];
  matchers: (() => boolean)[];
} {
  const requires: [string, unknown][] = [];
  const matchers: (() => boolean)[] = [];
  return {
    requires,
    matchers,
    require: (name, value) => requires.push([name, value]),
    attr: () => {},
    activeWhen: (m) => matchers.push(m as () => boolean),
  };
}

test("compileWhen fast-paths equality and keeps truthy/set predicates live", () => {
  const eq = fakeCtx();
  compileWhen("overlay == none", eq, () => undefined);
  expect(eq.requires).toEqual([["overlay", "none"]]);
  expect(eq.matchers.length).toBe(0);

  const truthy = fakeCtx();
  compileWhen("autocomplete", truthy, () => true);
  expect(truthy.requires.length).toBe(0);
  expect(truthy.matchers.length).toBe(1);
  expect(truthy.matchers[0]!()).toBe(true);

  const oneOf = fakeCtx();
  let overlay = "none";
  compileWhen("overlay in (none, plan)", oneOf, () => overlay);
  expect(oneOf.requires.length).toBe(0);
  expect(oneOf.matchers[0]!()).toBe(true);
  overlay = "diff";
  expect(oneOf.matchers[0]!()).toBe(false);
});
