import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const files = [
  "packages/llm/src/stream-metrics.ts",
  "packages/code/src/adapters/stream-metrics.ts",
];

function normalize(source: string): string {
  const allowedDefault = source.replace(/source\s*=\s*["'](?:loop|code)["']/, 'source = "owner"');
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    allowedDefault,
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  return tokens.join("\0");
}

test("the normalizer permits only the owner-specific default", () => {
  expect(
    normalize('function f(source = "loop") { return source; } // owner') !==
      normalize('function f(source = "code") { return source; }'),
  ).toBe(false);
  expect(normalize("const value = 1")).not.toBe(normalize("const value = 2"));
});

test("the two production stream metrics implementations stay token-identical", async () => {
  const [left, right] = await Promise.all(files.map((file) => readFile(file, "utf8")));
  expect(normalize(left ?? "")).toBe(normalize(right ?? ""));
});
