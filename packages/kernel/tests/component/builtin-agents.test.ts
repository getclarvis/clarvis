import { describe, expect, test } from "bun:test";
import { agentFrontmatterSchema } from "../../src/config.ts";
import {
  BUILTIN_AGENTS,
  BUILTIN_AGENT_NAMES,
  DEFAULT_ENTRY_AGENT,
  isBuiltinAgent,
  readBuiltinAgent,
} from "../../src/config/builtin-agents/index.ts";
import { compareAgentDisplayOrder } from "../../src/config/agent-resolution.ts";

const ADMIRAL = readBuiltinAgent("admiral")!;
const MARSHALL = readBuiltinAgent("marshall")!;
const PROMPT_TOKEN_BUDGETS = {
  marshall: 220,
  admiral: 300,
  coder: 130,
  explorer: 120,
  planner: 130,
} as const;
const FLEET_PROMPT_TOKEN_BUDGET = 800;

/** Match the engine's text-only estimate: one token per four characters. */
function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

describe("the agent fleet Clarvis ships", () => {
  test("is the five profiles, in the product's order", () => {
    expect(BUILTIN_AGENT_NAMES).toEqual(["marshall", "admiral", "coder", "explorer", "planner"]);
    expect(DEFAULT_ENTRY_AGENT).toBe("marshall");
  });

  test("carries a non-empty prompt and a valid frontmatter for every one", () => {
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.body.trim().length).toBeGreaterThan(0);
      const parsed = agentFrontmatterSchema.safeParse(agent.frontmatter);
      expect(`${agent.name}: ${parsed.error?.message ?? "ok"}`).toBe(`${agent.name}: ok`);
      expect(agent.frontmatter.description).toBeTypeOf("string");
    }
  });

  test("keeps the complete builtin prompt payload within its token budget", () => {
    let total = 0;
    for (const agent of BUILTIN_AGENTS) {
      const tokens = estimatedTokens(agent.body);
      total += tokens;
      expect(tokens).toBeLessThanOrEqual(
        PROMPT_TOKEN_BUDGETS[agent.name as keyof typeof PROMPT_TOKEN_BUDGETS],
      );
    }
    expect(total).toBeLessThanOrEqual(FLEET_PROMPT_TOKEN_BUDGET);
  });

  /**
   * A `can_spawn` naming an agent nothing defines is skipped by the run
   * assembler, silently. Within the shipped fleet that would be a typo nobody
   * ever sees — a lead quietly losing a sub-agent.
   */
  test("every profile a shipped agent may spawn is itself shipped", () => {
    for (const agent of BUILTIN_AGENTS) {
      const canSpawn = (agent.frontmatter.can_spawn ?? []) as string[];
      for (const child of canSpawn) expect(isBuiltinAgent(child)).toBe(true);
      const defaultSpawn = agent.frontmatter.default_spawn as string | undefined;
      if (defaultSpawn !== undefined) {
        expect(canSpawn).toContain(defaultSpawn);
        expect(defaultSpawn).not.toBe(agent.name);
      }
    }
  });

  test("declares no model, so the fleet inherits the workspace's default", () => {
    for (const agent of BUILTIN_AGENTS) expect(agent.frontmatter.model).toBeUndefined();
  });

  test("sorts ahead of a user's own agents, which follow ascending by name", () => {
    const listed = [
      { name: "zulu" },
      { name: "planner" },
      { name: "alpha" },
      { name: "marshall" },
      { name: "coder" },
    ].sort(compareAgentDisplayOrder);
    expect(listed.map((a) => a.name)).toEqual(["marshall", "coder", "planner", "alpha", "zulu"]);
  });

  test("hands out a defensive copy, so a consumer cannot corrupt the fleet", () => {
    const first = readBuiltinAgent("coder")!;
    expect(readBuiltinAgent("coder")).toBe(first);
    expect(readBuiltinAgent("nobody")).toBeUndefined();
    expect(isBuiltinAgent("nobody")).toBe(false);
  });
});

describe("the shipped admiral agent", () => {
  test("uses the full lead-session soft iteration allowance", () => {
    expect(ADMIRAL.frontmatter.iteration_limit).toBe(200);
  });

  test("carries the workflow grant, which is the only thing that routes a run as a workflow", () => {
    expect(ADMIRAL.frontmatter.grants).toContain("workflow");
  });

  test("can verify and repair without becoming the implementation worker", () => {
    expect(ADMIRAL.frontmatter.grants).toContain("read_workspace");
    expect(ADMIRAL.frontmatter.grants).toContain("edit_workspace");
    expect(ADMIRAL.frontmatter.grants).toContain("run_commands");
  });

  test("exposes manager-local children alongside the workflow harness", () => {
    const prompt = ADMIRAL.body.replace(/\s+/g, " ");
    expect(prompt).toContain("agent harness");
    expect(prompt).toContain("`spawn_subagent`");
    expect(prompt).toContain("`delegate_task`");
    expect(prompt).toContain("manager-local children");
    expect(prompt).toContain("genuinely independent work");
  });

  test("names the installed-workflow and human-preflight capability", () => {
    expect(ADMIRAL.body).toContain("`run_workflow`");
    expect(ADMIRAL.body).toContain("installed sequence with human preflight");
  });

  test("names the round checkpoint and supervision capabilities", () => {
    const prompt = ADMIRAL.body.replace(/\s+/g, " ");
    expect(prompt).toContain("`workflow_status`");
    expect(prompt).toContain("`workflow_decide`");
    expect(prompt).toContain("pauses at each round boundary");
    expect(prompt).toContain("finalization is blocked while a child is live");
  });
});

describe("the shipped marshall agent", () => {
  test("uses the full lead-session soft iteration allowance", () => {
    expect(MARSHALL.frontmatter.iteration_limit).toBe(200);
  });

  test("uses separate tools for independent spawning and tracked delegation", () => {
    const prompt = MARSHALL.body.replace(/\s+/g, " ");
    expect(prompt).toContain("agent harness adds clear value");
    expect(prompt).toContain("`spawn_subagent` for independent work");
    expect(prompt).toContain("`delegate_task` for an existing plan task");
    expect(prompt).toContain("exact `task_id`");
    expect(prompt).toContain(
      "not for trivial, sequential, overlapping, or performative delegation",
    );
  });
});

describe("the shipped Sub-agent leaves", () => {
  test("state their role and the harness boundary without teaching a workflow", () => {
    for (const name of ["coder", "explorer", "planner"] as const) {
      const agent = readBuiltinAgent(name)!;
      const prompt = agent.body.replace(/\s+/g, " ");
      expect(agent.frontmatter.can_spawn).toBeUndefined();
      expect(prompt).toContain(`You are \`${name}\``);
      expect(prompt).toContain("The harness gives you");
      expect(prompt).toContain("You are a leaf");
      expect(prompt).toContain("It does not give you the caller's conversation");
    }
  });
});
