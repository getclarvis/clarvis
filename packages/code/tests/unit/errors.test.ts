import { expect, test } from "bun:test";
import { errorText as kernelErrorText } from "@clarvis/kernel/policy";
import { errorText } from "../../src/adapters/errors.ts";

/**
 * Values chosen to cover both branches and the shapes that reach a catch block:
 * a plain error, a subclass, and every non-error a provider or a tool has been
 * seen to throw.
 */
const CASES: unknown[] = [
  new Error("boom"),
  new TypeError("wrong type"),
  Object.assign(new Error("with cause"), { cause: new Error("inner") }),
  new Error(""),
  "a bare string",
  42,
  null,
  undefined,
  { message: "not an Error" },
  Symbol("s"),
];

test("errorText matches the kernel implementation it was copied from", () => {
  for (const value of CASES) {
    expect(errorText(value)).toBe(kernelErrorText(value));
  }
});

test("errorText reports an Error's message and stringifies anything else", () => {
  expect(errorText(new Error("boom"))).toBe("boom");
  expect(errorText("a bare string")).toBe("a bare string");
  expect(errorText(null)).toBe("null");
  expect(errorText(undefined)).toBe("undefined");
});
