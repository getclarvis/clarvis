import { expect, test } from "bun:test";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { computeGroupedNodes } from "../../src/views/subagent-sections.ts";
import { computeToolGroups } from "../../src/views/tool-groups.ts";
import {
  computeFocusables,
  isFoldedAway,
  nextFocus,
  toggleOverride,
  type BlockOverride,
} from "../../src/views/block-focus.ts";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

let seq = 0;
const n = (
  o: Partial<LegacyCollapsibleNode> & { kind: TranscriptNode["kind"] },
): LegacyCollapsibleNode => ({
  key: `k${seq++}`,
  status: "ok",
  text: "",
  ...o,
});

test("focusables: tool solos and group heads — members, messages and the plan node excluded", () => {
  const nodes = [
    n({ kind: "user", text: "q" }),
    n({ kind: "assistant", text: "a" }),
    n({ kind: "tool_call", mcpName: "shell", collapsed: true }),
    n({ kind: "tool_call", toolName: "read_file", mcpName: "clarvis", collapsed: true }),
    n({ kind: "tool_call", toolName: "read_file", mcpName: "clarvis", collapsed: true }),
    n({ kind: "plan", tasks: [] }),
  ];
  const g = computeGroupedNodes(nodes);
  const groups = computeToolGroups(g.ordered);
  const keys = computeFocusables(g, groups, new Map());
  expect(keys).toEqual([nodes[2]!.key, nodes[3]!.key]);
});

test("a folded subagent section is ONE target (its card); unfolding exposes its tools", () => {
  const nodes = [
    n({ kind: "reasoning", text: "delegating" }),
    n({ kind: "assistant", text: "answer", subagentOrder: 0, agentLabel: "explorer" }),
    n({ kind: "tool_call", mcpName: "grep", subagentOrder: 0, agentLabel: "explorer" }),
    n({ kind: "subagent", subagentOrder: 0, title: "explorer", status: "ok" }),
  ];
  const g = computeGroupedNodes(nodes);
  const groups = computeToolGroups(g.ordered);
  const anchor = nodes[3]!.key;

  const folded = computeFocusables(g, groups, new Map());
  expect(folded).toEqual([anchor]);
  expect(isFoldedAway(g, nodes[2]!.key, new Map())).toBe(true);

  const open = new Map<string, BlockOverride>([[anchor, "expanded"]]);
  expect(isFoldedAway(g, nodes[2]!.key, open)).toBe(false);
  expect(computeFocusables(g, groups, open)).toContain(nodes[2]!.key);
});

test("the live roster settles a stale running transcript card", () => {
  const card = n({
    kind: "subagent",
    subagentId: "worker-1",
    subagentOrder: 0,
    title: "worker",
    status: "running",
  });
  const grouped = computeGroupedNodes([card], new Map([["worker-1", "ok"]]));
  expect(grouped.headers.get(card.key)?.status).toBe("ok");
});

test("a subagent-only run keeps every worker section folded behind its card", () => {
  const firstCard = n({
    kind: "subagent",
    subagentId: "worker-1",
    subagentOrder: 0,
    title: "researcher",
    status: "running",
  });
  const firstBody = n({
    kind: "assistant",
    subagentId: "worker-1",
    subagentOrder: 0,
    agentLabel: "researcher",
    text: "first result",
  });
  const secondCard = n({
    kind: "subagent",
    subagentId: "worker-2",
    subagentOrder: 1,
    title: "reviewer",
    status: "running",
  });
  const secondBody = n({
    kind: "tool_call",
    subagentId: "worker-2",
    subagentOrder: 1,
    agentLabel: "reviewer",
    mcpName: "grep",
  });

  const grouped = computeGroupedNodes([firstCard, firstBody, secondCard, secondBody]);
  const focusables = computeFocusables(grouped, computeToolGroups(grouped.ordered), new Map());

  expect(grouped.headers.get(firstCard.key)?.hiddenEntries).toBe(1);
  expect(grouped.headers.get(secondCard.key)?.hiddenEntries).toBe(1);
  expect(isFoldedAway(grouped, firstBody.key, new Map())).toBe(true);
  expect(isFoldedAway(grouped, secondBody.key, new Map())).toBe(true);
  expect(focusables).toEqual([firstCard.key, secondCard.key]);
});

test("the live roster settles a cardless section through its body identity", () => {
  const body = n({
    kind: "assistant",
    subagentId: "worker-1",
    subagentOrder: 0,
    agentLabel: "worker",
    status: "running",
    text: "finished result",
  });

  const grouped = computeGroupedNodes([body], new Map([["worker-1", "ok"]]));

  expect(grouped.headers.get(body.key)?.status).toBe("ok");
  expect(grouped.headers.get(body.key)?.hiddenEntries).toBeUndefined();
});

test("toggleOverride: head expands the batch, a mutation collapses, an anchor unfolds/refolds", () => {
  const head = n({ kind: "tool_call", toolName: "glob", mcpName: "c", collapsed: true });
  const member = n({ kind: "tool_call", toolName: "glob", mcpName: "c", collapsed: true });
  const edit = n({ kind: "tool_call", mcpName: "edit_file", collapsed: true });
  const nodes = [head, member, edit];
  const g = computeGroupedNodes(nodes);
  const groups = computeToolGroups(g.ordered);

  const args = { g, groups, expandAll: false, overrides: new Map<string, BlockOverride>() };
  const o1 = toggleOverride({ ...args, key: head.key, node: head });
  expect(o1.get(head.key)).toBe("expanded");
  const o2 = toggleOverride({ ...args, key: edit.key, node: edit });
  expect(o2.get(edit.key)).toBe("collapsed");
  const o3 = toggleOverride({ ...args, key: edit.key, node: edit, overrides: o2 });
  expect(o3.get(edit.key)).toBe("expanded");

  const wLead = n({ kind: "reasoning", text: "delegate" });
  const wBody = n({ kind: "assistant", subagentOrder: 0, agentLabel: "w", text: "done" });
  const wTool = n({ kind: "tool_call", mcpName: "grep", subagentOrder: 0, agentLabel: "w" });
  const wCard = n({ kind: "subagent", subagentOrder: 0, title: "w", status: "ok" });
  const wg = computeGroupedNodes([wLead, wBody, wTool, wCard]);
  const wgroups = computeToolGroups(wg.ordered);
  const s1 = toggleOverride({
    key: wCard.key,
    g: wg,
    groups: wgroups,
    node: wCard,
    expandAll: false,
    overrides: new Map(),
  });
  expect(s1.get(wCard.key)).toBe("expanded");
  const s2 = toggleOverride({
    key: wCard.key,
    g: wg,
    groups: wgroups,
    node: wCard,
    expandAll: false,
    overrides: s1,
  });
  expect(s2.has(wCard.key)).toBe(false);
});

test("nextFocus: starts at the newest target, clamps at the ends, null when empty", () => {
  expect(nextFocus([], null, 1)).toBeNull();
  expect(nextFocus(["a", "b", "c"], null, -1)).toBe("c");
  expect(nextFocus(["a", "b", "c"], null, 1)).toBe("c");
  expect(nextFocus(["a", "b", "c"], "c", -1)).toBe("b");
  expect(nextFocus(["a", "b", "c"], "a", -1)).toBe("a");
  expect(nextFocus(["a", "b", "c"], "c", 1)).toBe("c");
  expect(nextFocus(["a", "b"], "zz", -1)).toBe("b");
});
