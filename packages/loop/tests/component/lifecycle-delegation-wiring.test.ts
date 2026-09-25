import { describe, expect, it } from "../bun-test.ts";
import { loadEnv, type LifecycleHook, type PreSpawnContext } from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger } from "../../src/runtime/budget/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import {
  prepareSpawn,
  runPreparedSubagent,
  type SpawnContext,
} from "../../src/runtime/subagents/spawn-subagent.ts";
import type { ResolvedSubagentProfile } from "../../src/runtime/subagents/subagent-profiles.ts";
import { MockLLM } from "../helpers/fixtures.ts";

const env = loadEnv({});
const SPAWN_ARGS = { title: "worker", task: "do the thing", profile: "coder" };

function profile(): ResolvedSubagentProfile {
  return {
    name: "coder",
    model: "model",
    modelRef: "anthropic:model",
    provider: "anthropic",
    tools: [],
    contextWindowTokens: 200_000,
    stagnationThreshold: 3,
    callTimeoutMs: 60_000,
    reasoningSummary: "off",
    maxRetries: 0,
    maxRetryAfterMs: 0,
    compaction: DISABLED_COMPACTION,
    stream: true,
  };
}

function context(
  llm: MockLLM,
  hooks: LifecycleHook[],
): SpawnContext & { trace: ReturnType<typeof createTrace> } {
  return {
    env,
    opened: [],
    profiles: new Map([["coder", profile()]]),
    iterationLimitDefault: 5,
    llm,
    ledger: createTokenLedger(1_000_000),
    trace: createTrace(),
    subagentAggByModel: new Map(),
    hooks,
  };
}

describe("pre_spawn_subagent hook wiring", () => {
  it("passes validated spawn arguments to the fake hook and maps its denial", async () => {
    const seen: PreSpawnContext[] = [];
    const ctx = context(new MockLLM({ script: [] }), [
      {
        async preSpawnSubagent(input) {
          seen.push(input);
          return { kind: "deny", message: "coder subagents are disabled" };
        },
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared).toEqual({
      ok: false,
      text: "spawn_subagent DENIED by a workspace hook: coder subagents are disabled",
    });
    expect(seen).toEqual([SPAWN_ARGS]);
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(false);
  });

  it("a passing fake hook preserves the real subagent lifecycle wiring", async () => {
    const ctx = context(new MockLLM({ script: [{ text: "done" }] }), [
      { preSpawnSubagent: async () => ({ kind: "pass" }) },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const result = await runPreparedSubagent(prepared.prepared, ctx);

    expect(result).toMatchObject({ spawned: true, text: "done" });
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(true);
  });

  it("fails closed when the hook itself throws, so a broken gate denies the spawn", async () => {
    const ctx = context(new MockLLM({ script: [{ text: "should never run" }] }), [
      {
        preSpawnSubagent: () => {
          throw new Error("hook process exited 1");
        },
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.text).toContain("spawn_subagent DENIED by a workspace hook");
    expect(prepared.text).toContain("the hook itself failed");
    expect(prepared.text).toContain("hook process exited 1");
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(false);
  });

  it("denies on a throw even when a later hook would have passed the spawn", async () => {
    let laterRan = false;
    const ctx = context(new MockLLM({ script: [] }), [
      {
        preSpawnSubagent: async () => {
          await Promise.resolve();
          throw new Error("first gate is broken");
        },
      },
      {
        preSpawnSubagent: async () => {
          laterRan = true;
          return { kind: "pass" };
        },
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared.ok).toBe(false);
    expect(laterRan).toBe(false);
  });
});
