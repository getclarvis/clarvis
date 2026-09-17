import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, type Capability, type LLMProvider, type RunRequest } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { createTestRunInfrastructure } from "@clarvis/loop/testing";
import { createJudgeCapability, JUDGE_PORT, type JudgeCoordinator } from "../../src/index.ts";

test("each physical run publishes one coordinator before lazy consumers and closes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "judge-public-cap-"));
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
  const ports: JudgeCoordinator[] = [];
  let preflights = 0;
  let activations = 0;
  let childCalls = 0;
  const base: LLMProvider = {
    async call(params) {
      if (params.agentInstanceId === "judge") childCalls++;
      return {
        ...(params.agentInstanceId === "judge"
          ? {
              toolCalls: [
                {
                  id: "child",
                  name: "judge_step",
                  arguments: { action: "decide_command", decision: "allow" },
                },
              ],
            }
          : { text: "done" }),
        usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
      };
    },
  };
  const judge = createJudgeCapability({
    requiredFor() {
      preflights++;
      return true;
    },
    bind(ctx) {
      activations++;
      expect(ctx.executionBaseLlm).toBe(base);
      return {
        model: "anthropic/test",
        providers: [{ name: "anthropic", kind: "anthropic" }],
        timeoutMs: 1000,
        maxRetries: 0,
        createServices: ({ executionBaseLlm }) => ({
          ...infrastructure,
          env,
          llm: executionBaseLlm,
        }),
      };
    },
  });
  const consumer: Capability = {
    name: "consumer",
    forRun(ctx) {
      return {
        name: "consumer",
        forAgent(scope) {
          if (!scope.entry) return null;
          return {
            attach() {
              return {
                hooks: {
                  async beforeIteration() {
                    const port = ctx.services.get(JUDGE_PORT)!;
                    expect(port).toBeDefined();
                    ports.push(port);
                    const bound = {
                      snapshot: () => ({ revision: 1 }),
                      isCurrent: () => true,
                      validateReceipt: () => true,
                    };
                    const results = await Promise.all([
                      port.reviewCommand({ currentCase: {} }, bound),
                      ctx.services.get(JUDGE_PORT)!.reviewCommand({ currentCase: {} }, bound),
                    ]);
                    expect(results.map((result) => result.kind)).toEqual(["reviewed", "reviewed"]);
                  },
                },
              };
            },
          };
        },
      };
    },
  };
  const request: RunRequest = {
    messages: [{ role: "user", content: "work" }],
    providers: [{ name: "anthropic", kind: "anthropic" }],
    servers: [],
    entry: "work",
    profiles: [{ name: "work", model: "anthropic/test", tools: [], iteration_limit: 1 }],
    budget: { on_exceed: "stop", total_token_limit: 10000 },
    prompt_cache_ttl: "1h",
  };
  try {
    expect(judge.required).toBeUndefined();
    expect("requiresUserInput" in judge).toBe(false);
    for (let index = 0; index < 2; index++) {
      const result = await executeRun({
        owner: "owner",
        rawBody: { ...request, execution_id: `work-${index}` },
        deps: { ...infrastructure, env, llm: base, capabilities: [consumer, judge] },
      });
      expect(result.response.status).toBe("completed");
      expect(
        await ports[index]!.reviewCommand(
          { currentCase: {} },
          { snapshot: () => ({}), isCurrent: () => true, validateReceipt: () => true },
        ),
      ).toMatchObject({ kind: "failed", failureKind: "cancelled", attempts: 0 });
    }
    expect(preflights).toBe(2);
    expect(activations).toBe(2);
    expect(childCalls).toBe(2);
    expect(ports[0]).not.toBe(ports[1]);
  } finally {
    await infrastructure.connections.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});
