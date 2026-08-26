import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const ajvSource = join(import.meta.dir, "..", "..", "src", "validation", "ajv.ts");

/**
 * Every `require(...)` in a file, paired with whether some enclosing function
 * defers it past module evaluation.
 */
function requireCalls(source: string): { specifier: string; deferred: boolean }[] {
  const file = ts.createSourceFile("ajv.ts", source, ts.ScriptTarget.Latest, true);
  const found: { specifier: string; deferred: boolean }[] = [];
  const visit = (node: ts.Node, insideFunction: boolean): void => {
    const nowInside =
      insideFunction ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) {
        found.push({ specifier: argument.text, deferred: insideFunction });
      }
    }
    ts.forEachChild(node, (child) => visit(child, nowInside));
  };
  visit(file, false);
  return found;
}

describe("eager validator boundary", () => {
  it("loads ajv only when a validator is actually built", () => {
    const calls = requireCalls(readFileSync(ajvSource, "utf8"));
    expect(calls.map((c) => c.specifier).sort()).toEqual(["ajv", "ajv-formats"]);
    for (const call of calls) {
      expect(call.deferred).toBe(true);
    }
  });

  it("distinguishes a deferred require from a top-level one", () => {
    const sample = requireCalls(
      ['const a = require("eager");', "function later() {", '  return require("lazy");', "}"].join(
        "\n",
      ),
    );
    expect(sample).toEqual([
      { specifier: "eager", deferred: false },
      { specifier: "lazy", deferred: true },
    ]);
  });
});
