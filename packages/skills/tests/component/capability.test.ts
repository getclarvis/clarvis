import { describe, expect, it } from "bun:test";
import type { AgentIdentity, Logger, RunCapability } from "@clarvis/capability";
import { loadEnv } from "@clarvis/capability";
import {
  createSkillsCapability,
  LOAD_SKILL_TOOL_NAME,
  SKILLS_CAPABILITY_NAME,
  USE_SKILLS_GRANT,
  type SkillsProvider,
} from "../../src/capability.ts";
import type { PluginBootstrapSkill } from "../../src/bootstrap.ts";
import {
  fakeAgentBuildContext,
  fakeAgentScope,
  fakeRunCapabilityContext,
} from "../helpers/capability-fakes.ts";
import { makeContent, makeInfo, recordingLogger } from "../helpers/skill-fixtures.ts";

const PLUGIN_ROOT = "/plugins/superpowers/skills";

function pluginInfo(name: string, root = PLUGIN_ROOT) {
  return makeInfo({
    name,
    scope: "user",
    source: "plugin:superpowers",
    root,
    dir: `${root}/${name}`,
    path: `${root}/${name}/SKILL.md`,
  });
}

/** A provider over one plugin skill, counting the loads the capability performs. */
function provider(over: { root?: string; body?: string } = {}): SkillsProvider & {
  loads: () => number;
} {
  let loads = 0;
  const root = over.root ?? PLUGIN_ROOT;
  const catalog = [pluginInfo("using-superpowers", root), pluginInfo("alpha", root)];
  return {
    listSkills: () => catalog,
    loadSkill: (name) => {
      loads += 1;
      const found = catalog.find((skill) => skill.name === name);
      return found === undefined
        ? undefined
        : makeContent(found.name, {
            ...found,
            body: over.body ?? "ALWAYS BRAINSTORM FIRST",
          });
    },
    readResource: () => {
      throw new Error("no resources in this fake");
    },
    loads: () => loads,
  };
}

const ref = (
  over: Partial<PluginBootstrapSkill> & { root?: string } = {},
): PluginBootstrapSkill => {
  const { root, ...rest } = over;
  return {
    plugin: "superpowers",
    skill: "using-superpowers",
    roots: root === undefined ? [PLUGIN_ROOT] : [root],
    ...rest,
  };
};

/** Drive `forRun` with skills enabled, which is the only way it returns non-null. */
async function runCapability(args: {
  skills: SkillsProvider;
  bootstraps?: () => readonly PluginBootstrapSkill[];
  logger?: Logger;
}): Promise<RunCapability> {
  const capability = createSkillsCapability(
    args.skills,
    args.bootstraps !== undefined ? { bootstraps: args.bootstraps } : {},
  );
  const run = await capability.forRun(
    fakeRunCapabilityContext({
      env: loadEnv({ CLARVIS_SKILLS_ENABLED: "1" }),
      ...(args.logger !== undefined ? { logger: args.logger } : {}),
    }),
  );
  if (run === null) throw new Error("expected the skills capability to activate");
  return run;
}

const lead: AgentIdentity = { agent: "lead", entry: true, grants: [USE_SKILLS_GRANT] };
const spawned: AgentIdentity = { agent: "subagent", entry: false, grants: [USE_SKILLS_GRANT] };
const ungranted: AgentIdentity = { agent: "lead", entry: true, grants: [] };

describe("skills capability composition", () => {
  it("declares the grant, reservation and control effect while activation remains gated", async () => {
    const capability = createSkillsCapability();
    expect(capability.name).toBe(SKILLS_CAPABILITY_NAME);
    expect(capability.grants).toEqual([{ name: USE_SKILLS_GRANT }]);
    expect(capability.reservedWireNames).toEqual([LOAD_SKILL_TOOL_NAME]);
    expect(capability.toolEffects).toEqual({ [LOAD_SKILL_TOOL_NAME]: "control" });

    expect(
      await capability.forRun(
        fakeRunCapabilityContext({ env: loadEnv({ CLARVIS_SKILLS_ENABLED: "1" }) }),
      ),
    ).toBeNull();
    expect(
      await createSkillsCapability(provider()).forRun(
        fakeRunCapabilityContext({ env: loadEnv({ CLARVIS_SKILLS_ENABLED: "0" }) }),
      ),
    ).toBeNull();
  });

  it("resolves plugin bootstraps lazily once and reuses them for spawned agents", async () => {
    const { logger, warnings } = recordingLogger();
    const skills = provider();
    let calls = 0;
    const run = await runCapability({
      skills,
      bootstraps: () => {
        calls += 1;
        return [ref(), ref({ skill: "no-such-skill" })];
      },
      logger,
    });

    const first = run.systemSection!(lead)!;
    const second = run.systemSection!(spawned)!;
    expect(first).toContain("ALWAYS BRAINSTORM FIRST");
    expect(first.indexOf("ALWAYS BRAINSTORM FIRST")).toBeLessThan(
      first.indexOf("# Available skills"),
    );
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(skills.loads()).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it("does not scan or resolve bootstraps for an agent without the grant", async () => {
    const { logger, warnings } = recordingLogger();
    const skills = provider();
    let calls = 0;
    const run = await runCapability({
      skills,
      bootstraps: () => {
        calls += 1;
        return [ref()];
      },
      logger,
    });

    expect(run.systemSection!(ungranted)).toBeUndefined();
    expect(await run.forAgent!(fakeAgentScope({ grants: [] }))).toBeNull();
    expect(calls).toBe(0);
    expect(skills.loads()).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("degrades to the catalog when the host bootstrap port throws", async () => {
    const { logger, warnings } = recordingLogger();
    const run = await runCapability({
      skills: provider(),
      bootstraps: () => {
        throw new Error("settings unreadable");
      },
      logger,
    });

    const section = run.systemSection!(lead)!;
    expect(section).toContain("# Available skills");
    expect(section).toContain("using-superpowers");
    expect(section).not.toContain("ALWAYS BRAINSTORM FIRST");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("bootstrap_skills_unavailable");
  });

  it("suppresses both prompt section and tool when the catalog is empty", async () => {
    const empty: SkillsProvider = {
      listSkills: () => [],
      loadSkill: () => undefined,
      readResource: () => {
        throw new Error("no resources in this fake");
      },
    };
    const run = await runCapability({ skills: empty });
    expect(run.systemSection!(lead)).toBeUndefined();
    expect(await run.forAgent!(fakeAgentScope({ grants: [USE_SKILLS_GRANT] }))).toBeNull();
  });

  it("wires the unadvertised load_skill handler and preserves trace context", async () => {
    const run = await runCapability({ skills: provider() });
    const agent = await run.forAgent!(fakeAgentScope({ grants: [USE_SKILLS_GRANT] }));
    const build = fakeAgentBuildContext({ subagentInstanceId: "w7" });
    const contribution = await agent!.attach(build);
    const handler = contribution.handlers![0]!;

    expect(contribution.tools?.map((tool) => tool.wireName)).toEqual([LOAD_SKILL_TOOL_NAME]);
    expect(contribution.advertised).toBe(false);
    expect(handler.matches({ id: "c1", name: "read_file", arguments: {} })).toBe(false);
    expect(handler.matches({ id: "c1", name: LOAD_SKILL_TOOL_NAME, arguments: {} })).toBe(true);

    const verdict = await handler.handle(
      { id: "c1", name: LOAD_SKILL_TOOL_NAME, arguments: { name: "alpha" } },
      4,
    );
    expect(verdict).toEqual({
      kind: "result",
      text: expect.stringContaining("ALWAYS BRAINSTORM FIRST"),
      progress: true,
    });
    const traceEntry = build.trace.entries().find((entry) => entry.kind === "tool_call");
    expect(traceEntry?.detail).toMatchObject({ subagent_instance_id: "w7", iteration_ref: 4 });
  });

  it("maps a handler failure to a non-progressing result", async () => {
    const run = await runCapability({ skills: provider() });
    const agent = await run.forAgent!(fakeAgentScope({ grants: [USE_SKILLS_GRANT] }));
    const handler = (await agent!.attach(fakeAgentBuildContext())).handlers![0]!;
    const verdict = await handler.handle(
      { id: "c1", name: LOAD_SKILL_TOOL_NAME, arguments: { name: "ghost" } },
      1,
    );
    expect(verdict).toEqual({
      kind: "result",
      text: expect.stringContaining("unknown skill 'ghost'"),
      progress: false,
    });
  });
});
