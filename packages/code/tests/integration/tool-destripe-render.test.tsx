import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

const collapsed: LegacyCollapsibleNode = {
  key: "t1",
  kind: "tool_call",
  status: "ok",
  text: "",
  mcpName: "tree",
  toolName: "",
  args: { path: "." },
  result: "a\nb\nc\nd\ne",
  collapsed: true,
};

async function frame(ui: () => unknown, width = 70, height = 20): Promise<string[]> {
  const t = await openRender(ui as never, { width, height });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out.split("\n");
}

test("a collapsed tool call is one header line with a breathing row above", async () => {
  const rows = await frame(() => <BlockView node={collapsed} />);
  expect((rows[0] ?? "").trim()).toBe("");
  expect(rows[1]).toContain("tree");
  expect(rows[1]).toContain("… +5 lines");
  expect((rows[2] ?? "").trim()).toBe("");
});

test("consecutive collapsed calls each keep their own breathing row", async () => {
  const second: LegacyCollapsibleNode = { ...collapsed, key: "t2", mcpName: "glob" };
  const rows = await frame(() => (
    <box flexDirection="column">
      <BlockView node={collapsed} />
      <BlockView node={second} />
    </box>
  ));
  expect(rows[1]).toContain("tree");
  expect((rows[2] ?? "").trim()).toBe("");
  expect(rows[3]).toContain("glob");
});

test("a collapsed mutation shows real diff stats, not its one-line result", async () => {
  const edit: LegacyCollapsibleNode = {
    key: "t4",
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "edit_file",
    toolName: "",
    subagentOrder: 0,
    args: { path: "f.txt" },
    diff: "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1,2 @@\n-hi\n+hello\n+world",
    result: "edited f.txt",
    collapsed: true,
  };
  const rows = await frame(() => <BlockView node={edit} />);
  expect(rows[1]).toContain("edit_file");
  expect(rows[1]).toContain("+2");
  expect(rows[1]).toContain("… +6 lines");
});

test("a collapsed shell counts hidden output lines, not the JSON envelope", async () => {
  const sh: LegacyCollapsibleNode = {
    key: "t5",
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "shell",
    toolName: "",
    args: { command: "ls" },
    result: '{"exit_code":0,"stdout":"a\\nb\\nc","stderr":""}',
    collapsed: true,
  };
  const rows = await frame(() => <BlockView node={sh} />);
  expect(rows[1]).toContain("shell");
  expect(rows[1]).toContain("… +3 lines");
});

test("shell headers state whether the auto-guard judge approved or denied", async () => {
  const approved: LegacyCollapsibleNode = {
    ...collapsed,
    key: "guard-approved",
    mcpName: "shell",
    args: { command: "bun test" },
    result: '{"exit_code":0,"stdout":"","stderr":""}',
    guard: { mode: "auto", outcome: "allowed", answerer: "judge" },
  };
  const denied: LegacyCollapsibleNode = {
    ...approved,
    key: "guard-denied",
    status: "error",
    error: "denied",
    guard: { mode: "auto", outcome: "denied", answerer: "judge" },
  };
  const allowedRows = await frame(() => <BlockView node={approved} />, 110);
  const deniedRows = await frame(() => <BlockView node={denied} />, 110);
  expect(allowedRows.join("\n")).toContain("auto-guard approved · judge");
  expect(deniedRows.join("\n")).toContain("auto-guard denied · judge");
});

test("a finished call that ran >= 2s keeps its duration in the header", async () => {
  const slow: LegacyCollapsibleNode = { ...collapsed, key: "t6", elapsedMs: 65_000 };
  const rows = await frame(() => <BlockView node={slow} />);
  expect(rows[1]).toContain("1m05s");
});

test("a fast call (< 2s) earns no duration chip", async () => {
  const fast: LegacyCollapsibleNode = { ...collapsed, key: "t7", elapsedMs: 1_500 };
  const rows = await frame(() => <BlockView node={fast} />);
  expect(rows[1]).toContain("tree");
  expect(rows[1]).not.toContain("1s");
});

test("a composing call keeps its progress label separate from the tool name", async () => {
  const composing: LegacyCollapsibleNode = {
    key: "t8",
    kind: "tool_call",
    status: "running",
    text: "",
    mcpName: "transition_plan_task",
    toolName: "",
    args: {},
    inputChars: 0,
  };
  const rows = await frame(() => <BlockView node={composing} />);
  expect(rows[1]).toContain("transition_plan_task starting…");
  expect(rows[1]).not.toContain("taskstarting");
});

test("an expanded body renders only its curated result under the header", async () => {
  const expanded: LegacyCollapsibleNode = {
    ...collapsed,
    key: "t3",
    mcpName: "shell",
    args: { command: "ls", cwd: "packages/code", timeout_ms: 180_000 },
    result: '{"exit_code":0,"stdout":"one\\ntwo","stderr":""}',
    collapsed: false,
  };
  const rows = await frame(() => (
    <box flexDirection="column">
      <BlockView node={collapsed} />
      <BlockView node={expanded} />
    </box>
  ));
  expect(rows[1]).toContain("tree");
  expect((rows[2] ?? "").trim()).toBe("");
  expect(rows[3]).toContain("shell");
  expect(rows[3]).toContain("(ls, cwd=packages/code)");
  expect(rows.join("\n")).not.toContain("Arguments");
  expect(rows.join("\n")).not.toContain('"command": "ls"');
  expect(rows.join("\n")).not.toContain('"cwd": "packages/code"');
  expect(rows.join("\n")).not.toContain('"timeout_ms": 180000');
  expect(rows.join("\n")).toContain("exit 0");
  expect(rows.join("\n")).toContain("one");
  expect(rows.join("\n")).toContain("two");
});

test("a generic tool keeps its compact signature without mounting raw argument JSON", async () => {
  const generic: LegacyCollapsibleNode = {
    ...collapsed,
    key: "generic-tool",
    mcpName: "custom_server",
    toolName: "custom_tool",
    args: { mode: "fast", retries: 2 },
    result: "useful result",
    collapsed: false,
  };

  const out = (
    await frame(() => <BlockView node={generic} forceExpand={() => true} />, 80, 12)
  ).join("\n");
  expect(out).toContain("mode=fast");
  expect(out).toContain("useful result");
  expect(out).not.toContain("Arguments");
  expect(out).not.toContain('"mode": "fast"');
  expect(out).not.toContain('"retries": 2');
});

test("a shortened tool payload renders its recovery route as wrapping prose, not code", async () => {
  const oversized: LegacyCollapsibleNode = {
    key: "large-tool",
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "edit_file",
    toolName: "",
    args: {
      path: "large.ts",
      old_string: "before",
      new_string: "x".repeat(100_000),
    },
    result: "edited large.ts",
    collapsed: false,
  };

  const rows = await frame(() => <BlockView node={oversized} forceExpand={() => true} />, 48, 30);
  const out = rows.join("\n");
  expect(out).toContain("Tool display shortened to keep the terminal");
  expect(out).toContain("Use /export to inspect the");
  expect(out).toContain("persisted transcript.");
  expect(out).not.toContain("[Tool body display shortened");
});
