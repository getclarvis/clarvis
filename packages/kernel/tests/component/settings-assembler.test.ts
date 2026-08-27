import { PLANS_DEFAULTS } from "@clarvis/plan/settings";
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsRunAssembler } from "../../src/runs/settings-assembler.ts";
import { createConfigService } from "../../src/config/config-service.ts";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import { loadEnv } from "@clarvis/capability";
import { type AgentProfile, type SkillsProvider } from "@clarvis/loop";
import { validateBody } from "@clarvis/loop/testing";
import type { SettingsAssemblerOptions } from "../../src/runs/settings-assembler.ts";

interface RawBody {
  entry: string;
  profiles: AgentProfile[];
  messages: unknown[];
  plans?: unknown;
  budget?: { on_exceed?: string; total_token_limit?: number };
  agents?: Record<string, number>;
  hook_user_prompt_expansion?: { command_name: string };
}

async function assemblerWith(
  agents: Record<string, Record<string, unknown>>,
  settings: Record<string, unknown> = {},
  options: SettingsAssemblerOptions = {},
) {
  const store = createMemoryConfigStore({
    settings: { global: { default_model: "openrouter/m", ...settings } },
  });
  const config = createConfigService(store);
  for (const [name, frontmatter] of Object.entries(agents)) {
    await config.writeAgent("global", name, { frontmatter, body: `You are ${name}.` });
  }
  return createSettingsRunAssembler(store, options);
}

describe("settings run assembler", () => {
  it("threads can_spawn/default_spawn and builds the spawnable closure", async () => {
    const assemble = await assemblerWith({
      coder: {
        model: "openrouter/m",
        grants: ["read_workspace", "run_commands"],
        can_spawn: ["implementer"],
        default_spawn: "implementer",
      },
      implementer: { model: "openrouter/m", grants: ["read_workspace", "run_commands"] },
    });

    const body = assemble({ agent: "coder", messages: [], execution_id: "e1" }) as RawBody;

    expect(body.entry).toBe("coder");
    const coder = body.profiles.find((p) => p.name === "coder")!;
    expect(coder.can_spawn).toEqual(["implementer"]);
    expect(coder.default_spawn).toBe("implementer");
    expect(coder.grants).toContain("run_commands");
    expect(body.profiles.map((p) => p.name).sort()).toEqual(["coder", "implementer"]);
  });

  it("a solo agent yields a single profile; an unresolved spawn target is skipped", async () => {
    const assemble = await assemblerWith({
      solo: { model: "openrouter/m", grants: ["read_workspace"] },
      lead: { model: "openrouter/m", can_spawn: ["ghost"] },
    });
    expect(
      (assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody).profiles.map(
        (p) => p.name,
      ),
    ).toEqual(["solo"]);
    expect(
      (assemble({ agent: "lead", messages: [], execution_id: "e" }) as RawBody).profiles.map(
        (p) => p.name,
      ),
    ).toEqual(["lead"]);
  });

  it("injects CLARVIS.md, falls back to AGENTS.md, and never injects both", () => {
    const prompts = (files: Partial<Record<"CLARVIS.md" | "AGENTS.md", string>>) => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-context-assembler-"));
      const globalDir = join(workspaceRoot, "global");
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(workspaceRoot, name), content);
      }
      const store = createFileConfigStore({ workspaceRoot, globalDir });
      store.writeSettings("global", { default_model: "openrouter/m" });
      store.writeAgent("global", "lead", {
        frontmatter: { can_spawn: ["worker"] },
        body: "You are lead.",
      });
      store.writeAgent("global", "worker", { frontmatter: {}, body: "You are worker." });

      const body = createSettingsRunAssembler(store)({
        agent: "lead",
        messages: [],
        execution_id: "e",
      }) as RawBody;
      return Object.fromEntries(
        body.profiles.map((profile) => [profile.name, profile.base_prompt] as const),
      );
    };

    expect(prompts({})).toMatchObject({ lead: "You are lead.", worker: "You are worker." });
    expect(prompts({ "AGENTS.md": "agents instructions" }).lead).toBe(
      "You are lead.\n\n## Context: workspace/AGENTS.md\n\nagents instructions",
    );
    const both = prompts({
      "CLARVIS.md": "clarvis instructions",
      "AGENTS.md": "agents instructions must not enter",
    });
    expect(both.lead).toBe(
      "You are lead.\n\n## Context: workspace/CLARVIS.md\n\nclarvis instructions",
    );
    expect(both.worker).toBe("You are worker.");
  });

  it("404s an unknown entry agent", async () => {
    const assemble = await assemblerWith({});
    expect(() => assemble({ agent: "nope", messages: [], execution_id: "e" })).toThrow(
      /is not defined/,
    );
  });

  it("forwards only run policy and strips provider selection", async () => {
    const assemble = await assemblerWith(
      { solo: { model: "openrouter/m" } },
      {
        plans: {
          mode: "review",
          retention: "keep",
          pending_task_nudges: 0,
          provider: { kind: "plugin", plugin: "acme-linear" },
        },
      },
    );
    expect(assemble({ agent: "solo", messages: [], execution_id: "e" })).toMatchObject({
      plans: { mode: "review", retention: "keep", pending_task_nudges: 0 },
    });
    expect(
      (assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody).plans,
    ).not.toHaveProperty("provider");
  });

  it("materializes the product defaults for a bare plans block", async () => {
    const assemble = await assemblerWith({ solo: { model: "openrouter/m" } }, { plans: {} });
    expect((assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody).plans).toEqual(
      {
        mode: PLANS_DEFAULTS.mode,
        retention: PLANS_DEFAULTS.retention,
      },
    );
  });

  it("materializes the default retention rather than letting the store decide", async () => {
    const assemble = await assemblerWith(
      { solo: { model: "openrouter/m" } },
      { plans: { mode: "review" } },
    );
    expect((assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody).plans).toEqual(
      {
        mode: "review",
        retention: "keep",
      },
    );
  });

  it("honours an explicit mode 'off' instead of coercing it to 'on'", async () => {
    const assemble = await assemblerWith(
      { solo: { model: "openrouter/m" } },
      { plans: { mode: "off", retention: "discard" } },
    );
    expect((assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody).plans).toEqual(
      {
        mode: "off",
        retention: "discard",
      },
    );
  });

  it("falls back to the default mode when the block names an unknown one", async () => {
    const assemble = await assemblerWith(
      { solo: { model: "openrouter/m" } },
      { plans: { mode: "sometimes" } },
    );
    expect((assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody).plans).toEqual(
      {
        mode: PLANS_DEFAULTS.mode,
        retention: PLANS_DEFAULTS.retention,
      },
    );
  });

  it("omits plans entirely when no block is configured", async () => {
    const assemble = await assemblerWith({ solo: { model: "openrouter/m" } });
    expect(assemble({ agent: "solo", messages: [], execution_id: "e" })).not.toHaveProperty(
      "plans",
    );
  });

  it("an explicit per-run plans param wins over the settings block", async () => {
    const assemble = await assemblerWith(
      { solo: { model: "openrouter/m" } },
      { plans: { mode: "review", retention: "keep" } },
    );
    expect(
      assemble({ agent: "solo", messages: [], execution_id: "e", plans: "off" }),
    ).toMatchObject({ plans: "off" });
  });

  it("projects the aggregate agents buffer budget from settings onto the run", async () => {
    const assemble = await assemblerWith(
      { solo: { model: "openrouter/m" } },
      {
        agents: {
          buffer_bytes: 4096,
          max_total_buffer_bytes: 65_536,
          max_live_children: 2,
        },
      },
    );
    expect(
      (assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody).agents,
    ).toEqual({
      buffer_bytes: 4096,
      max_total_buffer_bytes: 65_536,
      max_live_children: 2,
    });
  });

  it("forwards reasoning_effort, reasoning_summary, retry, compaction, stagnation_threshold, and call_timeout_ms from frontmatter", async () => {
    const assemble = await assemblerWith({
      solo: {
        model: "openrouter/m",
        reasoning_effort: "high",
        reasoning_summary: "detailed",
        retry: { max_retries: 2 },
        compaction: { enabled: false },
        stagnation_threshold: 5,
        call_timeout_ms: 90_000,
      },
    });
    const solo = (
      assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody
    ).profiles.find((p) => p.name === "solo")!;
    expect(solo.reasoning_effort).toBe("high");
    expect(solo.reasoning_summary).toBe("detailed");
    expect(solo.retry).toEqual({ max_retries: 2 });
    expect(solo.compaction).toEqual({ enabled: false });
    expect(solo.stagnation_threshold).toBe(5);
    expect(solo.call_timeout_ms).toBe(90_000);
  });

  it("the user's model and effort override the Lead while a spawned Sub-agent keeps its profile", async () => {
    const assemble = await assemblerWith(
      {
        marshall: {
          model: "anthropic/agent-lead",
          reasoning_effort: "xhigh",
          can_spawn: ["coder"],
        },
        coder: { model: "openai/child", reasoning_effort: "high" },
      },
      { default_model: "openrouter/user-default", default_reasoning_effort: "low" },
    );
    const body = assemble({ agent: "marshall", messages: [], execution_id: "e" }) as RawBody;
    expect(body.profiles.find((p) => p.name === "marshall")).toMatchObject({
      model: "openrouter/user-default",
      reasoning_effort: "low",
    });
    expect(body.profiles.find((p) => p.name === "coder")).toMatchObject({
      model: "openai/child",
      reasoning_effort: "high",
    });
  });

  it("keeps agents on different ChatGPT and Grok subscription providers", async () => {
    const assemble = await assemblerWith(
      {
        marshall: {
          model: "chatgpt/gpt-codex",
          can_spawn: ["grok-coder"],
          default_spawn: "grok-coder",
          grants: [],
        },
        "grok-coder": { model: "grok/grok-code", grants: [] },
      },
      {
        default_model: "chatgpt/gpt-codex",
        providers: [
          {
            name: "chatgpt",
            kind: "openai-codex",
            models: { "gpt-codex": { context_window_tokens: 200_000 } },
          },
          {
            name: "grok",
            kind: "xai-grok",
            models: { "grok-code": { context_window_tokens: 256_000 } },
          },
        ],
      },
    );
    const body = assemble({
      agent: "marshall",
      messages: [{ role: "user", content: "use both subscriptions" }],
      execution_id: "mixed",
    }) as RawBody;

    expect(body.profiles.find((profile) => profile.name === "marshall")?.model).toBe(
      "chatgpt/gpt-codex",
    );
    expect(body.profiles.find((profile) => profile.name === "grok-coder")?.model).toBe(
      "grok/grok-code",
    );
    expect(() => validateBody(body, loadEnv({ CLARVIS_LOG_LEVEL: "silent" }))).not.toThrow();
  });

  it("a spawned Sub-agent with no model or effort falls back to the user's defaults", async () => {
    const assemble = await assemblerWith(
      {
        marshall: { model: "anthropic/lead", can_spawn: ["helper"] },
        helper: {},
      },
      { default_model: "openrouter/user-default", default_reasoning_effort: "medium" },
    );
    const body = assemble({ agent: "marshall", messages: [], execution_id: "e" }) as RawBody;
    expect(body.profiles.find((p) => p.name === "helper")).toMatchObject({
      model: "openrouter/user-default",
      reasoning_effort: "medium",
    });
  });

  it("leaves reasoning_effort unset when neither frontmatter nor settings declare one", async () => {
    const assemble = await assemblerWith({ solo: { model: "openrouter/m" } });
    const solo = (
      assemble({ agent: "solo", messages: [], execution_id: "e" }) as RawBody
    ).profiles.find((p) => p.name === "solo")!;
    expect(solo.reasoning_effort).toBeUndefined();
  });
});

describe("settings run assembler — fallback budget", () => {
  const SOLO = { solo: { model: "openrouter/m" } };
  const START = { agent: "solo", messages: [{ role: "user" as const, content: "hi" }] };

  it("falls back to escalate/40M when the host configures nothing", async () => {
    const assemble = await assemblerWith(SOLO);
    const body = assemble({ ...START, execution_id: "e" }) as RawBody;
    expect(body.budget).toEqual({ on_exceed: "escalate", total_token_limit: 40_000_000 });
  });

  it("applies the host's fallback, and the result validates as a hard-stop budget", async () => {
    const assemble = await assemblerWith(
      SOLO,
      { providers: [{ name: "openrouter", kind: "openai" }] },
      { fallbackOnExceed: "stop", fallbackTokenLimit: 2_000_000 },
    );
    const body = assemble({ ...START, execution_id: "e" }) as RawBody;
    expect(body.budget).toEqual({ on_exceed: "stop", total_token_limit: 2_000_000 });

    const { request, shape } = validateBody(body, loadEnv({ CLARVIS_LOG_LEVEL: "silent" }));
    expect(request.budget.on_exceed).toBe("stop");
    expect(request.budget).not.toHaveProperty("max_escalations");
    expect(request.profiles.every((p) => p.iteration_limit !== undefined)).toBe(true);
    expect(shape.softMode).toBe(false);
    expect(shape.userInputEnabled).toBe(false);
  });

  it("is only a fallback: settings and entry-agent budgets still win", async () => {
    const fromSettings = await assemblerWith(
      SOLO,
      { budget: { on_exceed: "escalate" } },
      {
        fallbackOnExceed: "stop",
      },
    );
    expect((fromSettings({ ...START, execution_id: "e" }) as RawBody).budget).toEqual({
      on_exceed: "escalate",
    });

    const fromAgent = await assemblerWith(
      { solo: { model: "openrouter/m", budget: { on_exceed: "escalate" } } },
      { budget: { on_exceed: "stop" } },
      { fallbackOnExceed: "stop" },
    );
    expect((fromAgent({ ...START, execution_id: "e" }) as RawBody).budget).toEqual({
      on_exceed: "escalate",
    });
  });
});

describe("settings run assembler — skill runs", () => {
  const PROVIDERS = { providers: [{ name: "openrouter", kind: "openai" }] };
  const ENV = () => loadEnv({ CLARVIS_LOG_LEVEL: "silent" });

  type FakeSkill = {
    name: string;
    description: string;
    body: string;
    userInvocable: boolean;
    metadata: unknown;
    source?: string;
  };

  function skillsProvider(skills: FakeSkill[]): SkillsProvider {
    return {
      listSkills: () => skills as never,
      loadSkill: (name) => (skills.find((s) => s.name === name) as never) ?? undefined,
      readResource: (name, rel) => `${name}/${rel}`,
    };
  }

  const skill = (over: Partial<FakeSkill> = {}): FakeSkill => ({
    name: "spec",
    description: "write a spec",
    body: "STEP 1: read the code",
    userInvocable: true,
    metadata: {},
    ...over,
  });

  const AGENTS = {
    coder: { model: "openrouter/m", grants: ["read_workspace"] },
    researcher: { model: "openrouter/m", grants: ["read_workspace"], can_spawn: ["helper"] },
    helper: { model: "openrouter/m", grants: ["read_workspace"] },
  };

  const assembleWithSkills = async (skills: FakeSkill[]) =>
    assemblerWith(AGENTS, PROVIDERS, { skills: skillsProvider(skills) });

  it("enters on the agent the skill names for itself, overriding the request's agent", async () => {
    const assemble = await assembleWithSkills([skill({ metadata: { agent: "researcher" } })]);

    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec", task: "add SSO" },
      execution_id: "e",
    }) as RawBody;

    expect(body.entry).toBe("researcher");
    expect(body.profiles.map((p) => p.name).sort()).toEqual(["helper", "researcher"]);

    const { request } = validateBody(body, ENV());
    expect(request.entry).toBe("researcher");
  });

  it("keeps the caller's agent when the skill names none", async () => {
    const assemble = await assembleWithSkills([skill({ metadata: {} })]);

    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec" },
      execution_id: "e",
    }) as RawBody;

    expect(body.entry).toBe("coder");
    expect(() => validateBody(body, ENV())).not.toThrow();
  });

  it("applies a trusted skill Plans policy while preserving retention", async () => {
    const assemble = await assemblerWith(
      AGENTS,
      { ...PROVIDERS, plans: { mode: "review", retention: "discard", pending_task_nudges: 2 } },
      {
        skills: skillsProvider([skill({ source: "plugin:speckit" })]),
        skillPlansMode: ({ name, source }) =>
          name === "spec" && source === "plugin:speckit" ? "off" : undefined,
      },
    );
    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec" },
      execution_id: "e",
    }) as RawBody;
    expect(body.plans).toEqual({ mode: "off", retention: "discard", pending_task_nudges: 2 });
  });

  it("an explicit request Plans mode wins over the skill policy", async () => {
    const assemble = await assemblerWith(
      AGENTS,
      { ...PROVIDERS, plans: { mode: "review" } },
      {
        skills: skillsProvider([skill({ source: "plugin:speckit" })]),
        skillPlansMode: () => "off",
      },
    );
    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec" },
      plans: "on",
      execution_id: "e",
    }) as RawBody;
    expect(body.plans).toBe("on");
  });

  it("seeds the run with the rendered skill as its final user message", async () => {
    const assemble = await assembleWithSkills([skill()]);

    const body = assemble({
      agent: "coder",
      messages: [{ role: "user" as const, content: "some earlier context" }],
      skill: { name: "spec", task: "add SSO" },
      execution_id: "e",
    }) as RawBody;

    expect(body.messages).toHaveLength(2);
    const last = body.messages.at(-1) as { role: string; content: string };
    expect(last.role).toBe("user");
    expect(last.content).toContain('The user invoked the "spec" skill.');
    expect(last.content).toContain("STEP 1: read the code");
    expect(last.content).toContain("add SSO");

    const { request } = validateBody(body, ENV());
    expect(request.messages).toHaveLength(2);
  });

  it("substitutes the task into a placeholder body rather than appending a target", async () => {
    const assemble = await assembleWithSkills([
      skill({ body: "Write a spec for $ARGUMENTS today." }),
    ]);

    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec", task: "add SSO" },
      execution_id: "e",
    }) as RawBody;

    const last = body.messages.at(-1) as { content: string };
    expect(last.content).toContain("Write a spec for add SSO today.");
    expect(last.content).not.toContain("Target:");
    expect(() => validateBody(body, ENV())).not.toThrow();
  });

  it("never forwards the skill key to the engine, which has no concept of one", async () => {
    const assemble = await assembleWithSkills([skill()]);

    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec", task: "add SSO" },
      execution_id: "e",
    }) as RawBody;

    expect(body).not.toHaveProperty("skill");
    expect(() => validateBody(body, ENV())).not.toThrow();
  });

  it("forwards only the exact user skill expansion context to hooks", async () => {
    const assemble = await assembleWithSkills([skill({ source: "plugin:toolkit" })]);

    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec" },
      execution_id: "e",
    }) as RawBody;

    expect(body.hook_user_prompt_expansion).toEqual({ command_name: "toolkit:spec" });
    expect(validateBody(body, ENV()).request.hook_user_prompt_expansion).toEqual({
      command_name: "toolkit:spec",
    });
  });

  it("keeps non-plugin skill expansion names bare", async () => {
    const assemble = await assembleWithSkills([skill({ source: "workspace" })]);
    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec" },
      execution_id: "e",
    }) as RawBody;
    expect(body.hook_user_prompt_expansion).toEqual({ command_name: "spec" });
  });

  it("a request with no messages of its own still validates, because the skill seeds one", async () => {
    const assemble = await assembleWithSkills([skill()]);

    const body = assemble({
      agent: "coder",
      messages: [],
      skill: { name: "spec" },
      execution_id: "e",
    }) as RawBody;

    expect(body.messages).toHaveLength(1);
    expect(() => validateBody(body, ENV())).not.toThrow();
  });

  it("404s an unknown skill, a non-invocable one, and any skill with no source configured", async () => {
    const assemble = await assembleWithSkills([skill({ name: "internal", userInvocable: false })]);
    const start = { agent: "coder", messages: [], execution_id: "e" };

    expect(() => assemble({ ...start, skill: { name: "nope" } })).toThrow(/is not available/);
    expect(() => assemble({ ...start, skill: { name: "internal" } })).toThrow(/is not available/);

    const noSkills = await assemblerWith(AGENTS, PROVIDERS);
    expect(() => noSkills({ ...start, skill: { name: "spec" } })).toThrow(/is not available/);
  });

  it("404s when the agent a skill names is not defined", async () => {
    const assemble = await assembleWithSkills([skill({ metadata: { agent: "ghost" } })]);
    expect(() =>
      assemble({ agent: "coder", messages: [], skill: { name: "spec" }, execution_id: "e" }),
    ).toThrow(/is not defined/);
  });
});

/**
 * The assembler's return type is `unknown` (see `RunRequestAssembler`), so there
 * is no compile-time drift lock below the loop package: a dropped field is
 * silent. These tests are the only guard on the prompt-cache fields.
 */
describe("settings run assembler · prompt cache", () => {
  const SOLO = { solo: { model: "openrouter/m" } };
  const START = { agent: "solo", messages: [{ role: "user" as const, content: "hi" }] };

  interface CacheBody {
    prompt_cache_key?: string;
    prompt_cache_ttl?: string;
  }

  const ttlFor = async (
    settings: Record<string, unknown>,
    params: Record<string, unknown> = {},
  ): Promise<string | undefined> => {
    const assemble = await assemblerWith(SOLO, settings);
    return (assemble({ ...START, execution_id: "e", ...params }) as CacheBody).prompt_cache_ttl;
  };

  it("passes an explicit prompt_cache_key and prompt_cache_ttl through", async () => {
    const assemble = await assemblerWith(SOLO);
    const body = assemble({
      ...START,
      execution_id: "e",
      prompt_cache_key: "conversation-42",
      prompt_cache_ttl: "5m",
    }) as CacheBody;
    expect(body.prompt_cache_key).toBe("conversation-42");
    expect(body.prompt_cache_ttl).toBe("5m");
  });

  it("omits both when the caller sets neither and no guard parks on a human", async () => {
    const assemble = await assemblerWith(SOLO, { guard: { mode: "off" } });
    const body = assemble({ ...START, execution_id: "e" }) as CacheBody;
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_ttl).toBeUndefined();
  });

  // The guard is on unless the user turned it off, so an unconfigured host parks
  // on a human by default and earns the long TTL — the conversation sits idle
  // while someone decides. Asserting the empty case pins that the posture and
  // the cache policy agree.
  it("derives 1h from an unconfigured host, because the guard defaults to on", async () => {
    const assemble = await assemblerWith(SOLO);
    const body = assemble({ ...START, execution_id: "e" }) as CacheBody;
    expect(body.prompt_cache_ttl).toBe("1h");
  });

  it("derives 1h from a guard mode that asks a human", async () => {
    expect(await ttlFor({ guard: { mode: "on" } })).toBe("1h");
    expect(await ttlFor({}, { guard_mode: "on" })).toBe("1h");
  });

  // Mode `auto` builds the judge only when a guard_judge is configured and
  // otherwise falls back to the human prompt, so "auto with no judge" parks on a
  // human exactly as `on` does.
  it("treats auto WITHOUT a judge as parking on a human, and auto WITH one as not", async () => {
    expect(await ttlFor({}, { guard_mode: "auto" })).toBe("1h");
    expect(
      await ttlFor({}, { guard_mode: "auto", guard_judge: { model: "openrouter/m" } }),
    ).toBeUndefined();
  });

  it("leaves the TTL to the loop when the guard is off", async () => {
    expect(await ttlFor({ guard: { mode: "off" } })).toBeUndefined();
    expect(await ttlFor({}, { guard_mode: "off" })).toBeUndefined();
  });

  it("lets an explicit request param override the guard-derived default", async () => {
    expect(await ttlFor({ guard: { mode: "on" } }, { prompt_cache_ttl: "5m" })).toBe("5m");
  });
});

// P1 lived here: `settings.json` spells the MCP transport `type`, the engine's
// strict request schema spells it `transport`, and the assembler forwarded the
// entry verbatim — so every run referencing `<server>.<tool>` died in
// `validateBody` with `unrecognized_keys`. Nothing asserted the seam end to end.
describe("mcpServers reach the engine in its own shape", () => {
  const ENV = () => loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const MESSAGE = { role: "user" as const, content: "hi" };
  const PROVIDERS = [{ name: "openrouter", kind: "openai" }];

  async function assembleWithServers(mcpServers: Record<string, unknown>, tool = "fs.read_file") {
    const assemble = await assemblerWith(
      { custom: { model: "openrouter/m", tools: [tool] } },
      { mcpServers, providers: PROVIDERS },
    );
    return assemble({ agent: "custom", messages: [MESSAGE], execution_id: "e" });
  }

  it("a referenced stdio server produces a request validateBody accepts", async () => {
    const body = await assembleWithServers({ fs: { type: "stdio", command: "npx" } });
    expect(() => validateBody(body, ENV())).not.toThrow();
    const { request } = validateBody(body, ENV());
    expect(request.servers).toEqual([{ name: "fs", transport: "stdio", command: "npx" }]);
  });

  it("carries a remote server's url, headers and the stdio-only knobs", async () => {
    const remote = await assembleWithServers({
      fs: { type: "sse", url: "https://example.test/sse", headers: { Auth: "${A}" } },
    });
    expect(validateBody(remote, ENV()).request.servers[0]).toEqual({
      name: "fs",
      transport: "sse",
      url: "https://example.test/sse",
      headers: { Auth: "${A}" },
    });

    const local = await assembleWithServers({
      fs: { type: "stdio", command: "npx", args: ["-y"], shared: true, resources: false },
    });
    expect(validateBody(local, ENV()).request.servers[0]).toMatchObject({
      transport: "stdio",
      args: ["-y"],
      shared: true,
      resources: false,
    });
  });

  // Plugin contribution resolution qualifies the server before settings reach
  // this generic assembler. The full effective name must survive unchanged.
  it("translates a namespaced plugin-contributed server without losing its prefix", async () => {
    const body = await assembleWithServers(
      { "demo:fs": { type: "stdio", command: "plugin-srv" } },
      "demo:fs.read_file",
    );
    expect(validateBody(body, ENV()).request.servers[0]).toMatchObject({
      name: "demo:fs",
      transport: "stdio",
      command: "plugin-srv",
    });
  });

  // A dropped server would surface much later as `invalid_profile` pointing at
  // the agent, not at the typo.
  it("rejects a malformed entry by name instead of dropping it", async () => {
    await expect(assembleWithServers({ fs: { type: "stdio" } })).rejects.toThrow(
      /mcpServers\['fs'\].*command is required/s,
    );
    await expect(
      assembleWithServers({ fs: { type: "stdio", command: "x", cwd: "." } }),
    ).rejects.toThrow(/mcpServers\['fs'\]/);
  });

  it("omits a server no agent references", async () => {
    const assemble = await assemblerWith(
      { custom: { model: "openrouter/m", tools: ["read_file"] } },
      { mcpServers: { fs: { type: "stdio", command: "npx" } }, providers: PROVIDERS },
    );
    const body = assemble({ agent: "custom", messages: [MESSAGE], execution_id: "e" });
    expect(validateBody(body, ENV()).request.servers).toEqual([]);
  });
});
