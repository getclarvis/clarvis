import { describe, expect, test } from "bun:test";
import {
  ARG_MATCH_MAX_CHARS,
  argText,
  compileMatch,
  globToRegExp,
  matchesCandidate,
} from "../../src/match.ts";
import type { HookLogger, ToolCandidate } from "../../src/types.ts";

function candidate(tool: string, args: unknown = {}): ToolCandidate {
  return { tool, arguments: args };
}

function recorder(): { logger: HookLogger; warnings: Record<string, unknown>[] } {
  const warnings: Record<string, unknown>[] = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      warn: (fields) => warnings.push(fields),
    },
  };
}

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
    ["a*b*c", "aXXbYYc", true],
    ["a+b", "a+b", true],
    ["a+b", "aab", false],
  ])("%p vs %p", (pattern, subject, expected) => {
    expect(globToRegExp(pattern).test(subject)).toBe(expected);
  });
});

describe("compileMatch", () => {
  test("returns undefined when there is nothing to filter on", () => {
    expect(compileMatch(undefined)).toBeUndefined();
    expect(compileMatch({})).toBeUndefined();
    expect(compileMatch({ tool: [] })).toBeUndefined();
  });

  test("accepts a single pattern and an array alike", () => {
    expect(compileMatch({ tool: "shell" })?.tool).toHaveLength(1);
    expect(compileMatch({ tool: ["a", "b"] })?.tool).toHaveLength(2);
  });

  test("marks an uncompilable args pattern broken and warns", () => {
    const { logger, warnings } = recorder();
    const compiled = compileMatch({ args: { command: "([" } }, logger);
    expect(compiled?.broken).toBe(true);
    expect(warnings[0]?.match_arg).toBe("command");
  });

  test("compiles without the stateful g and y flags", () => {
    const compiled = compileMatch({ args: { command: "rm" } });
    const [entry] = compiled?.args ?? [];
    expect(entry?.[1].global).toBe(false);
    expect(entry?.[1].sticky).toBe(false);
  });

  test("a pattern is stable across repeated tests", () => {
    const compiled = compileMatch({ tool: "shell", args: { command: "rm" } });
    const call = candidate("shell", { command: "rm -rf /tmp/x" });
    expect(matchesCandidate(compiled, call)).toBe(true);
    expect(matchesCandidate(compiled, call)).toBe(true);
    expect(matchesCandidate(compiled, call)).toBe(true);
  });
});

describe("argText", () => {
  test.each([
    [{ a: "hello" }, "a", "hello"],
    [{ a: 42 }, "a", "42"],
    [{ a: true }, "a", "true"],
    [{ a: null }, "a", "null"],
    [{ a: { b: 1 } }, "a", '{"b":1}'],
    [{ a: [1, 2] }, "a", "[1,2]"],
    [{ a: "x" }, "b", undefined],
    [{ a: undefined }, "a", undefined],
  ])("reads %p.%s", (args, key, expected) => {
    expect(argText(args, key)).toBe(expected as string | undefined);
  });

  test("never resolves through the prototype chain", () => {
    expect(argText({}, "constructor")).toBeUndefined();
    expect(argText({}, "toString")).toBeUndefined();
    expect(argText({}, "hasOwnProperty")).toBeUndefined();
  });

  test("a non-object arguments value never yields text", () => {
    expect(argText(null, "a")).toBeUndefined();
    expect(argText("a string", "a")).toBeUndefined();
    expect(argText(7, "a")).toBeUndefined();
    expect(argText([{ a: 1 }], "a")).toBeUndefined();
  });

  test("an unserializable value does not match", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(argText({ a: circular }, "a")).toBeUndefined();
    expect(argText({ a: () => undefined }, "a")).toBeUndefined();
  });
});

describe("matchesCandidate", () => {
  test("an unfiltered hook always fires, candidate or not", () => {
    expect(matchesCandidate(undefined, candidate("shell"))).toBe(true);
    expect(matchesCandidate(undefined, undefined)).toBe(true);
  });

  test("a filtered hook never fires without a candidate", () => {
    expect(matchesCandidate(compileMatch({ tool: "shell" }), undefined)).toBe(false);
  });

  test("a broken filter never fires", () => {
    const compiled = compileMatch({ args: { command: "([" } });
    expect(matchesCandidate(compiled, candidate("shell", { command: "anything" }))).toBe(false);
  });

  test("tool patterns are alternatives", () => {
    const compiled = compileMatch({ tool: ["shell", "write_file"] });
    expect(matchesCandidate(compiled, candidate("shell"))).toBe(true);
    expect(matchesCandidate(compiled, candidate("write_file"))).toBe(true);
    expect(matchesCandidate(compiled, candidate("read_file"))).toBe(false);
  });

  test("tool matching is case-sensitive", () => {
    expect(matchesCandidate(compileMatch({ tool: "shell" }), candidate("Shell"))).toBe(false);
  });

  test("args entries are conjunctive", () => {
    const compiled = compileMatch({ args: { command: "rm", cwd: "/tmp" } });
    expect(matchesCandidate(compiled, candidate("shell", { command: "rm x", cwd: "/tmp" }))).toBe(
      true,
    );
    expect(matchesCandidate(compiled, candidate("shell", { command: "rm x", cwd: "/var" }))).toBe(
      false,
    );
    expect(matchesCandidate(compiled, candidate("shell", { command: "rm x" }))).toBe(false);
  });

  test("args patterns are unanchored unless the operator anchors them", () => {
    expect(
      matchesCandidate(
        compileMatch({ args: { c: "rm -rf" } }),
        candidate("shell", { c: "sudo rm -rf /" }),
      ),
    ).toBe(true);
    expect(
      matchesCandidate(
        compileMatch({ args: { c: "^rm " } }),
        candidate("shell", { c: "sudo rm -rf /" }),
      ),
    ).toBe(false);
  });

  test("tool and args must both hold", () => {
    const compiled = compileMatch({ tool: "shell", args: { command: "rm" } });
    expect(matchesCandidate(compiled, candidate("write_file", { command: "rm" }))).toBe(false);
    expect(matchesCandidate(compiled, candidate("shell", { command: "ls" }))).toBe(false);
  });

  test("only the clamped head of an argument is tested", () => {
    const compiled = compileMatch({ args: { command: "needle" } });
    const beyond = "x".repeat(ARG_MATCH_MAX_CHARS) + "needle";
    expect(matchesCandidate(compiled, candidate("shell", { command: beyond }))).toBe(false);
    const within = "x".repeat(10) + "needle";
    expect(matchesCandidate(compiled, candidate("shell", { command: within }))).toBe(true);
  });
});
