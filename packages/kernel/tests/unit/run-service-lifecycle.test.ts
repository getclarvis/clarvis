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
