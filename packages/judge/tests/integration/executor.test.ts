import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, ProviderError, type LLMCallParams } from "@clarvis/capability";
import { createTestRunInfrastructure, MockLLM } from "@clarvis/loop/testing";
import { executeJudge } from "../../src/executor.ts";
import { JUDGE_POLICY } from "../../src/prompt.ts";

const command = { action: "decide_command", decision: "allow" } as const;
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
} as const;
const answer = (args: unknown) => ({
  toolCalls: [{ name: "judge_step", arguments: args }],
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 3, cache_write_tokens: 1 },
});

test("concurrent command and effect executions retain independent observation cursors", async () => {
  const root = mkdtempSync(join(tmpdir(), "judge-concurrent-cursors-"));
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
  const bothEntered = Promise.withResolvers<void>();
  let entered = 0;
  const observations: Array<{ id: string; stage: string; consumer: string | undefined }> = [];
  try {
    const results = await Promise.all(
      (["command", "effects"] as const).map(async (kind) => {
        const base = new MockLLM({
          script: kind === "command" ? [answer(command)] : [answer(compile), answer(decide)],
        });
        let calls = 0;
        return executeJudge({
          owner: "owner",
          executionId: kind,
          sessionId: "shared-session",
          executionBaseLlm: base,
          promptCacheTtl: "1h",
          model: "anthropic/test",
          providers: [{ name: "anthropic", kind: "anthropic" }],
          timeoutMs: 20000,
          maxRetries: 0,
          snapshot: { authority: { revision: 1 } },
          currentCase: { kind },
          observation: {
            path: kind === "command" ? "call_local" : "effect_review",
            consumer: kind === "command" ? "command_guard" : "configure_clarvis",
          },
          binding:
            kind === "command"
              ? { kind: "command" }
              : { kind: "compile_effects", validateAndInstall: async () => transition },
          createServices(descriptor) {
            return {
              ...infrastructure,
              env,
              llm: {
                async call(params) {
                  if (++calls === 1) {
                    if (++entered === 2) bothEntered.resolve();
                    await bothEntered.promise;
                  }
                  expect(params.executionId).toBe(descriptor.executionId);
                  observations.push({
                    id: descriptor.executionId,
                    stage: descriptor.stage(),
                    consumer: descriptor.observation?.consumer,
                  });
                  return descriptor.executionBaseLlm.call(params);
                },
              },
            };
          },
        });
      }),
    );
    expect(results.map((result) => result.response.status)).toEqual(["completed", "completed"]);
    expect(observations.filter((item) => item.id === "command")).toEqual([
      { id: "command", stage: "decide", consumer: "command_guard" },
    ]);
    expect(observations.filter((item) => item.id === "effects")).toEqual([
      { id: "effects", stage: "compile", consumer: "configure_clarvis" },
      { id: "effects", stage: "decide", consumer: "configure_clarvis" },
    ]);
  } finally {
    await infrastructure.connections.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["command", "compile"] as const)(
  "executor isolates %s and reuses the effective host provider",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "judge-executor-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
    const base = new MockLLM({
      script: kind === "command" ? [answer(command)] : [answer(compile), answer(decide)],
    });
    const calls: LLMCallParams[] = [];
    let wrappers = 0;
    try {
      const outcome = await executeJudge({
        owner: "owner",
        executionId: "child",
        sessionId: "parent",
        executionBaseLlm: base,
        promptCacheTtl: "1h",
        model: "anthropic/test",
        providers: [{ name: "anthropic", kind: "anthropic" }],
        timeoutMs: 20_000,
        maxRetries: 1,
        binding:
          kind === "command"
            ? { kind: "command" }
            : {
                kind: "compile_effects",
                async validateAndInstall() {
                  return transition;
                },
              },
        snapshot: { authority: { revision: 0 }, guidance: "bounded" },
        currentCase: { command: "private command" },
        createServices(input) {
          expect(input.executionBaseLlm).toBe(base);
          expect(input.executionId).toBe("child");
          expect(input.stage()).toBe(kind === "command" ? "decide" : "compile");
          return {
            ...infrastructure,
            env,
            capabilities: [
              {
                name: "judge",
                required: true,
                forRun() {
                  throw new Error("Judge recursively inherited its host capability");
                },
              },
            ],
            operatorAuthority() {
              throw new Error("Authority runtime leaked into Judge");
            },
            hostMetadata() {
              throw new Error("Host metadata leaked into Judge");
            },
            llm: {
              async call(params) {
                wrappers++;
                expect(input.stage()).toBe(
                  kind === "compile" && wrappers === 1 ? "compile" : "decide",
                );
                calls.push({ ...params, messages: params.messages.slice() });
                const response = await input.executionBaseLlm.call(params);
                if (kind === "compile" && wrappers === 1) {
                  params.onRetry?.({
                    attempt: 1,
                    maxRetries: 1,
                    delayMs: 0,
                    kind: "transient",
                    message: "scripted retry",
                  });
                  return {
                    ...response,
                    retriedUsage: {
                      input_tokens: 7,
                      output_tokens: 3,
                      cached_tokens: 2,
                      cache_write_tokens: 0,
                    },
                  };
                }
                return response;
              },
            },
          };
        },
      });
      expect(outcome.receipt).toEqual(
        expect.objectContaining(kind === "command" ? command : decide),
      );
      expect(outcome.response.status).toBe("completed");
      expect(outcome.attempts).toBe(kind === "command" ? 1 : 3);
      expect(wrappers).toBe(kind === "command" ? 1 : 2);
      const stored = infrastructure.traceStore.getById("owner", "child")!;
      expect(stored.total_input_tokens).toBe(kind === "command" ? 10 : 27);
      expect(stored.total_output_tokens).toBe(kind === "command" ? 5 : 13);
      expect(outcome.timedOut).toBe(false);
      for (const call of calls) {
        expect(call.executionId).toBe("child");
        expect(call.sessionId).toBe("parent");
        expect(call.agentInstanceId).toBe("judge");
        expect(call.promptCacheKey).toBe("parent_judge");
        expect(call.promptCacheTtl).toBe("1h");
        expect(call.maxOutputTokens).toBe(kind === "command" ? 1024 : 2048);
        expect(call.maxRetries).toBe(1);
        expect(call.timeoutMs).toBe(20_000);
        expect(call.messages[0]).toEqual({ role: "system", content: JUDGE_POLICY });
        expect(call.messages[1]?.role).toBe("user");
        expect(call.messages[2]?.role).toBe("user");
        expect(call.cacheBreakpoints).toContain(3);
        expect(JSON.stringify(call.messages)).not.toContain(root);
        expect(call.tools?.map((entry) => entry.wireName)).toEqual(["judge_step"]);
      }
      if (calls.length === 2)
        expect(calls[1]!.messages.slice(0, 6)).toEqual(calls[0]!.messages.slice(0, 6));
    } finally {
      await infrastructure.connections.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["command", "effects"] as const)(
  "successive %s cases share the exact stable prefix, not their transcript or transition token",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "judge-prefix-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
    const base = new MockLLM({
      script: Array.from({ length: 4 }, (_, index) =>
        answer(
          kind === "command" ? command : { ...decide, transition_token: `case-token-${index}` },
        ),
      ),
    });
    const calls: LLMCallParams[] = [];
    try {
      for (let index = 0; index < 4; index++)
        await executeJudge({
          owner: "owner",
          executionId: `child-${index}`,
          sessionId: "parent",
          executionBaseLlm: base,
          promptCacheTtl: "5m",
          model: "anthropic/test",
          providers: [{ name: "anthropic", kind: "anthropic" }],
          timeoutMs: 1000,
          maxRetries: 0,
          binding:
            kind === "command"
              ? { kind: "command" }
              : {
                  kind: "effects",
                  transition: { ...transition, transition_token: `case-token-${index}` },
                },
          snapshot: {
            authority: { revision: index < 2 ? 1 : 2 },
            guidance: "stable",
            operator_instructions:
              index === 0
                ? [{ scope: "global", source: "AGENTS.md", content: "Validate changes" }]
                : [
                    {
                      content: index === 3 ? "Changed instructions" : "Validate changes",
                      source: "AGENTS.md",
                      scope: "global",
                    },
                  ],
          },
          currentCase: { command: `case-${index}` },
          createServices: () => ({
            ...infrastructure,
            env,
            llm: {
              async call(params) {
                calls.push({ ...params, messages: params.messages.slice() });
                return await base.call(params);
              },
            },
          }),
        });
      expect(calls[0]!.messages.slice(0, 4)).toEqual(calls[1]!.messages.slice(0, 4));
      expect(calls[1]!.messages[4]).not.toEqual(calls[2]!.messages[4]);
      expect(calls[2]!.messages.slice(0, 4)).toEqual(calls[0]!.messages.slice(0, 4));
      expect(calls[3]!.messages[0]).toEqual(calls[0]!.messages[0]);
      expect(calls[3]!.messages[1]).not.toEqual(calls[0]!.messages[1]);
      expect(calls[3]!.messages[1]!.content).toContain("Changed instructions");
      expect(calls[0]!.promptCacheKey).toBe("parent_judge");
      for (const [index, call] of calls.entries()) {
        expect(call.tools).toEqual(calls[0]!.tools);
        expect(call.cacheBreakpoints).toEqual(calls[0]!.cacheBreakpoints);
        expect(call.promptCacheKey).toBe(calls[0]!.promptCacheKey);
        expect(JSON.stringify(call.messages)).not.toContain(`child-${index}`);
        expect(call.messages).toHaveLength(6);
        expect(call.promptCacheTtl).toBe("5m");
        expect(JSON.stringify(call.messages[5])).toContain(`case-${index}`);
        if (kind === "effects") {
          expect(JSON.stringify(call.messages[5])).toContain(`case-token-${index}`);
          expect(JSON.stringify(call.messages.slice(0, 5))).not.toContain("case-token-");
        }
      }
    } finally {
      await infrastructure.connections.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["client", "auth", "deadline", "host", "cancel", "late_cancel", "empty"] as const)(
  "executor preserves %s failure without another external call",
  async (failureKind) => {
    const root = mkdtempSync(join(tmpdir(), "judge-failure-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
    let calls = 0;
    const controller = new AbortController();
    const failure = new Error("host transaction fault");
    const base = {
      async call(params: LLMCallParams) {
        calls++;
        if (failureKind === "empty")
          return { reasoning: "private reasoning", usage: answer(command).usage };
        if (failureKind === "late_cancel") controller.abort();
        if (failureKind === "client" || failureKind === "auth")
          throw new ProviderError("private provider text", { kind: failureKind });
        if (failureKind === "deadline")
          await new Promise<void>((resolve) => {
            if (params.signal?.aborted) resolve();
            else params.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        return {
          ...answer(failureKind === "host" || failureKind === "cancel" ? compile : command),
          toolCalls: [
            {
              id: "call",
              name: "judge_step",
              arguments: failureKind === "host" || failureKind === "cancel" ? compile : command,
            },
          ],
        };
      },
    };
    try {
      const operation = executeJudge({
        owner: "owner",
        executionId: "failed",
        signal: controller.signal,
        sessionId: "parent",
        executionBaseLlm: base,
        promptCacheTtl: "5m",
        model: "anthropic/test",
        providers: [{ name: "anthropic", kind: "anthropic" }],
        timeoutMs: failureKind === "deadline" ? 1 : 1000,
        maxRetries: 0,
        binding:
          failureKind === "host" || failureKind === "cancel"
            ? {
                kind: "compile_effects",
                async validateAndInstall() {
                  if (failureKind === "host") throw failure;
                  controller.abort();
                  return transition;
                },
              }
            : { kind: "command" },
        snapshot: {},
        currentCase: {},
        createServices: () => ({ ...infrastructure, env, llm: base }),
      });
      if (failureKind === "host") await expect(operation).rejects.toBe(failure);
      else if (failureKind === "cancel" || failureKind === "late_cancel") {
        const outcome = await operation;
        expect(outcome.response.status).toBe("cancelled");
        expect(outcome.receipt).toBeUndefined();
        const record = infrastructure.traceStore.getById("owner", "failed")!;
        expect(record.total_input_tokens).toBe(10);
        expect(record.total_output_tokens).toBe(5);
      } else {
        const outcome = await operation;
        expect(outcome.response.status).toBe("error");
        expect(outcome.receipt).toBeUndefined();
        if (failureKind === "empty") {
          expect(outcome.invalidResponse).toBe(true);
          expect(outcome.response.usage.iterations_used).toBe(1);
        } else expect(outcome.providerFailure?.error).toBeInstanceOf(ProviderError);
        expect(outcome.timedOut).toBe(failureKind === "deadline");
        expect(outcome.attempts).toBe(1);
        if (failureKind === "deadline") {
          const record = infrastructure.traceStore.getById("owner", "failed")!;
          expect(record.total_input_tokens).toBe(10);
          expect(record.total_output_tokens).toBe(5);
        }
      }
      expect(calls).toBe(1);
    } finally {
      await infrastructure.connections.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
