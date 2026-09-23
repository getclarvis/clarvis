import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clarvisSkillRoots, createAgentSkills } from "@clarvis/skills";
import { dollarSkillSeeds } from "../../src/skills/dollar-mentions.ts";
import { createSkillsService } from "../../src/skills/skills-service.ts";

test("all system skill roots remain model-readable but absent from user invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-invocation-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const globalDir = join(root, "global-clarvis");
    const roots = clarvisSkillRoots({
      home,
      workspace,
      env: { CLARVIS_HOME: globalDir },
    });
    for (const [index, skillRoot] of roots.entries()) {
      for (const [name, extra] of [
        [`implicit-${String(index)}`, ""],
        [`explicit-${String(index)}`, "user-invocable: true\n"],
      ] as const) {
        const directory = join(skillRoot.path, ".system", name);
        await mkdir(join(directory, "references"), { recursive: true });
        await writeFile(
          join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Internal guide\n${extra}---\nInternal body.\n`,
        );
        await writeFile(join(directory, "references", "guide.md"), "Model-only reference.\n");
      }
      const ordinary = join(skillRoot.path, `ordinary-${String(index)}`);
      await mkdir(ordinary, { recursive: true });
      await writeFile(
        join(ordinary, "SKILL.md"),
        `---\nname: ordinary-${String(index)}\ndescription: Ordinary guide\n---\nOrdinary body.\n`,
      );
    }
    const skills = createAgentSkills({ workspace, home, roots });
    const service = createSkillsService({ skills });
    const listed = (await service.list()).map((skill) => skill.name);
    expect(listed).toEqual(roots.map((_, index) => `ordinary-${String(index)}`));
    for (const index of roots.keys()) {
      for (const kind of ["implicit", "explicit"] as const) {
        const name = `${kind}-${String(index)}`;
        await expect(service.getPrompt(name)).rejects.toMatchObject({ code: "not_found" });
        expect(dollarSkillSeeds(`$${name}`, skills)).toEqual([]);
        expect(skills.loadSkill(name)?.body).toContain("Internal body.");
        expect(skills.readResource(name, "references/guide.md")).toBe("Model-only reference.\n");
      }
      expect(dollarSkillSeeds(`$ordinary-${String(index)}`, skills)).toHaveLength(1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
