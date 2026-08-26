import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { createTranscriptState, type TranscriptState } from "../../src/views/transcript-state.ts";
import { computeFocusables } from "../../src/views/block-focus.ts";
import {
  WINDOW_MAX_BLOCKS,
  WINDOW_RENDER_BUDGET,
  WINDOW_TEXT_CHARS_BUDGET,
} from "../../src/views/transcript-window.ts";

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

describe("the transcript pager in reactive state", () => {
  test("a long transcript mounts a hard-bounded page", () => {
    const nodes = transcript(500, 6);
    const harness_ = harness(nodes);
    expect(harness_.ts.grouped().ordered.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
    expect(harness_.ts.window().renderCost).toBeLessThanOrEqual(WINDOW_RENDER_BUDGET);
    expect(harness_.ts.window().mountedTextChars).toBeLessThanOrEqual(WINDOW_TEXT_CHARS_BUDGET);
    expect(harness_.ts.window().hiddenBlocks).toBeGreaterThan(0);
    harness_.dispose();
  });

  test("grouping and focus derive only from mounted nodes", () => {
    const harness_ = harness(transcript(200, 4));
    const mounted = new Set(harness_.ts.window().nodes.map((node) => node.key));
    for (const node of harness_.ts.grouped().ordered) expect(mounted.has(node.key)).toBe(true);
    for (const key of computeFocusables(harness_.ts.grouped(), harness_.ts.toolGroups(), new Map()))
      expect(mounted.has(key)).toBe(true);
    for (const [key, info] of harness_.ts.toolGroups()) {
      expect(mounted.has(key)).toBe(true);
      if (info.headKey !== undefined) expect(mounted.has(info.headKey)).toBe(true);
    }
    harness_.dispose();
  });

  test("loadEarlier replaces the page and loadLater retraces it", () => {
    const harness_ = harness(transcript(300, 4));
    const latestFirst = harness_.ts.window().nodes[0]!.key;
    const latestLength = harness_.ts.window().nodes.length;
    expect(harness_.ts.loadEarlier()).toBe(true);
    expect(harness_.ts.window().nodes.at(-1)!.key).not.toBe(latestFirst);
    expect(harness_.ts.window().nodes.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
    expect(harness_.ts.window().laterBlocks).toBeGreaterThan(0);
    expect(harness_.ts.loadLater()).toBe(true);
    expect(harness_.ts.window().nodes[0]!.key).toBe(latestFirst);
    expect(harness_.ts.window().nodes.length).toBe(latestLength);
    expect(harness_.ts.window().atEnd).toBe(true);
    harness_.dispose();
  });

  test("paging reaches both ends without ever growing the mounted page", () => {
    const harness_ = harness(transcript(300, 4));
    let pages = 0;
    while (harness_.ts.loadEarlier()) {
      pages += 1;
      expect(harness_.ts.window().nodes.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
      expect(pages).toBeLessThan(100);
    }
    expect(harness_.ts.window().atStart).toBe(true);
    while (harness_.ts.loadLater()) {
      expect(harness_.ts.window().nodes.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
    }
    expect(harness_.ts.window().atEnd).toBe(true);
    harness_.dispose();
  });

  test("reset returns directly to the bounded latest page", () => {
    const harness_ = harness(transcript(300, 4));
    harness_.ts.loadEarlier();
    expect(harness_.ts.window().laterBlocks).toBeGreaterThan(0);
    harness_.ts.reset();
    expect(harness_.ts.window().atEnd).toBe(true);
    harness_.dispose();
  });

  test("a no-boundary subagent view is bounded too", () => {
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
    expect(state.window().nodes.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
    dispose();
  });

  test("pickDiffNode still reaches outside the mounted page", () => {
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
    expect(harness_.ts.window().nodes.some((node) => node.key === oldest.key)).toBe(false);
    expect(harness_.ts.pickDiffNode()?.key).toBe(oldest.key);
    harness_.dispose();
  });
});
