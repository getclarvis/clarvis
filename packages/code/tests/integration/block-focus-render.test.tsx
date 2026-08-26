import { expect, test } from "bun:test";
import { For } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex } from "@opentui/core";
import { BlockView } from "../../src/views/blocks.tsx";
import { computeToolGroups } from "../../src/views/tool-groups.ts";
import type { BlockOverride } from "../../src/views/block-focus.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { focusBg, selectionBg } from "../../src/theme/surfaces.ts";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

let seq = 0;
function bash(result: string, collapsed = true): LegacyCollapsibleNode {
  return {
    key: `b${seq++}`,
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "shell",
    toolName: "",
    args: { command: "run" },
    result: JSON.stringify({ exit_code: 0, stdout: result, stderr: "" }),
    error: null,
    collapsed,
  };
}

async function frame(
  nodes: TranscriptNode[],
  overrides: ReadonlyMap<string, BlockOverride>,
): Promise<string> {
  const groups = computeToolGroups(nodes);
  const t = await openRender(
    () => (
      <box flexDirection="column">
        <For each={nodes}>
          {(node) => (
            <BlockView
              node={node}
              forceExpand={() => false}
              group={() => groups.get(node.key)}
              overrideOf={(key) => overrides.get(key)}
            />
          )}
        </For>
      </box>
    ),
    { width: 100, height: 80 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("a per-block 'expanded' override opens a collapsed tool body", async () => {
  const node = bash("hello-from-stdout");
  expect((await frame([node], new Map())).includes("hello-from-stdout")).toBe(false);
  const open = new Map<string, BlockOverride>([[node.key, "expanded"]]);
  expect((await frame([node], open)).includes("hello-from-stdout")).toBe(true);
});

test("the explicit expand lifts the 10-line clamp (full body, no '+N more lines')", async () => {
  const lines = Array.from({ length: 25 }, (_, i) => `LINE-${i}`).join("\n");
  const node = bash(lines);
  const open = new Map<string, BlockOverride>([[node.key, "expanded"]]);
  const out = await frame([node], open);
  expect(out).toContain("LINE-24");
  expect(out).not.toContain("more lines");
});

test("a focused block paints the shared focus wash at selection weight", async () => {
  const node: LegacyCollapsibleNode = {
    key: "a1",
    kind: "annotation",
    status: "ok",
    text: "note-under-focus",
  };
  const t = await openRender(() => <BlockView node={node} focused={() => true} />, {
    width: 60,
    height: 6,
  });
  await t.renderOnce();
  const frame = t.captureSpans();
  t.renderer.destroy();
  const span = frame.lines.flatMap((l) => l.spans).find((s) => s.text.includes("note-under-focus"));
  expect(span).toBeDefined();
  expect(rgbToHex(span!.bg).toLowerCase()).toBe(focusBg().toLowerCase());
  expect(focusBg()).toBe(selectionBg());
});

test("a head 'expanded' override explodes the group and lifts members' clamps", async () => {
  const a = bash("alpha-body");
  const b = bash("beta-body");
  const collapsed = await frame([a, b], new Map());
  expect(collapsed).toContain("x2");
  expect(collapsed.includes("alpha-body")).toBe(false);
  const open = new Map<string, BlockOverride>([[a.key, "expanded"]]);
  const out = await frame([a, b], open);
  expect(out).not.toContain("x2");
  expect(out).toContain("alpha-body");
  expect(out).toContain("beta-body");
});
