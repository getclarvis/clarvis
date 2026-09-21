import { expect, test } from "bun:test";
import { wrapCells } from "../../src/views/truncate.ts";

test("a name wider than its panel breaks by cell without losing a character", () => {
  const name = "nome-completo-do-arquivo.test.ts";
  const lines = wrapCells(name, 20);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.join("")).toBe(name);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
});

test("a break prefers a separator so the pieces stay readable", () => {
  expect(wrapCells("packages/kernel/tests/integration", 20)).toEqual([
    "packages/kernel/",
    "tests/integration",
  ]);
});

test("a token with no separator at all still breaks by cell", () => {
  expect(wrapCells("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
});

test("a wide grapheme is never cut in half", () => {
  const text = "aébc👩‍🚀d";
  const lines = wrapCells(text, 3);
  expect(lines.join("")).toBe(text);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(3);
});

test("an explicit newline always starts a new line", () => {
  expect(wrapCells("one\ntwo", 10)).toEqual(["one", "two"]);
});

test("empty and nullish text lay out as one empty line", () => {
  expect(wrapCells("", 10)).toEqual([""]);
  expect(wrapCells(undefined, 10)).toEqual([""]);
});

test("a width below one cell still lays the text out", () => {
  expect(wrapCells("ab", 0)).toEqual(["a", "b"]);
});
