import { expect, test } from "bun:test";
import { selectTailOwnedKeys } from "../../src/views/history/tail-ownership.ts";
import { selectLiveFrontierNodes } from "../../src/views/live/tail-ownership.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";

test("frontier keys are always tail-owned", () => {
  expect(selectTailOwnedKeys(new Set(), ["user:0"], ["exec::tool"])).toEqual(["exec::tool"]);
});

test("a previously presented committed suffix stays owned after settle", () => {
  expect(selectTailOwnedKeys(new Set(["exec::tool"]), ["exec::tool"], [])).toEqual(["exec::tool"]);
});

test("a newer history-only key breaks the suffix and releases earlier tools", () => {
  expect(selectTailOwnedKeys(new Set(["exec::tool"]), ["exec::tool", "user:1"], [])).toEqual([]);
});

test("two presented tools plus a live sibling stay a suffix", () => {
  expect(
    selectTailOwnedKeys(new Set(["exec::a", "exec::b"]), ["exec::a", "exec::b"], ["exec::c"]),
  ).toEqual(["exec::a", "exec::b", "exec::c"]);
});

test("keys that left the mounted slice are not owned when not following", () => {
  expect(
    selectTailOwnedKeys(
      new Set(["exec::old", "exec::new"]),
      ["exec::new"],
      [],
      ["exec::old", "exec::new"],
      false,
    ),
  ).toEqual(["exec::new"]);
});

test("a just-committed key is held while following even before the slice admits it", () => {
  expect(
    selectTailOwnedKeys(
      new Set(["exec::tool"]),
      ["exec::other"],
      [],
      ["exec::other", "exec::tool"],
      true,
    ),
  ).toEqual(["exec::tool"]);
});

test("an empty mounted slice does not hold earlier committed keys", () => {
  expect(selectTailOwnedKeys(new Set(["exec::tool"]), [], [], ["exec::tool"], true)).toEqual([]);
});

test("lead frontier omits plans, thinking, and child nodes", () => {
  const nodes: TranscriptNode[] = [
    { key: "p", kind: "plan", status: "running", text: "" },
    { key: "t", kind: "thinking", status: "running", text: "" },
    {
      key: "child",
      kind: "tool_call",
      status: "running",
      text: "",
      toolName: "read_file",
      subagentId: "w1",
    },
    { key: "lead", kind: "tool_call", status: "running", text: "", toolName: "read_file" },
  ];
  expect(selectLiveFrontierNodes(nodes, null).map((node) => node.key)).toEqual(["lead"]);
  expect(selectLiveFrontierNodes(nodes, "w1").map((node) => node.key)).toEqual(["child"]);
});
