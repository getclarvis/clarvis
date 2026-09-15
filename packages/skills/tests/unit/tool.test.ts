import { describe, it, expect } from "bun:test";
import {
  loadSkillTool,
  LOAD_SKILL_TOOL_NAME,
  readSkillResourceTool,
  READ_SKILL_RESOURCE_TOOL_NAME,
  renderSkillsSection,
} from "../../src/tool.ts";
import { makeInfo } from "../helpers/skill-fixtures.ts";

describe("loadSkillTool definition", () => {
  it("is a built-in tool wired under the load_skill name", () => {
    expect(loadSkillTool.wireName).toBe(LOAD_SKILL_TOOL_NAME);
    expect(loadSkillTool.mcpName).toBe("");
    expect(loadSkillTool.toolName).toBe(LOAD_SKILL_TOOL_NAME);
  });

  it("accepts exactly one required name", () => {
    const schema = loadSkillTool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["name"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["name"]);
  });

  it("uses a separate strict tool for resource pages", () => {
    expect(loadSkillTool.description).toContain("accepts only `name`");
    expect(loadSkillTool.description).toContain("clearly matches");
    expect(loadSkillTool.description).not.toContain("only when the task calls for that skill");
    expect(readSkillResourceTool.wireName).toBe(READ_SKILL_RESOURCE_TOOL_NAME);
    const schema = readSkillResourceTool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { pattern?: string }>;
    };
    expect(schema.required).toEqual(["name", "resource", "offset"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["name", "resource", "offset"]);
    const pattern = schema.properties.resource?.pattern;
    expect(pattern).toBeString();
    expect(pattern).not.toContain("(?");
    const resourcePath = new RegExp(pattern as string, "u");
    for (const valid of ["notes.md", "references/api.md", ".hidden", "...", "éxample/a:b"]) {
      expect(resourcePath.test(valid)).toBe(true);
    }
    for (const invalid of [
      "/absolute",
      "C:/absolute",
      "../escape",
      "a/../escape",
      "a//b",
      "a\\b",
      "a/.",
      "control\u0000byte",
    ]) {
      expect(resourcePath.test(invalid)).toBe(false);
    }
  });
});

describe("renderSkillsSection", () => {
  it("renders the catalog and instructs the model to call load_skill", () => {
    const section = renderSkillsSection([makeInfo({ name: "alpha" }), makeInfo({ name: "beta" })]);
    expect(section).toContain("# Available skills");
    expect(section).toContain("alpha");
    expect(section).toContain("The beta skill");
    expect(section).toContain(`\`${LOAD_SKILL_TOOL_NAME}\``);
    expect(section).toContain(`\`${READ_SKILL_RESOURCE_TOOL_NAME}\``);
    expect(section).toContain("That tool accepts only `name`");
    expect(section).toContain("If the user names a skill");
    expect(section).toContain("description clearly matches");
    expect(section).toContain("merely because it is in the list");
    expect(section).toContain("The user's current instructions take precedence over the skill");
    expect(section).toContain("identify the relevant SKILL.md rule");
    expect(section).not.toContain("not because of keywords or mere availability");
    expect(section).not.toContain("only when the task actually calls for it");
  });

  it("is byte-identical with no bootstraps, however the argument is omitted", () => {
    const catalog = [makeInfo({ name: "alpha" }), makeInfo({ name: "beta" })];
    const base = renderSkillsSection(catalog);
    expect(renderSkillsSection(catalog, [])).toBe(base);
    expect(renderSkillsSection(catalog, undefined)).toBe(base);
    expect(base.startsWith("# Available skills")).toBe(true);
  });

  it("puts a bootstrap body ahead of the catalog, attributed and fenced", () => {
    const catalog = [makeInfo({ name: "alpha" })];
    const section = renderSkillsSection(catalog, [
      { plugin: "superpowers", skill: "using-superpowers", body: "ALWAYS BRAINSTORM FIRST" },
    ]);
    expect(section.indexOf("ALWAYS BRAINSTORM FIRST")).toBeLessThan(
      section.indexOf("# Available skills"),
    );
    expect(section).toContain("'superpowers' plugin");
    expect(section).toContain("'using-superpowers' skill");
    expect(section).toContain(
      "<plugin_instructions>\nALWAYS BRAINSTORM FIRST\n</plugin_instructions>",
    );
    expect(section.endsWith(renderSkillsSection(catalog))).toBe(true);
  });

  it("renders several bootstraps in the order given", () => {
    const section = renderSkillsSection(
      [makeInfo({ name: "alpha" })],
      [
        { plugin: "first", skill: "a", body: "BODY-A" },
        { plugin: "second", skill: "b", body: "BODY-B" },
      ],
    );
    expect(section.indexOf("BODY-A")).toBeLessThan(section.indexOf("BODY-B"));
    expect(section.indexOf("BODY-B")).toBeLessThan(section.indexOf("# Available skills"));
  });
});
