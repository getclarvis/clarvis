import { expect, test } from "bun:test";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import {
  hiddenBodyLines,
  renderToolPreview,
  resolveErrorRenderer,
} from "../../src/views/tools/registry.tsx";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import type { LegacyCollapsibleToolNode } from "../helpers/transcript-fixtures.ts";

let seq = 0;
function toolNode(over: Partial<LegacyCollapsibleToolNode>): LegacyCollapsibleToolNode {
  return {
    key: `n${seq++}`,
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "",
    toolName: "",
    args: {},
    result: "",
    error: null,
    collapsed: false,
    ...over,
  };
}

async function frame(node: TranscriptNode, width = 100, height = 40): Promise<string> {
  const t = await openRender(() => <BlockView node={node} forceExpand={() => true} />, {
    width,
    height,
  });
  await settleSyntaxSurfaces(t);
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("read_file with trailing notes renders the note lines under the code", async () => {
  const result = [
    "    10\tconst a = 1",
    "    11\tconst b = 2",
    "[... 2 of 40 lines shown; continue with offset=12 ...]",
  ].join("\n");
  const out = await frame(toolNode({ mcpName: "read_file", args: { path: "a.ts" }, result }));
  expect(out).toContain("const a = 1");
  expect(out).toContain("lines 10");
  expect(out).toContain("[... 2 of 40 lines shown");
});

test("read_file with no line-numbered rows omits the lines header", async () => {
  const out = await frame(
    toolNode({ mcpName: "read_file", args: { path: "empty.ts" }, result: "" }),
  );
  expect(out).not.toContain("lines");
});

test("read_files renders one section per file, flags per-file errors, and shows the trailing note", async () => {
  const result = [
    "==> src/a.ts <==",
    "     1\tconst a = 1",
    "==> src/missing.ts — not_found: no such file <==",
    "==> src/c.ts <==",
    "     1\tok()",
    "[... 2 more file(s) not shown ...]",
  ].join("\n");
  const out = await frame(toolNode({ mcpName: "read_files", args: {}, result }), 120, 40);
  expect(out).toContain("src/a.ts");
  expect(out).toContain("const a = 1");
  expect(out).toContain("src/missing.ts");
  expect(out).toContain("not_found: no such file");
  expect(out).toContain("src/c.ts");
  expect(out).toContain("ok()");
  expect(out).toContain("2 more file(s) not shown");
});

test("read_files with no ==> headers falls back to the generic renderer", async () => {
  const out = await frame(
    toolNode({ mcpName: "read_files", args: {}, result: "just some plain text" }),
  );
  expect(out).toContain("just some plain text");
});

test("read_image shows the path when given", async () => {
  const out = await frame(toolNode({ mcpName: "read_image", args: { path: "shot.png" } }));
  expect(out).toContain("[image]");
  expect(out).toContain("shot.png");
});

test("read_image with no path arg renders just the marker", async () => {
  const out = await frame(toolNode({ mcpName: "read_image", args: {} }));
  expect(out).toContain("[image]");
});

test("grep content mode groups matches by path and clamps past the line budget", async () => {
  const rows = (n: number, path: string): string =>
    Array.from({ length: n }, (_, i) => `${path}:${i + 1}:line ${i + 1}`).join("\n");
  const result = [rows(6, "a.ts"), "--", rows(6, "b.ts")].join("\n--\n");
  const out = await frame(
    toolNode({ mcpName: "grep", args: { output_mode: "content", pattern: "x" }, result }),
  );
  expect(out).toContain("a.ts");
  expect(out).toContain("line 1");
  expect(out).toContain("… +");
});

test("grep content mode with no matches renders the muted placeholder", async () => {
  const out = await frame(
    toolNode({
      mcpName: "grep",
      args: { output_mode: "content", pattern: "nope" },
      result: "(no matches)",
    }),
  );
  expect(out).toContain("(no matches)");
});

test("grep in files_with_matches mode (default) renders as a path list", async () => {
  const out = await frame(
    toolNode({ mcpName: "grep", args: { pattern: "x" }, result: "a.ts\nb.ts\n" }),
  );
  expect(out).toContain("a.ts");
  expect(out).toContain("b.ts");
});

test("glob with no matches renders the muted placeholder", async () => {
  const out = await frame(toolNode({ mcpName: "glob", args: {}, result: "(no matches)" }));
  expect(out).toContain("(no matches)");
});

test("glob clamps a long path list and reports the hidden count", async () => {
  const paths = Array.from({ length: 15 }, (_, i) => `file_${i + 1}.ts`).join("\n");
  const out = await frame(toolNode({ mcpName: "glob", args: {}, result: paths }));
  expect(out).toContain("file_1.ts");
  expect(out).toContain("file_10.ts");
  expect(out).not.toContain("file_11.ts");
  expect(out).toContain("… +5 lines");
});

test("write_file over the mutation-gate line cap collapses to a stats chip", async () => {
  const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = await frame(
    toolNode({
      mcpName: "write_file",
      subagentOrder: 0,
      args: { path: "big.ts", content },
      result: "",
      diff: undefined,
    }),
  );
  expect(out).toContain("Wrote big.ts");
  expect(out).toContain("+50");
  expect(out).not.toContain("line 49");
});

test("edit_file over the mutation-gate line cap (no real diff) shows reconstructed + stats chip", async () => {
  const oldText = Array.from({ length: 25 }, (_, i) => `old ${i}`).join("\n");
  const newText = Array.from({ length: 25 }, (_, i) => `new ${i}`).join("\n");
  const out = await frame(
    toolNode({
      mcpName: "edit_file",
      subagentOrder: 0,
      args: { path: "big.ts", old_string: oldText, new_string: newText },
      result: "",
      diff: undefined,
    }),
  );
  expect(out).toContain("(reconstructed)");
  expect(out).toContain("+25");
  expect(out).not.toContain("new 24");
});

test("apply_patch renders its result line above a normal-size diff", async () => {
  const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
  const out = await frame(
    toolNode({
      mcpName: "apply_patch",
      args: { patch: diff },
      result: "Applied patch to x.ts.",
      diff,
    }),
  );
  expect(out).toContain("Applied patch to x.ts.");
  expect(out).toContain("new");
});

test("apply_patch over the cap collapses to a stats chip, with no result line when empty", async () => {
  const bigDiff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,50 +1,50 @@",
    ...Array.from({ length: 50 }, (_, i) => `+line ${i}`),
  ].join("\n");
  const out = await frame(
    toolNode({
      mcpName: "apply_patch",
      subagentOrder: 0,
      args: { patch: bigDiff },
      result: "",
      diff: bigDiff,
    }),
  );
  expect(out).toContain("+50");
});

test("the diff tool with no diff and no result falls back to the generic renderer", async () => {
  const out = await frame(
    toolNode({ mcpName: "diff", args: { from: "a.ts", to: "b.ts" }, result: "", diff: undefined }),
  );
  expect(out).toContain("(no output)");
});

test("the diff tool's (no matches) result stays a muted one-liner", async () => {
  const out = await frame(
    toolNode({
      mcpName: "diff",
      args: { from: "a.ts", to: "b.ts" },
      result: "(no matches)",
      diff: undefined,
    }),
  );
  expect(out).toContain("(no matches)");
});

test("the diff tool over the cap shows the summary and a stats chip instead of the full diff", async () => {
  const lines = Array.from({ length: 50 }, (_, i) => ` c${i}`);
  const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,50 +1,50 @@", ...lines].join("\n");
  const out = await frame(
    toolNode({
      mcpName: "diff",
      args: { from: "a.ts", to: "b.ts" },
      result: "50 lines differ",
      diff,
    }),
  );
  expect(out).toContain("50 lines differ");
  expect(out).toContain("+0");
});

test("monitor_list with no monitors renders the muted placeholder", async () => {
  const out = await frame(
    toolNode({ mcpName: "monitor_list", args: {}, result: JSON.stringify({ monitors: [] }) }),
  );
  expect(out).toContain("(no monitors)");
});

test("monitor_list renders each monitor's running state and command", async () => {
  const out = await frame(
    toolNode({
      mcpName: "monitor_list",
      args: {},
      result: JSON.stringify({
        monitors: [
          { id: "m1", command: "npm run dev", running: true },
          { id: "m2", command: "npm run build", running: false },
        ],
      }),
    }),
  );
  expect(out).toContain("m1");
  expect(out).toContain("npm run dev");
  expect(out).toContain("m2");
  expect(out).toContain("npm run build");
});

test("a collapsed monitor_list counts monitors, not lines of its JSON", () => {
  // monitor_list returns unindented JSON.stringify, so the raw line count is
  // always 1 while the rendered body is one row per monitor.
  const result = JSON.stringify({
    monitors: [
      { id: "m1", command: "npm run dev", running: true },
      { id: "m2", command: "npm run build", running: false },
      { id: "m3", command: "npm test", running: false },
    ],
  });
  expect(result.split("\n")).toHaveLength(1);
  expect(hiddenBodyLines("monitor_list", "", result)).toBe(3);
  expect(hiddenBodyLines("monitor_list", "", JSON.stringify({ monitors: [] }))).toBe(0);
});

test("monitor_start shows running + not-ready and tails live output", async () => {
  const out = await frame(
    toolNode({
      mcpName: "monitor_start",
      args: {},
      result: JSON.stringify({ id: "m1", running: true, ready: false, output: "booting up\n" }),
    }),
  );
  expect(out).toContain("running");
  expect(out).toContain("m1");
  expect(out).toContain("not ready");
  expect(out).toContain("booting up");
});

test("monitor_poll shows ready + exit code once the process has finished", async () => {
  const out = await frame(
    toolNode({
      mcpName: "monitor_poll",
      args: {},
      result: JSON.stringify({
        id: "m1",
        running: false,
        ready: true,
        exit_code: 1,
        output: "done\n",
      }),
    }),
  );
  expect(out).toContain("exited");
  expect(out).toContain("ready");
  expect(out).toContain("exit 1");
});

test("monitor_stop reports the stopped label", async () => {
  const out = await frame(
    toolNode({
      mcpName: "monitor_stop",
      args: {},
      result: JSON.stringify({ id: "m1", stopped: true, running: false, output: "" }),
    }),
  );
  expect(out).toContain("stopped");
});

test("monitor with an unparsable result falls back to the generic renderer", async () => {
  const out = await frame(toolNode({ mcpName: "monitor_poll", args: {}, result: "" }));
  expect(out).toContain("(no output)");
});

test("move/copy/mkdir/remove render their one-line summary", async () => {
  for (const mcpName of ["move", "copy", "mkdir", "remove"]) {
    const out = await frame(toolNode({ mcpName, args: {}, result: `${mcpName} done` }));
    expect(out).toContain(`${mcpName} done`);
  }
});

test("tree renders the raw listing", async () => {
  const out = await frame(toolNode({ mcpName: "tree", args: {}, result: "src/\n  a.ts\n  b.ts" }));
  expect(out).toContain("a.ts");
  expect(out).toContain("b.ts");
});

test("tree with an empty result shows the muted placeholder", async () => {
  const out = await frame(toolNode({ mcpName: "tree", args: {}, result: "" }));
  expect(out).toContain("(empty)");
});

test("file_stat renders as a JSON key/value card", async () => {
  const out = await frame(
    toolNode({
      mcpName: "file_stat",
      args: { path: "a.ts" },
      result: JSON.stringify({ size: 123, isDirectory: false }),
    }),
  );
  expect(out).toContain("size");
  expect(out).toContain("123");
});

test("read_memory renders the body as markdown code, or the empty placeholder", async () => {
  const withBody = await frame(
    toolNode({ mcpName: "read_memory", args: { path: "PROFILE.md" }, result: "# Profile\n- x" }),
  );
  expect(withBody).toContain("# Profile");
  const empty = await frame(toolNode({ mcpName: "read_memory", args: {}, result: "" }));
  expect(empty).toContain("(no output)");
});

test("list_memories renders as a path list", async () => {
  const out = await frame(
    toolNode({ mcpName: "list_memories", args: {}, result: "PROFILE.md\ninfra/TOPIC.md" }),
  );
  expect(out).toContain("PROFILE.md");
  expect(out).toContain("infra/TOPIC.md");
});

test("grep_memories with matches renders grouped content rows", async () => {
  const out = await frame(
    toolNode({
      mcpName: "grep_memories",
      args: { pattern: "auth" },
      result: "PROFILE.md:2:auth notes here",
    }),
  );
  expect(out).toContain("PROFILE.md");
  expect(out).toContain("auth notes here");
});

test("grep_memories with no matches falls back to the generic renderer", async () => {
  const out = await frame(
    toolNode({ mcpName: "grep_memories", args: { pattern: "auth" }, result: "(no matches)" }),
  );
  expect(out).toContain("(no matches)");
});

test("delete_memory renders its one-line summary", async () => {
  const out = await frame(
    toolNode({ mcpName: "delete_memory", args: {}, result: "Deleted PROFILE.md." }),
  );
  expect(out).toContain("Deleted PROFILE.md.");
});

test("a generic tool result that happens to be a JSON object renders as a key/value card", async () => {
  const out = await frame(
    toolNode({ mcpName: "custom_tool", args: {}, result: JSON.stringify({ a: 1 }) }),
  );
  expect(out).toContain("a");
  expect(out).toContain("1");
});

test("a generic tool with an empty result shows the muted placeholder", async () => {
  const out = await frame(toolNode({ mcpName: "custom_tool", args: {}, result: "" }));
  expect(out).toContain("(no output)");
});

test("resolveErrorRenderer uses the same renderer for an error-aware tool (shell)", async () => {
  const out = await frame(
    toolNode({
      mcpName: "shell",
      args: { command: "false" },
      result: "",
      error: JSON.stringify({ exit_code: 1, stdout: "", stderr: "boom", signal: null }),
    }),
  );
  expect(out).toContain("exit 1");
  expect(out).toContain("boom");
});

test("resolveErrorRenderer falls back to plain error text for a non-error-aware tool", async () => {
  const out = await frame(
    toolNode({
      mcpName: "read_file",
      args: { path: "missing.ts" },
      result: "",
      error: "ENOENT: no such file",
    }),
  );
  expect(out).toContain("ENOENT: no such file");
});

test("resolveErrorRenderer identity resolution matches resolveToolRenderer's", () => {
  expect(resolveErrorRenderer("shell", "")).not.toBe(resolveErrorRenderer("read_file", ""));
});

test("renderToolPreview renders a tool's body from sample args with an empty result", async () => {
  const t = await openRender(() => renderToolPreview("shell", "", { command: "ls -la" }), {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  expect(out).toContain("ls -la");
});

// A shell call that never reached a shell arrives with the same sentence as both
// `result` and `error`, and used to render it twice — once as body text, once in
// red — under a "done" that claimed the command had run.
test("a shell call that never ran shows its message once, and does not claim 'done'", async () => {
  const message =
    "The arguments for 'shell' arrived truncated or malformed and could not be parsed as JSON, " +
    'so the call was not run. What arrived was: {"command":"npm test 2>';
  const out = await frame(
    toolNode({ mcpName: "shell", status: "error", args: {}, result: message, error: message }),
  );
  const body = out.slice(out.indexOf("arrived truncated"));
  expect(body.match(/arrived truncated/g)).toHaveLength(1);
  expect(out).toContain("failed");
  expect(out).not.toContain("done");
});

test("a shell call that ran and failed still reports its exit code, not 'failed'", async () => {
  const out = await frame(
    toolNode({
      mcpName: "shell",
      status: "error",
      args: { command: "false" },
      result: JSON.stringify({ exit_code: 1, stdout: "", stderr: "boom\n" }),
      error: JSON.stringify({ exit_code: 1, stdout: "", stderr: "boom\n" }),
    }),
  );
  expect(out).toContain("exit 1");
  expect(out).not.toContain("failed");
});
