import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { createTranscriptState, type TranscriptState } from "../../src/views/transcript-state.ts";

function node(partial: Partial<TranscriptNode> & { key: string }): TranscriptNode {
  return { kind: "tool_call", status: "ok", text: "", ...partial };
}

type SubagentDep = { id: string; order: number; title: string };

function harness(
  nodes: TranscriptNode[],
  subagents: SubagentDep[] = [],
): {
  ts: TranscriptState;
  toasts: string[];
  dispose: () => void;
  setNodes: (nodes: TranscriptNode[]) => void;
  setSubagents: (s: SubagentDep[]) => void;
} {
  const toasts: string[] = [];
  let ts!: TranscriptState;
  let setSubs!: (s: SubagentDep[]) => void;
  let setNodes!: (nodes: TranscriptNode[]) => void;
  const dispose = createRoot((d) => {
    const [subs, setSubsSignal] = createSignal(subagents);
    const [currentNodes, setNodesSignal] = createSignal(nodes);
    setSubs = setSubsSignal;
    setNodes = (next) => setNodesSignal(next);
    ts = createTranscriptState({
      nodes: currentNodes,
      subagents: () => subs(),
      notify: (m) => toasts.push(m),
    });
    return d;
  });
  return { ts, toasts, dispose, setNodes, setSubagents: setSubs };
}

test("cycleSubagent: none → each subagent ascending → back to all", () => {
  const h = harness(
    [],
    [
      { id: "fixer-id", order: 1, title: "Fixer" },
      { id: "scout-id", order: 0, title: "Scout" },
    ],
  );
  h.ts.cycleSubagent();
  expect(h.ts.selectedSubagent()).toBe("scout-id");
  expect(h.toasts.at(-1)).toBe("focused sub-agent: Scout");
  h.ts.cycleSubagent();
  expect(h.ts.selectedSubagent()).toBe("fixer-id");
  expect(h.toasts.at(-1)).toBe("focused sub-agent: Fixer");
  h.ts.cycleSubagent();
  expect(h.ts.selectedSubagent()).toBeNull();
  expect(h.toasts.at(-1)).toBe("showing Lead transcript");
  h.dispose();
});

test("cycleSubagent: empty roster clears the selection and says so", () => {
  const h = harness([]);
  h.ts.cycleSubagent();
  expect(h.ts.selectedSubagent()).toBeNull();
  expect(h.toasts).toEqual(["no sub-agents to focus"]);
  h.dispose();
});

test("a selected subagent isolates its blocks and cycling back restores only Lead", () => {
  const nodes = [
    node({ key: "r::u", kind: "user", text: "q" }),
    node({ key: "r::lead", kind: "assistant" }),
    node({
      key: "r::w0",
      mcpName: "fs",
      toolName: "grep",
      subagentOrder: 0,
      subagentId: "scout-id",
    }),
    node({ key: "r::w1", kind: "assistant", subagentOrder: 1, subagentId: "fixer-id" }),
  ];
  const h = harness(nodes, [
    { id: "scout-id", order: 0, title: "Scout" },
    { id: "fixer-id", order: 1, title: "Fixer" },
  ]);
  h.ts.cycleSubagent();
  expect(h.ts.grouped().ordered.map((n) => n.key)).toEqual(["r::w0"]);
  h.ts.cycleSubagent();
  h.ts.cycleSubagent();
  expect(h.ts.grouped().ordered.map((n) => n.key)).toEqual(["r::u", "r::lead"]);
  h.dispose();
});

test("two different runs' subagents at the same order never collide", () => {
  const nodes = [
    node({
      key: "run1::w0",
      mcpName: "fs",
      toolName: "grep",
      subagentOrder: 0,
      subagentId: "id-a",
    }),
    node({
      key: "run2::w0",
      mcpName: "fs",
      toolName: "grep",
      subagentOrder: 0,
      subagentId: "id-b",
    }),
  ];
  const h = harness(nodes, [{ id: "id-a", order: 0, title: "Scout" }]);
  h.ts.toggleSubagent("id-a");
  expect(h.ts.grouped().ordered.map((n) => n.key)).toEqual(["run1::w0"]);
  h.dispose();
});

test("toggleSubagent: selects, re-toggling the same clears, toggling another switches directly", () => {
  const nodes = [
    node({
      key: "r::w0",
      mcpName: "fs",
      toolName: "grep",
      subagentOrder: 0,
      subagentId: "scout-id",
    }),
    node({ key: "r::w1", kind: "assistant", subagentOrder: 1, subagentId: "fixer-id" }),
  ];
  const h = harness(nodes, [
    { id: "scout-id", order: 0, title: "Scout" },
    { id: "fixer-id", order: 1, title: "Fixer" },
  ]);
  h.ts.toggleSubagent("scout-id");
  expect(h.ts.selectedSubagent()).toBe("scout-id");
  expect(h.ts.grouped().ordered.map((n) => n.key)).toEqual(["r::w0"]);
  h.ts.toggleSubagent("scout-id");
  expect(h.ts.selectedSubagent()).toBeNull();
  expect(h.toasts.at(-1)).toBe("showing Lead transcript");
  h.ts.toggleSubagent("fixer-id");
  expect(h.ts.selectedSubagent()).toBe("fixer-id");
  expect(h.ts.grouped().ordered.map((n) => n.key)).toEqual(["r::w1"]);
  h.dispose();
});

test("cycleSubagent continues from a click-made selection", () => {
  const h = harness(
    [],
    [
      { id: "scout-id", order: 0, title: "Scout" },
      { id: "fixer-id", order: 1, title: "Fixer" },
    ],
  );
  h.ts.toggleSubagent("scout-id");
  h.ts.cycleSubagent();
  expect(h.ts.selectedSubagent()).toBe("fixer-id");
  h.dispose();
});

test("a selection is cleared automatically if its subagent disappears from the roster", () => {
  const h = harness([], [{ id: "scout-id", order: 0, title: "Scout" }]);
  h.ts.toggleSubagent("scout-id");
  expect(h.ts.selectedSubagent()).toBe("scout-id");
  h.setSubagents([]);
  expect(h.ts.selectedSubagent()).toBeNull();
  h.dispose();
});

test("selecting a subagent clears a focused key that's no longer visible", () => {
  const nodes = [
    node({ key: "r::t1", mcpName: "fs", toolName: "grep" }),
    node({
      key: "r::w0",
      mcpName: "fs",
      toolName: "grep",
      subagentOrder: 0,
      subagentId: "scout-id",
    }),
  ];
  const h = harness(nodes, [{ id: "scout-id", order: 0, title: "Scout" }]);
  h.ts.toggleAt("r::t1");
  expect(h.ts.focusedKey()).toBe("r::t1");
  h.ts.toggleSubagent("scout-id");
  expect(h.ts.focusedKey()).toBeNull();
  h.dispose();
});

test("a first child selection expands its section without changing Lead fold state", () => {
  const lead = node({ key: "run::lead-tool", mcpName: "fs", toolName: "grep" });
  const card = node({
    key: "run::child-card",
    kind: "subagent",
    title: "Scout",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const body = node({
    key: "run::child-body",
    kind: "assistant",
    text: "child result",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const h = harness([lead, card, body], [{ id: "scout-id", order: 0, title: "Scout" }]);
  h.ts.toggleAt(lead.key);
  expect(h.ts.overrideOf(lead.key)).toBe("collapsed");

  h.ts.toggleSubagent("scout-id");

  expect(h.ts.overrideOf(card.key)).toBe("expanded");
  expect(h.ts.folded(body.key)).toBe(false);
  expect(h.ts.overrideOf(lead.key)).toBe("collapsed");
  expect(h.ts.expandAll()).toBe(false);
  h.dispose();
});

test("a child selected before its body arrives expands when the section becomes foldable", () => {
  const card = node({
    key: "run::child-card",
    kind: "subagent",
    title: "Scout",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const body = node({
    key: "run::child-body",
    kind: "assistant",
    text: "late child result",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const h = harness([card], [{ id: "scout-id", order: 0, title: "Scout" }]);
  h.ts.toggleSubagent("scout-id");
  expect(h.ts.overrideOf(card.key)).toBeUndefined();

  h.setNodes([card, body]);

  expect(h.ts.overrideOf(card.key)).toBe("expanded");
  expect(h.ts.folded(body.key)).toBe(false);
  h.dispose();
});

test("manual child collapse survives Lead and child reselection while siblings expand independently", () => {
  const scoutCard = node({
    key: "run::scout-card",
    kind: "subagent",
    title: "Scout",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const scoutBody = node({
    key: "run::scout-body",
    kind: "assistant",
    text: "scout result",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const fixerCard = node({
    key: "run::fixer-card",
    kind: "subagent",
    title: "Fixer",
    subagentId: "fixer-id",
    subagentOrder: 1,
  });
  const fixerBody = node({
    key: "run::fixer-body",
    kind: "assistant",
    text: "fixer result",
    subagentId: "fixer-id",
    subagentOrder: 1,
  });
  const h = harness(
    [scoutCard, scoutBody, fixerCard, fixerBody],
    [
      { id: "scout-id", order: 0, title: "Scout" },
      { id: "fixer-id", order: 1, title: "Fixer" },
    ],
  );

  h.ts.toggleSubagent("scout-id");
  expect(h.ts.overrideOf(scoutCard.key)).toBe("expanded");
  h.ts.toggleAt(scoutCard.key);
  expect(h.ts.overrideOf(scoutCard.key)).toBeUndefined();
  expect(h.ts.folded(scoutBody.key)).toBe(true);

  h.ts.toggleSubagent("scout-id");
  h.ts.toggleSubagent("scout-id");
  expect(h.ts.overrideOf(scoutCard.key)).toBeUndefined();
  expect(h.ts.folded(scoutBody.key)).toBe(true);

  h.ts.toggleSubagent("fixer-id");
  expect(h.ts.overrideOf(fixerCard.key)).toBe("expanded");
  expect(h.ts.folded(fixerBody.key)).toBe(false);
  expect(h.ts.overrideOf(scoutCard.key)).toBeUndefined();
  h.dispose();
});

test("first-selection anchors are pruned with semantic retention", () => {
  const card = node({
    key: "run::child-card",
    kind: "subagent",
    title: "Scout",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const body = node({
    key: "run::child-body",
    kind: "assistant",
    text: "child result",
    subagentId: "scout-id",
    subagentOrder: 0,
  });
  const h = harness([card, body], [{ id: "scout-id", order: 0, title: "Scout" }]);
  h.ts.toggleSubagent("scout-id");
  h.ts.toggleAt(card.key);
  expect(h.ts.overrideOf(card.key)).toBeUndefined();

  h.setNodes([]);
  h.setNodes([card, body]);

  expect(h.ts.overrideOf(card.key)).toBe("expanded");
  expect(h.ts.folded(body.key)).toBe(false);
  h.dispose();
});

test("toggleExpandOrBlock without focus flips expand-all; the second flip clears the toast", () => {
  const h = harness([]);
  h.ts.toggleExpandOrBlock();
  expect(h.ts.expandAll()).toBe(true);
  expect(h.toasts.at(-1)).toBe("blocks expanded");
  h.ts.toggleExpandOrBlock();
  expect(h.ts.expandAll()).toBe(false);
  expect(h.toasts.at(-1)).toBe("");
  h.dispose();
});

test("toggleExpandOrBlock with a focused block overrides that block only", () => {
  const nodes = [
    node({ key: "r::t1", mcpName: "fs", toolName: "grep" }),
    node({ key: "r::t2", mcpName: "fs", toolName: "read_file" }),
  ];
  const h = harness(nodes);
  expect(h.ts.focusBlock(-1)).toBe("r::t2");
  h.ts.toggleExpandOrBlock();
  expect(h.ts.expandAll()).toBe(false);
  expect(h.ts.overrideOf("r::t2")).toBe("collapsed");
  expect(h.ts.overrideOf("r::t1")).toBeUndefined();
  h.dispose();
});

test("focusBlock clamps at the ends; clearFocus reports whether there was one", () => {
  const nodes = [
    node({ key: "r::t1", mcpName: "fs", toolName: "grep" }),
    node({ key: "r::t2", mcpName: "fs", toolName: "read_file" }),
  ];
  const h = harness(nodes);
  expect(h.ts.clearFocus()).toBe(false);
  h.ts.focusBlock(-1);
  h.ts.focusBlock(-1);
  expect(h.ts.focusedKey()).toBe("r::t1");
  h.ts.focusBlock(-1);
  expect(h.ts.focusedKey()).toBe("r::t1");
  expect(h.ts.clearFocus()).toBe(true);
  expect(h.ts.focusedKey()).toBeNull();
  h.dispose();
});

test("focusBlock with nothing focusable notifies and returns null", () => {
  const h = harness([node({ key: "r::u", kind: "user" })]);
  expect(h.ts.focusBlock(1)).toBeNull();
  expect(h.toasts).toEqual(["nothing to focus"]);
  h.dispose();
});

test("toggleAt focuses the block and toggles it; reset clears focus and overrides", () => {
  const nodes = [node({ key: "r::t1", mcpName: "fs", toolName: "grep" })];
  const h = harness(nodes);
  h.ts.toggleAt("r::t1");
  expect(h.ts.focusedKey()).toBe("r::t1");
  expect(h.ts.overrideOf("r::t1")).toBe("collapsed");
  h.ts.reset();
  expect(h.ts.focusedKey()).toBeNull();
  expect(h.ts.overrideOf("r::t1")).toBeUndefined();
  h.dispose();
});

test("fold overrides are pruned as semantic retention evicts their keys", () => {
  const first = node({ key: "turn-0::tool", mcpName: "fs", toolName: "grep" });
  const h = harness([first]);
  h.ts.toggleAt(first.key);

  for (let turn = 1; turn <= 100; turn += 1) {
    const previousKey = `turn-${turn - 1}::tool`;
    const current = node({
      key: `turn-${turn}::tool`,
      mcpName: "fs",
      toolName: "grep",
    });
    h.setNodes([current]);
    expect(h.ts.overrideOf(previousKey)).toBeUndefined();
    h.ts.toggleAt(current.key);
    expect(h.ts.overrideOf(current.key)).toBe("collapsed");
  }

  for (let turn = 0; turn < 100; turn += 1)
    expect(h.ts.overrideOf(`turn-${turn}::tool`)).toBeUndefined();
  expect(h.ts.overrideOf("turn-100::tool")).toBe("collapsed");
  h.dispose();
});

test("pickDiffNode: newest diff-producing call by default, including builtin mutations", () => {
  const nodes = [
    node({ key: "a::1", mcpName: "write_file" }),
    node({ key: "a::2", mcpName: "edit_file" }),
    node({ key: "a::3", mcpName: "fs", toolName: "grep" }),
  ];
  const h = harness(nodes);
  expect(h.ts.pickDiffNode()?.key).toBe("a::2");
  h.dispose();
});

test("pickDiffNode never crosses between Lead and a selected sub-agent transcript", () => {
  const nodes = [
    node({ key: "a::lead-edit", toolName: "edit_file" }),
    node({
      key: "a::child-edit",
      toolName: "write_file",
      subagentId: "worker",
      subagentOrder: 0,
    }),
  ];
  const h = harness(nodes, [{ id: "worker", order: 0, title: "Worker" }]);
  expect(h.ts.pickDiffNode()?.key).toBe("a::lead-edit");
  h.ts.toggleSubagent("worker");
  expect(h.ts.pickDiffNode()?.key).toBe("a::child-edit");
  h.dispose();
});

test("pickDiffNode: a focused diff call wins; a focused non-diff falls back to the newest", () => {
  const nodes = [
    node({ key: "a::1", mcpName: "write_file" }),
    node({ key: "a::2", mcpName: "edit_file" }),
    node({ key: "a::3", mcpName: "fs", toolName: "grep" }),
  ];
  const h = harness(nodes);
  h.ts.toggleAt("a::1");
  expect(h.ts.pickDiffNode()?.key).toBe("a::1");
  h.ts.toggleAt("a::3");
  expect(h.ts.pickDiffNode()?.key).toBe("a::2");
  h.dispose();
});

test("pickDiffNode: null when the transcript has no diff-producing call", () => {
  const h = harness([node({ key: "a::1", mcpName: "fs", toolName: "grep" })]);
  expect(h.ts.pickDiffNode()).toBeNull();
  h.dispose();
});

function diffHarness(nodes: TranscriptNode[]): {
  ts: TranscriptState;
  asked: string[];
  dispose: () => void;
} {
  const asked: string[] = [];
  let ts!: TranscriptState;
  const dispose = createRoot((d) => {
    ts = createTranscriptState({
      nodes: () => nodes,
      subagents: () => [],
      notify: () => {},
      rehydrate: (key) => asked.push(key),
    });
    return d;
  });
  return { ts, asked, dispose };
}

test("pickDiffNode asks for a refill when the selected diff block was dehydrated", () => {
  const h = diffHarness([
    node({ key: "e1::c1", toolName: "write_file", diff: "old diff" }),
    node({ key: "e1::c2", toolName: "apply_patch", dehydrated: true }),
  ]);
  try {
    const picked = h.ts.pickDiffNode();
    expect(picked?.key).toBe("e1::c2");
    expect(h.asked).toEqual(["e1::c2"]);
  } finally {
    h.dispose();
  }
});

test("pickDiffNode asks for nothing when the selected diff block still has its body", () => {
  const h = diffHarness([node({ key: "e1::c1", toolName: "write_file", diff: "a diff" })]);
  try {
    expect(h.ts.pickDiffNode()?.key).toBe("e1::c1");
    expect(h.asked).toEqual([]);
  } finally {
    h.dispose();
  }
});
