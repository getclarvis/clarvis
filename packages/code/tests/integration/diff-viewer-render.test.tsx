import { expect, test } from "bun:test";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { TranscriptToolNode } from "../../src/adapters/store.ts";
import { DiffViewer, projectDiffFiles } from "../../src/views/overlays/DiffViewer.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const REAL_DIFF = [
  "--- a.ts",
  "+++ a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
].join("\n");

function fakeInteraction(): {
  interaction: Interaction;
  registered: ReturnType<typeof createFakeKeymap>["layers"];
} {
  const { keymap, layers } = createFakeKeymap();
  return { interaction: { keymap } as unknown as Interaction, registered: layers };
}

let seq = 0;
function toolNode(over: Partial<TranscriptToolNode> = {}): TranscriptToolNode {
  return {
    key: `n${seq++}`,
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "",
    toolName: "edit_file",
    args: { path: "a.ts", old_string: "two", new_string: "TWO" },
    result: "Replaced 1 occurrence in a.ts.",
    error: null,
    collapsed: false,
    ...over,
  } as TranscriptToolNode;
}

async function frame(node: TranscriptToolNode | null): Promise<string> {
  const { interaction } = fakeInteraction();
  const t = await openRender(
    (() => (
      <DiffViewer
        interaction={interaction}
        nodes={() => (node === null ? [] : [node])}
        onClose={() => undefined}
      />
    )) as never,
    { width: 100, height: 40 },
  );
  await settleSyntaxSurfaces(t);
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("no node yet shows the empty hint, not a blank pane", async () => {
  const out = await frame(null);
  expect(out).toContain("Diff");
  expect(out).toContain("no diff in the transcript yet");
  expect(out).toContain("run a file-editing tool to populate one");
});

test("a node with a real diff renders it via the shared tool renderer", async () => {
  const out = await frame(toolNode({ diff: REAL_DIFF }));
  expect(out).toContain("TWO");
  expect(out).toContain("two");
  expect(out).not.toContain("no diff in the transcript yet");
});

test("the changed-file tree expands folders and selects one complete file diff", async () => {
  const { keymap, press } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  const nodes = [
    toolNode({
      args: { path: "src/first.ts" },
      diff: "--- src/first.ts\n+++ src/first.ts\n@@ -1 +1 @@\n-old first\n+new first",
    }),
    toolNode({
      args: { path: "src/second.ts" },
      diff: "--- src/second.ts\n+++ src/second.ts\n@@ -1 +1 @@\n-old second\n+new second",
    }),
  ];
  const t = await openRender(
    (() => (
      <DiffViewer interaction={interaction} nodes={() => nodes} onClose={() => undefined} />
    )) as never,
    { width: 100, height: 40 },
  );
  await settleSyntaxSurfaces(t);
  let out = t.captureCharFrame();
  expect(out).toContain("2 files · 2 changes");
  expect(out).toContain("src/first.ts");
  expect(out).toContain("new first");
  expect(out).toContain("second.ts");
  expect(out).not.toContain("new second");
  press("return");
  await t.renderOnce();
  out = t.captureCharFrame();
  expect(out.match(/first\.ts/g)).toHaveLength(1);
  expect(out).not.toContain("second.ts");
  press("return");
  await t.renderOnce();
  press("down");
  press("down");
  await settleSyntaxSurfaces(t);
  out = t.captureCharFrame();
  expect(out).toContain("src/first.ts");
  expect(out).toContain("new first");
  expect(out).not.toContain("new second");
  press("return");
  await settleSyntaxSurfaces(t);
  out = t.captureCharFrame();
  expect(out).toContain("src/second.ts");
  expect(out).toContain("new second");
  expect(out).not.toContain("new first");
  t.renderer.destroy();
});

test("all edits to the same file stay grouped and multi-file unified diffs split by path", () => {
  const samePath = [
    toolNode({ args: { path: "src/a.ts" }, diff: "--- src/a.ts\n+++ src/a.ts\n+one" }),
    toolNode({ args: { path: "src/a.ts" }, diff: "--- src/a.ts\n+++ src/a.ts\n+two" }),
  ];
  expect(projectDiffFiles(samePath)).toMatchObject([
    {
      path: "src/a.ts",
      changes: [{ diff: expect.stringContaining("one") }, { diff: expect.stringContaining("two") }],
    },
  ]);
  const split = projectDiffFiles([
    toolNode({
      toolName: "apply_patch",
      args: {},
      diff: [
        "--- a/one.ts",
        "+++ b/one.ts",
        "@@ -1 +1 @@",
        "-one",
        "+ONE",
        "--- a/two.ts",
        "+++ b/two.ts",
        "@@ -1 +1 @@",
        "-two",
        "+TWO",
      ].join("\n"),
    }),
  ]);
  expect(split.map((file) => file.path)).toEqual(["one.ts", "two.ts"]);
});

test("a narrow terminal opens file detail as a separate step and Escape returns to the tree", async () => {
  const { keymap, press } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  const node = toolNode({
    args: { path: "src/narrow.ts" },
    diff: "--- src/narrow.ts\n+++ src/narrow.ts\n@@ -1 +1 @@\n-old\n+NARROW DETAIL",
  });
  const t = await openRender(
    (() => (
      <DiffViewer interaction={interaction} nodes={() => [node]} onClose={() => undefined} />
    )) as never,
    { width: 60, height: 24 },
  );
  await t.renderOnce();
  let out = t.captureCharFrame();
  expect(out).toContain("Changed files");
  expect(out).not.toContain("NARROW DETAIL");
  press("down");
  press("return");
  await settleSyntaxSurfaces(t);
  out = t.captureCharFrame();
  expect(out).not.toContain("Changed files");
  expect(out).toContain("NARROW DETAIL");
  press("escape");
  await t.renderOnce();
  out = t.captureCharFrame();
  expect(out).toContain("Changed files");
  expect(out).not.toContain("NARROW DETAIL");
  t.renderer.destroy();
});

test("a node without a diff falls back to the args-reconstructed diff", async () => {
  const out = await frame(toolNode({ diff: undefined }));
  expect(out).toContain("(reconstructed)");
  expect(out).toContain("TWO");
});

test("the subtitle is the tool label built from mcpName and toolName", async () => {
  const out = await frame(toolNode({ mcpName: "fs", toolName: "edit_file", diff: REAL_DIFF }));
  expect(out).toContain("fs:edit_file");
});

test("an mcp-less tool still labels the subtitle from toolName alone", async () => {
  const out = await frame(toolNode({ mcpName: "", toolName: "edit_file", diff: REAL_DIFF }));
  expect(out).toContain("edit_file");
});

test("an errored node still renders through the tool renderer with its error", async () => {
  const out = await frame(
    toolNode({
      toolName: "shell",
      status: "error",
      error: "command failed: exit 1",
      result: "",
      args: { command: "false" },
      diff: undefined,
    }),
  );
  expect(out).toContain("command failed: exit 1");
});

test("write_file on a new file with no diff shows the full new content", async () => {
  const out = await frame(
    toolNode({
      toolName: "write_file",
      args: { path: "fresh.txt", content: "brand new content" },
      result: "Wrote 17 bytes to fresh.txt (created).",
      diff: undefined,
    }),
  );
  expect(out).toContain("brand new content");
});

test("the page projects file navigation before detail scrolling", async () => {
  const out = await frame(toolNode({ diff: REAL_DIFF }));
  expect(out).toContain("open");
});

test("mounting registers scroll keys on the interaction keymap", async () => {
  const { interaction, registered } = fakeInteraction();
  const t = await openRender(
    (() => (
      <DiffViewer
        interaction={interaction}
        nodes={() => [toolNode({ diff: REAL_DIFF })]}
        onClose={() => undefined}
      />
    )) as never,
    { width: 100, height: 40 },
  );
  await t.renderOnce();
  const scrollBindings = registered.flatMap((layer) => layer.bindings ?? []).map((b) => b.key);
  for (const key of ["up", "down", "j", "k", "pageup", "pagedown"]) {
    expect(scrollBindings).toContain(key);
  }
  t.renderer.destroy();
});

test("a very long line wraps in the full-screen viewer rather than being hard-clipped", async () => {
  // The viewer hard-clipped long lines at the pane width with no truncation
  // indicator and no horizontal scroll, so the tail was simply unreachable.
  const tail = "TAIL_MARKER_AT_THE_VERY_END";
  const long = "x".repeat(200) + tail;
  const out = await frame(
    toolNode({
      toolName: "diff",
      diff: ["--- a.ts", "+++ a.ts", "@@ -1,1 +1,1 @@", `+${long}`].join("\n"),
    }),
  );
  expect(out.replace(/[\s│]/g, "")).toContain(tail);
});

test("a bare carriage return does not desynchronise the gutter or drop a marker", async () => {
  // A CR is a cursor command, not content: the text buffer treats one as a line
  // break while the diff parser does not, so numbers jumped 1 to 5 and two
  // genuinely added lines showed no `+`.
  const out = await frame(
    toolNode({
      toolName: "diff",
      diff: [
        "--- a.ts",
        "+++ a.ts",
        "@@ -1,2 +1,4 @@",
        " context\rwith-a-bare-cr",
        "+added one",
        "+added two",
      ].join("\n"),
    }),
  );
  expect(out).toContain("added one");
  expect(out).toContain("added two");
  expect(out).not.toContain("\r");
});

test("the subtitle names the file, not only the tool", async () => {
  // The inline block a reader opens this page from shows the path; the
  // full-screen view — the one with room for the whole diff — dropped it.
  const out = await frame(toolNode({ mcpName: "fs", toolName: "edit_file", diff: REAL_DIFF }));
  expect(out).toContain("fs:edit_file");
  expect(out).toContain("a.ts");
});

test("a line wider than the viewport wraps in the full-screen view instead of being clipped", async () => {
  const longLine = "x".repeat(400);
  const out = await frame(
    toolNode({
      mcpName: "fs",
      toolName: "read_file",
      diff: undefined,
      result: `     1\t${longLine}\n`,
    }),
  );
  // The inline block may clip; this is the surface a reader opens *because* the
  // inline block was not enough room, so clipping here discards the only copy
  // they asked for.
  const painted = out.split("\n").filter((row) => row.includes("xxxx")).length;
  expect(painted).toBeGreaterThan(1);
});
