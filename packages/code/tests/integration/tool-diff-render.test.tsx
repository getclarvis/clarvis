import { expect, test } from "bun:test";
import { DiffRenderable, type Renderable } from "@opentui/core";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { diffHeaderPath } from "../../src/views/tools/registry.tsx";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import type { FoldFixtureToolNode } from "../helpers/transcript-fixtures.ts";

const REAL_DIFF = [
  "--- a.ts",
  "+++ a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
].join("\n");

let seq = 0;

function diffRenderables(root: Renderable): DiffRenderable[] {
  const found: DiffRenderable[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof DiffRenderable) found.push(node);
    for (const child of node.getChildren()) visit(child as Renderable);
  };
  visit(root);
  return found;
}
function toolNode(over: Partial<FoldFixtureToolNode>): FoldFixtureToolNode {
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
  };
}

async function frame(node: TranscriptNode): Promise<string> {
  const t = await openRender(() => <BlockView node={node} forceExpand={() => true} />, {
    width: 100,
    height: 40,
  });
  let out = "";
  let stable = 0;
  for (let index = 0; index < 80; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8));
    await t.renderOnce();
    const next = t.captureCharFrame();
    const ready = diffRenderables(t.renderer.root).every((renderable) => renderable.opacity === 1);
    stable = next === out && ready ? stable + 1 : 0;
    out = next;
    if (stable >= 2) break;
  }
  t.renderer.destroy();
  return out;
}

test("edit_file with a real diff renders it (no `(reconstructed)` label)", async () => {
  const out = await frame(toolNode({ diff: REAL_DIFF }));
  expect(out).toContain("TWO");
  expect(out).toContain("two");
  expect(out).not.toContain("(reconstructed)");
});

test("edit_file without a diff falls back to the args-reconstructed diff", async () => {
  const out = await frame(toolNode({ diff: undefined }));
  expect(out).toContain("(reconstructed)");
  expect(out).toContain("TWO");
});

test("write_file overwrite renders the before/after diff", async () => {
  const out = await frame(
    toolNode({
      toolName: "write_file",
      args: { path: "a.ts", content: "one\nTWO\nthree\n" },
      result: "Wrote 14 bytes to a.ts (overwritten).",
      diff: REAL_DIFF,
    }),
  );
  expect(out).toContain("TWO");
  expect(out).toContain("two");
});

test("write_file on a new file (no diff) shows the full new content", async () => {
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

test("diffHeaderPath reads the filetype path from the jsdiff `+++ <relpath>` header", () => {
  expect(diffHeaderPath(REAL_DIFF)).toBe("a.ts");
  expect(diffHeaderPath("Index: src/x.ts\n===\n--- src/x.ts\n+++ src/x.ts\n@@ @@\n+x")).toBe(
    "src/x.ts",
  );
});

test("diffHeaderPath strips git a/ b/ prefixes and skips /dev/null to the surviving side", () => {
  expect(diffHeaderPath("--- a/src/x.ts\n+++ b/src/x.ts\n@@ @@\n+x")).toBe("src/x.ts");
  expect(diffHeaderPath("--- src/gone.ts\n+++ /dev/null\n@@ @@\n-x")).toBe("src/gone.ts");
  expect(diffHeaderPath("no headers at all")).toBeUndefined();
});

test("write_memory renders the write card with its markdown body, not a generic dump", async () => {
  const out = await frame(
    toolNode({
      toolName: "write_memory",
      args: { path: "PROFILE.md", content: "# Profile\n- Bun workspace" },
      result: "Wrote PROFILE.md.",
      diff: undefined,
    }),
  );
  expect(out).toContain("Wrote PROFILE.md.");
  expect(out).toContain("- Bun workspace");
});

test("edit_memory renders the reconstructed diff, exactly like edit_file", async () => {
  const out = await frame(
    toolNode({
      toolName: "edit_memory",
      args: { path: "infra/TOPIC.md", old_string: "two", new_string: "TWO" },
      result: "Edited infra/TOPIC.md.",
      diff: undefined,
    }),
  );
  expect(out).toContain("(reconstructed)");
  expect(out).toContain("TWO");
  expect(out).toContain("two");
});

test("a replace renders its summary plus one highlighted diff per touched file", async () => {
  const perFile = (rel: string, old: string, neu: string): string =>
    [
      `Index: ${rel}`,
      "===================================================================",
      `--- ${rel}`,
      `+++ ${rel}`,
      "@@ -1 +1 @@",
      `-${old}`,
      `+${neu}`,
    ].join("\n");
  const out = await frame(
    toolNode({
      toolName: "replace",
      args: { pattern: "foo", replacement: "bar" },
      result: "Replaced 2 occurrence(s) in 2 file(s):\n  M one.ts (1 replacement)",
      diff: perFile("one.ts", "foo1", "bar1") + "\n" + perFile("two.ts", "foo2", "bar2"),
    }),
  );
  expect(out).toContain("Replaced 2 occurrence(s)");
  expect(out).toContain("bar1");
  expect(out).toContain("bar2");
});

test("the diff tool renders its unified result as a diff, not plain text", async () => {
  const out = await frame(
    toolNode({
      toolName: "diff",
      args: { from: "a.ts", to: "b.ts" },
      result: REAL_DIFF,
      diff: undefined,
    }),
  );
  expect(out).toContain("TWO");
  expect(out).toContain("two");
});

test("the diff tool's no-difference result stays a muted one-liner", async () => {
  const out = await frame(
    toolNode({
      toolName: "diff",
      args: { from: "a.ts", to: "b.ts" },
      result: "(no differences)",
      diff: undefined,
    }),
  );
  expect(out).toContain("(no differences)");
});

test("every diff normalizes CRLF and bare CR before it reaches OpenTUI", async () => {
  const source = REAL_DIFF.replace(/\n/g, "\r\n").replace(" one\r\n", " one\r");
  const t = await openRender(
    () => <BlockView node={toolNode({ diff: source })} forceExpand={() => true} />,
    { width: 100, height: 40 },
  );
  try {
    await t.waitForFrame((captured) => captured.includes("TWO"));
    const rendered = diffRenderables(t.renderer.root);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.diff).not.toContain("\r");
    expect(rendered[0]!.diff).toBe(source.replace(/\r\n/g, "\n").replace(/\r/g, ""));
  } finally {
    t.renderer.destroy();
  }
});

test("a finalized diff keeps one renderable while an active sibling updates", async () => {
  const node = toolNode({ diff: REAL_DIFF });
  const [activity, setActivity] = createSignal(0);
  const t = await openRender(
    () => (
      <box flexDirection="column">
        <BlockView node={node} forceExpand={() => true} />
        <text>{`activity ${activity()}`}</text>
      </box>
    ),
    { width: 100, height: 40 },
  );
  try {
    await t.waitForFrame((captured) => captured.includes("TWO"));
    const stable = diffRenderables(t.renderer.root);
    expect(stable).toHaveLength(1);
    expect(stable[0]!.opacity).toBe(1);

    for (let index = 1; index <= 8; index += 1) {
      setActivity(index);
      await t.renderOnce();
      expect(diffRenderables(t.renderer.root)).toEqual(stable);
      expect(t.captureCharFrame()).toContain("TWO");
    }
  } finally {
    t.renderer.destroy();
  }
});
