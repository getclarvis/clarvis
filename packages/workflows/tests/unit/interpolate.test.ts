import { describe, expect, test } from "bun:test";

import { interpolate, placeholders } from "../../src/interpolate.ts";

describe("interpolate", () => {
  test("substitutes args, item fields and earlier round state", () => {
    const out = interpolate("{{args.goal}} on {{item.id}} given {{state.discover.scope}}", {
      args: { goal: "Audit" },
      item: { id: "f1" },
      state: { discover: { scope: "the parser" } },
    });
    expect(out).toEqual({ text: "Audit on f1 given the parser" });
  });

  test("a bare {{item}} renders the whole item", () => {
    expect(interpolate("{{item}}", { item: { id: "f1" } })).toEqual({ text: '{"id":"f1"}' });
    expect(interpolate("{{item}}", { item: "plain" })).toEqual({ text: "plain" });
  });

  test("a template with no placeholders is returned unchanged", () => {
    expect(interpolate("just prose", {})).toEqual({ text: "just prose" });
  });

  test("a non-string value is serialized rather than coerced loosely", () => {
    expect(interpolate("{{item.n}}", { item: { n: 3 } })).toEqual({ text: "3" });
    expect(interpolate("{{item.a}}", { item: { a: [1, 2] } })).toEqual({ text: "[1,2]" });
  });

  test("a missing key is an error, never a silently blank brief", () => {
    const out = interpolate("look at {{item.missing}}", { item: { id: "f1" } });
    expect("error" in out && out.error).toContain("{{item.missing}}");
    expect("error" in out && out.error).toContain("did not resolve");
  });

  test("a missing arg and a missing round are both errors", () => {
    expect("error" in interpolate("{{args.x}}", {})).toBe(true);
    expect("error" in interpolate("{{state.ghost.field}}", { state: {} })).toBe(true);
  });

  test("an unknown root names the three scopes that do exist", () => {
    const out = interpolate("{{env.HOME}}", {});
    expect("error" in out && out.error).toContain("args, item or state");
  });

  test("the first failure is the one reported, and the text is not half-substituted", () => {
    const out = interpolate("{{item.a}} {{item.b}}", { item: { b: "ok" } });
    expect("error" in out && out.error).toContain("{{item.a}}");
  });

  test("a path through a non-object stops rather than throwing", () => {
    expect("error" in interpolate("{{item.a.b}}", { item: { a: 3 } })).toBe(true);
  });

  test("placeholders lists what a template references, for load-time validation", () => {
    expect(placeholders("{{args.a}} and {{item.b.c}} and {{ state.r.f }}")).toEqual([
      "args.a",
      "item.b.c",
      "state.r.f",
    ]);
    expect(placeholders("no placeholders")).toEqual([]);
  });
});
