import { describe, expect, test } from "bun:test";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import {
  earlierLabel,
  createTranscriptTurnIndex,
  laterLabel,
  transcriptNodeMountedTextChars,
  transcriptNodeRenderCost,
  windowTranscriptIndexed,
  WINDOW_MAX_BLOCKS,
  WINDOW_MIN_BLOCKS,
  WINDOW_RENDER_BUDGET,
  WINDOW_TEXT_CHARS_BUDGET,
  type TranscriptWindow,
} from "../../src/views/transcript-window.ts";

const user = (turn: number): TranscriptNode => ({
  key: `user:${turn}`,
  kind: "user",
  status: "ok",
  text: `turn ${turn}`,
});

const tool = (turn: number, index: number): TranscriptNode => ({
  key: `exec${turn}::call-${index}`,
  kind: "tool_call",
  status: "ok",
  text: "",
  mcpName: "fs",
  toolName: "read_file",
});

function transcript(turns: number, perTurn: number): TranscriptNode[] {
  const nodes: TranscriptNode[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    nodes.push(user(turn));
    for (let index = 0; index < perTurn; index += 1) nodes.push(tool(turn, index));
  }
  return nodes;
}

describe("transcript page selection", () => {
  test("a short transcript remains the same array", () => {
    const nodes = transcript(3, 2);
    const window = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());
    expect(window.nodes).toBe(nodes);
    expect(window.atStart).toBe(true);
    expect(window.atEnd).toBe(true);
  });

  test("the latest page obeys both hard ceilings", () => {
    const nodes = transcript(500, 4);
    const window = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());
    expect(window.nodes.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
    expect(window.renderCost).toBeLessThanOrEqual(WINDOW_RENDER_BUDGET);
    expect(window.mountedTextChars).toBeLessThanOrEqual(WINDOW_TEXT_CHARS_BUDGET);
    expect(window.nodes.length).toBeGreaterThanOrEqual(WINDOW_MIN_BLOCKS);
    expect(window.hiddenBlocks + window.nodes.length).toBe(nodes.length);
    expect(window.atEnd).toBe(true);
  });

  test("ordinary pages prefer a turn boundary", () => {
    for (const perTurn of [0, 1, 3, 7]) {
      const window = windowTranscriptIndexed(
        transcript(100, perTurn),
        null,
        createTranscriptTurnIndex(),
      );
      expect(window.nodes[0]!.key.startsWith("user:")).toBe(true);
    }
  });

  test("one pathological turn cannot defeat the ceiling", () => {
    const nodes = [user(0), ...Array.from({ length: 2_000 }, (_, index) => tool(0, index))];
    const window = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());
    expect(window.nodes.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
    expect(window.renderCost).toBeLessThanOrEqual(WINDOW_RENDER_BUDGET);
    expect(window.atStart).toBe(false);
  });

  test("one oversized node is presentation-clamped and cannot defeat the text ceiling", () => {
    const nodes = Array.from({ length: 20 }, (_, index): TranscriptNode => ({
      key: `assistant:${String(index)}`,
      kind: "assistant",
      status: "ok",
      text: "x".repeat(2 * 1024 * 1024),
    }));

    const window = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());

    expect(window.nodes).toHaveLength(1);
    expect(window.mountedTextChars).toBe(WINDOW_TEXT_CHARS_BUDGET);
    expect(transcriptNodeMountedTextChars(window.nodes[0]!)).toBe(WINDOW_TEXT_CHARS_BUDGET);
  });

  test("every textual semantic kind pays proportional render and character cost", () => {
    const text = "x".repeat(100_000);
    const kinds = [
      "user",
      "assistant",
      "reasoning",
      "subagent",
      "plan",
      "annotation",
      "error",
      "run",
    ] as const;
    const nodes = kinds.map(
      (kind, index) => ({ key: `${kind}:${index}`, kind, status: "ok", text }) as TranscriptNode,
    );

    for (const node of nodes) expect(transcriptNodeRenderCost(node)).toBeGreaterThan(20);
    const window = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());
    expect(window.nodes.length).toBeLessThan(nodes.length);
    expect(window.mountedTextChars).toBe(
      window.nodes.reduce((total, node) => total + transcriptNodeMountedTextChars(node), 0),
    );
    expect(window.mountedTextChars).toBeLessThanOrEqual(WINDOW_TEXT_CHARS_BUDGET);
  });

  test("a page with no user boundaries is still bounded", () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) => tool(0, index));
    const window = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());
    expect(window.nodes.length).toBeLessThan(nodes.length);
    expect(window.nodes.length).toBeLessThanOrEqual(WINDOW_MAX_BLOCKS);
    expect(window.hiddenTurns).toBe(0);
  });

  test("an explicit page end exposes newer and older history", () => {
    const nodes = transcript(200, 4);
    const latest = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());
    const older = windowTranscriptIndexed(nodes, latest.start, createTranscriptTurnIndex());
    expect(older.end).toBe(latest.start);
    expect(older.laterBlocks).toBe(nodes.length - older.end);
    expect(older.laterTurns).toBeGreaterThan(0);
    expect(older.nodes.at(-1)).toBe(nodes[older.end - 1]);
  });

  test("turn and block accounting closes on both sides", () => {
    const nodes = transcript(200, 4);
    const latest = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex());
    const window = windowTranscriptIndexed(nodes, latest.start, createTranscriptTurnIndex());
    expect(window.hiddenBlocks + window.nodes.length + window.laterBlocks).toBe(nodes.length);
    const shownTurns = window.nodes.filter((node) => node.key.startsWith("user:")).length;
    expect(window.hiddenTurns + shownTurns + window.laterTurns).toBe(200);
  });

  test("empty input is a complete empty page", () => {
    const window = windowTranscriptIndexed([], null, createTranscriptTurnIndex());
    expect(window.nodes).toEqual([]);
    expect(window.atStart).toBe(true);
    expect(window.atEnd).toBe(true);
  });

  test("limits are configurable and the reported cost is exact", () => {
    const nodes = transcript(100, 4);
    const window = windowTranscriptIndexed(nodes, null, createTranscriptTurnIndex(), 5, 20, 80);
    expect(window.nodes.length).toBeLessThanOrEqual(20);
    expect(window.renderCost).toBe(
      window.nodes.reduce((total, node) => total + transcriptNodeRenderCost(node), 0),
    );
    expect(window.renderCost).toBeLessThanOrEqual(80);
  });

  test("the production turn index scans only an appended suffix after its first page", () => {
    let keyReads = 0;
    const observed = (node: TranscriptNode): TranscriptNode =>
      new Proxy(node, {
        get(target, property, receiver) {
          if (property === "key") keyReads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    const nodes = transcript(2_000, 2).map(observed);
    const index = createTranscriptTurnIndex();

    windowTranscriptIndexed(nodes, null, index);
    keyReads = 0;
    nodes.push(observed(user(2_000)), observed(tool(2_000, 0)));
    const next = windowTranscriptIndexed(nodes, null, index);

    expect(next.hiddenTurns).toBeGreaterThan(1_900);
    // Selection visits one bounded page; accounting checks the former tail and
    // the two appended nodes instead of rereading all 6,000 existing keys.
    expect(keyReads).toBeLessThan(WINDOW_MAX_BLOCKS + 10);
  });

  test("the production turn index rebuilds after replacing its source", () => {
    const index = createTranscriptTurnIndex();
    const first = windowTranscriptIndexed(transcript(200, 2), null, index);
    expect(first.hiddenTurns).toBeGreaterThan(0);

    const replacement = transcript(5, 0);
    const next = windowTranscriptIndexed(replacement, null, index);
    expect(next.hiddenTurns).toBe(0);
    expect(next.nodes).toBe(replacement);
  });

  test("an indexed older page keeps its node identity and scroll anchor across appends", () => {
    const nodes = transcript(500, 2);
    const index = createTranscriptTurnIndex();
    const latest = windowTranscriptIndexed(nodes, null, index);
    const older = windowTranscriptIndexed(nodes, latest.start, index);
    const mounted = [...older.nodes];

    nodes.push(user(500), tool(500, 0));
    const afterAppend = windowTranscriptIndexed(nodes, older.end, index);

    expect(afterAppend.end).toBe(older.end);
    expect(afterAppend.laterTurns).toBe(older.laterTurns + 1);
    expect(afterAppend.nodes.every((node, at) => node === mounted[at])).toBe(true);
  });
});

describe("page labels", () => {
  const window = (over: Partial<TranscriptWindow>): TranscriptWindow => ({
    nodes: [],
    hiddenTurns: 0,
    hiddenBlocks: 0,
    laterTurns: 0,
    laterBlocks: 0,
    atStart: false,
    atEnd: false,
    start: 0,
    end: 0,
    renderCost: 0,
    mountedTextChars: 0,
    ...over,
  });

  test("uses turns when available and blocks for a split giant turn", () => {
    expect(earlierLabel(window({ hiddenTurns: 2, hiddenBlocks: 20 }))).toBe("2 earlier turns");
    expect(earlierLabel(window({ hiddenBlocks: 1 }))).toBe("1 earlier block");
    expect(laterLabel(window({ laterTurns: 1, laterBlocks: 20 }))).toBe("1 later turn");
    expect(laterLabel(window({ laterBlocks: 3 }))).toBe("3 later blocks");
  });
});
