import { describe, expect, it } from "bun:test";
import { analyzeShell, posixDialect, powershellDialect } from "../../src/guard/index.ts";

describe("Git presentation flag normalization", () => {
  it.each([
    "git --no-pager status",
    "git --no-color --no-pager status",
    "FOO=bar timeout 5 nice git --no-pager --no-color status",
  ])("strips leading global presentation flags from %s", (command) => {
    const facts = analyzeShell(command, posixDialect);
    expect(facts.segments[0]!.normalized).toBe("git status");
    expect(facts.segments[0]!.argv).toEqual(["git", "status"]);
  });

  it.each([
    "git diff --no-color",
    "git status -- --no-pager",
    "echo git --no-pager status",
    "git -C src status",
    "git -c alias.x=--no-color status",
  ])("preserves command operands and non-presentation options in %s", (command) => {
    expect(analyzeShell(command, posixDialect).segments[0]!.normalized).toBe(command);
  });

  it("retains env assignments and leaves PowerShell normalization unchanged", () => {
    expect(
      analyzeShell("FOO=bar git --no-pager status", posixDialect).segments[0]!.envAssignments,
    ).toEqual(["FOO=bar"]);
    expect(analyzeShell("git --no-pager status", powershellDialect).segments[0]!.normalized).toBe(
      "git --no-pager status",
    );
  });
});
