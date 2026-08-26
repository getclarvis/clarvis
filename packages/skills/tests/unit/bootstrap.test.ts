import { describe, it, expect } from "bun:test";
import {
  resolveBootstrapSkills,
  BOOTSTRAP_SKILL_MAX_CHARS,
  BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS,
  type PluginBootstrapSkill,
} from "../../src/bootstrap.ts";
import { makeContent, recordingLogger } from "../helpers/skill-fixtures.ts";

const PLUGIN_ROOT = "/home/.clarvis/plugins/superpowers/skills";

function content(over: Parameters<typeof makeContent>[1] = {}) {
  const name = over.name ?? "using-superpowers";
  return makeContent(name, {
    scope: "user",
    source: "plugin:superpowers",
    root: PLUGIN_ROOT,
    dir: `${PLUGIN_ROOT}/${name}`,
    path: `${PLUGIN_ROOT}/${name}/SKILL.md`,
    body: "ALWAYS BRAINSTORM FIRST",
    ...over,
  });
}

function ref(over: Partial<PluginBootstrapSkill> & { root?: string } = {}): PluginBootstrapSkill {
  const { root, ...rest } = over;
  return {
    plugin: "superpowers",
    skill: "using-superpowers",
    roots: root === undefined ? [PLUGIN_ROOT] : [root],
    ...rest,
  };
}

const reasons = (warnings: { fields: Record<string, unknown> }[]): unknown[] =>
  warnings.map((warning) => warning.fields.reason);

describe("resolveBootstrapSkills", () => {
  it("admits a skill scanned from the declaring plugin's own root", () => {
    const admitted = resolveBootstrapSkills({
      refs: [ref()],
      loadSkill: () => content(),
    });
    expect(admitted).toEqual([
      { plugin: "superpowers", skill: "using-superpowers", body: "ALWAYS BRAINSTORM FIRST" },
    ]);
  });

  it("reports the skill's own name, not the manifest's raw string", () => {
    const admitted = resolveBootstrapSkills({
      refs: [ref({ skill: "Using-Superpowers" })],
      loadSkill: () => content({ name: "using-superpowers" }),
    });
    expect(admitted[0]!.skill).toBe("using-superpowers");
  });

  it("matches roots that differ only in normalization", () => {
    const admitted = resolveBootstrapSkills({
      refs: [ref({ root: "/home/.clarvis/plugins/superpowers/../superpowers/skills" })],
      loadSkill: () => content(),
    });
    expect(admitted).toHaveLength(1);
  });

  it("refuses a skill shadowed by a higher-precedence root (the RP2.2 gate)", () => {
    const { logger, warnings } = recordingLogger();
    const admitted = resolveBootstrapSkills({
      refs: [ref()],
      loadSkill: () => content({ root: "/home/.clarvis/skills", source: "clarvis" }),
      logger,
    });
    expect(admitted).toEqual([]);
    expect(reasons(warnings)).toEqual(["foreign_root"]);
    expect(warnings[0]!.fields).toMatchObject({
      expected: PLUGIN_ROOT,
      actual: "/home/.clarvis/skills",
    });
  });

  it("warns and skips a bootstrap naming a skill that does not exist", () => {
    const { logger, warnings } = recordingLogger();
    const admitted = resolveBootstrapSkills({
      refs: [ref({ skill: "no-such-skill" })],
      loadSkill: () => undefined,
      logger,
    });
    expect(admitted).toEqual([]);
    expect(reasons(warnings)).toEqual(["not_found"]);
  });

  it("never rethrows a loader failure", () => {
    const { logger, warnings } = recordingLogger();
    const admitted = resolveBootstrapSkills({
      refs: [ref()],
      loadSkill: () => {
        throw new Error("skills are unavailable");
      },
      logger,
    });
    expect(admitted).toEqual([]);
    expect(reasons(warnings)).toEqual(["load_failed"]);
    expect(warnings[0]!.fields.cause).toBe("skills are unavailable");
  });

  it("skips a skill whose body is empty or only whitespace", () => {
    const { logger, warnings } = recordingLogger();
    const admitted = resolveBootstrapSkills({
      refs: [ref()],
      loadSkill: () => content({ body: "  \n\t " }),
      logger,
    });
    expect(admitted).toEqual([]);
    expect(reasons(warnings)).toEqual(["empty_body"]);
  });

  it("admits a body at the cap and skips one over it, never truncating", () => {
    const at = resolveBootstrapSkills({
      refs: [ref()],
      loadSkill: () => content({ body: "x".repeat(BOOTSTRAP_SKILL_MAX_CHARS) }),
    });
    expect(at[0]!.body).toHaveLength(BOOTSTRAP_SKILL_MAX_CHARS);

    const { logger, warnings } = recordingLogger();
    const over = resolveBootstrapSkills({
      refs: [ref()],
      loadSkill: () => content({ body: "x".repeat(BOOTSTRAP_SKILL_MAX_CHARS + 1) }),
      logger,
    });
    expect(over).toEqual([]);
    expect(reasons(warnings)).toEqual(["too_long"]);
  });

  it("admits every valid bootstrap, in declaration order", () => {
    const { logger, warnings } = recordingLogger();
    const admitted = resolveBootstrapSkills({
      refs: [
        ref({ plugin: "alpha", skill: "a", root: "/plugins/alpha/skills" }),
        ref({ plugin: "beta", skill: "b", root: "/plugins/beta/skills" }),
      ],
      loadSkill: (name) =>
        name === "a"
          ? content({ name: "a", root: "/plugins/alpha/skills", body: "A" })
          : content({ name: "b", root: "/plugins/beta/skills", body: "B" }),
      logger,
    });
    expect(admitted.map((entry) => entry.plugin)).toEqual(["alpha", "beta"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("bootstrap_skills_multiple");
  });

  it("keeps going past an invalid entry rather than stopping at it", () => {
    const admitted = resolveBootstrapSkills({
      refs: [
        ref({ plugin: "alpha", skill: "missing", root: "/plugins/alpha/skills" }),
        ref({ plugin: "beta", skill: "b", root: "/plugins/beta/skills" }),
      ],
      loadSkill: (name) =>
        name === "b" ? content({ name: "b", root: "/plugins/beta/skills" }) : undefined,
    });
    expect(admitted.map((entry) => entry.plugin)).toEqual(["beta"]);
  });

  it("stops admitting once the run budget would be exceeded", () => {
    const { logger, warnings } = recordingLogger();
    const body = "x".repeat(15_000);
    const admitted = resolveBootstrapSkills({
      refs: ["a", "b", "c"].map((n) => ref({ plugin: n, skill: n, root: `/plugins/${n}/skills` })),
      loadSkill: (name) => content({ name, root: `/plugins/${name}/skills`, body }),
      logger,
    });
    expect(admitted.map((entry) => entry.plugin)).toEqual(["a", "b"]);
    expect(reasons(warnings)).toContain("over_run_budget");
    const total = admitted.reduce((sum, entry) => sum + entry.body.length, 0);
    expect(total).toBeLessThanOrEqual(BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS);
  });

  it("resolves without a logger", () => {
    expect(resolveBootstrapSkills({ refs: [ref()], loadSkill: () => undefined })).toEqual([]);
    expect(resolveBootstrapSkills({ refs: [], loadSkill: () => undefined })).toEqual([]);
  });
});

describe("a plugin declaring several skill roots", () => {
  it("admits a bootstrap scanned from any one of them", () => {
    const admitted = resolveBootstrapSkills({
      refs: [{ plugin: "p", skill: "s", roots: ["/plugins/p/a", "/plugins/p/b"] }],
      loadSkill: () => content({ name: "s", root: "/plugins/p/b", body: "B" }),
    });
    expect(admitted).toEqual([{ plugin: "p", skill: "s", body: "B" }]);
  });

  it("still refuses one scanned from a root it never declared", () => {
    const admitted = resolveBootstrapSkills({
      refs: [{ plugin: "p", skill: "s", roots: ["/plugins/p/a", "/plugins/p/b"] }],
      loadSkill: () => content({ name: "s", root: "/plugins/other/skills" }),
    });
    expect(admitted).toEqual([]);
  });
});
