import { describe, expect, test } from "../helpers/bun-test.ts";
import { escapeRegExp, globToRegExp } from "../../src/glob.ts";

describe("escapeRegExp", () => {
  test("escapes every regex metacharacter", () => {
    expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeRegExp("github_create_issue")).toBe("github_create_issue");
  });
});

describe("globToRegExp", () => {
  test.each([
    ["shell", "shell", true],
    ["shell", "shell_extra", false],
    ["shell", "my_shell", false],
    ["github.*", "github.create_issue", true],
    ["github.*", "github.", true],
    ["github.*", "mygithub.create_issue", false],
    ["github.*", "githubXcreate", false],
    ["*", "anything", true],
    ["*", "", true],
    ["a*b*c", "aXXbYYc", true],
    ["a+b", "a+b", true],
    ["a+b", "aab", false],
  ])("%p vs %p -> %p", (pattern, subject, expected) => {
    expect(globToRegExp(pattern).test(subject)).toBe(expected);
  });

  test("anchors the whole string, not a substring", () => {
    expect(globToRegExp("git").test("gitx")).toBe(false);
    expect(globToRegExp("git").test("xgit")).toBe(false);
  });
});
