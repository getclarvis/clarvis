import { expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import type { RunDetail, RunEvent } from "@clarvis/protocol";
import { applyEvent, createTranscriptStore } from "../../src/adapters/store.ts";
import { createChildTranscriptStore } from "../../src/adapters/child-transcript-store.ts";

const executionId = "exec-child-cache";

function created(id: string, at = 1): RunEvent {
  return {
    type: "delegation_created",
    at,
    delegation_id: id,
    title: id,
    task: `Investigate ${id}`,
  };
}

function childText(id: string, iteration: number, text: string): RunEvent[] {
  return [
    {
      type: "iteration_started",
      at: iteration * 10,
      agent: "subagent",
      subagent_id: id,
      iteration,
    },
    {
      type: "text_delta",
      at: iteration * 10 + 1,
      agent: "subagent",
      subagent_id: id,
      iteration,
      channel: "text",
      text,
      reset: true,
    },
  ];
}

test("Lead-only events retain the existing transcript projection", () => {
  createRoot((dispose) => {
    const isolated = createChildTranscriptStore({ fetchRun: async () => null });
    const baseline = createTranscriptStore();
    const isolatedSink = isolated.openRun(executionId);
    const baselineSink = baseline.openRun(executionId);
    const events: RunEvent[] = [
      { type: "run_started", at: 0 },
      { type: "iteration_started", at: 1, agent: "lead", iteration: 1 },
      {
        type: "text_delta",
        at: 2,
        agent: "lead",
        iteration: 1,
        channel: "text",
        text: "Lead answer",
        reset: true,
      },
    ];
    for (const event of events) {
      applyEvent(isolatedSink, event, "live");
      applyEvent(baselineSink, event, "live");
    }
    expect(JSON.stringify(isolated.nodes)).toBe(JSON.stringify(baseline.nodes));
    dispose();
  });
});

test("hidden children do not enter the Lead store and completed tails are released", () => {
  createRoot((dispose) => {
    const store = createChildTranscriptStore({ fetchRun: async () => null });
    const sink = store.openRun(executionId);
    const run = (event: RunEvent) => applyEvent(sink, event, "live");
    let projections = 0;
    const leadNodes = createMemo(() => {
      projections++;
      return store.nodes;
    });
    run({ type: "run_started", at: 0 });
    for (let child = 0; child < 16; child++) run(created(`child-${child}`));
    const leadBefore = leadNodes();
    const beforeCount = projections;
    let childEvents = 0;
    for (let iteration = 1; iteration <= 512; iteration++) {
      for (let child = 0; child < 16; child++) {
        const id = `child-${child}`;
        for (const event of childText(id, iteration, `answer-${iteration}`)) {
          run(event);
          childEvents++;
        }
        for (let delta = 0; delta < 2; delta++) {
          run({
            type: "text_delta",
            at: iteration * 10 + 2 + delta,
            agent: "subagent",
            subagent_id: id,
            iteration,
            channel: "text",
            text: `answer-${iteration}-${delta}`,
            reset: true,
          });
          childEvents++;
        }
      }
    }
    for (let extra = 0; extra < 33; extra++) {
      run({
        type: "text_delta",
        at: 6000 + extra,
        agent: "subagent",
        subagent_id: "child-0",
        iteration: 512,
        channel: "text",
        text: `tail-${extra}`,
        reset: true,
      });
      childEvents++;
    }
    expect(store.nodes).toBe(leadBefore);
    expect(leadNodes()).toBe(leadBefore);
    expect(projections).toBe(beforeCount);
    for (let child = 0; child < 16; child++) {
      const id = `child-${child}`;
      run({
        type: "delegation_completed",
        at: 2000 + child,
        delegation_id: id,
        status: "completed",
      });
    }
    expect(
      store.nodes.some(
        (node) =>
          node.subagentId !== undefined &&
          (node.kind === "assistant" || node.kind === "reasoning" || node.kind === "tool_call"),
      ),
    ).toBe(false);
    expect(childEvents).toBe(32_801);
    expect(store.memory?.().child_tail_bytes).toBeLessThanOrEqual(1024 * 1024);
    sink.complete();
    expect(store.memory?.().child_tail_bytes).toBe(0);
    expect(store.memory?.().child_resident_nodes).toBe(0);
    dispose();
  });
});

test("selecting a child replays its own persisted events and ignores a late foreign response", async () => {
  const requests = new Map<string, (detail: RunDetail | null) => void>();
  const { store, dispose } = createRoot((dispose) => ({
    dispose,
    store: createChildTranscriptStore({
      fetchRun: (id) =>
        new Promise<RunDetail | null>((done) => {
          requests.set(id, done);
        }),
    }),
  }));
  try {
    const first = store.openRun("exec-one");
    const second = store.openRun("exec-two");
    applyEvent(first, created("first"), "replay");
    applyEvent(second, created("second"), "replay");
    store.selectSubagent("first");
    store.selectSubagent("second");
    const detail = (events: RunEvent[]) => ({ events }) as RunDetail;
    requests.get("exec-one")?.(detail([...childText("first", 1, "first answer")]));
    requests.get("exec-two")?.(detail([...childText("second", 1, "second answer")]));
    await Promise.resolve();
    expect(store.nodes.some((node) => node.text === "first answer")).toBe(false);
    expect(store.nodes.some((node) => node.text === "second answer")).toBe(true);
    store.selectSubagent(null);
    expect(store.nodes.some((node) => node.text === "second answer")).toBe(false);
  } finally {
    dispose();
  }
});

test("a failed child reload is local and a later selection restores the full persisted task", async () => {
  const fullTask = "task".repeat(1500);
  const creation = { ...created("child"), task: fullTask };
  let reads = 0;
  const { store, projected, dispose } = createRoot((dispose) => {
    const store = createChildTranscriptStore({
      fetchRun: async () => {
        if (++reads === 1) throw new Error("temporarily unavailable");
        return { events: [creation, ...childText("child", 1, "persisted answer")] } as RunDetail;
      },
    });
    return { store, projected: createMemo(() => store.nodes), dispose };
  });
  try {
    const sink = store.openRun(executionId);
    applyEvent(sink, creation, "live");
    const lead = store.nodes;
    expect(lead.find((node) => node.kind === "subagent")?.text.length).toBeLessThan(
      fullTask.length,
    );
    store.selectSubagent("child");
    await Promise.resolve();
    expect(store.childLoadStatus?.()).toBe("unavailable");
    expect(store.nodes.some((node) => node.kind === "subagent" && node.text === fullTask)).toBe(
      false,
    );
    store.selectSubagent(null);
    expect(store.nodes).toBe(lead);
    store.selectSubagent("child");
    await Promise.resolve();
    expect(store.childLoadStatus?.()).toBe("ready");
    expect(projected().some((node) => node.kind === "subagent" && node.text === fullTask)).toBe(
      true,
    );
    expect(store.nodes.some((node) => node.kind === "subagent" && node.text === fullTask)).toBe(
      true,
    );
    expect(store.nodes.some((node) => node.text === "persisted answer")).toBe(true);
  } finally {
    dispose();
  }
});

test("selection joins live child events received while persisted history loads", async () => {
  let finish!: (detail: RunDetail) => void;
  const { store, dispose } = createRoot((dispose) => ({
    dispose,
    store: createChildTranscriptStore({
      fetchRun: () => new Promise<RunDetail>((resolve) => (finish = resolve)),
    }),
  }));
  try {
    const sink = store.openRun(executionId);
    applyEvent(sink, created("child"), "live");
    store.selectSubagent("child");
    expect(store.childLoadStatus?.()).toBe("loading");
    for (const event of childText("child", 2, "live answer")) applyEvent(sink, event, "live");
    finish({ events: [created("child"), ...childText("child", 1, "older answer")] } as RunDetail);
    await Promise.resolve();
    expect(store.childLoadStatus?.()).toBe("ready");
    expect(store.nodes.some((node) => node.text === "older answer")).toBe(true);
    expect(store.nodes.some((node) => node.text === "live answer")).toBe(true);
    expect(store.memory?.().child_resident_projections).toBe(1);
    const maintenance = store.releaseReconstructible?.();
    expect(maintenance?.before.child_resident_nodes).toBeGreaterThan(0);
    expect(maintenance?.after.child_resident_projections).toBe(1);
    store.selectSubagent(null);
    expect(store.memory?.().child_resident_nodes).toBe(0);
  } finally {
    dispose();
  }
});

test("persisted live-tail overlap does not repeat incremental child text", async () => {
  let finish!: (detail: RunDetail) => void;
  const { store, dispose } = createRoot((dispose) => ({
    dispose,
    store: createChildTranscriptStore({
      fetchRun: () => new Promise<RunDetail>((resolve) => (finish = resolve)),
    }),
  }));
  try {
    const sink = store.openRun(executionId);
    applyEvent(sink, created("child"), "live");
    store.selectSubagent("child");
    const events: RunEvent[] = [
      { type: "iteration_started", at: 2, agent: "subagent", subagent_id: "child", iteration: 1 },
      {
        type: "text_delta",
        at: 3,
        agent: "subagent",
        subagent_id: "child",
        iteration: 1,
        channel: "text",
        text: "hello",
        reset: false,
      },
      {
        type: "text_delta",
        at: 4,
        agent: "subagent",
        subagent_id: "child",
        iteration: 1,
        channel: "text",
        text: " world",
        reset: false,
      },
    ];
    for (const event of events) applyEvent(sink, event, "live");
    finish({ events: [created("child"), ...events] } as RunDetail);
    await Promise.resolve();
    expect(store.nodes.find((node) => node.kind === "assistant")?.text).toBe("hello world");
  } finally {
    dispose();
  }
});

test("an oversized hidden event breaks the tail rather than retaining a misleading gap", () => {
  createRoot((dispose) => {
    const store = createChildTranscriptStore({ fetchRun: async () => null });
    const sink = store.openRun(executionId);
    applyEvent(sink, created("child"), "live");
    for (const event of childText("child", 1, "small")) applyEvent(sink, event, "live");
    expect(store.memory?.().child_tail_bytes).toBeGreaterThan(0);
    applyEvent(
      sink,
      {
        type: "text_delta",
        at: 20,
        agent: "subagent",
        subagent_id: "child",
        iteration: 1,
        channel: "text",
        text: "x".repeat(20_000),
        reset: true,
      },
      "live",
    );
    expect(store.memory?.().child_tail_bytes).toBe(0);
    expect(store.nodes.some((node) => node.kind === "assistant")).toBe(false);
    dispose();
  });
});

test("many active hidden children share one byte budget", () => {
  createRoot((dispose) => {
    const store = createChildTranscriptStore({ fetchRun: async () => null });
    const sink = store.openRun(executionId);
    for (let child = 0; child < 16; child++) applyEvent(sink, created(`child-${child}`), "live");
    for (let iteration = 1; iteration <= 20; iteration++)
      for (let child = 0; child < 16; child++)
        applyEvent(
          sink,
          {
            type: "text_delta",
            at: iteration * 100 + child,
            agent: "subagent",
            subagent_id: `child-${child}`,
            iteration,
            channel: "text",
            text: "x".repeat(4000),
            reset: true,
          },
          "live",
        );
    expect(store.memory?.().child_tail_bytes).toBeGreaterThan(0);
    expect(store.memory?.().child_tail_bytes).toBeLessThanOrEqual(1024 * 1024);
    sink.complete();
    expect(store.memory?.().child_tail_bytes).toBe(0);
    dispose();
  });
});

test("folding an old turn releases its hidden child cache", () => {
  createRoot((dispose) => {
    const store = createChildTranscriptStore({ fetchRun: async () => null });
    store.appendUserMessage("first", undefined, "exec-first");
    const first = store.openRun("exec-first");
    applyEvent(first, created("old-child"), "live");
    for (const event of childText("old-child", 1, "old detail")) applyEvent(first, event, "live");
    const nextKey = store.appendUserMessage("second", undefined, "exec-second");
    expect(store.memory?.().child_tail_bytes).toBeGreaterThan(0);
    expect(store.foldPrefixBefore(nextKey, "older turn folded")).toBe(true);
    expect(store.memory?.().child_tail_bytes).toBe(0);
    store.selectSubagent("old-child");
    expect(store.childLoadStatus?.()).toBe("idle");
    dispose();
  });
});
