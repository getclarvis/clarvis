import { describe, expect, test } from "bun:test";
import { agentFrontmatterSchema, WORKFLOW_RESULT_SCHEMAS } from "../../src/config.ts";
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

/** Every fenced ```json block in the prompt body, parsed. */
function jsonBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const fence = /```json\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    blocks.push(JSON.parse(match[1] ?? ""));
  }
  return blocks;
}

/**
 * Drop every `description` so the comparison covers what a leader is actually
 * held to — field names, types, enums, `required`, `additionalProperties`. The
 * prompt keeps its blocks compact and explains the fields in prose beside them;
 * the exported constants carry per-field descriptions for a programmatic caller.
 */
function structure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structure);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, inner]) => [key, structure(inner)]),
  );
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

  test("may spawn a narrow Sub-agent while preferring workflows for substantive fan-out", () => {
    const prompt = ADMIRAL.body.replace(/\s+/g, " ");
    expect(prompt).toContain("`spawn_subagent`");
    expect(prompt).toContain("`delegate_task`");
    expect(prompt).toContain("It always requires that task's exact `task_id`");
    expect(prompt).toContain("Prefer workflows and `run_leader`");
  });

  test("an explicitly requested installed workflow is never replaced with ad-hoc orchestration", () => {
    expect(ADMIRAL.body).toContain("Honor an explicit installed-workflow request");
    expect(ADMIRAL.body).toContain("call `run_workflow`");
    expect(ADMIRAL.body).toContain("mandatory human");
    expect(ADMIRAL.body).toContain("preflight before any leader starts");
  });

  test("the prompt's schemas are the product's schemas, so the two cannot drift apart", () => {
    const shipped = Object.values(WORKFLOW_RESULT_SCHEMAS);
    const blocks = jsonBlocks(ADMIRAL.body).map(structure);
    expect(blocks).toHaveLength(shipped.length);
    for (const schema of shipped) {
      expect(blocks).toContainEqual(structure(schema));
    }
  });
});

describe("the shipped marshall agent", () => {
  test("uses the full lead-session soft iteration allowance", () => {
    expect(MARSHALL.frontmatter.iteration_limit).toBe(200);
  });

  test("keeps the user informed during multi-step tool work without pausing before the tool", () => {
    expect(MARSHALL.body).toContain("begin with a one- or two-sentence visible update");
    expect(MARSHALL.body).toContain("call it immediately after the update");
    expect(MARSHALL.body).toContain("about a minute of uninterrupted tool work");
    expect(MARSHALL.body).toContain("Never invent progress or expose hidden reasoning");
  });

  test("uses separate tools for independent spawning and tracked delegation", () => {
    const prompt = MARSHALL.body.replace(/\s+/g, " ");
    expect(prompt).toContain("A plan is not a prerequisite for spawning a Sub-agent");
    expect(prompt).toContain("Use `spawn_subagent` for independent bounded work");
    expect(prompt).toContain("it has no `task_id` parameter");
    expect(prompt).toContain("Use `delegate_task` only when the Sub-agent genuinely implements");
    expect(prompt).toContain("switch to `spawn_subagent`");
  });
});
