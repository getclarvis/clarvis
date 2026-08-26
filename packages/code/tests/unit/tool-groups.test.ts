import { expect, test } from "bun:test";
import type { NodeStatus, TranscriptNode } from "../../src/adapters/store.ts";
import {
  aggregateStatus,
  computeToolGroups,
  failureCount,
  MIN_GROUP,
} from "../../src/views/tool-groups.ts";

let seq = 0;
function tool(toolName: string, status: NodeStatus = "ok", mcpName = "clarvis"): TranscriptNode {
  return {
    key: `t${seq++}`,
    kind: "tool_call",
    status,
    text: "",
    mcpName,
    toolName,
  };
}
function msg(kind: TranscriptNode["kind"] = "assistant"): TranscriptNode {
  return { key: `m${seq++}`, kind, status: "ok", text: "hi" };
}
function roles(nodes: TranscriptNode[]): string[] {
  const info = computeToolGroups(nodes);
  return nodes.map((n) => info.get(n.key)!.role);
}

test("a run of identical tool calls folds into head + members", () => {
  const nodes = [tool("glob"), tool("glob"), tool("glob")];
  expect(roles(nodes)).toEqual(["head", "member", "member"]);
  const head = computeToolGroups(nodes).get(nodes[0]!.key)!;
  expect(head.size).toBe(3);
  expect(head.members).toHaveLength(3);
});

test("a model message between identical calls breaks the run — no message in the middle", () => {
  const nodes = [tool("glob"), tool("glob"), msg("assistant"), tool("glob"), tool("glob")];
  expect(roles(nodes)).toEqual(["head", "member", "solo", "head", "member"]);
});

test("reasoning also breaks a run (any non-tool node does)", () => {
  const nodes = [tool("glob"), msg("reasoning"), tool("glob")];
  expect(roles(nodes)).toEqual(["solo", "solo", "solo"]);
});

test("different tools stay separate even when adjacent", () => {
  const nodes = [tool("list_dir"), tool("glob"), tool("glob"), tool("read_file")];
  expect(roles(nodes)).toEqual(["solo", "head", "member", "solo"]);
});

test("same tool name from different mcp servers does not merge", () => {
  const nodes = [tool("run", "ok", "alpha"), tool("run", "ok", "beta")];
  expect(roles(nodes)).toEqual(["solo", "solo"]);
});

test("same tool from different source agents does not merge (subagent A vs subagent B)", () => {
  const a = { ...tool("grep"), subagentOrder: 0 };
  const b = { ...tool("grep"), subagentOrder: 1 };
  expect(roles([a, b])).toEqual(["solo", "solo"]);
  const c = { ...tool("grep"), subagentOrder: 0 };
  const d = { ...tool("grep"), subagentOrder: 0 };
  expect(roles([c, d])).toEqual(["head", "member"]);
});

test("a lone call is a solo, and MIN_GROUP is the fold threshold", () => {
  expect(roles([tool("glob")])).toEqual(["solo"]);
  expect(MIN_GROUP).toBe(2);
});

test("mutations never fold into a group — their diff/write is the point of the turn", () => {
  expect(roles([tool("edit_file"), tool("edit_file")])).toEqual(["solo", "solo"]);
  expect(roles([tool("write_file"), tool("write_file"), tool("write_file")])).toEqual([
    "solo",
    "solo",
    "solo",
  ]);
  const builtin = { ...tool("", "ok", "edit_file"), toolName: "" };
  const builtin2 = { ...tool("", "ok", "edit_file"), toolName: "" };
  expect(roles([builtin, builtin2])).toEqual(["solo", "solo"]);
  expect(roles([tool("read_file"), tool("read_file"), tool("edit_file")])).toEqual([
    "head",
    "member",
    "solo",
  ]);
});

test("memory writes are mutations too — a wiki rewrite never folds like a read run", () => {
  expect(roles([tool("write_memory"), tool("write_memory")])).toEqual(["solo", "solo"]);
  expect(roles([tool("read_memory"), tool("read_memory"), tool("edit_memory")])).toEqual([
    "head",
    "member",
    "solo",
  ]);
});

test("aggregate status is the worst member state; failures are tallied", () => {
  const running = [tool("glob", "ok"), tool("glob", "running"), tool("glob", "error")];
  expect(aggregateStatus(running)).toBe("running");
  const failed = [tool("glob", "ok"), tool("glob", "error"), tool("glob", "error")];
  expect(aggregateStatus(failed)).toBe("error");
  expect(failureCount(failed)).toBe(2);
  expect(aggregateStatus([tool("glob", "ok"), tool("glob", "ok")])).toBe("ok");
});
