import { expect, test } from "bun:test";
import { For } from "solid-js";
import { createStore } from "solid-js/store";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex, TextRenderable, type Renderable } from "@opentui/core";
import { BlockView } from "../../src/views/blocks.tsx";
import type { BlockOverride } from "../../src/views/block-focus.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { focusBg, selectionBg } from "../../src/theme/surfaces.ts";
import type { FoldFixtureNode } from "../helpers/transcript-fixtures.ts";

let seq = 0;
function bash(result: string, collapsed = true): FoldFixtureNode {
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
  const t = await openRender(
    () => (
      <box flexDirection="column">
        <For each={nodes}>
          {(node) => (
            <BlockView
              node={node}
              forceExpand={() => false}
              defaultFolded={() => (node as FoldFixtureNode).collapsed ?? false}
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

test("a live shell control paints a compact close target", async () => {
  const node: TranscriptNode = {
    key: "sh1",
    kind: "tool_call",
    status: "running",
    toolPhase: "running",
    text: "",
    toolName: "shell",
    args: { command: "sleep 30" },
    control: { tool_execution_id: "tok_shell", actions: ["interrupt"] },
  };
  const t = await openRender(() => <BlockView node={node} canInterruptShell={() => true} />, {
    width: 120,
    height: 8,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("[X]");
  t.renderer.destroy();
});

test("a per-block 'expanded' override opens a collapsed tool body", async () => {
  const node = bash("hello-from-stdout");
  expect((await frame([node], new Map())).includes("hello-from-stdout")).toBe(false);
  const open = new Map<string, BlockOverride>([[node.key, "expanded"]]);
  expect((await frame([node], open)).includes("hello-from-stdout")).toBe(true);
});

test("narrow shell headers place the stable close target immediately after elapsed time", async () => {
  const [node, setNode] = createStore<Extract<TranscriptNode, { kind: "tool_call" }>>({
    key: "shell-click",
    kind: "tool_call",
    text: "",
    toolName: "shell",
    status: "running",
    toolPhase: "running",
    control: { tool_execution_id: "tok_click", actions: ["interrupt"] },
    args: {
      command: "echo a very long shell command signature that must truncate before the action",
    },
    startedAt: Date.now() - 30_000,
  });
  let stops = 0;
  let folds = 0;
  const t = await openRender(
    () => (
      <BlockView
        node={node}
        defaultFolded={() => true}
        canInterruptShell={() => node.interruptRequest !== "pending"}
        onInterruptShell={() => {
          stops++;
          setNode("interruptRequest", "pending");
        }}
        onToggle={() => {
          folds++;
        }}
      />
    ),
    { width: 52, height: 20 },
  );
  const texts = (root: Renderable): TextRenderable[] => [
    ...(root instanceof TextRenderable ? [root] : []),
    ...root.getChildren().flatMap(texts),
  ];
  const click = async (label: string) => {
    await t.renderOnce();
    const action = texts(t.renderer.root).find((text) => text.plainText.includes(label))!;
    expect(action).toBeDefined();
    expect(action.width).toBe(4);
    expect(action.height).toBe(1);
    expect(action.x + action.width).toBeLessThanOrEqual(52);
    const identity = texts(t.renderer.root).find((text) => text.plainText.includes("shell("))!;
    expect(identity.y).toBe(action.y);
    expect(identity.height).toBe(1);
    expect(identity.x + identity.width).toBe(action.x);
    const lines = t.captureCharFrame().split("\n");
    const actionSpan = t
      .captureSpans()
      .lines[action.y]!.spans.find((span) => span.text.includes(label));
    expect(actionSpan?.text.endsWith(` ${label}`)).toBe(true);
    expect(lines.filter((line) => line.trim().length > 0)).toHaveLength(1);
    expect(lines[action.y]).not.toContain("before the action");
    await t.mockMouse.click(action.x + 2, action.y);
    await t.renderOnce();
  };
  await click("[X]");
  expect(stops).toBe(1);
  expect(folds).toBe(0);
  expect(t.captureCharFrame()).toContain("[X]");
  await click("[X]");
  expect(stops).toBe(1);
  expect(folds).toBe(0);
  setNode({
    status: "error",
    toolPhase: "interrupted",
    interruption: { source: "operator" },
    control: undefined,
    interruptRequest: undefined,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("[X]");
  expect(t.captureCharFrame()).toContain("Interrupted by operator");
});

test("interrupted scope and composition rows do not blame the operator", async () => {
  for (const error of [
    "Execution scope closed without an authoritative tool result.",
    "Argument composition interrupted by a model retry.",
  ]) {
    const node: TranscriptNode = {
      key: error,
      kind: "tool_call",
      status: "error",
      toolPhase: "interrupted",
      text: "",
      toolName: "shell",
      error,
    };
    const out = await frame([node], new Map());
    expect(out).toContain(error);
    expect(out).not.toContain("Interrupted by operator");
  }
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
  const node: FoldFixtureNode = {
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
