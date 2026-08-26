import { expect, test } from "bun:test";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { computeGroupedNodes } from "../../src/views/subagent-sections.ts";
import { computeToolGroups } from "../../src/views/tool-groups.ts";
import { computeFocusables } from "../../src/views/block-focus.ts";

/**
 * Fields whose value changes on the streaming hot path — a `text_delta` per
 * token, a tool result or diff on every tool close, a body dropped by the
 * transcript's retention window.
 *
 * The grouping/focus memos are recomputed whenever a signal they read changes,
 * and they each scan the whole transcript. As long as they read none of these,
 * a token arriving is O(1) for them and dehydrating an old block is free. That
 * property is currently accidental — nothing in the code says "do not read
 * `.text` here" — and it is worth more than the scans themselves, so this test
 * says it.
 */
const HOT_FIELDS = ["text", "result", "diff", "args", "liveOutput", "dehydrated"] as const;

function watched(node: TranscriptNode, seen: Set<string>): TranscriptNode {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && (HOT_FIELDS as readonly string[]).includes(prop)) {
        seen.add(prop);
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function fixture(): TranscriptNode[] {
  return [
    { key: "user:0", kind: "user", status: "ok", text: "hello" },
    {
      key: "e1::c1",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "fs",
      toolName: "grep",
      args: { pattern: "x" },
      result: "a result",
      diff: "a diff",
    },
    {
      key: "e1::c2",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "fs",
      toolName: "read",
      result: "another",
      dehydrated: true,
    },
    { key: "e1::i1#msg", kind: "assistant", status: "ok", text: "an answer" },
    { key: "e1::i1#reasoning", kind: "reasoning", status: "ok", text: "thought" },
    {
      key: "e1::subagent:w1",
      kind: "subagent",
      status: "ok",
      text: "",
      title: "explorer",
      subagentOrder: 1,
      subagentId: "w1",
    },
    {
      key: "e1::c3",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "fs",
      toolName: "glob",
      subagentOrder: 1,
      subagentId: "w1",
      result: "sub result",
    },
    { key: "e1::run", kind: "run", status: "ok", text: "" },
  ] as TranscriptNode[];
}

test("computeGroupedNodes reads no field that changes on the streaming hot path", () => {
  const seen = new Set<string>();
  const nodes = fixture().map((n) => watched(n, seen));

  computeGroupedNodes(nodes);

  expect([...seen]).toEqual([]);
});

test("computeToolGroups and computeFocusables read no hot-path field either", () => {
  const seen = new Set<string>();
  const nodes = fixture().map((n) => watched(n, seen));

  const grouped = computeGroupedNodes(nodes);
  const groups = computeToolGroups(grouped.ordered);
  computeFocusables(grouped, groups, new Map());

  expect([...seen]).toEqual([]);
});

test("the guard itself catches a read, so a green run means something", () => {
  const seen = new Set<string>();
  const nodes = fixture().map((n) => watched(n, seen));

  for (const n of nodes) if (n.kind === "tool_call") void n.result;

  expect([...seen]).toEqual(["result"]);
});

test("grouping is unaffected by dehydrating a block", () => {
  const hydrated = fixture();
  const dehydrated = fixture().map((n) =>
    n.kind === "tool_call"
      ? ({ ...n, args: undefined, result: undefined, diff: undefined, dehydrated: true } as
          TranscriptNode | typeof n)
      : n,
  ) as TranscriptNode[];

  const a = computeGroupedNodes(hydrated);
  const b = computeGroupedNodes(dehydrated);

  expect(b.ordered.map((n) => n.key)).toEqual(a.ordered.map((n) => n.key));
  expect([...b.folded]).toEqual([...a.folded]);
  expect([...b.anchors]).toEqual([...a.anchors]);
  expect([...b.headers.keys()]).toEqual([...a.headers.keys()]);
});
