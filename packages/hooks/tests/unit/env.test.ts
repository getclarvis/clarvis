import { describe, expect, test } from "bun:test";
import { filterHookEnv as filterFull, interpolatedNames } from "../../src/env.ts";

/** The environment half, for the many cases that assert only on the result. */
function filterHookEnv(
  source: Parameters<typeof filterFull>[0],
  opts?: Parameters<typeof filterFull>[1],
): Record<string, string> {
  return filterFull(source, opts).env;
}

describe("filterHookEnv", () => {
  test("keeps what a shell needs to be a shell", () => {
    const out = filterHookEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      SHELL: "/bin/sh",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm",
      TMPDIR: "/tmp",
    });
    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      SHELL: "/bin/sh",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm",
      TMPDIR: "/tmp",
    });
  });

  test("keeps the toolchain roots the sandbox already considers necessary", () => {
    const out = filterHookEnv({ BUN_INSTALL: "/b", CARGO_HOME: "/c", JAVA_HOME: "/j" });
    expect(Object.keys(out).sort()).toEqual(["BUN_INSTALL", "CARGO_HOME", "JAVA_HOME"]);
  });

  test.each([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "MY_SECRET",
    "DB_PASSWORD",
    "SOME_TOKEN",
    "SERVICE_CREDENTIAL",
    "PRIVATE_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "VAULT_ADDR",
    "AUTHORIZATION",
    "SESSION_ID",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "PASSWORD_MANAGER_PATH",
  ])("drops %s by name shape", (name) => {
    expect(filterHookEnv({ [name]: "sensitive" })).toEqual({});
  });

  test.each(["AUTHOR", "AUTHORS", "PATH", "PATHEXT", "TOKENIZER_CACHE", "KEYBOARD_LAYOUT"])(
    "keeps %s, which merely looks similar",
    (name) => {
      expect(filterHookEnv({ [name]: "fine" })).toEqual({ [name]: "fine" });
    },
  );

  test("drops the run's own provider key even when its name says nothing", () => {
    const source = { MY_COMPANY_LLM: "sk-live", UNRELATED: "keep" };
    expect(filterHookEnv(source, { denyExact: ["MY_COMPANY_LLM"] })).toEqual({ UNRELATED: "keep" });
  });

  test("an exact denylist entry cannot strip a keep-listed variable", () => {
    expect(filterHookEnv({ PATH: "/usr/bin" }, { denyExact: ["PATH"] })).toEqual({
      PATH: "/usr/bin",
    });
  });

  test("undefined values are dropped rather than becoming the string 'undefined'", () => {
    expect(filterHookEnv({ A: undefined, B: "b" })).toEqual({ B: "b" });
  });

  test("added variables are applied last and are never filtered", () => {
    const out = filterHookEnv(
      { UNRELATED: "keep" },
      { add: { CLARVIS_HOOK_EVENT: "pre_tool_use", CLARVIS_HOOK_TOKEN_LIKE: "1" } },
    );
    expect(out.CLARVIS_HOOK_EVENT).toBe("pre_tool_use");
    expect(out.CLARVIS_HOOK_TOKEN_LIKE).toBe("1");
    expect(out.UNRELATED).toBe("keep");
  });

  test("does not mutate the source", () => {
    const source = { SECRET_KEY: "x", PATH: "/usr/bin" };
    filterHookEnv(source, { add: { EXTRA: "1" } });
    expect(source).toEqual({ SECRET_KEY: "x", PATH: "/usr/bin" });
  });
});

describe("filterHookEnv denial counts", () => {
  test("counts the exact denylist and the shape rule separately", () => {
    const out = filterFull(
      { MY_COMPANY_LLM: "sk", OPENAI_API_KEY: "sk", DB_PASSWORD: "p", UNRELATED: "keep" },
      { denyExact: ["MY_COMPANY_LLM"] },
    );
    expect(out.env).toEqual({ UNRELATED: "keep" });
    expect(out.denied).toEqual({ exact: 1, shape: 2 });
  });

  test("a variable the exact list dropped is never also charged to the shape rule", () => {
    const out = filterFull({ OPENAI_API_KEY: "sk" }, { denyExact: ["OPENAI_API_KEY"] });
    expect(out.denied).toEqual({ exact: 1, shape: 0 });
  });

  test("a keep-listed variable counts as neither", () => {
    const out = filterFull({ PATH: "/usr/bin" }, { denyExact: ["PATH"] });
    expect(out.denied).toEqual({ exact: 0, shape: 0 });
  });

  test("nothing withheld reports zero", () => {
    expect(filterFull({ UNRELATED: "keep" }).denied).toEqual({ exact: 0, shape: 0 });
  });
});

describe("interpolatedNames", () => {
  test.each([
    ["${TOKEN}", ["TOKEN"]],
    ["Bearer ${API_KEY}", ["API_KEY"]],
    ["${A}-${B}", ["A", "B"]],
    ["no references", []],
    ["${1BAD}", []],
    ["$NOT_BRACED", []],
    ["${_leading}", ["_leading"]],
  ])("reads %p", (template, expected) => {
    expect(interpolatedNames(template)).toEqual(expected);
  });
});
