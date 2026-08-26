import { expect, test } from "bun:test";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import type { LegacyCollapsibleToolNode } from "../helpers/transcript-fixtures.ts";

function toolNode(
  mcpName: string,
  args: Record<string, unknown>,
  result: string,
): LegacyCollapsibleToolNode {
  return {
    key: "t0",
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName,
    toolName: "",
    args,
    result,
    error: null,
    collapsed: false,
  };
}

async function frame(node: TranscriptNode): Promise<string> {
  const t = await openRender(() => <BlockView node={node} forceExpand={() => true} />, {
    width: 100,
    height: 60,
  });
  await settleSyntaxSurfaces(t);
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("shell stdout over the cap shows 10 lines + a `… +N lines` footer", async () => {
  const stdout = Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join("\n");
  const result = JSON.stringify({
    exit_code: 0,
    stdout,
    stderr: "",
    signal: null,
    timed_out: false,
  });
  const out = await frame(toolNode("shell", { command: "seq 25" }, result));
  expect(out).toContain("L1");
  expect(out).toContain("L10");
  expect(out).not.toContain("L11");
  expect(out).not.toContain("L25");
  expect(out).toContain("… +15 lines");
});

test("output within the cap renders in full, no footer", async () => {
  const stdout = "one\ntwo\nthree";
  const result = JSON.stringify({
    exit_code: 0,
    stdout,
    stderr: "",
    signal: null,
    timed_out: false,
  });
  const out = await frame(toolNode("shell", { command: "x" }, result));
  expect(out).toContain("three");
  expect(out).not.toContain("… +");
});

test("a read_file preview is capped to 10 lines", async () => {
  const body = Array.from(
    { length: 30 },
    (_, i) => `${String(i + 1).padStart(6)}\tline_${i + 1}`,
  ).join("\n");
  const out = await frame(toolNode("read_file", { path: "big.ts" }, body));
  expect(out).toContain("line_1");
  expect(out).toContain("line_10");
  expect(out).not.toContain("line_11");
  expect(out).toContain("… +20 lines");
});

test("the `… +1 line` footer is singular", async () => {
  const stdout = Array.from({ length: 11 }, (_, i) => `n${i + 1}`).join("\n");
  const result = JSON.stringify({
    exit_code: 0,
    stdout,
    stderr: "",
    signal: null,
    timed_out: false,
  });
  const out = await frame(toolNode("shell", { command: "x" }, result));
  expect(out).toContain("… +1 line");
  expect(out).not.toContain("… +1 lines");
});

test("a mutation diff over the cap is NOT clamped — clamping breaks the unified-diff parser", async () => {
  const diff = [
    "Index: src/x.ts",
    "===================================================================",
    "--- src/x.ts",
    "+++ src/x.ts",
    "@@ -1,10 +1,10 @@",
    " c1",
    " c2",
    " c3",
    " c4",
    " c5",
    " c6",
    " c7",
    " c8",
    '-const OLD = "before"',
    '+const NEW = "after"',
    " c10",
  ].join("\n");
  const node = toolNode("edit_file", { path: "src/x.ts" }, "Replaced 1 occurrence.");
  node.diff = diff;
  const out = await frame(node);
  expect(out).not.toContain("Error parsing diff");
  expect(out).not.toContain("… +");
  expect(out).toContain('const OLD = "before"');
  expect(out).toContain('const NEW = "after"');
  expect(out).toContain("c10");
});

test("a generic tool whose result is a JSON object renders the key/value card", async () => {
  const result = JSON.stringify({ status: "indexed", documents: 3 });
  const out = await frame(toolNode("mcp_search", { query: "auth" }, result));
  expect(out).toContain("status");
  expect(out).toContain("indexed");
  expect(out).toContain("documents");
  expect(out).not.toContain('{"status"');
});

test("the JSON card clamps past 10 entries with the shared `… +N lines` footer", async () => {
  const wide: Record<string, number> = {};
  for (let i = 1; i <= 15; i++) wide[`field_${String(i).padStart(2, "0")}`] = i;
  const out = await frame(toolNode("mcp_search", {}, JSON.stringify(wide)));
  expect(out).toContain("field_01");
  expect(out).toContain("field_10");
  expect(out).not.toContain("field_11");
  expect(out).toContain("… +5 lines");
});

test("a generic non-JSON result still renders as clamped muted text", async () => {
  const out = await frame(toolNode("mcp_notes", {}, "plain output\nsecond line"));
  expect(out).toContain("plain output");
  expect(out).toContain("second line");
});
