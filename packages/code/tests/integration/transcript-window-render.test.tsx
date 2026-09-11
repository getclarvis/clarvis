import { describe, expect, test } from "bun:test";
import {
  MouseEvent,
  type KeyEvent,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { createMutable } from "solid-js/store";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import type { TranscriptNode, TranscriptStore } from "../../src/adapters/store.ts";
import type { TranscriptPublicationBatch } from "../../src/adapters/transcript-publication.ts";
import type { LayoutMode } from "../../src/app/layout.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { TranscriptRegion } from "../../src/views/app/TranscriptRegion.tsx";
import type { TranscriptRegionProps } from "../../src/views/app/TranscriptRegion.tsx";
import {
  CommittedHistory,
  type CommittedHistoryHandle,
} from "../../src/views/history/CommittedHistory.tsx";
import {
  TRANSCRIPT_FULL_MOUNT_CEILING,
  TRANSCRIPT_MOUNTED_BATCH_COUNT,
} from "../../src/views/history/visible-slice.ts";
import { createTranscriptState, type TranscriptState } from "../../src/views/transcript-state.ts";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";

function transcript(turns: number, perTurn: number): TranscriptNode[] {
  const nodes: TranscriptNode[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    nodes.push({ key: `user:${turn}`, kind: "user", status: "ok", text: `ask ${turn}` });
    nodes.push({ key: `e${turn}::msg`, kind: "assistant", status: "ok", text: `reply ${turn}` });
    for (let index = 0; index < perTurn; index += 1) {
      nodes.push({
        key: `e${turn}::call-${index}`,
        kind: "tool_call",
        status: "ok",
        text: "",
        mcpName: "",
        toolName: "read_file",
        args: { path: `f${index}.ts` },
        result: "ok",
        error: null,
      } as TranscriptNode);
    }
  }
  return nodes;
}

function publication(node: TranscriptNode, index: number): TranscriptPublicationBatch {
  return {
    id: `fixture:${index}`,
    kind: node.kind === "user" ? "user" : "annotation",
    nodes: [node],
    defaultFolded: { [node.key]: false },
    toolGroups: {},
    sectionHeaders: {},
    sectionAnchors: {},
    sectionFoldedKeys: [],
    phase: "committed",
    ready: true,
  };
}

function fixture(
  nodes: TranscriptNode[],
  dimensions: { width: number; height: number } = { width: 120, height: 34 },
): { props: TranscriptRegionProps; ts: TranscriptState } {
  const publications = nodes.map(publication);
  const store = {
    nodes,
    publicationBatches: publications,
    frontierNodes: () => [],
    committedNodes: () => nodes,
    markPublicationReady: () => {},
    defaultFolded: () => false,
  } as unknown as TranscriptStore;
  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const ts = createTranscriptState({
    nodes: () => store.nodes,
    preserveOrder: true,
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
      layout: {
        mode: () => "wide" as LayoutMode,
        sidebarVisible: () => false,
        sidebarWidth: () => 28,
        drawerOpen: () => false,
        contentInset: () => 0,
        width: () => dimensions.width,
        height: () => dimensions.height,
      },
      contextWindow: () => 1_024_000,
      agent: () => "coder",
      model: () => "m",
      notify: () => {},
      openPlan: () => {},
      onScrollbox: () => {},
    },
  };
}

async function renderFixture(
  nodes: TranscriptNode[],
  dimensions: { width: number; height: number } = { width: 120, height: 34 },
) {
  const { props, ts } = fixture(nodes, dimensions);
  let scrollbox: ScrollBoxRenderable | undefined;
  let history: CommittedHistoryHandle | undefined;
  const rendered = await openRender(
    () => (
      <TranscriptRegion
        {...props}
        onScrollbox={(value) => (scrollbox = value)}
        onHistoryHandle={(value) => (history = value)}
      />
    ),
    dimensions,
  );
  if (scrollbox === undefined || history === undefined) throw new Error("history refs not mounted");
  const mountedScrollbox = scrollbox;
  const mountedHistory = history;
  await settleSyntaxSurfaces(rendered);
  for (let pass = 0; pass < 50; pass += 1) await rendered.renderOnce();
  return { rendered, scrollbox: mountedScrollbox, history: mountedHistory, ts };
}

function descendants(root: Renderable): Renderable[] {
  const found: Renderable[] = [];
  const visit = (node: Renderable): void => {
    found.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

function wheel(scrollbox: ScrollBoxRenderable, direction: "up" | "down", delta: number): void {
  scrollbox.processMouseEvent(
    new MouseEvent(scrollbox, {
      type: "scroll",
      button: 0,
      x: scrollbox.x + 2,
      y: scrollbox.y + 2,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: { direction, delta },
    }),
  );
}

describe("the index transcript window", () => {
  test("short history mounts every committed owner", async () => {
    const nodes = transcript(2, 1);
    const { rendered, history, scrollbox } = await renderFixture(nodes);
    try {
      expect(nodes.length).toBeLessThanOrEqual(TRANSCRIPT_FULL_MOUNT_CEILING);
      expect(history.snapshot()).toMatchObject({
        earlierUnknown: 0,
        laterUnknown: 0,
        followingTail: true,
        navigating: false,
      });
      expect(history.snapshot().activeBatchIds).toHaveLength(nodes.length);
      expect(scrollbox.viewportCulling).toBe(true);
      expect(scrollbox.stickyScroll).toBe(true);
      expect(
        descendants(rendered.renderer.root).filter((node) =>
          node.id.startsWith("history:fixture:"),
        ),
      ).toHaveLength(nodes.length);
      expect(rendered.renderer.root.findDescendantById("live-transcript-tail")).toBeDefined();
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("long history mounts a sliding index window instead of every owner", async () => {
    const nodes = transcript(200, 4);
    const { rendered, history } = await renderFixture(nodes);
    try {
      expect(nodes.length).toBeGreaterThan(TRANSCRIPT_FULL_MOUNT_CEILING);
      const snapshot = history.snapshot();
      expect(snapshot.activeBatchIds.length).toBe(TRANSCRIPT_MOUNTED_BATCH_COUNT);
      expect(snapshot.earlierUnknown).toBeGreaterThan(0);
      expect(snapshot.laterUnknown).toBe(0);
      expect(snapshot.activeBatchIds.at(-1)).toBe(`fixture:${nodes.length - 1}`);
      expect(
        descendants(rendered.renderer.root).filter((node) =>
          node.id.startsWith("history:fixture:"),
        ),
      ).toHaveLength(snapshot.activeBatchIds.length);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("uses direct ScrollBox children with native viewport culling always on", async () => {
    const { rendered, scrollbox } = await renderFixture(transcript(30, 3));
    try {
      expect(scrollbox.viewportCulling).toBe(true);
      const all = descendants(rendered.renderer.root);
      expect(all.some((node) => node.id === "history-page")).toBe(false);
      const owners = all.filter((node) => node.id.startsWith("history:fixture:"));
      expect(owners.length).toBeGreaterThan(0);
      expect(owners.every((owner) => owner.parent === scrollbox.content)).toBe(true);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("explicit navigation pauses native stick until the tail is revealed", async () => {
    const nodes = transcript(120, 0);
    const { rendered, scrollbox, history } = await renderFixture(nodes);
    try {
      expect(history.revealKey(nodes[0]!.key)).toBe(true);
      for (let pass = 0; pass < 20; pass += 1) await rendered.renderOnce();
      expect(history.snapshot().navigating).toBe(true);
      expect(scrollbox.stickyScroll).toBe(false);
      expect(history.snapshot().activeBatchIds).toContain("fixture:0");
      expect(rendered.captureCharFrame()).toContain("ask 0");
      expect(rendered.renderer.root.findDescendantById("live-transcript-tail")).toBeDefined();

      expect(history.returnToTail()).toBe(true);
      for (let pass = 0; pass < 20; pass += 1) await rendered.renderOnce();
      expect(history.snapshot()).toMatchObject({
        followingTail: true,
        navigating: false,
        laterUnknown: 0,
      });
      expect(scrollbox.stickyScroll).toBe(true);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("native scrollbar movement is free after returning to the tail", async () => {
    const { rendered, scrollbox, history } = await renderFixture(transcript(30, 1));
    try {
      history.returnToTail();
      for (let pass = 0; pass < 3; pass += 1) await rendered.renderOnce();
      const maxScrollTop = Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
      const manualTop = Math.max(0, maxScrollTop - scrollbox.viewport.height);
      expect(manualTop).toBeLessThan(maxScrollTop);
      scrollbox.scrollTo({ x: 0, y: manualTop });
      await rendered.renderOnce();
      await rendered.renderOnce();
      expect(scrollbox.scrollTop).toBe(manualTop);
      expect(history.snapshot().followingTail).toBe(false);
      expect(rendered.renderer.root.findDescendantById("live-transcript-tail")).toBeDefined();
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("wheel-up over a long stream does not clamp back to the tail", async () => {
    const { rendered, scrollbox, history } = await renderFixture(transcript(40, 1));
    try {
      const followedTop = scrollbox.scrollTop;
      wheel(scrollbox, "up", 8);
      await rendered.renderOnce();
      await rendered.renderOnce();
      expect(scrollbox.scrollTop).toBeLessThan(followedTop);
      expect(history.snapshot().followingTail).toBe(false);
      expect(rendered.renderer.root.findDescendantById("live-transcript-tail")).toBeDefined();
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("keyboard-sized navigation reveals both index edges and returns to the tail", async () => {
    const nodes = Array.from(
      { length: TRANSCRIPT_FULL_MOUNT_CEILING + 1 },
      (_, index): TranscriptNode => ({
        key: `navigation:${index}`,
        kind: "user",
        status: "ok",
        text: `ask ${index}`,
      }),
    );
    const { rendered, history } = await renderFixture(nodes);
    try {
      expect(history.scrollBy(0)).toBe("scrolled");
      expect(history.scrollBy(-10_000)).toBe("preparing");
      for (let pass = 0; pass < 10; pass += 1) await rendered.renderOnce();
      expect(history.snapshot().laterUnknown).toBeGreaterThan(0);
      expect(history.scrollBy(10_000)).toBe("preparing");

      let laterRequests = 0;
      while (history.requestLater()) {
        laterRequests += 1;
        expect(laterRequests).toBeLessThan(10);
      }
      expect(laterRequests).toBeGreaterThan(0);
      expect(history.scrollBy(10_000)).toBe("end");
      expect(history.requestEarlier()).toBe(true);
      expect(history.revealKey("missing:key")).toBe(false);
      expect(history.diagnostics()).toMatchObject({
        pendingRevealKey: null,
        tailEntries: 0,
        newerEntries: expect.any(Number),
        stickyScroll: expect.any(Boolean),
      });
      expect(typeof history.returnToTail()).toBe("boolean");
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("coalesces incremental session reconstruction onto the newest tail", async () => {
    const mutable = createMutable({
      nodes: [] as TranscriptNode[],
      publicationBatches: [] as TranscriptPublicationBatch[],
    });
    let history: CommittedHistoryHandle | undefined;
    const rendered = await openRender(
      () => (
        <CommittedHistory
          store={mutable}
          transcript={{
            semanticNodes: () => mutable.nodes,
            expandAll: () => false,
            selectedSubagent: () => null,
            focusedKey: () => null,
            overrideOf: () => undefined,
            toggleAt: () => {},
          }}
          splitOpen={() => false}
          notify={() => {}}
          onScrollbox={() => {}}
          onHandle={(value) => (history = value)}
        />
      ),
      { width: 120, height: 34 },
    );
    try {
      if (history === undefined) throw new Error("history handle not mounted");
      const mountedHistory = history;
      for (let index = 0; index < 40; index += 1) {
        const assistant = index % 2 === 1;
        const node: TranscriptNode = assistant
          ? { key: `resume:${index}:msg`, kind: "assistant", status: "ok", text: `reply ${index}` }
          : { key: `resume:${index}:user`, kind: "user", status: "ok", text: `ask ${index}` };
        mutable.nodes.push(node);
        mutable.publicationBatches.push(publication(node, index));
      }
      for (let pass = 0; pass < 40; pass += 1) await rendered.renderOnce();
      expect(mountedHistory.snapshot().activeBatchIds.at(-1)).toBe("fixture:39");
      expect(mountedHistory.snapshot().laterUnknown).toBe(0);
      expect(rendered.captureCharFrame()).toContain("reply 39");
      const owner = rendered.renderer.root.findDescendantById("history:fixture:39");
      for (let pass = 0; pass < 20; pass += 1) await rendered.renderOnce();
      expect(rendered.renderer.root.findDescendantById("history:fixture:39")).toBe(owner);
    } finally {
      rendered.renderer.destroy();
    }
  });
});
