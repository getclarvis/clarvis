import { describe, expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { createMutable } from "solid-js/store";
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { TranscriptRegion } from "../../src/views/app/TranscriptRegion.tsx";
import type {
  TranscriptRegionLayout,
  TranscriptRegionProps,
} from "../../src/views/app/TranscriptRegion.tsx";
import { createTranscriptState, type TranscriptState } from "../../src/views/transcript-state.ts";
import type { TranscriptNode, TranscriptStore } from "../../src/adapters/store.ts";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { LayoutMode } from "../../src/app/layout.ts";

/** `turns` turns of a user message, a reply, and `perTurn` tool calls. */
function transcript(turns: number, perTurn: number): TranscriptNode[] {
  const nodes: TranscriptNode[] = [];
  for (let t = 0; t < turns; t += 1) {
    nodes.push({ key: `user:${t}`, kind: "user", status: "ok", text: `ask ${t}` });
    nodes.push({ key: `e${t}::msg`, kind: "assistant", status: "ok", text: `reply ${t}` });
    for (let i = 0; i < perTurn; i += 1) {
      nodes.push({
        key: `e${t}::call-${i}`,
        kind: "tool_call",
        status: "ok",
        text: "",
        mcpName: "",
        toolName: "read_file",
        args: { path: `f${i}.ts` },
        result: "ok",
        error: null,
      } as TranscriptNode);
    }
  }
  return nodes;
}

function layout(): TranscriptRegionLayout {
  return {
    mode: () => "wide" as LayoutMode,
    sidebarVisible: () => false,
    sidebarWidth: () => 28,
    drawerOpen: () => false,
    contentInset: () => 0,
    width: () => 120,
  };
}

function propsFor(
  nodes: TranscriptNode[],
  notes: string[],
): { props: TranscriptRegionProps; ts: TranscriptState } {
  const store = { nodes, defaultFolded: () => false } as unknown as TranscriptStore;
  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const ts = createTranscriptState({
    nodes: () => store.nodes,
    subagents: () => [],
    notify: () => {},
  });
  return {
    ts,
    props: {
      store,
      transcript: ts,
      activity,
      interaction: {
        keymap: { registerLayer: () => () => {} } as unknown as Keymap<Renderable, KeyEvent>,
        pushOverlayContext: () => {},
        popOverlayContext: () => {},
        syncContext: () => {},
      } as unknown as Interaction,
      run: { elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null },
      layout: layout(),
      contextWindow: () => 1_024_000,
      agent: () => "coder",
      model: () => "m",
      notify: (message) => notes.push(message),
      openPlan: () => {},
      onScrollbox: () => {},
    },
  };
}

/**
 * Render the region and capture it, optionally scrolled back to the top.
 *
 * @remarks The transcript's scrollbox is `stickyStart="bottom"`, so a capture
 *   taken as-is shows the newest turns and the anchor row — the *first* child —
 *   is simply off-screen. Scrolling to the top is what a user does to reach it,
 *   and it is the only way this assertion sees the row at all.
 */
async function frameOf(
  props: TranscriptRegionProps,
  opts: { toTop?: boolean } = {},
): Promise<{ frame: string; destroy: () => void }> {
  let scrollEl: ScrollBoxRenderable | undefined;
  const withRef: TranscriptRegionProps = {
    ...props,
    onScrollbox: (el) => {
      scrollEl = el;
      props.onScrollbox(el);
    },
  };
  const t = await openRender(() => <TranscriptRegion {...withRef} />, { width: 120, height: 34 });
  await t.renderOnce();
  await t.renderOnce();
  if (opts.toTop && scrollEl) {
    scrollEl.scrollTop = 0;
    await t.renderOnce();
  }
  return { frame: t.captureCharFrame(), destroy: () => t.renderer.destroy() };
}

describe("the transcript window anchor", () => {
  test("a windowed transcript shows how many turns it is holding back", async () => {
    const notes: string[] = [];
    const { props, ts } = propsFor(transcript(200, 4), notes);
    expect(ts.window().hiddenTurns).toBeGreaterThan(0);
    const r = await frameOf(props, { toTop: true });
    expect(r.frame).toContain(`${ts.window().hiddenTurns} earlier turns`);
    expect(r.frame).toContain("to load");
    r.destroy();
  });

  test("a short transcript shows no anchor at all", async () => {
    const notes: string[] = [];
    const { props } = propsFor(transcript(3, 2), notes);
    const r = await frameOf(props, { toTop: true });
    expect(r.frame).not.toContain("earlier turn");
    expect(r.frame).not.toContain("earlier block");
    r.destroy();
  });

  test("the anchor's count shrinks as earlier turns are loaded", async () => {
    const notes: string[] = [];
    const { props, ts } = propsFor(transcript(200, 4), notes);
    const first = ts.window().hiddenTurns;
    ts.loadEarlier();
    expect(ts.window().hiddenTurns).toBeLessThan(first);

    const r = await frameOf(props, { toTop: true });
    expect(r.frame).toContain(`${ts.window().hiddenTurns} earlier turns`);
    r.destroy();
  });

  test("the anchor disappears once the window reaches the start", async () => {
    const notes: string[] = [];
    const { props, ts } = propsFor(transcript(200, 4), notes);
    let guard = 0;
    while (!ts.window().atStart && guard < 100) {
      ts.loadEarlier();
      guard += 1;
    }
    expect(ts.window().atStart).toBe(true);
    const r = await frameOf(props, { toTop: true });
    expect(r.frame).not.toContain("earlier turn");
    r.destroy();
  });

  test("only the windowed turns are rendered", async () => {
    const notes: string[] = [];
    const { props, ts } = propsFor(transcript(200, 4), notes);
    const r = await frameOf(props);
    const shown = ts.window().nodes;
    expect(r.frame).not.toContain("ask 0");
    expect(r.frame).toContain(`ask ${199}`);
    expect(shown.some((n) => n.key === "user:199")).toBe(true);
    r.destroy();
  });
});
