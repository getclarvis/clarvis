import { describe, expect, it } from "bun:test";
import { agentFrontmatterSchema, splitAgentFrontmatter } from "@clarvis/loop/host";
import type { SkillsProvider } from "@clarvis/loop";
import { renderSkillCatalog } from "@clarvis/skills/catalog";
import { kernelSettingsSchema } from "../../src/config/capability-registry.ts";
import { withBuiltinSkills } from "../../src/skills/builtin-skills.ts";
import { CLARVIS_CONFIGURE_SKILL } from "../../src/skills/clarvis-configure.ts";
import {
  CONFIGURATION_EXAMPLES,
  configurationExample,
} from "../../src/skills/configuration-examples.ts";
import { createSkillsService } from "../../src/skills/skills-service.ts";

describe("shipped configuration skill", () => {
  it("is available through the protocol without any filesystem provider", async () => {
    const skills = withBuiltinSkills(undefined);
    const service = createSkillsService({ skills });
    expect(await service.list()).toMatchObject([
      { name: "clarvis-configure", provenance: { source: "builtin" } },
    ]);
    expect((await service.getPrompt("clarvis-configure"))[0]?.content).toContain("can_spawn");
    expect(renderSkillCatalog(skills.listSkills())).not.toContain("## Working procedure");
    expect(skills.loadSkill("missing")).toBeUndefined();
    expect(() => skills.readResource("clarvis-configure", "keys.json")).toThrow();
  });

  it("reserves its identity and returns detached metadata and content", () => {
    const original = withBuiltinSkills(undefined).loadSkill("clarvis-configure")!;
    const counterfeit = { ...original, source: "plugin:foreign", body: "replacement" };
    const discovered: SkillsProvider = {
      listSkills: () => [counterfeit],
      loadSkill: () => counterfeit,
      readResource: () => "foreign file",
      readResourceChunk: () => ({ text: "foreign file", offset: 0, totalBytes: 12 }),
    };
    const skills = withBuiltinSkills(discovered);
    skills.listSkills()[0]!.metadata.name = "changed";
    skills.loadSkill(original.name)!.body = "changed";
    expect(skills.listSkills()).toHaveLength(1);
    expect(skills.loadSkill(original.name)).toEqual(original);
    expect(() => skills.readResourceChunk!(original.name, "any", 0)).toThrow();
    expect(skills.readResource("foreign", "notes.txt")).toBe("foreign file");
    expect(skills.readResourceChunk!("foreign", "notes.txt", 0).text).toBe("foreign file");
  });

  it("preserves live external discovery and resource readers", () => {
    let reads = 0;
    const original = withBuiltinSkills(undefined).loadSkill("clarvis-configure")!;
    const external = { ...original, name: "external", source: "clarvis" };
    const skills = withBuiltinSkills({
      listSkills: () => (++reads === 1 ? [] : [external]),
      loadSkill: (name) => (name === "external" ? external : undefined),
      readResource: (_name, rel) => rel,
    });
    expect(skills.listSkills()).toHaveLength(1);
    expect(skills.listSkills()).toHaveLength(2);
    expect(skills.loadSkill("external")).toBe(external);
    expect("readResourceChunk" in skills).toBe(false);
  });

  it("embeds every executable example verbatim and validates settings and agent fragments", () => {
    const blocks = [...CLARVIS_CONFIGURE_SKILL.body.matchAll(/```(?:json|yaml|text)\n/g)];
    expect(blocks).toHaveLength(Object.keys(CONFIGURATION_EXAMPLES).length);
    for (const name of Object.keys(
      CONFIGURATION_EXAMPLES,
    ) as (keyof typeof CONFIGURATION_EXAMPLES)[]) {
      const example = CONFIGURATION_EXAMPLES[name];
      expect(CLARVIS_CONFIGURE_SKILL.body).toContain(configurationExample(name));
      if (example.path === "settings.json") {
        expect(kernelSettingsSchema.parse(JSON.parse(example.content))).toMatchObject(
          JSON.parse(example.content),
        );
      } else if (example.path.startsWith("agents/")) {
        expect(
          agentFrontmatterSchema.safeParse(splitAgentFrontmatter(example.content).data).success,
        ).toBe(true);
      }
    }
    expect(CLARVIS_CONFIGURE_SKILL.body.length).toBeLessThan(32_768);
  });
});
