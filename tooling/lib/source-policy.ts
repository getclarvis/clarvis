import ts from "typescript";

const TEST_LEVELS = new Set([
  "architecture",
  "component",
  "contract",
  "e2e",
  "integration",
  "unit",
]);

const scriptKindFor = (file) => {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
};

/** Find process-global Bun module replacements in one JavaScript/TypeScript source file. */
export function findModuleMockCalls(file, source) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const findings = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "mock" &&
      node.expression.name.text === "module"
    ) {
      const { line, character } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      findings.push({ file, line: line + 1, column: character + 1 });
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return findings;
}

/**
 * Every filename shape Bun collects as a test.
 *
 * @remarks Matching only `*.test.*` was a hole with teeth: verified on the
 * pinned Bun 1.3.11 that `tests/helpers/thing.spec.ts` and
 * `tests/helpers/thing_test.ts` are both collected and run, and both slipped
 * past this filter — so a test could sit outside every declared level, run on
 * every CI leg, and be reported by nothing. The four forms below are Bun's own
 * default collection patterns; the `[cm]?` covers the `.mts`/`.cts` variants
 * this repository already uses.
 */
const BUN_TEST_FILENAME = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/;

/** Return test files whose first directory below `tests/` is not an explicit test level. */
export function findUnclassifiedTestFiles(files) {
  return files.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    if (!BUN_TEST_FILENAME.test(normalized)) return false;
    const marker = "/tests/";
    const testsAt = normalized.lastIndexOf(marker);
    if (testsAt < 0) return false;
    const relative = normalized.slice(testsAt + marker.length);
    return !TEST_LEVELS.has(relative.split("/", 1)[0]);
  });
}
