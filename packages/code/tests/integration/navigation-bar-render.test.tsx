import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { KeymapProvider } from "@opentui/keymap/solid";
import { createTestKeymap } from "@opentui/keymap/testing";
import { registerTimedLeader } from "@opentui/keymap/addons";
import type { Keymap } from "@opentui/keymap";
import { TextRenderable, type KeyEvent, type Renderable } from "@opentui/core";
import { openRender } from "../helpers/tracked-render.ts";
import { registerUiActionFields, uiCommand } from "../../src/keys/actions.ts";
import { LAYER } from "../../src/keys/keyspec.ts";
import type { KeyboardEnvironment } from "../../src/keys/keyboard-profile.ts";
import { NavigationBar } from "../../src/ui/patterns/navigation-bar.tsx";

const ENVIRONMENT: KeyboardEnvironment = {
  transport: "local",
  runtimePlatform: "linux",
  terminal: { name: "test" },
  protocol: "kitty",
  multiplexer: "unknown",
  modifiers: {
    ctrl: "supported",
    shift: "supported",
    meta: "supported",
    super: "supported",
    hyper: "supported",
  },
  baseLayout: "supported",
  profile: "enhanced",
};

/**
 * A keymap whose shell command and page verb share one sequence.
 *
 * @remarks This is the shape the Plan page has in the application: `plan.open`
 *   lives in the shell layer and the open page binds the same `Ctrl+X P` to its
 *   own close verb, which wins.
 */
function twoLayerKeymap() {
  const test = createTestKeymap({ defaultKeys: true });
  registerUiActionFields(test.keymap as never);
  registerTimedLeader(test.keymap, { trigger: "ctrl+x", timeoutMs: 2_000 });
  test.keymap.registerLayer({
    commands: [
      uiCommand({
        id: "plan.open",
        title: "Plan details",
        description: "Open the current or latest plan full-screen",
        category: "navigate",
        surfaces: ["footer", "full-help"],
        footerLabel: "open plan",
        footerShortLabel: "plan",
        hintPriority: 55,
        hintGroup: "navigation",
        run: () => {},
      }),
    ],
    bindings: [{ key: "<leader>p", cmd: "plan.open" }],
  });
  test.keymap.registerLayer({
    priority: LAYER.OVERLAY,
    commands: [
      uiCommand({
        id: "ui.level.close",
        title: "Close plan",
        description: "Return to the transcript",
        category: "escape",
        surfaces: ["footer", "full-help"],
        footerLabel: "close",
        hintPriority: 100,
        hintGroup: "escape",
        essential: true,
        run: () => {},
      }),
    ],
    bindings: [
      { key: "<leader>p", cmd: "ui.level.close" },
      { key: "escape", cmd: "ui.level.close" },
    ],
  });
  return test;
}

/** The narrowest width the shell paints a band at: below this the floor screen owns the frame. */
const MIN_BAND_WIDTH = 24;

async function openBand(width: () => number, keymap: Keymap<Renderable, KeyEvent>) {
  return openRender(
    (() => (
      <KeymapProvider keymap={keymap}>
        <NavigationBar environment={() => ENVIRONMENT} width={width} />
      </KeymapProvider>
    )) as never,
    { width: 100, height: 10 },
  );
}

/** The band's own painted rows, independent of the renderer's frame width. */
function bandLines(root: Renderable): string[] {
  const lines: string[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof TextRenderable && node.plainText.trim().length > 0)
      lines.push(node.plainText);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return lines;
}

test("a command whose sequence a higher layer took is not announced beside it", async () => {
  const test = twoLayerKeymap();
  const t = await openBand(() => 100, test.keymap as unknown as Keymap<Renderable, KeyEvent>);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("close");
  expect(frame).not.toContain("open plan");
  t.renderer.destroy();
  test.cleanup();
});

test("the pending prefix names the continuation the keymap would dispatch", async () => {
  const test = twoLayerKeymap();
  const t = await openBand(() => 100, test.keymap as unknown as Keymap<Renderable, KeyEvent>);
  await t.renderOnce();
  test.host.press("x", { ctrl: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Ctrl+X active");
  expect(frame).toContain("close");
  expect(frame).not.toContain("open plan");
  // The activity band is not part of this component: exactly one indication.
  expect(frame.match(/Ctrl\+X active/g)?.length).toBe(1);

  test.host.press("escape");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Ctrl+X active");
  t.renderer.destroy();
  test.cleanup();
});

test("the pending continuation wraps inside its band instead of clipping", async () => {
  const test = twoLayerKeymap();
  const [width, setWidth] = createSignal(100);
  const t = await openBand(width, test.keymap as unknown as Keymap<Renderable, KeyEvent>);
  await t.renderOnce();
  setWidth(24);
  test.host.press("x", { ctrl: true });
  await t.renderOnce();
  const rows = bandLines(t.renderer.root);
  expect(rows[0]).toContain("Ctrl+X active");
  for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(24);
  // The prefix is named once, on the row the continuations start from.
  expect(t.captureCharFrame().match(/Ctrl\+X active/g)?.length).toBe(1);
  t.renderer.destroy();
  test.cleanup();
});

test("a bracket key stays readable inside the segment wrapper", async () => {
  const test = createTestKeymap({ defaultKeys: true });
  registerUiActionFields(test.keymap as never);
  test.keymap.registerLayer({
    commands: [
      uiCommand({
        id: "diff.comparison.next",
        title: "Next comparison",
        description: "Cycle the workspace comparison",
        category: "navigate",
        surfaces: ["footer"],
        footerLabel: "view",
        run: () => {},
      }),
    ],
    bindings: [{ key: "[", cmd: "diff.comparison.next" }],
  });
  const t = await openBand(() => 100, test.keymap as unknown as Keymap<Renderable, KeyEvent>);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("[ [ ] view");
  expect(frame).not.toContain("[[]");
  t.renderer.destroy();
  test.cleanup();
});

test("a narrow band keeps every action and repeats the shared prefix", async () => {
  const test = createTestKeymap({ defaultKeys: true });
  registerUiActionFields(test.keymap as never);
  const surfaces = ["footer", "full-help"] as const;
  test.keymap.registerLayer({
    commands: [
      uiCommand({
        id: "isolation.picker",
        title: "Isolation",
        description: "Pick isolation",
        category: "navigate",
        surfaces: [...surfaces],
        footerLabel: "isolation",
        hintPriority: 50,
        hintGroup: "navigation",
        run: () => {},
      }),
      uiCommand({
        id: "memory.picker",
        title: "Memory",
        description: "Pick memory",
        category: "navigate",
        surfaces: [...surfaces],
        footerLabel: "memory",
        hintPriority: 49,
        hintGroup: "navigation",
        run: () => {},
      }),
    ],
    bindings: [
      { key: "ctrl+x i", cmd: "isolation.picker" },
      { key: "ctrl+x m", cmd: "memory.picker" },
    ],
  });
  const [width, setWidth] = createSignal(100);
  const t = await openRender(
    (() => (
      <KeymapProvider keymap={test.keymap as never}>
        <NavigationBar environment={() => ENVIRONMENT} width={width} responsive />
      </KeymapProvider>
    )) as never,
    { width: 100, height: 10 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("[I] isolation  [M] memory");

  setWidth(MIN_BAND_WIDTH);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("isolation");
  expect(frame).toContain("memory");
  const rows = bandLines(t.renderer.root);
  for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(MIN_BAND_WIDTH);
  expect(rows.join("\n").match(/Ctrl\+X:/g)?.length).toBeGreaterThan(1);
  t.renderer.destroy();
  test.cleanup();
});
