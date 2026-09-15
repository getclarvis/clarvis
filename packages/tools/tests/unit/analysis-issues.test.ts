import { describe, expect, test } from "bun:test";
import { analyzeShell, posixDialect, powershellDialect } from "../../src/guard/index.ts";

describe("structured shell uncertainty", () => {
  test.each([
    ['git commit -m "$MSG"', "parameter_expansion", "value"],
    ['git commit -m "${MSG}"', "parameter_expansion", "value"],
    ['git commit -m "$(cat message)"', "command_substitution", "value"],
    ["echo `date`", "command_substitution", "value"],
    ["cat <(echo text)", "process_substitution", "path"],
    ["$CMD status", "dynamic_command", "executable"],
    ['git "$SUBCOMMAND"', "dynamic_subcommand", "subcommand"],
    ['cat "$FILE"', "dynamic_path", "path"],
    ["cat ~someone/file", "opaque_path", "path"],
    ['echo "unfinished', "unbalanced_syntax", "control_flow"],
    ["''", "tokenizer_gap", "executable"],
    ...["eval", "source", "env", "xargs", "base64", "sh -c", "bash -c"].map(
      (command) => [command, "opaque_command", "executable"] as const,
    ),
  ] as const)("attributes %s", (command, kind, impact) => {
    const facts = analyzeShell(`git status; ${command!}`, posixDialect);
    expect(facts.analysisIssues).toContainEqual({ segmentIndex: 1, kind, impact });
    expect(facts.analysisIssues).toEqual(
      facts.segments.flatMap((segment) => segment.analysisIssues),
    );
    expect(facts.undecidable).toBe(facts.analysisIssues.length > 0);
  });

  test("keeps literal quoted data static", () => {
    expect(analyzeShell("echo '$MSG $(date)'", posixDialect).analysisIssues).toEqual([]);
  });

  test("resolves assignment values as paths instead of assignment-shaped filenames", () => {
    expect(analyzeShell("LD_PRELOAD=/evil.so git status", posixDialect).paths).toEqual([
      "/evil.so",
    ]);
  });

  test("PowerShell backticks escape while dollar subexpressions remain dynamic", () => {
    expect(analyzeShell('Write-Output "hello`nworld"', powershellDialect).analysisIssues).toEqual(
      [],
    );
    expect(
      analyzeShell('Write-Output "$(Get-Date)"', powershellDialect).analysisIssues,
    ).toContainEqual({ segmentIndex: 0, kind: "command_substitution", impact: "value" });
  });
});
