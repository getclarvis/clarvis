import { describe, expect, it } from "bun:test";
import { loadEnv, type ContextSnapshotEntry, type ExecutionRecord } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import type { RunHandle } from "@clarvis/protocol";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { createRunService } from "../../src/runs/run-service.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function managerHandle(executionId: string, closed: Promise<void>): RunHandle {
  return {
    execution_id: executionId,
    events: { async *[Symbol.asyncIterator]() {} },
    done: Promise.resolve({ execution_id: executionId, status: "completed" }),
    closed,
    steer: async () => {},
    compact: async () => {},
    cancel: async () => {},
    respond: async () => {},
    onElicit: () => {},
  };
}

function settledRecord(id: string, context: ContextSnapshotEntry[]): ExecutionRecord {
  return {
    id,
    owner_key_name: "owner",
    status: "completed",
    started_at: 1,
    ended_at: 2,
    elapsed_ms: 1,
    request: {
      messages: [{ role: "user", content: "continue" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 2,
          compaction: { enabled: true, preserve_recent_tokens: 0 },
        },
      ],
      entry: "solo",
      providers: [
        { name: "anthropic", kind: "anthropic", models: { x: { context_window_tokens: 1000 } } },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    },
    response: {
      status: "completed",
      result: "done",
      usage: { iterations_used: 1, elapsed_ms: 1, by_agent: [] },
    },
    trace: { events: [] },
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_cache_write_tokens: 0,
    final_context: context,
  };
}

describe("run-service lifecycle reservation", () => {
  it.each([
    { text: "Preserve the user's confirmed database choice.", expected: "compacted" },
    { text: "An ineffective summary. ".repeat(500), expected: "skipped" },
  ])(
    "settled guided compaction accounts for model usage when $expected",
    async ({ text, expected }) => {
      const traceStore = createMemoryTraceStore();
      const context: ContextSnapshotEntry[] = Array.from({ length: 8 }, (_, index) => ({
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `turn ${index}: ${"x".repeat(700)}`,
        },
        evictable: true,
        summary: false,
        canonical: false,
      }));
      await traceStore.insert(settledRecord("background-result", context));
      const llm = new MockLLM({
        script: [
          {
            text,
            usage: { input_tokens: 30, output_tokens: 12, cached_tokens: 4, cache_write_tokens: 2 },
          },
        ],
      });
      const service = createRunService({
        deps: { env: loadEnv({}), llm, traceStore } as unknown as ExecuteRunDeps,
        owner: "owner",
        assembleRunRequest: () => {
          throw new Error("compaction must not prepare another turn");
        },
      });
      const result = await service.compact("background-result", "  preserve confirmed choices  ");
      expect(result.status).toBe(expected);
      expect(llm.calls).toHaveLength(1);
      expect(JSON.stringify(llm.calls[0]!.messages)).toContain("preserve confirmed choices");
      const stored = traceStore.getById("owner", "background-result")!;
      expect(stored.total_input_tokens).toBe(30);
      expect(stored.total_output_tokens).toBe(12);
      expect(stored.total_cached_tokens).toBe(4);
      expect(stored.total_cache_write_tokens).toBe(2);
      if (expected === "compacted") {
        expect(JSON.stringify(stored.final_context)).toContain(
          "Preserve the user's confirmed database choice",
        );
        expect(result).toMatchObject({
          usage: { input_tokens: 30, output_tokens: 12, cached_tokens: 4, cache_write_tokens: 2 },
        });
      } else expect(stored.final_context).toEqual(context);
    },
  );

  it("a stored execution removed during guided compaction cannot be recreated by its late summary", async () => {
    const traceStore = createMemoryTraceStore();
    const context: ContextSnapshotEntry[] = Array.from({ length: 8 }, (_, index) => ({
      message: { role: index % 2 === 0 ? "user" : "assistant", content: "x".repeat(700) },
      evictable: true,
      summary: false,
      canonical: false,
    }));
    await traceStore.insert(settledRecord("removed-result", context));
    const llm = new MockLLM({ script: [{ text: "Retain the decision." }] });
    const service = createRunService({
      deps: {
        env: loadEnv({}),
        traceStore,
        llm: {
          async call(params: Parameters<MockLLM["call"]>[0]) {
            await traceStore.deleteById("owner", "removed-result");
            return llm.call(params);
          },
        },
      } as unknown as ExecuteRunDeps,
      owner: "owner",
      assembleRunRequest: () => ({}),
    });
    await expect(service.compact("removed-result", "retain decisions")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(traceStore.getById("owner", "removed-result")).toBeNull();
  });

  it("empty and unavailable stored runs do not launch compaction or accept invalid targets", async () => {
    const traceStore = createMemoryTraceStore();
    await traceStore.insert(settledRecord("empty", []));
    const llm = new MockLLM({ script: [] });
    const service = createRunService({
      deps: { env: loadEnv({}), llm, traceStore } as unknown as ExecuteRunDeps,
      owner: "owner",
      assembleRunRequest: () => ({}),
    });
    await expect(service.compact("empty")).resolves.toMatchObject({
      status: "skipped",
      reason: "no_context",
    });
    await expect(service.compact("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.compact("empty", undefined, { mechanical_target_tokens: 0.5 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(llm.calls).toEqual([]);
  });

  it("keeps an execution id reserved until bounded post-run event delivery closes", async () => {
    const firstClosed = deferred();
    let generation = 0;
    const service = createRunService({
      deps: { traceStore: createMemoryTraceStore() } as ExecuteRunDeps,
      owner: "owner",
      assembleRunRequest: () => ({}),
      isManagerRun: () => true,
      runManagerWorkflow: (params) =>
        managerHandle(
          params.execution_id,
          generation++ === 0 ? firstClosed.promise : Promise.resolve(),
        ),
    });

    const first = await service.start({ execution_id: "same-id", messages: [] });
    await first.done;
    await expect(
      service.compact("same-id", undefined, { mechanical_target_tokens: 1000 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.start({ execution_id: "same-id", messages: [] })).rejects.toMatchObject({
      code: "conflict",
    });

    firstClosed.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.start({ execution_id: "same-id", messages: [] })).resolves.toMatchObject({
      execution_id: "same-id",
    });
  });

  it("inspects and mechanically fits a settled continuation before a model switch", async () => {
    const traceStore = createMemoryTraceStore();
    const context: ContextSnapshotEntry[] = Array.from({ length: 8 }, (_, index) => ({
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index}: ${"x".repeat(700)}`,
      },
      evictable: true,
      summary: false,
      canonical: false,
    }));
    await traceStore.insert(settledRecord("settled", context));
    const service = createRunService({
      deps: {
        env: loadEnv({ CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: "0" }),
        llm: new MockLLM({ script: [{ text: "unused" }] }),
        traceStore,
      } as unknown as ExecuteRunDeps,
      owner: "owner",
      assembleRunRequest: () => ({}),
    });

    await expect(service.context("settled", 1000)).resolves.toMatchObject({
      has_context: true,
      high_water_tokens: 800,
      requires_compaction: true,
    });
    await expect(
      service.compact("settled", undefined, { mechanical_target_tokens: 1000 }),
    ).resolves.toMatchObject({ status: "compacted", execution_id: "settled" });
    await expect(service.context("settled", 1000)).resolves.toMatchObject({
      requires_compaction: false,
    });
    await expect(service.context("settled", 0)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
