import { describe, expect, test } from "bun:test";
import { builtinAgentRecord, resolveEffectiveAgent } from "../../src/config/agent-overlay.ts";
import { readBuiltinAgent } from "../../src/config/builtin-agents/index.ts";
import type { AgentRecord } from "../../src/config/config-store.ts";

const MARSHALL = builtinAgentRecord(readBuiltinAgent("marshall")!);

function file(scope: "global" | "workspace", over: Partial<AgentRecord> = {}): AgentRecord {
  return { name: "marshall", scope, frontmatter: {}, body: "", ...over };
}

describe("resolving the agent a run will actually enter", () => {
  test("a shipped agent nothing overlays is returned as shipped", () => {
    const record = resolveEffectiveAgent("marshall")!;
    expect(record.scope).toBe("builtin");
    expect(record.overlay).toBeUndefined();
    expect(record.body).toBe(MARSHALL.body);
    expect(record.frontmatter.grants).toEqual(MARSHALL.frontmatter.grants);
  });

  test("a name nothing ships and no file defines resolves to nothing", () => {
    expect(resolveEffectiveAgent("nobody")).toBeNull();
  });

  test("a name only a file defines is that file, unchanged", () => {
    const own = file("global", { name: "mine", frontmatter: { iteration_limit: 4 }, body: "hi" });
    const record = resolveEffectiveAgent("mine", { global: own })!;
    expect(record).toBe(own);
  });

  /**
   * The whole point of the merge: changing one field must not cost the user
   * every field they did not mention.
   */
  test("a valid overlay changes the fields it names and inherits the rest", () => {
    const record = resolveEffectiveAgent("marshall", {
      global: file("global", { frontmatter: { iteration_limit: 80 } }),
    })!;
    expect(record.scope).toBe("global");
    expect(record.overlay).toEqual({ scope: "global", status: "applied" });
    expect(record.frontmatter.iteration_limit).toBe(80);
    expect(record.frontmatter.grants).toEqual(MARSHALL.frontmatter.grants);
    expect(record.frontmatter.can_spawn).toEqual(MARSHALL.frontmatter.can_spawn);
    expect(record.body).toBe(MARSHALL.body);
  });

  test("an overlay body replaces the shipped prompt and nothing else", () => {
    const record = resolveEffectiveAgent("marshall", {
      global: file("global", { body: "Fale sempre em português." }),
    })!;
    expect(record.body).toBe("Fale sempre em português.");
    expect(record.frontmatter.grants).toEqual(MARSHALL.frontmatter.grants);
  });

  /**
   * `base_prompt` is the other channel an overlay may write a prompt through.
   * Reading only the body left such a file inheriting the shipped prompt and
   * discarding the one its author wrote.
   */
  test("an overlay that writes its prompt as base_prompt is honoured too", () => {
    const record = resolveEffectiveAgent("marshall", {
      global: file("global", { frontmatter: { base_prompt: "Seja breve." } }),
    })!;
    expect(record.body).toBe("Seja breve.");
    expect(record.frontmatter.base_prompt).toBeUndefined();
  });

  test("an empty list in an overlay removes a shipped field rather than omitting it", () => {
    const record = resolveEffectiveAgent("marshall", {
      global: file("global", { frontmatter: { grants: [] } }),
    })!;
    expect(record.frontmatter.grants).toEqual([]);
  });

  test("the description projection follows the merged frontmatter", () => {
    const record = resolveEffectiveAgent("marshall", {
      global: file("global", { frontmatter: { description: "meu lead" } }),
    })!;
    expect(record.description).toBe("meu lead");
  });

  test("workspace beats global, and the loser is reported as a conflict", () => {
    const record = resolveEffectiveAgent("marshall", {
      workspace: file("workspace", { frontmatter: { iteration_limit: 9 } }),
      global: file("global", { frontmatter: { iteration_limit: 80 } }),
    })!;
    expect(record.frontmatter.iteration_limit).toBe(9);
    expect(record.overlay).toEqual({
      scope: "workspace",
      status: "applied",
      shadowed: ["global"],
    });
  });
});

describe("an overlay Clarvis cannot use", () => {
  test("is refused for malformed YAML, and the shipped agent stands whole", () => {
    const record = resolveEffectiveAgent("marshall", {
      global: file("global", { body: "hi", malformed: "missing closing fence" }),
    })!;
    expect(record.scope).toBe("builtin");
    expect(record.body).toBe(MARSHALL.body);
    expect(record.frontmatter.grants).toEqual(MARSHALL.frontmatter.grants);
    expect(record.overlay).toEqual({
      scope: "global",
      status: "rejected",
      reason: "missing closing fence",
    });
  });

  test("is refused when the frontmatter does not satisfy the agent schema", () => {
    const record = resolveEffectiveAgent("marshall", {
      global: file("global", { frontmatter: { iteration_limit: "soon" }, body: "hi" }),
    })!;
    expect(record.scope).toBe("builtin");
    expect(record.body).toBe(MARSHALL.body);
    expect(record.overlay?.status).toBe("rejected");
    expect(record.overlay?.reason).toContain("iteration_limit");
  });

  /**
   * Tolerance is possible only where there is a default to fall back *to*. A
   * user's own agent has none, so a broken one stays broken and visible rather
   * than being replaced by something they never wrote.
   */
  test("has no equivalent for an agent Clarvis does not ship", () => {
    const broken = file("global", { name: "mine", body: "hi", malformed: "bad yaml" });
    const record = resolveEffectiveAgent("mine", { global: broken })!;
    expect(record).toBe(broken);
    expect(record.malformed).toBe("bad yaml");
    expect(record.overlay).toBeUndefined();
  });
});
