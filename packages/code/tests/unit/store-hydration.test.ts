import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { RunDetail, RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptToolNode } from "../../src/adapters/store.ts";
import { formatToolCall } from "../../src/views/tools/signature.ts";
import { mutationStats } from "../../src/views/tools/mutation-gate.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";

function toolCall(callId: string): RunEvent {
  return runEvent({
    type: "tool_call",
    agent: "lead",
    call_id: callId,
    at: 2,
    server: "fs",
    tool: "grep",
    arguments: { pattern: `p-${callId}` },
    result: `result-${callId}`,
    diff: `diff-${callId}`,
    ok: true,
  });
}

function bodyCall(callId: string, result: string): RunEvent {
  return runEvent({
    type: "tool_call",
    agent: "lead",
    call_id: callId,
    at: 2,
    server: "mcp",
    tool: "large_result",
    arguments: {},
    result,
    ok: true,
  });
}

function detail(events: RunEvent[]): RunDetail {
  return {
    execution_id: "exec_1",
    status: "completed",
    created_at: 1,
    messages: [],
    events,
  };
}

function detailFor(executionId: string, events: RunEvent[]): RunDetail {
  return { ...detail(events), execution_id: executionId };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The composition root's real projection, so a test sees what the TUI renders. */
const describeToolCall: NonNullable<
  NonNullable<Parameters<typeof createTranscriptStore>[0]>["describeToolCall"]
> = (input) => ({
  signature: formatToolCall(input.mcpName ?? "", input.toolName ?? "", input.args ?? {}),
  mutation: mutationStats(input),
});

function withStore<T>(
  deps: Parameters<typeof createTranscriptStore>[0],
  run: (store: ReturnType<typeof createTranscriptStore>) => Promise<T>,
): Promise<T>;
function withStore<T>(
  deps: Parameters<typeof createTranscriptStore>[0],
  run: (store: ReturnType<typeof createTranscriptStore>) => T,
): T;
function withStore<T>(
  deps: Parameters<typeof createTranscriptStore>[0],
  run: (store: ReturnType<typeof createTranscriptStore>) => T | Promise<T>,
): T | Promise<T> {
  return createRoot((dispose) => {
    const store = createTranscriptStore({ describeToolCall, ...deps });
    try {
      const result = run(store);
      if (result instanceof Promise) return result.finally(dispose);
      dispose();
      return result;
    } catch (error) {
      dispose();
      throw error;
    }
  });
}

const toolNodes = (store: ReturnType<typeof createTranscriptStore>): TranscriptToolNode[] =>
  store.nodes.filter((n): n is TranscriptToolNode => n.kind === "tool_call");

test("keeps the newest tool bodies and drops the older ones past the limit", () => {
  withStore({ hydratedToolLimit: 3 }, (store) => {
    const sink = store.openRun("exec_1");
    for (let i = 0; i < 6; i++) applyRunEvent(sink, toolCall(`c${i}`), "live");

    const tools = toolNodes(store);
    expect(tools).toHaveLength(6);

    const dropped = tools.slice(0, 3);
    const kept = tools.slice(3);
    expect(dropped.map((n) => n.dehydrated)).toEqual([true, true, true]);
    expect(dropped.every((n) => !n.result && !n.diff && !n.args)).toBe(true);
    expect(kept.map((n) => n.dehydrated)).toEqual([undefined, undefined, undefined]);
    expect(kept.map((n) => n.result)).toEqual(["result-c3", "result-c4", "result-c5"]);
    expect(kept.every((n) => n.diff !== undefined && n.args !== undefined)).toBe(true);
  });
});

test("also bounds hydrated tool bodies by aggregate estimated bytes", () => {
  withStore(
    {
      hydratedToolLimit: 100,
      hydratedToolBytesLimit: 100,
      hydratedToolSingleBytesLimit: 100,
    },
    (store) => {
      const sink = store.openRun("exec_1");
      applyRunEvent(sink, bodyCall("c0", "123456"), "live");
      applyRunEvent(sink, bodyCall("c1", "abcdef"), "live");

      expect(toolNodes(store).map((node) => node.dehydrated)).toEqual([true, undefined]);
      expect(toolNodes(store).map((node) => node.result)).toEqual([undefined, "abcdef"]);

      // A body larger than the single-body ceiling is kept only in persistence;
      // it does not evict the ordinary body that already fits the window.
      applyRunEvent(sink, bodyCall("c2", "x".repeat(100)), "live");
      expect(toolNodes(store).map((node) => node.dehydrated)).toEqual([true, undefined, true]);
    },
  );
});

test("an explicitly rehydrated oversized body stays persisted and shows a recovery route", async () => {
  const oversized = bodyCall("c0", "x".repeat(20));
  await withStore(
    {
      hydratedToolLimit: 100,
      hydratedToolBytesLimit: 150,
      hydratedToolSingleBytesLimit: 80,
      fetchRun: async () => detail([oversized]),
    },
    async (store) => {
      const sink = store.openRun("exec_1");
      applyRunEvent(sink, oversized, "live");
      expect(toolNodes(store)[0]!.dehydrated).toBe(true);

      await store.rehydrate('exec_1::tool:["lead","c0"]');
      expect(toolNodes(store)[0]!.result).toBeUndefined();
      expect(toolNodes(store)[0]!.dehydrated).toBe(true);
      expect(toolNodes(store)[0]!.hydrationNotice).toContain("/export");

      applyRunEvent(sink, bodyCall("c1", "z"), "live");
      expect(toolNodes(store).map((node) => node.dehydrated)).toEqual([true, undefined]);
    },
  );
});

test("the end-of-run replay does not evict a block that fits the window twice over", () => {
  withStore({ hydratedToolLimit: 3 }, (store) => {
    const sink = store.openRun("exec_1");
    const calls = ["c0", "c1"];
    for (const c of calls) applyRunEvent(sink, toolCall(c), "live");

    sink.beginReconcile();
    for (const c of calls) applyRunEvent(sink, toolCall(c), "replay");
    sink.endReconcile();

    expect(toolNodes(store).map((n) => n.dehydrated)).toEqual([undefined, undefined]);
    expect(toolNodes(store).map((n) => n.result)).toEqual(["result-c0", "result-c1"]);
  });
});

test("re-noting a key moves it to newest instead of leaving a stale duplicate behind", () => {
  withStore({ hydratedToolLimit: 3 }, (store) => {
    const sink = store.openRun("exec_1");
    applyRunEvent(sink, toolCall("c0"), "live");
    applyRunEvent(sink, toolCall("c1"), "live");
    applyRunEvent(sink, toolCall("c0"), "replay");
    applyRunEvent(sink, toolCall("c2"), "live");

    const byKey = new Map(toolNodes(store).map((n) => [n.key, n]));
    expect(byKey.get('exec_1::tool:["lead","c0"]')!.dehydrated).toBeUndefined();
    expect(byKey.get('exec_1::tool:["lead","c0"]')!.result).toBe("result-c0");
    expect(byKey.get('exec_1::tool:["lead","c1"]')!.dehydrated).toBeUndefined();
    expect(byKey.get('exec_1::tool:["lead","c2"]')!.dehydrated).toBeUndefined();
  });
});

test("a dehydrated node still renders its collapsed header and export signature", () => {
  withStore({ hydratedToolLimit: 1 }, (store) => {
    const sink = store.openRun("exec_1");
    applyRunEvent(sink, toolCall("c0"), "live");
    applyRunEvent(sink, toolCall("c1"), "live");

    const dropped = toolNodes(store)[0]!;
    expect(dropped.dehydrated).toBe(true);
    expect(dropped.args).toBeUndefined();
    expect(dropped.signature).toBeDefined();
    expect(dropped.signature).toContain("p-c0");
    expect(dropped.mutation).toBeDefined();
  });
});

test("tool_call_started writes the resident signature from the live arguments", () => {
  withStore({}, (store) => {
    const sink = store.openRun("exec_1");
    applyRunEvent(
      sink,
      runEvent({
        type: "tool_call_started",
        agent: "subagent",
        subagent_id: "w1",
        call_id: "c0",
        at: 1,
        server: "fs",
        tool: "read_file",
        arguments: { path: "src/live.ts" },
      }),
      "live",
    );

    const node = toolNodes(store)[0]!;
    expect(node.status).toBe("running");
    expect(node.signature).toContain("src/live.ts");
    expect(node.mutation).toBeUndefined();
  });
});

test("a dehydrated node keeps its identity, key, status and tool name", () => {
  withStore({ hydratedToolLimit: 1 }, (store) => {
    const sink = store.openRun("exec_1");
    applyRunEvent(sink, toolCall("c0"), "live");
    applyRunEvent(sink, toolCall("c1"), "live");

    const first = toolNodes(store)[0]!;
    expect(first.key).toBe('exec_1::tool:["lead","c0"]');
    expect(first.status).toBe("ok");
    expect(first.toolName).toBe("grep");
    expect(first.mcpName).toBe("fs");
  });
});

test("rehydrate refills a dropped body from the persisted run and clears the flag", async () => {
  let calls = 0;
  const persisted = detail([toolCall("c0")]);
  await withStore(
    {
      hydratedToolLimit: 1,
      fetchRun: async (id) => {
        calls++;
        return id === "exec_1" ? persisted : null;
      },
    },
    async (store) => {
      const sink = store.openRun("exec_1");
      applyRunEvent(sink, toolCall("c0"), "live");
      applyRunEvent(sink, toolCall("c1"), "live");
      expect(toolNodes(store)[0]!.dehydrated).toBe(true);

      await store.rehydrate('exec_1::tool:["lead","c0"]');

      const refilled = toolNodes(store)[0]!;
      expect(refilled.dehydrated).toBeUndefined();
      expect(refilled.result).toBe("result-c0");
      expect(refilled.diff).toBe("diff-c0");
      expect(refilled.args).toEqual({ pattern: "p-c0" });
      expect(calls).toBe(1);
    },
  );
});

test("rehydrate is a no-op for a node that still has its body", async () => {
  let calls = 0;
  await withStore(
    {
      fetchRun: async () => {
        calls++;
        return null;
      },
    },
    async (store) => {
      const sink = store.openRun("exec_1");
      applyRunEvent(sink, toolCall("c0"), "live");

      await store.rehydrate('exec_1::tool:["lead","c0"]');
      await store.rehydrate('exec_1::tool:["lead","missing"]');

      expect(calls).toBe(0);
    },
  );
});

test("concurrent rehydrates of one key share a single fetch", async () => {
  let calls = 0;
  const persisted = detail([toolCall("c0")]);
  const fetch = deferred<RunDetail>();
  await withStore(
    {
      hydratedToolLimit: 1,
      fetchRun: async () => {
        calls++;
        return fetch.promise;
      },
    },
    async (store) => {
      const sink = store.openRun("exec_1");
      applyRunEvent(sink, toolCall("c0"), "live");
      applyRunEvent(sink, toolCall("c1"), "live");

      const first = store.rehydrate('exec_1::tool:["lead","c0"]');
      const second = store.rehydrate('exec_1::tool:["lead","c0"]');
      expect(calls).toBe(1);
      fetch.resolve(persisted);
      await Promise.all([first, second]);

      expect(calls).toBe(1);
      expect(toolNodes(store)[0]!.result).toBe("result-c0");
    },
  );
});

test("distinct rehydrates use a bounded physical concurrency and queue", async () => {
  let active = 0;
  let peak = 0;
  const gates = new Map<string, ReturnType<typeof deferred<RunDetail>>>();
  await withStore(
    {
      hydratedToolLimit: 1,
      maxConcurrentRehydrates: 2,
      maxQueuedRehydrates: 3,
      fetchRun: (executionId) => {
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred<RunDetail>();
        gates.set(executionId, gate);
        return gate.promise.finally(() => {
          active -= 1;
        });
      },
    },
    async (store) => {
      for (let index = 0; index < 5; index += 1) {
        const sink = store.openRun(`exec_${index}`);
        applyRunEvent(sink, toolCall("c0"), "live");
        applyRunEvent(sink, toolCall("c1"), "live");
      }
      const loads = Array.from({ length: 5 }, (_, index) =>
        store.rehydrate(`exec_${index}::tool:["lead","c0"]`),
      );
      expect(peak).toBe(2);
      expect(gates.size).toBe(2);

      for (let index = 0; index < 5; index += 1) {
        while (!gates.has(`exec_${index}`)) await Promise.resolve();
        gates.get(`exec_${index}`)!.resolve(detailFor(`exec_${index}`, [toolCall("c0")]));
        await Promise.resolve();
      }
      await Promise.all(loads);
      expect(peak).toBe(2);
    },
  );
});

test("rehydrate refuses excess queued keys visibly without starting another fetch", async () => {
  const gate = deferred<RunDetail>();
  let calls = 0;
  await withStore(
    {
      hydratedToolLimit: 1,
      maxConcurrentRehydrates: 1,
      maxQueuedRehydrates: 0,
      fetchRun: () => {
        calls += 1;
        return gate.promise;
      },
    },
    async (store) => {
      for (const executionId of ["exec_0", "exec_1"]) {
        const sink = store.openRun(executionId);
        applyRunEvent(sink, toolCall("c0"), "live");
        applyRunEvent(sink, toolCall("c1"), "live");
      }
      const first = store.rehydrate('exec_0::tool:["lead","c0"]');
      await store.rehydrate('exec_1::tool:["lead","c0"]');
      expect(calls).toBe(1);
      expect(
        toolNodes(store).find((node) => node.key === 'exec_1::tool:["lead","c0"]')?.hydrationNotice,
      ).toContain("queue is full");
      gate.resolve(detailFor("exec_0", [toolCall("c0")]));
      await first;
    },
  );
});

test("a failed fetch leaves the node dehydrated instead of throwing, and says so", async () => {
  const recording = recordDiagnostics();
  try {
    await withStore(
      {
        hydratedToolLimit: 1,
        fetchRun: () => Promise.reject(new Error("gone")),
      },
      async (store) => {
        const sink = store.openRun("exec_1");
        applyRunEvent(sink, toolCall("c0"), "live");
        applyRunEvent(sink, toolCall("c1"), "live");

        await store.rehydrate('exec_1::tool:["lead","c0"]');

        expect(toolNodes(store)[0]!.dehydrated).toBe(true);
        expect(toolNodes(store)[0]!.hydrationNotice).toContain("could not be reloaded");
      },
    );
  } finally {
    recording.uninstall();
  }
  expect(recording.first("transcript.rehydrate.failed")?.level).toBe("warn");
});

test("a persisted run missing the requested tool leaves an explicit reload failure", async () => {
  await withStore(
    {
      hydratedToolLimit: 1,
      fetchRun: async () => detail([]),
    },
    async (store) => {
      const sink = store.openRun("exec_1");
      applyRunEvent(sink, toolCall("c0"), "live");
      applyRunEvent(sink, toolCall("c1"), "live");

      await store.rehydrate('exec_1::tool:["lead","c0"]');

      expect(toolNodes(store)[0]).toMatchObject({
        dehydrated: true,
        hydrationNotice: expect.stringContaining("could not be reloaded"),
      });
    },
  );
});

test("retained-body accounting accepts primitive and null argument members", () => {
  withStore(
    {
      hydratedToolBytesLimit: 1_000,
      hydratedToolSingleBytesLimit: 1_000,
    },
    (store) => {
      const sink = store.openRun("exec_1");
      applyRunEvent(
        sink,
        runEvent({
          ...toolCall("primitive"),
          arguments: { count: 3, enabled: true, empty: null },
        }),
        "live",
      );

      expect(toolNodes(store)[0]?.dehydrated).toBeUndefined();
    },
  );
});

test("without a run fetcher a dropped body simply stays empty", async () => {
  await withStore({ hydratedToolLimit: 1 }, async (store) => {
    const sink = store.openRun("exec_1");
    applyRunEvent(sink, toolCall("c0"), "live");
    applyRunEvent(sink, toolCall("c1"), "live");

    await store.rehydrate('exec_1::tool:["lead","c0"]');

    expect(toolNodes(store)[0]!.dehydrated).toBe(true);
    expect(toolNodes(store)[0]!.hydrationNotice).toContain("could not be reloaded");
  });
});

test("a reconcile over a partly dehydrated transcript preserves order, count and keys", () => {
  withStore({ hydratedToolLimit: 2 }, (store) => {
    const sink = store.openRun("exec_1");
    const calls = ["c0", "c1", "c2", "c3"];
    for (const c of calls) applyRunEvent(sink, toolCall(c), "live");

    const before = store.nodes.map((n) => n.key);
    const identities = store.nodes.slice();

    sink.beginReconcile();
    for (const c of calls) applyRunEvent(sink, toolCall(c), "replay");
    sink.endReconcile();

    expect(store.nodes.map((n) => n.key)).toEqual(before);
    expect(store.nodes.length).toBe(identities.length);
    expect(toolNodes(store).map((n) => n.dehydrated)).toEqual([true, true, undefined, undefined]);
  });
});

test("clear() forgets the retention window so a fresh session starts hydrated", () => {
  withStore({ hydratedToolLimit: 2 }, (store) => {
    const first = store.openRun("exec_1");
    for (const c of ["c0", "c1", "c2"]) applyRunEvent(first, toolCall(c), "live");
    expect(toolNodes(store)[0]!.dehydrated).toBe(true);

    store.clear();

    const second = store.openRun("exec_2");
    applyRunEvent(second, toolCall("c0"), "live");
    applyRunEvent(second, toolCall("c1"), "live");
    expect(toolNodes(store).map((n) => n.dehydrated)).toEqual([undefined, undefined]);
  });
});

test("clear() cancels queued reloads and discards an in-flight reload result", async () => {
  const firstFetch = deferred<RunDetail>();
  let fetches = 0;
  await withStore(
    {
      hydratedToolLimit: 1,
      maxConcurrentRehydrates: 1,
      maxQueuedRehydrates: 2,
      fetchRun: () => {
        fetches += 1;
        return firstFetch.promise;
      },
    },
    async (store) => {
      for (const executionId of ["exec_0", "exec_1"]) {
        const sink = store.openRun(executionId);
        applyRunEvent(sink, toolCall("c0"), "live");
        applyRunEvent(sink, toolCall("c1"), "live");
      }

      const active = store.rehydrate('exec_0::tool:["lead","c0"]');
      const queued = store.rehydrate('exec_1::tool:["lead","c0"]');
      expect(fetches).toBe(1);

      store.clear();
      await queued;
      firstFetch.resolve(detailFor("exec_0", [toolCall("c0")]));
      await active;

      expect(fetches).toBe(1);
      expect(store.nodes).toEqual([]);
    },
  );
});
