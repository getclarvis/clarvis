import { describe, it, expect } from "bun:test";
import {
  interpolateEnvWith,
  resolveStringMap,
  resolveStringMapWith,
  MissingEnvVarsError,
} from "../../src/env-interpolate.ts";

/** An env-shaped lookup, so the substring cases read as they did before. */
const from =
  (env: Record<string, string>) =>
  (name: string): string | undefined =>
    env[name];

describe("interpolateEnvWith", () => {
  it("resolves a ${VAR} substring within a value", () => {
    const { resolved, missing } = interpolateEnvWith("Bearer ${TOK}", from({ TOK: "abc" }));
    expect(resolved).toBe("Bearer abc");
    expect(missing).toEqual([]);
  });

  it("resolves multiple ${VAR}s in one value", () => {
    const { resolved, missing } = interpolateEnvWith("${A}-${B}", from({ A: "1", B: "2" }));
    expect(resolved).toBe("1-2");
    expect(missing).toEqual([]);
  });

  it("passes a value with no ${VAR} through unchanged", () => {
    const { resolved, missing } = interpolateEnvWith("literal value", from({}));
    expect(resolved).toBe("literal value");
    expect(missing).toEqual([]);
  });

  it("reports a missing var (and does not emit a literal ${VAR})", () => {
    const { resolved, missing } = interpolateEnvWith("Bearer ${NOPE}", from({}));
    expect(missing).toEqual(["NOPE"]);
    expect(resolved).not.toContain("${NOPE}");
  });
});

describe("resolveStringMap", () => {
  it("resolves every header value from env", () => {
    const out = resolveStringMap(
      { Authorization: "Bearer ${TOK}", "X-Api-Key": "${KEY}" },
      { TOK: "t", KEY: "k" },
    );
    expect(out).toEqual({ Authorization: "Bearer t", "X-Api-Key": "k" });
  });

  it("throws MissingEnvVarsError naming the absent var(s) — never the value", () => {
    let thrown: unknown;
    try {
      resolveStringMap({ Authorization: "Bearer ${ABSENT}" }, {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingEnvVarsError);
    expect((thrown as MissingEnvVarsError).missing).toEqual(["ABSENT"]);
  });

  it("leaves a literal header untouched", () => {
    expect(resolveStringMap({ "X-Static": "plain" }, {})).toEqual({ "X-Static": "plain" });
  });
});

describe("the arbitrary-lookup primitives", () => {
  it("interpolateEnvWith reads through the supplied lookup, not process.env", () => {
    const seen: string[] = [];
    const { resolved, missing } = interpolateEnvWith("Bearer ${TOK}", (name) => {
      seen.push(name);
      return name === "TOK" ? "abc" : undefined;
    });
    expect(resolved).toBe("Bearer abc");
    expect(missing).toEqual([]);
    expect(seen).toEqual(["TOK"]);
  });

  it("resolveStringMapWith collects every missing name across the whole map, deduped", () => {
    let thrown: unknown;
    try {
      resolveStringMapWith({ a: "${X}", b: "${Y}-${X}" }, () => undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingEnvVarsError);
    expect((thrown as MissingEnvVarsError).missing).toEqual(["X", "Y"]);
  });
});
