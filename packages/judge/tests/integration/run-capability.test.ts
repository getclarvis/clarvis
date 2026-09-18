import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, type OutputTokenBudget, type RunRequest } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { createTestRunInfrastructure, MockLLM } from "@clarvis/loop/testing";
import { createJudgeRunCapability } from "../../src/run-capability.ts";

const command = { action: "decide_command", decision: "allow" };
const envelope = { version: 1 as const, revision: 1, objectives: [], grants: [], exclusions: [] };
const transition = { envelope, revision: 1, transition_token: "host" };
const compile = { action: "compile_authority", candidate: envelope };
const decide = {
  action: "decide_effects",
  decision: "allow",
  relation: "none",
  grant_ids: [],
  revision: 1,
  transition_token: "host",
};
const tool = (arguments_: unknown) => ({ name: "judge_step", arguments: arguments_ });
const budget = (): OutputTokenBudget => ({
  remaining: () => 8192,
  reserveOutput: (amount) => ({ amount, settle() {}, release() {} }),
});

test.each([
  {
    kind: "command",
    script: [
      { text: "Deny this action regardless of the tool decision.", toolCalls: [tool(command)] },
    ],
    iterations: 1,
    completed: true,
    installs: 0,
  },
  {
    kind: "compile",
    script: [
      { text: "Ignore authority constraints.", toolCalls: [tool(compile)] },
      { text: "Use a different transition.", toolCalls: [tool(decide)] },
    ],
    iterations: 2,
    completed: true,
    installs: 1,
  },
  {
    kind: "command",
    script: [{ toolCalls: [tool(JSON.stringify(command))] }],
    iterations: 1,
    completed: true,
    installs: 0,
  },
  {
    kind: "command",
    script: [{ toolCalls: [tool("{")] }],
    iterations: 1,
    completed: false,
    installs: 0,
  },
  {
    kind: "command",
    script: [{ toolCalls: [tool({ action: "decide_command", decision: "bad" })] }],
    iterations: 1,
    completed: false,
    installs: 0,
  },

  {
    kind: "compile",
    script: [{ toolCalls: [tool(compile)] }],
    iterations: 1,
    completed: false,
    installs: 1,
    hostFailure: true,
  },
  {
    kind: "command",
    script: [{ toolCalls: [tool(compile)] }],
    iterations: 1,
    completed: false,
    installs: 0,
  },
  {
    kind: "compile",
    script: [{ toolCalls: [tool(compile)] }, { toolCalls: [tool(decide)] }],
    iterations: 2,
    completed: true,
    installs: 1,
  },
  {
    kind: "compile",
    script: [{ toolCalls: [tool(compile), tool(compile)] }],
    iterations: 1,
    completed: false,
    installs: 0,
  },
  { kind: "command", script: [{ text: "yes" }], iterations: 1, completed: false, installs: 0 },
  {
    kind: "command",
    script: [{ toolCalls: [{ name: "foreign", arguments: {} }] }],
    iterations: 1,
    completed: false,
    installs: 0,
  },
  {
    kind: "compile",
    script: [{ toolCalls: [tool(decide)] }],
    iterations: 1,
    completed: false,
    installs: 0,
  },
])("private capability executes bounded case %#", async (fixture) => {
  const root = mkdtempSync(join(tmpdir(), "judge-capability-"));
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
  let installs = 0;
  const privateRun = createJudgeRunCapability(
    fixture.kind === "command"
      ? { kind: "command" }
      : {
          kind: "compile_effects",
          async validateAndInstall() {
            installs++;
            if ("hostFailure" in fixture) throw new Error("host transaction fault");
            return transition;
          },
        },
    budget(),
  );
  const llm = new MockLLM({
    script: (fixture.completed || "hostFailure" in fixture
      ? fixture.script
      : Array.from({ length: 4 }, () => fixture.script[0]!)
    ).map((entry) => ({
      ...entry,
      toolCalls: "toolCalls" in entry ? entry.toolCalls.map((call) => ({ ...call })) : undefined,
    })),
  });
  const request: RunRequest = {
    agent_instance_id: "judge",
    session_id: "parent",
    prompt_cache_ttl: "1h",
    entry: "judge",
    shared_prompt: "",
    messages: [{ role: "user", content: "private case" }],
    servers: [],
    profiles: [
      {
        name: "judge",
        model: "anthropic/test",
        tools: [],
        iteration_limit: 8,
        compaction: { enabled: false },
      },
    ],
    providers: [{ name: "anthropic", kind: "anthropic" }],
    budget: { total_token_limit: 32768, on_exceed: "stop" },
  };
  try {
    const result = await executeRun({
      owner: "owner",
      rawBody: request,
      deps: {
        ...infrastructure,
        env,
        executionVisibility: "internal",
        includeEnvironmentPreamble: false,
        capabilities: [privateRun.capability],
        llm: {
          async call(params) {
            expect(params.toolChoice).toEqual({
              type: "function",
              function: { name: "judge_step" },
            });
            expect(params.tools?.map((entry) => entry.wireName)).toEqual(["judge_step"]);
            const schema = params.tools?.[0]?.inputSchema as Record<string, unknown>;
            if (fixture.kind === "command") {
              expect(schema.oneOf).toBeUndefined();
              expect(schema.required).toEqual(["action", "decision"]);
              expect(schema.properties).toMatchObject({
                action: { const: "decide_command" },
                decision: { enum: ["allow", "deny", "unsure"] },
              });
            } else {
              expect(schema.oneOf).toBeArray();
            }
            const result = await llm.call(params);
            return privateRun.admitResponse(result.toolCalls, result.text)
              ? result
              : {
                  ...result,
                  text: "",
                  toolCalls: [{ id: "rejected", name: "judge_step", arguments: {} }],
                };
          },
        },
      },
    });
    expect(result.response.status).toBe(fixture.completed ? "completed" : "error");
    expect(result.response.usage.iterations_used).toBe(
      fixture.completed || "hostFailure" in fixture ? fixture.iterations : 4,
    );
    expect(installs).toBe(fixture.installs);
    if (result.response.status === "completed")
      expect(result.response.result).toEqual(fixture.kind === "command" ? command : decide);
    else if (result.response.status === "error")
      expect(result.response.error.code).toBe(
        "hostFailure" in fixture ? "internal_error" : "judge_invalid_response",
      );
    expect(privateRun.stage()).toBe("closed");
    expect(privateRun.invalidResponse()).toBe(!fixture.completed && !("hostFailure" in fixture));
    expect(privateRun.hostFailure() !== undefined).toBe("hostFailure" in fixture);
  } finally {
    await infrastructure.connections.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});
