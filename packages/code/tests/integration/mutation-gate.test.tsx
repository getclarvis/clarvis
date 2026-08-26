import { expect, test } from "bun:test";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import { resolveToolRenderer, type ToolCallView } from "../../src/views/tools/registry.tsx";
import {
  diffStats,
  isLeadMutation,
  isOversizeMutation,
  MUTATION_GATE_LINES,
  mutationStats,
} from "../../src/views/tools/mutation-gate.ts";

function bigDiff(lines: number): string {
  const added = Array.from({ length: lines }, (_, i) => `+line ${i}`);
  return ["--- a/f.ts", "+++ b/f.ts", "@@ -0,0 +1," + lines + " @@", ...added].join("\n");
}

function view(over: Partial<ToolCallView>): ToolCallView {
  return {
    mcpName: "write_file",
    toolName: "",
    arguments: {},
    result: "",
    error: null,
    status: "ok",
    ...over,
  };
}

async function frame(v: ToolCallView): Promise<string> {
  const renderer = resolveToolRenderer(v.mcpName, v.toolName);
  const t = await openRender(() => <box flexDirection="column">{renderer(v)}</box>, {
    width: 90,
    height: 30,
  });
  await settleSyntaxSurfaces(t);
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("diffStats counts +/− excluding file headers", () => {
  const s = diffStats(bigDiff(3));
  expect(s.added).toBe(3);
  expect(s.removed).toBe(0);
  const both = diffStats("--- a/f\n+++ b/f\n@@ @@\n+one\n-two\n context");
  expect(both.added).toBe(1);
  expect(both.removed).toBe(1);
});

test("an oversize write_file diff collapses to a stats chip", async () => {
  const out = await frame(
    view({ arguments: { path: "f.ts" }, diff: bigDiff(60), result: "Wrote f.ts" }),
  );
  expect(out).toContain("+60");
  expect(out).toContain("… +63 lines");
  expect(out).not.toContain("line 5");
});

test("full=true renders the whole diff (the gate lifts)", async () => {
  const out = await frame(
    view({ arguments: { path: "f.ts" }, diff: bigDiff(60), result: "Wrote f.ts", full: true }),
  );
  expect(out).toContain("line 5");
  expect(out).not.toContain("… +");
});

test("a small diff renders untouched", async () => {
  const out = await frame(view({ arguments: { path: "f.ts" }, diff: bigDiff(5) }));
  expect(out).toContain("line 2");
  expect(out).not.toContain("… +");
});

test("a new-file write (content, no diff) is gated too", async () => {
  const content = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i}`).join("\n");
  const out = await frame(view({ arguments: { path: "f.ts", content } }));
  expect(out).toContain("+50");
  expect(out).not.toContain("const x5");
});

test("isOversizeMutation: mutations only, above the line gate", () => {
  const diff = bigDiff(MUTATION_GATE_LINES + 5);
  expect(isOversizeMutation({ mcpName: "edit_file", toolName: "", diff })).toBe(true);
  expect(isOversizeMutation({ mcpName: "edit_file", toolName: "", diff: bigDiff(3) })).toBe(false);
  expect(isOversizeMutation({ mcpName: "read_file", toolName: "", diff })).toBe(false);
});

test("isLeadMutation distinguishes the run lead from delegated mutations", () => {
  expect(isLeadMutation({ mcpName: "edit_file" })).toBe(true);
  expect(isLeadMutation({ mcpName: "apply_patch", subagentOrder: 0 })).toBe(false);
  expect(isLeadMutation({ mcpName: "read_file" })).toBe(false);
});

test("isOversizeMutation agrees with renderEdit on the synthesized-diff fallback (no meta.diff)", async () => {
  const newText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const args = { path: "f.ts", old_string: "old", new_string: newText };
  expect(isOversizeMutation({ mcpName: "edit_file", toolName: "", args })).toBe(true);
  const out = await frame(view({ mcpName: "edit_file", arguments: args, result: "edited" }));
  expect(out).toContain("… +65 lines");
  expect(out).toContain("(reconstructed)");
});

test("an oversize replace collapses to its summary plus a stats chip", async () => {
  const out = await frame(
    view({
      mcpName: "replace",
      arguments: { pattern: "foo", replacement: "bar" },
      diff: bigDiff(60),
      result: "Replaced 60 occurrence(s) in 1 file(s)",
    }),
  );
  expect(out).toContain("Replaced 60 occurrence(s)");
  expect(out).toContain("+60");
  expect(out).toContain("… +63 lines");
  expect(out).not.toContain("line 5");
});

test("full=true lifts the replace gate onto the per-file diffs", async () => {
  const out = await frame(
    view({
      mcpName: "replace",
      diff: bigDiff(60),
      result: "Replaced 60 occurrence(s) in 1 file(s)",
      full: true,
    }),
  );
  expect(out).toContain("line 5");
  expect(out).not.toContain("… +");
});

test("isOversizeMutation gates replace on its meta.diff, matching the renderer", () => {
  expect(isOversizeMutation({ mcpName: "replace", toolName: "", diff: bigDiff(80) })).toBe(true);
  expect(isOversizeMutation({ mcpName: "replace", toolName: "", diff: bigDiff(3) })).toBe(false);
  expect(isOversizeMutation({ mcpName: "replace", toolName: "" })).toBe(false);
});

test("memory writes gate under their own identity, like their file twins", async () => {
  const content = Array.from({ length: 50 }, (_, i) => `wiki line ${i}`).join("\n");
  const write = { mcpName: "write_memory", toolName: "", args: { path: "PROFILE.md", content } };
  expect(isOversizeMutation(write)).toBe(true);
  expect(mutationStats(write)).toEqual({ added: 50, removed: 0, lines: 50 });

  const newText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const edit = {
    mcpName: "edit_memory",
    toolName: "",
    args: { path: "PROFILE.md", old_string: "old", new_string: newText },
  };
  expect(isOversizeMutation(edit)).toBe(true);

  const out = await frame(
    view({ mcpName: "write_memory", arguments: { path: "PROFILE.md", content } }),
  );
  expect(out).toContain("+50");
  expect(out).not.toContain("wiki line 5");
});

test("apply_patch gates on the real meta.diff when present, else the patch argument", () => {
  const smallPatch = "+one\n+two";
  expect(
    isOversizeMutation({ mcpName: "apply_patch", toolName: "", args: { patch: smallPatch } }),
  ).toBe(false);
  expect(
    isOversizeMutation({
      mcpName: "apply_patch",
      toolName: "",
      diff: bigDiff(80),
      args: { patch: smallPatch },
    }),
  ).toBe(true);
});
