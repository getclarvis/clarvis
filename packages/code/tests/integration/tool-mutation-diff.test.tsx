import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { resolveToolRenderer } from "../../src/views/tools/registry.tsx";
import type { BlockOverride } from "../../src/views/block-focus.ts";

const ev = runEvent;

const EDIT_DIFF = `Index: frontend/tailwind.config.js
===================================================================
--- frontend/tailwind.config.js
+++ frontend/tailwind.config.js
@@ -1,3 +1,3 @@
       primary: {
-        DEFAULT: '#6366f1',
+        DEFAULT: '#3b82f6',
       }`;

function nodesFor(events: RunEvent[]): TranscriptNode[] {
  return projectionFor(events).nodes;
}

function projectionFor(events: RunEvent[]) {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const e of events) applyRunEvent(sink, e, "replay");
    return store;
  });
}

function editEvent(): RunEvent {
  return ev({
    type: "tool_call",
    agent: "subagent",
    subagent_id: "w1",
    call_id: "call_1",
    at: 2,
    server: "edit_file",
    tool: "",
    arguments: {
      path: "frontend/tailwind.config.js",
      old_string: "#6366f1",
      new_string: "#3b82f6",
    },
    result: "Replaced 1 occurrence in frontend/tailwind.config.js.",
    ok: true,
    diff: EDIT_DIFF,
  });
}

function grepEvent(): RunEvent {
  return ev({
    type: "tool_call",
    agent: "subagent",
    subagent_id: "w1",
    call_id: "call_2",
    at: 2,
    server: "grep",
    tool: "",
    arguments: { pattern: "indigo" },
    result: "(no matches)",
    ok: true,
  });
}

test("a successful mutation tool (name in mcp_name, tool_name empty) auto-collapses and keeps its diff", () => {
  const store = projectionFor([editEvent()]);
  const node = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(store.defaultFolded(node.key)).toBe(true);
  expect(node.diff).toBe(EDIT_DIFF);
});

test("a read-only tool still auto-collapses to its header", () => {
  const store = projectionFor([grepEvent()]);
  const node = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(store.defaultFolded(node.key)).toBe(true);
});

test("resolveToolRenderer falls back to mcp_name when tool_name is empty (builtin tools)", () => {
  expect(resolveToolRenderer("edit_file", "")).toBe(resolveToolRenderer("", "edit_file"));
  expect(resolveToolRenderer("read_file", "")).toBe(resolveToolRenderer("", "read_file"));
});

async function frame(
  node: TranscriptNode,
  expand: boolean,
  options: {
    defaultFolded?: boolean;
    override?: BlockOverride;
    height?: number;
  } = {},
): Promise<string> {
  const t = await openRender(
    () => (
      <BlockView
        node={node}
        forceExpand={() => expand}
        defaultFolded={() => options.defaultFolded ?? false}
        overrideOf={() => options.override}
      />
    ),
    { width: 120, height: options.height ?? 30 },
  );
  await settleSyntaxSurfaces(t);
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("the edit_file block renders its compact signature and real unified diff", async () => {
  const node = nodesFor([editEvent()]).find((n) => n.kind === "tool_call")!;
  const out = await frame(node, false);
  expect(out).toContain("edit_file(frontend/tailwind.config.js)");
  expect(out).not.toContain('"path": "frontend/tailwind.config.js"');
  expect(out).not.toContain("[accessor omitted]");
  expect(out).toContain("#6366f1");
  expect(out).toContain("#3b82f6");
  expect(out).not.toContain("edit_file:");
});

const largeMutationDiff = (): string =>
  [
    "--- a/src/visible.ts",
    "+++ b/src/visible.ts",
    "@@ -0,0 +1,55 @@",
    ...Array.from({ length: 55 }, (_, index) => `+lead-visible-${index}`),
  ].join("\n");

function mutationEvent(tool: "edit_file" | "multi_edit" | "apply_patch", lead: boolean): RunEvent {
  const diff = largeMutationDiff();
  return ev({
    type: "tool_call",
    agent: lead ? "lead" : "subagent",
    ...(lead ? {} : { subagent_id: "w1" }),
    call_id: `${tool}-${lead ? "lead" : "sub"}`,
    at: 2,
    server: tool,
    tool: "",
    arguments:
      tool === "apply_patch"
        ? { patch: diff }
        : tool === "multi_edit"
          ? { path: "src/visible.ts", edits: [{ old_string: "old", new_string: "new" }] }
          : { path: "src/visible.ts", old_string: "old", new_string: "new" },
    result: "mutation applied",
    ok: true,
    diff,
  });
}

test("lead edit, multi_edit and apply_patch calls show their mutation body past the line gate", async () => {
  for (const tool of ["edit_file", "multi_edit", "apply_patch"] as const) {
    const node = nodesFor([mutationEvent(tool, true)]).find((item) => item.kind === "tool_call")!;
    const out = await frame(node, false, { defaultFolded: true, height: 100 });
    expect(out).toContain("lead-visible-54");
    expect(out).not.toContain("… +58 lines");
  }
});

test("sub-agent mutations keep the ordinary folded default", async () => {
  const node = nodesFor([mutationEvent("apply_patch", false)]).find(
    (item) => item.kind === "tool_call",
  )!;
  const out = await frame(node, false, { defaultFolded: true, height: 100 });
  expect(out).not.toContain("lead-visible-54");
  expect(out).not.toContain('"patch"');
});

test("an explicit user fold still hides a lead mutation", async () => {
  const node = nodesFor([mutationEvent("apply_patch", true)]).find(
    (item) => item.kind === "tool_call",
  )!;
  const out = await frame(node, false, {
    defaultFolded: true,
    override: "collapsed",
    height: 100,
  });
  expect(out).not.toContain("lead-visible-54");
});
