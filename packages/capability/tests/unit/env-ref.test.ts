import { describe, expect, test } from "../helpers/bun-test.ts";
import { envRefPattern, extractEnvRefs } from "../../src/env-ref.ts";

describe("envRefPattern", () => {
  test("returns a fresh, globally-flagged RegExp on every call", () => {
    const a = envRefPattern();
    const b = envRefPattern();
    expect(a).not.toBe(b);
    expect(a.global).toBe(true);
  });

  test("matches ${NAME} and captures the name", () => {
    const match = envRefPattern().exec("${TOKEN}");
    expect(match?.[0]).toBe("${TOKEN}");
    expect(match?.[1]).toBe("TOKEN");
  });

  test("a shared instance reused across replace calls is not left mid-scan", () => {
    const re = envRefPattern();
    "${A}".replace(re, () => "x");
    expect("${B}".replace(re, () => "y")).toBe("y");
  });
});

describe("extractEnvRefs", () => {
  test.each([
    ["${TOKEN}", ["TOKEN"]],
    ["Bearer ${API_KEY}", ["API_KEY"]],
    ["${A}-${B}", ["A", "B"]],
    ["no references", []],
    ["${1BAD}", []],
    ["$NOT_BRACED", []],
    ["${_leading}", ["_leading"]],
    ["${FOO}${BAR}${FOO}", ["FOO", "BAR", "FOO"]],
    ["${VAR}text${VAR2}", ["VAR", "VAR2"]],
  ])("reads %p", (template, expected) => {
    expect(extractEnvRefs(template)).toEqual(expected);
  });

  test("two separate calls do not share state", () => {
    expect(extractEnvRefs("${A}")).toEqual(["A"]);
    expect(extractEnvRefs("${B}${C}")).toEqual(["B", "C"]);
  });
});
