import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { createTranscriptState, type TranscriptState } from "../../src/views/transcript-state.ts";
import { computeFocusables } from "../../src/views/block-focus.ts";

function transcript(turns: number, perTurn: number): TranscriptNode[] {
  const nodes: TranscriptNode[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    nodes.push({ key: `user:${turn}`, kind: "user", status: "ok", text: `ask ${turn}` });
    nodes.push({ key: `e${turn}::msg`, kind: "assistant", status: "ok", text: `reply ${turn}` });
    for (let index = 0; index < perTurn; index += 1) {
      nodes.push({
        key: `e${turn}::call-${index}`,
        kind: "tool_call",
        status: "ok",
        text: "",
        mcpName: "fs",
        toolName: "read_file",
        args: { path: `f${index}.ts` },
      });
    }
  }
  return nodes;
}

function harness(nodes: TranscriptNode[]): { ts: TranscriptState; dispose: () => void } {
  let state!: TranscriptState;
  const dispose = createRoot((close) => {
    const [subagents] = createSignal<{ id: string; order: number; title: string }[]>([]);
    state = createTranscriptState({
      nodes: () => nodes,
      subagents,
      notify: () => {},
    });
    return close;
  });
  return { ts: state, dispose };
}

describe("the semantic transcript projection", () => {
  test("retains the complete ordered semantic input for physical windowing", () => {
    const nodes = transcript(500, 6);
    const harness_ = harness(nodes);
    expect(harness_.ts.semanticNodes()).toBe(nodes);
    harness_.dispose();
  });

  test("grouping and focus derive from the same complete semantic order", () => {
    const harness_ = harness(transcript(200, 4));
    const mounted = new Set(harness_.ts.semanticNodes().map((node) => node.key));
    for (const node of harness_.ts.grouped().ordered) expect(mounted.has(node.key)).toBe(true);
    for (const key of computeFocusables(harness_.ts.grouped(), harness_.ts.toolGroups(), new Map()))
      expect(mounted.has(key)).toBe(true);
    for (const [key, info] of harness_.ts.toolGroups()) {
      expect(mounted.has(key)).toBe(true);
      if (info.headKey !== undefined) expect(mounted.has(info.headKey)).toBe(true);
    }
    harness_.dispose();
  });

  test("reset changes view overrides without slicing semantic history", () => {
    const harness_ = harness(transcript(300, 4));
    const nodes = harness_.ts.semanticNodes();
    harness_.ts.toggleAt(nodes[0]!.key);
    harness_.ts.reset();
    expect(harness_.ts.semanticNodes()).toBe(nodes);
    expect(harness_.ts.focusedKey()).toBeNull();
    harness_.dispose();
  });

  test("a no-boundary subagent view remains a semantic filter", () => {
    const nodes = Array.from({ length: 2_000 }, (_, index): TranscriptNode => ({
      key: `sub:${index}`,
      kind: "tool_call",
      status: "ok",
      text: "",
      subagentId: "sub-1",
      mcpName: "fs",
      toolName: "read_file",
    }));
    let state!: TranscriptState;
    const dispose = createRoot((close) => {
      state = createTranscriptState({
        nodes: () => nodes,
        subagents: () => [{ id: "sub-1", order: 0, title: "worker" }],
        notify: () => {},
      });
      state.toggleSubagent("sub-1");
      return close;
    });
    expect(state.semanticNodes()).toHaveLength(2_000);
    expect(state.semanticNodes().every((node) => node.subagentId === "sub-1")).toBe(true);
    dispose();
  });

  test("the main transcript excludes sub-agent work until that transcript is selected", () => {
    const lead: TranscriptNode = {
      key: "run::lead",
      kind: "assistant",
      status: "ok",
      text: "lead answer",
    };
    const child: TranscriptNode[] = [
      {
        key: "run::child-answer",
        kind: "assistant",
        status: "ok",
        text: "private worker answer",
        subagentId: "sub-1",
        subagentOrder: 0,
      },
      {
        key: "run::child-tool",
        kind: "tool_call",
        status: "ok",
        text: "",
        subagentId: "sub-1",
        subagentOrder: 0,
        mcpName: "fs",
        toolName: "read_file",
        args: { path: "child.ts" },
      },
    ];
    const lifecycle: TranscriptNode[] = [
      {
        key: "run::delegation:sub-1:spawned",
        kind: "annotation",
        status: "ok",
        tone: "info",
        text: "Worker spawned",
      },
      {
        key: "run::delegation:sub-1:completed",
        kind: "annotation",
        status: "ok",
        tone: "info",
        text: "Worker completed",
      },
    ];
    let state!: TranscriptState;
    const dispose = createRoot((close) => {
      state = createTranscriptState({
        nodes: () => [lead, lifecycle[0]!, ...child, lifecycle[1]!],
        subagents: () => [{ id: "sub-1", order: 0, title: "worker" }],
        notify: () => {},
      });
      return close;
    });

    expect(state.semanticNodes()).toEqual([lead, ...lifecycle]);
    state.toggleSubagent("sub-1");
    expect(state.semanticNodes()).toEqual(child);
    state.toggleSubagent("sub-1");
    expect(state.semanticNodes()).toEqual([lead, ...lifecycle]);
    dispose();
  });

  test("pickDiffNode searches the semantic/detail source independently of residency", () => {
    const nodes = transcript(300, 2);
    const oldest: TranscriptNode = {
      key: "e0::edit",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "fs",
      toolName: "edit_file",
      args: { path: "old.ts" },
    };
    nodes.splice(2, 0, oldest);
    const harness_ = harness(nodes);
    expect(harness_.ts.semanticNodes().some((node) => node.key === oldest.key)).toBe(true);
    expect(harness_.ts.pickDiffNode()?.key).toBe(oldest.key);
    harness_.dispose();
  });
});
