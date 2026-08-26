import { describe, it, expect } from "bun:test";
import { loadSkillTool, LOAD_SKILL_TOOL_NAME, renderSkillsSection } from "../../src/tool.ts";
import { makeInfo } from "../helpers/skill-fixtures.ts";

describe("loadSkillTool definition", () => {
  it("is a built-in tool wired under the load_skill name", () => {
    expect(loadSkillTool.wireName).toBe(LOAD_SKILL_TOOL_NAME);
    expect(loadSkillTool.mcpName).toBe("");
    expect(loadSkillTool.toolName).toBe(LOAD_SKILL_TOOL_NAME);
  });

  it("requires name and offers an optional resource", () => {
    const schema = loadSkillTool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["name"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["name", "resource"]);
  });

  it("tells the model to omit resource when loading the skill body", () => {
    expect(loadSkillTool.description).toContain("Omit `resource` to load the skill instructions");
    const schema = loadSkillTool.inputSchema as {
      properties: { resource: { description: string } };
    };
    expect(schema.properties.resource.description).toContain("Omit this field to load SKILL.md");
    expect(schema.properties.resource.description).toContain("do not send SKILL.md");
    expect(schema.properties.resource.description).toContain("'./', or '/'");
  });
});

describe("renderSkillsSection", () => {
  it("renders the catalog and instructs the model to call load_skill", () => {
    const section = renderSkillsSection([makeInfo({ name: "alpha" }), makeInfo({ name: "beta" })]);
    expect(section).toContain("# Available skills");
    expect(section).toContain("alpha");
    expect(section).toContain("The beta skill");
    expect(section).toContain(`\`${LOAD_SKILL_TOOL_NAME}\``);
    expect(section).toContain("Omit `resource` for those instructions");
    expect(section).toContain("only when the task actually calls for it");
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
