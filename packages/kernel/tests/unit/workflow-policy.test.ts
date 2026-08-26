import { describe, it, expect } from "bun:test";
import type { SkillsProvider } from "@clarvis/loop";
import type { StartRunParams } from "@clarvis/protocol";
import { createAgentWorkflowPolicy } from "../../src/application/workflow-policy.ts";
import { createConfigService } from "../../src/config/config-service.ts";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";

async function storeWith(agents: Record<string, Record<string, unknown>>) {
  const store = createMemoryConfigStore({
    settings: { global: { default_model: "openrouter/m" } },
  });
  const config = createConfigService(store);
  for (const [name, frontmatter] of Object.entries(agents)) {
    await config.writeAgent("global", name, { frontmatter, body: `You are ${name}.` });
  }
  return store;
}

function skillsWith(metadata: Record<string, unknown>): SkillsProvider {
  return {
    loadSkill: (name: string) =>
      name === "plan-release"
        ? ({
            name,
            description: "ship it",
            body: "do the thing",
            metadata,
          } as unknown as ReturnType<SkillsProvider["loadSkill"]>)
        : undefined,
  } as unknown as SkillsProvider;
}

const AGENTS = {
  manager: { model: "openrouter/m", grants: ["workflow"] },
  coder: { model: "openrouter/m", grants: ["read_workspace"] },
};

const params = (over: Partial<StartRunParams>): StartRunParams =>
  ({ messages: [], ...over }) as unknown as StartRunParams;

describe("createAgentWorkflowPolicy — isManagerRun", () => {
  it("routes a plain request by its own agent", async () => {
    const policy = createAgentWorkflowPolicy(await storeWith(AGENTS));
    expect(policy.isManagerRun(params({ agent: "manager" }))).toBe(true);
    expect(policy.isManagerRun(params({ agent: "coder" }))).toBe(false);
    expect(policy.isManagerRun(params({}))).toBe(false);
  });

  it("routes a skill by the entry agent the skill itself declares", async () => {
    const policy = createAgentWorkflowPolicy(
      await storeWith(AGENTS),
      skillsWith({ agent: "manager" }),
    );
    expect(policy.isManagerRun(params({ skill: { name: "plan-release", task: "ship 1.2" } }))).toBe(
      true,
    );
  });

  it("lets a skill's declared agent win over the caller's, in both directions", async () => {
    const store = await storeWith(AGENTS);
    expect(
      createAgentWorkflowPolicy(store, skillsWith({ agent: "manager" })).isManagerRun(
        params({ agent: "coder", skill: { name: "plan-release", task: "t" } }),
      ),
    ).toBe(true);
    expect(
      createAgentWorkflowPolicy(store, skillsWith({ agent: "coder" })).isManagerRun(
        params({ agent: "manager", skill: { name: "plan-release", task: "t" } }),
      ),
    ).toBe(false);
  });

  it("falls back to the caller's agent when the skill names none", async () => {
    const policy = createAgentWorkflowPolicy(await storeWith(AGENTS), skillsWith({}));
    expect(
      policy.isManagerRun(params({ agent: "manager", skill: { name: "plan-release", task: "t" } })),
    ).toBe(true);
  });

  it("falls back to the caller's agent when the skill is unknown or no source is configured", async () => {
    const store = await storeWith(AGENTS);
    expect(
      createAgentWorkflowPolicy(store, skillsWith({ agent: "manager" })).isManagerRun(
        params({ agent: "manager", skill: { name: "missing", task: "t" } }),
      ),
    ).toBe(true);
    expect(
      createAgentWorkflowPolicy(store).isManagerRun(
        params({ agent: "coder", skill: { name: "plan-release", task: "t" } }),
      ),
    ).toBe(false);
  });
});
