import { describe, expect, test } from "bun:test";
import { evaluateCacheAgents, validCacheUsage } from "../../cache/evaluation.ts";
import type { CacheCall, CacheTrial, CacheReport } from "../../cache/types.ts";
import { auditCacheTrial, auditCacheReport } from "../../cache/evidence.ts";
import { cacheHash } from "../../cache/wire.ts";

function series(agentInstanceId = "leader", count = 12): CacheCall[] {
  return Array.from({ length: count }, (_, index) => ({
    scenario: "C01",
    trial: 1,
    sessionId: "session",
    agentInstanceId,
    purpose: agentInstanceId === "leader" ? "leader" : "child",
    iteration: index + 1,
    attempt: 1,
    phase: "growth",
    base: 0,
    startedAt: index * 1000,
    endedAt: index * 1000 + 100,
    requestedModel: "gpt-6-astra",
    serializedModel: "gpt-6-astra",
    serializedEffort: "medium",
    requestedEffort: "medium",
    sdkVersion: "test",
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    keyHash: agentInstanceId,
    instructionsHash: "instructions",
    toolsHash: "tools",
    parametersHash: "parameters",
    itemHashes: Array.from({ length: index + 1 }, (_, item) => `item-${item}`),
    usage: {
      input: 20000 + index * 1000,
      cached: index === 0 ? 0 : 19000 + index * 1000,
      output: 20,
    },
    status: "completed",
    toolCalls: [{ name: "cache_cursor", callId: `call-${index}` }],
  }));
}

describe("prompt-cache qualification from independent measured records", () => {
  test("does not trust a stored pass, a missing matrix member or an unrelated loaded artifact", () => {
    const calls = series().map((call) => ({
      ...call,
      executionId: "execution",
      sessionHeaderHash: cacheHash(call.keyHash),
    }));
    const trial: CacheTrial = {
      scenario: "C01",
      trial: 1,
      model: "gpt-6-astra",
      limits: { calls: 60, input: 2500000, output: 80000, durationMs: 1800000 },
      calls,
      agents: [],
      checkpoints: [{ name: "cursor/leader", verdict: "pass" }],
      accounting: [
        {
          executionId: "execution",
          usage: { input: 306000, cached: 275000, output: 240 },
          physicalCalls: 12,
          unknownUsageCalls: 0,
          reconciled: true,
        },
      ],
      diagnostics: [],
      verdict: "pass",
    };
    expect(auditCacheTrial(trial)).toBe("pass");
    const unrelatedModel = structuredClone(trial);
    unrelatedModel.calls[0].resolvedModel = "gpt-6-astra-mini";
    expect(auditCacheTrial(unrelatedModel)).toBe("incomplete");
    expect(unrelatedModel.diagnostics).toContain("resolved_model_mismatch");
    const compacted = structuredClone(trial);
    compacted.calls.push({
      ...calls[0],
      purpose: "compaction",
      executionId: "summary",
      requestedEffort: undefined,
      serializedEffort: undefined,
      divergence: { surface: "instructions" },
      usage: { input: 12000, cached: 0, output: 800 },
    });
    compacted.accounting.push({
      executionId: "summary",
      usage: { input: 12000, cached: 0, output: 800 },
      physicalCalls: 1,
      unknownUsageCalls: 0,
      reconciled: true,
    });
    expect(auditCacheTrial(compacted)).toBe("pass");
    expect(compacted.agents.find((agent) => agent.purpose === "compaction")?.totals.input).toBe(
      12000,
    );
    compacted.calls.at(-1).requestedEffort = "medium";
    expect(auditCacheTrial(compacted)).toBe("incomplete");
    expect(compacted.diagnostics).toContain("requested_effort_mismatch");
    const report: CacheReport = {
      schemaVersion: 1,
      source: {
        commit: "a".repeat(40),
        inputsHash: "a".repeat(64),
        lockfileHash: "b".repeat(64),
        bun: "fixture",
        platform: "linux",
        arch: "x64",
        sdkVersion: "fixture",
        fixtureHash: "c".repeat(64),
        configHash: "d".repeat(64),
      },
      limits: trial.limits,
      expected: [{ scenario: "C01", model: "gpt-6-astra", trials: 1 }],
      trials: [trial],
      verdict: "pass",
      diagnostics: [],
    };
    expect(auditCacheReport(report)).toBe("pass");
    expect(auditCacheReport(report, true)).toBe("incomplete");
    const missingCheckpoint = structuredClone(trial);
    missingCheckpoint.scenario = "C07";
    missingCheckpoint.calls.forEach((call) => {
      call.scenario = "C07";
    });
    expect(auditCacheTrial(missingCheckpoint)).toBe("incomplete");
    expect(missingCheckpoint.diagnostics).toContain("missing_checkpoint:process-restart");
    report.expected[0].trials = 3;
    expect(auditCacheReport(report)).toBe("incomplete");
    calls[3].sessionHeaderHash = "unrelated";
    expect(auditCacheTrial(trial)).toBe("incomplete");
    expect(trial.diagnostics).toContain("subscription_affinity_mismatch");
    calls[3].divergence = { surface: "history", item: 0 };
    expect(auditCacheTrial(trial)).toBe("fail");
  });
  test("accepts the healthy small-growth control with a weighted window", () => {
    const [agent] = evaluateCacheAgents(series());
    expect(agent.verdict).toBe("pass");
    expect(agent.windows[0].inputGrowth).toBe(9000);
    expect(agent.windows[0].weightedHit).toBeGreaterThan(0.9);
    expect(agent.totals.input).toBe(306000);
  });

  test("evaluates the first truncated-result request and its three continuations", () => {
    const calls = series("leader", 16).map((call) => ({ ...call, scenario: "C08" as const }));
    calls[12].truncatedNewResult = true;
    calls[12].usage.cached = Math.floor(calls[12].usage.input * 0.75);
    const [failed] = evaluateCacheAgents(calls);
    expect(failed.windows.find((window) => window.name === "base-0")?.verdict).toBe("pass");
    expect(failed.verdict).toBe("fail");
    expect(
      failed.windows.find((window) => window.name === "transition/new-result-truncated")?.reasons,
    ).toContain("first_transition_call_below_85_percent");

    calls[12].usage.cached = calls[12].usage.input - 1000;
    const [healthy] = evaluateCacheAgents(calls);
    expect(healthy.verdict).toBe("pass");
    expect(
      healthy.windows.find((window) => window.name === "transition/new-result-truncated"),
    ).toMatchObject({ verdict: "pass", calls: 4 });
    const [short] = evaluateCacheAgents(calls.slice(0, 15));
    expect(
      short.windows.find((window) => window.name === "transition/new-result-truncated")?.verdict,
    ).toBe("incomplete");
  });

  test("rejects a leader's concurrency window even when its whole conversation remains healthy", () => {
    const leader = series("leader", 100).map((call) => ({ ...call, scenario: "C03" as const }));
    const children = ["explorer-one", "explorer-two"].flatMap((id) =>
      series(id).map((call) => ({
        ...call,
        scenario: "C03" as const,
        startedAt: call.startedAt + 10000,
        endedAt: call.endedAt + 10000,
      })),
    );
    for (const call of leader.slice(12, 16)) call.usage.cached = Math.floor(call.usage.input * 0.6);
    const measured = evaluateCacheAgents([...leader, ...children]).find(
      (agent) => agent.purpose === "leader",
    );
    expect(measured.windows.find((window) => window.name === "base-0")?.verdict).toBe("pass");
    expect(measured.windows.find((window) => window.name === "concurrency/during")?.verdict).toBe(
      "fail",
    );
    expect(measured.verdict).toBe("fail");
  });

  test("rejects cached 25,984 stagnating as input reaches 100,476", () => {
    const calls = series("leader", 82);
    for (let i = 0; i < calls.length; i += 1)
      calls[i].usage = {
        input: 19476 + i * 1000,
        cached: Math.min(25984, 19476 + i * 1000),
        output: 20,
      };
    const [agent] = evaluateCacheAgents(calls);
    expect(calls.at(-1).usage.input).toBe(100476);
    expect(agent.verdict).toBe("fail");
    expect(agent.windows[0].reasons).toContain("cached_stagnated_while_input_grew");
  });

  test("does not let aggregate 75.61 percent or extra children hide a leader at 30.37 percent", () => {
    const leader = series();
    for (const call of leader) call.usage.cached = Math.floor(call.usage.input * 0.3037);
    const children = series("explorer-1", 48);
    for (const call of children) call.usage.cached = Math.floor(call.usage.input * 0.956);
    for (const volume of [1, 10, 100]) {
      const result = evaluateCacheAgents([
        ...leader,
        ...Array.from({ length: volume }, (_, id) =>
          children.map((call) => ({ ...call, agentInstanceId: `child-${id}` })),
        ).flat(),
      ]);
      expect(result.find((agent) => agent.agentInstanceId === "leader").verdict).toBe("fail");
    }
    const weighted = [
      ...leader.map((call) => ({ ...call, usage: { input: 100000, cached: 30370, output: 20 } })),
      ...series("child", 12).map((call) => ({
        ...call,
        usage: { input: 300000, cached: 272070, output: 20 },
      })),
    ];
    const overall =
      weighted.reduce((sum, call) => sum + call.usage.cached, 0) /
      weighted.reduce((sum, call) => sum + call.usage.input, 0);
    expect(overall).toBeCloseTo(0.7561, 4);
    expect(evaluateCacheAgents(weighted)[0].verdict).toBe("fail");
  });

  test.each(["history", "tools", "identity", "instructions"] as const)(
    "rejects deliberate %s corruption despite healthy usage",
    (surface) => {
      const calls = series();
      calls[5].divergence = { surface, item: 2, path: "metadata" };
      expect(evaluateCacheAgents(calls)[0].verdict).toBe("fail");
    },
  );

  test("records missing usage and cancellation as unknown instead of measured zero", () => {
    const calls = series();
    calls.push({ ...calls.at(-1), iteration: 13, status: "cancelled", usage: undefined });
    const [agent] = evaluateCacheAgents(calls);
    expect(agent.verdict).toBe("incomplete");
    expect(agent.unknownUsageCalls).toBe(1);
    expect(agent.physicalCalls).toBe(13);
    expect(agent.totals.input).toBe(306000);
  });

  test("accounts for auxiliary consumption separately from leader performance", () => {
    const auxiliary = {
      ...series()[0],
      purpose: "compaction" as const,
      usage: { input: 12000, cached: 0, output: 800 },
    };
    const result = evaluateCacheAgents([...series(), auxiliary]);
    expect(result.find((agent) => agent.purpose === "leader").verdict).toBe("pass");
    expect(result.find((agent) => agent.purpose === "compaction").totals).toEqual(auxiliary.usage);
  });

  test("rejects invalid cache splits and never warms a continuation for free", () => {
    expect(validCacheUsage({ input: 10, cached: 11, output: 0 })).toBe(false);
    expect(validCacheUsage(undefined)).toBe(false);
    const calls = series("leader", 16);
    calls[12].transition = "restart";
    calls[12].usage.cached = 0;
    const [agent] = evaluateCacheAgents(calls);
    expect(agent.verdict).toBe("fail");
    expect(agent.windows.find((window) => window.name === "transition/restart").reasons).toContain(
      "first_transition_call_below_85_percent",
    );
  });
});
