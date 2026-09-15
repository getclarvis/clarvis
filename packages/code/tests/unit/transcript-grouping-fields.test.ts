import { expect, test } from "bun:test";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { createRoot } from "solid-js";
import type { TranscriptStore } from "../../src/adapters/store.ts";
import { createTranscriptProjection } from "../../src/adapters/transcript-projection.ts";

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

function project(nodes: TranscriptNode[]) {
  return createRoot((dispose) => {
    try {
      const projection = createTranscriptProjection(
        { nodes, committedNodes: () => [] } as unknown as TranscriptStore,
        () => null,
      );
      return [...projection.ids()];
    } finally {
      dispose();
    }
  });
}
test("row grouping reads none of the streaming payload fields", () => {
  const seen = new Set<string>();
  project(fixture().map((node) => watched(node, seen)));
  expect([...seen]).toEqual([]);
});
test("the hot-field guard detects a payload read", () => {
  const seen = new Set<string>();
  for (const node of fixture().map((node) => watched(node, seen)))
    if (node.kind === "tool_call") void node.result;
  expect([...seen]).toEqual(["result"]);
});
test("dehydrating content cannot alter row IDs or order", () => {
  expect(
    project(
      fixture().map((node) =>
        node.kind === "tool_call"
          ? {
              ...node,
              result: undefined,
              args: undefined,
              diff: undefined,
              dehydrated: true as const,
            }
          : node,
      ),
    ),
  ).toEqual(project(fixture()));
});
