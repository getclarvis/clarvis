import { describe, it, expect } from "../bun-test.ts";
import {
  agentFrontmatterSchema,
  agentPromptOf,
  normalizeTools,
  splitAgentFrontmatter,
} from "../../src/settings/agent-frontmatter.ts";

describe("splitAgentFrontmatter", () => {
  const DOC = "---\nmodel: prov/m\n---\n\nBody text.\n";

  it("splits fenced YAML frontmatter from the body", () => {
    const { data, body } = splitAgentFrontmatter(DOC);
    expect(data).toEqual({ model: "prov/m" });
    expect(body.trim()).toBe("Body text.");
  });

  it("strips a BOM before the fence and tolerates a missing fence", () => {
    const bom = splitAgentFrontmatter("\uFEFF---\nmodel: prov/m\n---\nbody");
    expect(bom.data).toEqual({ model: "prov/m" });
    expect(bom.body).toBe("body");
    expect(splitAgentFrontmatter("just a body")).toEqual({ data: {}, body: "just a body" });
  });

  it("strict mode throws on a misaligned fence and on invalid YAML", () => {
    expect(() => splitAgentFrontmatter("---\nmodel: x")).toThrow(/frontmatter/);
    expect(() => splitAgentFrontmatter("---\n{ not: yaml: [ }\n---\nbody")).toThrow();
  });

  it("lenient mode degrades malformed input to an empty frontmatter", () => {
    expect(splitAgentFrontmatter("---\nmodel: x", "lenient")).toEqual({
      data: {},
      body: "---\nmodel: x",
    });
    const badYaml = splitAgentFrontmatter("---\n{ not: yaml: [ }\n---\nbody", "lenient");
    expect(badYaml.data).toEqual({});
    expect(badYaml.body).toBe("body");
  });
});

describe("agentFrontmatterSchema / helpers", () => {
  it("accepts tools as a list or comma string; normalizeTools trims both forms", () => {
    expect(agentFrontmatterSchema.safeParse({ tools: ["a.b", " c.d "] }).success).toBe(true);
    expect(agentFrontmatterSchema.safeParse({ tools: "a.b, c.d" }).success).toBe(true);
    expect(normalizeTools([" fs.read_file ", ""])).toEqual(["fs.read_file"]);
    expect(normalizeTools("a.b, c.d ,")).toEqual(["a.b", "c.d"]);
  });

  it("carries an unknown key through instead of rejecting or stripping it (.loose)", () => {
    const parsed = agentFrontmatterSchema.safeParse({
      description: "d",
      "x-house-style": "terse",
      presentation: { colour: "amber", tags: ["a", "b"] },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      description: "d",
      "x-house-style": "terse",
      presentation: { colour: "amber", tags: ["a", "b"] },
    });
  });

  it("still validates every key it owns while unknown keys pass", () => {
    const cases: Record<string, unknown>[] = [
      { model: "not-a-model-ref" },
      { description: 7 },
      { base_prompt: "" },
      { grants: "read_workspace" },
      { can_spawn: [1, 2] },
      { iteration_limit: 0 },
      { stagnation_threshold: -1 },
      { call_timeout_ms: 0 },
      { reasoning_effort: "sideways" },
      { reasoning_summary: "verbose" },
      { retry: { max_retries: -1 } },
      { compaction: { context_fraction: 2 } },
      { budget: { on_exceed: "explode" } },
    ];
    for (const bad of cases) {
      expect(agentFrontmatterSchema.safeParse({ ...bad, unknown_key: true }).success).toBe(false);
    }
    expect(
      agentFrontmatterSchema.safeParse({
        model: "prov/m",
        description: "d",
        tools: "a.b, c.d",
        grants: ["read_workspace"],
        can_spawn: ["explorer"],
        iteration_limit: 4,
        reasoning_effort: "high",
        unknown_key: true,
      }).success,
    ).toBe(true);
  });

  it("keeps rejecting an unknown key nested inside a strict block it owns", () => {
    expect(agentFrontmatterSchema.safeParse({ retry: { nope: 1 } }).success).toBe(false);
    expect(agentFrontmatterSchema.safeParse({ compaction: { nope: 1 } }).success).toBe(false);
  });

  it("rejects a frontmatter tool fanout above the retained profile bound", () => {
    expect(agentFrontmatterSchema.safeParse({ tools: Array(513).fill("x") }).success).toBe(false);
  });

  it("agentPromptOf: a non-empty body wins over base_prompt", () => {
    expect(agentPromptOf("fm prompt", "  body  ")).toBe("body");
    expect(agentPromptOf("fm prompt", "   ")).toBe("fm prompt");
    expect(agentPromptOf(undefined, "")).toBeUndefined();
  });
});
