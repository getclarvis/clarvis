import { describe, expect, test } from "bun:test";
import {
  MouseEvent,
  type KeyEvent,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { TestRecorder, type RecordedFrame } from "@opentui/core/testing";
import type { Keymap } from "@opentui/keymap";
import { createSignal } from "solid-js";
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
      historyMeasurementRecovery: { leaseMs: 20, retries: 1 },
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
  try {
    await settleSyntaxSurfaces(rendered);
  } catch (error) {
    const candidate = mountedHistory.snapshot().candidate;
    const owner =
      candidate === null
        ? undefined
        : rendered.renderer.root.findDescendantById(`history:${candidate.batchId}`);
    throw new Error(
      `${String(error)} ${JSON.stringify({ snapshot: mountedHistory.snapshot(), contentWidth: mountedScrollbox.content.width, owner: owner === undefined ? null : { width: owner.width, height: owner.height } })}`,
      { cause: error },
    );
  }
  let settled = false;
  for (let pass = 0; pass < 1_000; pass += 1) {
    const snapshot = mountedHistory.snapshot();
    settled =
      snapshot.candidate === null &&
      physicalWindowCovered(snapshot) &&
      snapshot.activeBatchIds.every((id) => mountedHistory.marker(id) !== undefined);
    if (settled) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await rendered.renderOnce();
  }
  if (!settled)
    throw new Error(
      `physical fixture did not settle: ${JSON.stringify({ snapshot: mountedHistory.snapshot(), diagnostics: mountedHistory.diagnostics() })}`,
    );
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

function committedHistoryRows(root: Renderable, frame: string): string {
  const history = root.findDescendantById("committed-history");
  if (history === undefined) throw new Error("committed history not mounted");
  return frame
    .split("\n")
    .slice(history.y, history.y + history.height)
    .join("\n");
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

function visibleSemanticToken(recorded: RecordedFrame, root: Renderable): string {
  const history = root.findDescendantById("committed-history");
  if (history === undefined) throw new Error("committed history not mounted");
  const rows = recorded.frame.split("\n");
  const first = Math.max(history.y + 2, 0);
  const last = Math.min(history.y + history.height - 3, rows.length - 1);
  const center = (first + last) / 2;
  const candidates: { token: string; distance: number }[] = [];
  for (let row = first; row <= last; row += 1) {
    const token = rows[row]?.match(/\b(?:ask|reply) \d+\b/)?.[0];
    if (token !== undefined) candidates.push({ token, distance: Math.abs(row - center) });
  }
  candidates.sort((left, right) => left.distance - right.distance);
  const selected = candidates[0]?.token;
  if (selected === undefined)
    throw new Error(`no stable semantic token in viewport:\n${recorded.frame}`);
  return selected;
}

function tokenCells(recorded: RecordedFrame, token: string, width: number) {
  const rows = recorded.frame.split("\n");
  const row = rows.findIndex((value) => value.includes(token));
  const column = row < 0 ? -1 : rows[row]!.indexOf(token);
  expect(row).toBeGreaterThanOrEqual(0);
  expect(column).toBeGreaterThanOrEqual(0);
  expect(recorded.buffers?.fg).toBeDefined();
  expect(recorded.buffers?.bg).toBeDefined();
  expect(recorded.buffers?.attributes).toBeDefined();
  const start = row * width + column;
  const end = start + token.length;
  return {
    row,
    column,
    fg: Array.from(recorded.buffers!.fg!.slice(start, end)),
    bg: Array.from(recorded.buffers!.bg!.slice(start, end)),
    attributes: Array.from(recorded.buffers!.attributes!.slice(start, end)),
  };
}

function physicalWindowCovered(snapshot: ReturnType<CommittedHistoryHandle["snapshot"]>): boolean {
  const activeStart = (snapshot.earlierUnknown > 0 ? 1 : 0) + snapshot.beforeRows;
  const activeEnd = activeStart + snapshot.activeRows;
  const beforeViewports = snapshot.prefetchDirection === "earlier" ? 2 : 1;
  const afterViewports = snapshot.prefetchDirection === "later" ? 2 : 1;
  const keepStart = Math.max(0, snapshot.scrollTop - snapshot.viewportRows * beforeViewports);
  const keepEnd =
    snapshot.scrollTop + snapshot.viewportRows + snapshot.viewportRows * afterViewports;
  return (
    (snapshot.earlierUnknown === 0 || activeStart <= keepStart) &&
    (snapshot.laterUnknown === 0 || activeEnd >= keepEnd)
  );
}

async function waitForResident(
  rendered: Awaited<ReturnType<typeof openRender>>,
  history: CommittedHistoryHandle,
  batchId: string,
  frameNeedle: string,
): Promise<void> {
  for (let pass = 0; pass < 1_000; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await rendered.renderOnce();
    if (
      history.snapshot().activeBatchIds.includes(batchId) &&
      rendered.captureCharFrame().includes(frameNeedle)
    )
      return;
  }
  const candidate = history.snapshot().candidate;
  const owner =
    candidate === null
      ? undefined
      : rendered.renderer.root.findDescendantById(`history:${candidate.batchId}`);
  const targetOwner = rendered.renderer.root.findDescendantById(`history:${batchId}`);
  throw new Error(
    `physical navigation stalled: ${JSON.stringify({ snapshot: history.snapshot(), diagnostics: history.diagnostics(), owner: owner === undefined ? null : { width: owner.width, height: owner.height }, targetOwner: targetOwner === undefined ? null : { width: targetOwner.width, height: targetOwner.height, opacity: targetOwner.opacity, y: targetOwner.y, screenY: targetOwner.screenY }, frame: rendered.captureCharFrame() })}`,
  );
}

async function waitForRevealFixedPoint(
  rendered: Awaited<ReturnType<typeof openRender>>,
  history: CommittedHistoryHandle,
): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    await rendered.renderOnce();
    if (history.diagnostics().pendingRevealKey === null) return;
  }
  throw new Error(
    `explicit reveal did not reach a fixed point: ${JSON.stringify({ snapshot: history.snapshot(), diagnostics: history.diagnostics() })}`,
  );
}

describe("the physical transcript window", () => {
  test("coalesces incremental session reconstruction onto a settled newest tail", async () => {
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
          measurementRecovery={{ leaseMs: 20, retries: 1 }}
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

      expect(mountedHistory.snapshot().candidate).toMatchObject({
        batchId: "fixture:39",
        reason: "initial",
      });
      for (let pass = 0; pass < 1_000; pass += 1) {
        await rendered.renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 1));
        const snapshot = mountedHistory.snapshot();
        if (
          snapshot.candidate === null &&
          physicalWindowCovered(snapshot) &&
          snapshot.laterUnknown === 0 &&
          snapshot.activeBatchIds.includes("fixture:39") &&
          rendered.captureCharFrame().includes("reply 39")
        )
          break;
      }

      const settled = mountedHistory.snapshot();
      expect(settled.candidate).toBeNull();
      expect(settled.activeBatchIds.at(-1)).toBe("fixture:39");
      expect(settled.laterUnknown).toBe(0);
      expect(rendered.captureCharFrame()).toContain("reply 39");
      expect(rendered.captureCharFrame()).not.toContain(
        "Syntax formatting was simplified because highlighting did not settle.",
      );
      await new Promise<void>((resolve) => process.nextTick(resolve));
      await new Promise<void>((resolve) => process.nextTick(resolve));
      const lifecycle = rendered.renderer.getLifecyclePasses().size;
      const owners = new Map(
        settled.activeBatchIds.map((id) => [
          id,
          rendered.renderer.root.findDescendantById(`history:${id}`),
        ]),
      );

      for (let pass = 0; pass < 200; pass += 1) await rendered.renderOnce();
      await new Promise<void>((resolve) => process.nextTick(resolve));
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(mountedHistory.snapshot()).toEqual(settled);
      expect(rendered.renderer.getLifecyclePasses().size).toBe(lifecycle);
      for (const [id, owner] of owners)
        expect(rendered.renderer.root.findDescendantById(`history:${id}`)).toBe(owner);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("keeps complete semantics while mounting only a row-bounded tail", async () => {
    const nodes = transcript(200, 4);
    const { rendered, history, ts } = await renderFixture(nodes);
    try {
      const physical = history.snapshot();
      expect(ts.semanticNodes()).toBe(nodes);
      expect(physical.activeBatchIds.length).toBeGreaterThan(0);
      expect(physical.activeBatchIds.length).toBeLessThan(nodes.length);
      expect(physical.earlierUnknown).toBeGreaterThan(0);
      expect(physical.activeBatchIds.filter((id) => history.marker(id) === undefined)).toEqual([]);
      expect(physical.activeBatchIds.at(-1)).toBe(`fixture:${nodes.length - 1}`);
      const largest = Math.max(
        ...physical.activeBatchIds.map((id) => history.marker(id)?.rows ?? 0),
      );
      expect(physical.activeRows).toBeLessThanOrEqual(physical.viewportRows * 4 + largest);
      expect(
        descendants(rendered.renderer.root).filter((node) =>
          node.id.startsWith("history:fixture:"),
        ),
      ).toHaveLength(physical.activeBatchIds.length);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("uses direct ScrollBox children with native viewport culling", async () => {
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

  test("keeps the hidden measurement candidate outside hit-testing and pointer input", async () => {
    const nodes = transcript(80, 2);
    const { rendered, scrollbox, history, ts } = await renderFixture(nodes);
    try {
      expect(history.requestEarlier()).toBe(true);
      const requested = history.snapshot().candidate;
      if (requested === null) throw new Error("earlier navigation did not create a candidate");
      await rendered.renderOnce();
      const candidate = history.snapshot().candidate;
      if (candidate === null) throw new Error("candidate settled before its first measured frame");
      expect(candidate.batchId).toBe(requested.batchId);
      const owner = rendered.renderer.root.findDescendantById(`history:${candidate.batchId}`);
      if (owner === undefined) throw new Error("candidate owner was not mounted");

      expect(owner.screenY).toBeGreaterThanOrEqual(
        scrollbox.viewport.screenY + scrollbox.viewport.height,
      );
      const candidateRenderables = new Set(descendants(owner).map((item) => item.num));
      expect(
        candidateRenderables.has(rendered.renderer.hitTest(owner.screenX, owner.screenY)),
      ).toBe(false);

      const candidateIndex = Number(candidate.batchId.slice("fixture:".length));
      const candidateKey = nodes[candidateIndex]!.key;
      await rendered.mockMouse.click(owner.screenX, owner.screenY);
      expect(ts.overrideOf(candidateKey)).toBeUndefined();
      expect(rendered.renderer.hasSelection).toBe(false);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("an unchanged semantic projection preserves its physical owner identity", async () => {
    const lead: TranscriptNode = {
      key: "mixed::lead",
      kind: "assistant",
      status: "ok",
      text: "stable lead projection",
    };
    const child: TranscriptNode = {
      key: "mixed::child",
      kind: "assistant",
      status: "ok",
      text: "child projection",
      subagentId: "child",
      subagentOrder: 0,
    };
    const unrelated: TranscriptNode = {
      key: "later::lead",
      kind: "assistant",
      status: "ok",
      text: "later semantic node",
    };
    const mixed: TranscriptPublicationBatch = {
      id: "fixture:mixed-projection",
      kind: "iteration",
      nodes: [lead, child],
      defaultFolded: { [lead.key]: false, [child.key]: false },
      toolGroups: {},
      sectionHeaders: {},
      sectionAnchors: {},
      sectionFoldedKeys: [],
      phase: "committed",
      ready: true,
    };
    const [semanticNodes, setSemanticNodes] = createSignal<readonly TranscriptNode[]>([lead]);
    let history: CommittedHistoryHandle | undefined;
    const rendered = await openRender(
      () => (
        <CommittedHistory
          store={{ publicationBatches: [mixed] }}
          transcript={{
            semanticNodes,
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
          measurementRecovery={{ leaseMs: 20, retries: 1 }}
        />
      ),
      { width: 120, height: 34 },
    );
    try {
      if (history === undefined) throw new Error("history handle not mounted");
      const mountedHistory = history;
      await settleSyntaxSurfaces(rendered);
      for (let pass = 0; pass < 100 && mountedHistory.snapshot().candidate !== null; pass += 1)
        await rendered.renderOnce();
      expect(mountedHistory.snapshot().candidate).toBeNull();
      const firstOwner = rendered.renderer.root.findDescendantById(`history:${mixed.id}`);
      const firstMarker = mountedHistory.marker(mixed.id);
      expect(firstOwner).toBeDefined();
      expect(firstMarker).toBeDefined();

      setSemanticNodes([lead, unrelated]);
      await rendered.renderOnce();
      await rendered.renderOnce();

      expect(rendered.renderer.root.findDescendantById(`history:${mixed.id}`)).toBe(firstOwner);
      expect(mountedHistory.marker(mixed.id)).toBe(firstMarker);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("short history needs neither guessed boundary nor spacer", async () => {
    const nodes = transcript(2, 1);
    const { rendered, history } = await renderFixture(nodes);
    try {
      expect(history.snapshot()).toMatchObject({
        earlierUnknown: 0,
        laterUnknown: 0,
        beforeRows: 0,
        afterRows: 0,
      });
      expect(history.snapshot().activeBatchIds).toHaveLength(nodes.length);
      expect(history.scrollBy(0)).toBe("scrolled");
      expect(history.revealKey("missing-key")).toBe(false);
      expect(history.diagnostics()).toMatchObject({
        pendingRevealKey: null,
      });
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("revealing a short final batch clears its lease at the clamped scroll limit", async () => {
    const nodes = transcript(1, 0);
    const { rendered, scrollbox, history } = await renderFixture(nodes);
    try {
      expect(scrollbox.scrollHeight).toBeLessThanOrEqual(scrollbox.viewport.height);
      expect(history.revealKey(nodes.at(-1)!.key)).toBeTrue();
      await waitForRevealFixedPoint(rendered, history);
      expect(history.diagnostics().pendingRevealKey).toBeNull();
      expect(history.snapshot().candidate).toBeNull();
      expect(scrollbox.scrollTop).toBe(0);

      await new Promise<void>((resolve) => process.nextTick(resolve));
      const lifecycle = rendered.renderer.getLifecyclePasses().size;
      await new Promise<void>((resolve) => process.nextTick(resolve));
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(rendered.renderer.getLifecyclePasses().size).toBe(lifecycle);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("explicit navigation disposes and later remounts native owners without changing semantics", async () => {
    const nodes = transcript(12, 2);
    const { rendered, history, ts } = await renderFixture(nodes);
    try {
      const newestId = `fixture:${nodes.length - 1}`;
      const firstNewestOwner = rendered.renderer.root.findDescendantById(`history:${newestId}`);
      expect(firstNewestOwner).toBeDefined();
      expect(history.revealKey(nodes[0]!.key)).toBe(true);
      await waitForResident(rendered, history, "fixture:0", "ask 0");
      await waitForRevealFixedPoint(rendered, history);
      expect(rendered.renderer.root.findDescendantById(`history:${newestId}`)).toBeUndefined();
      await new Promise<void>((resolve) => process.nextTick(resolve));
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(firstNewestOwner?.isDestroyed).toBe(true);
      expect(history.revealKey(nodes.at(-1)!.key)).toBe(true);
      await waitForResident(rendered, history, newestId, "f1.ts");
      await waitForRevealFixedPoint(rendered, history);
      const secondNewestOwner = rendered.renderer.root.findDescendantById(`history:${newestId}`);
      expect(secondNewestOwner).toBeDefined();
      expect(secondNewestOwner).not.toBe(firstNewestOwner);
      expect(ts.semanticNodes()).toBe(nodes);
      expect(history.snapshot().earlierUnknown).toBe(0);
      expect(history.snapshot().beforeRows).toBeGreaterThan(0);
      expect(rendered.renderer.root.findDescendantById("history-boundary-earlier")).toBeUndefined();
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("explicit tail return prepares and atomically swaps an old reader window for the tail", async () => {
    const nodes = transcript(30, 1);
    const { rendered, scrollbox, history } = await renderFixture(nodes);
    try {
      const newestId = `fixture:${nodes.length - 1}`;
      const newestMarker = history.marker(newestId);
      expect(newestMarker).toBeDefined();

      expect(history.revealKey(nodes[0]!.key)).toBeTrue();
      await waitForResident(rendered, history, "fixture:0", "ask 0");
      await waitForRevealFixedPoint(rendered, history);
      expect(history.snapshot().followingTail).toBeFalse();
      expect(history.snapshot().end).toBeLessThan(history.snapshot().batchIds.length);

      expect(history.requestLater()).toBeTrue();
      expect(history.snapshot().candidate).not.toBeNull();
      const readerIds = history.snapshot().activeBatchIds;
      const swapRecorder = new TestRecorder(rendered.renderer);
      swapRecorder.rec();
      expect(history.returnToTail()).toBeTrue();
      const immediate = history.snapshot();
      expect(immediate).toMatchObject({
        followingTail: true,
        activeBatchIds: readerIds,
        candidate: { batchId: newestId, reason: "return-tail", resident: false },
      });
      expect(immediate.afterRows).toBeGreaterThan(0);
      expect(history.marker(newestId)).toBe(newestMarker);
      expect(rendered.captureCharFrame()).toContain("ask 0");

      let frame = "";
      for (let pass = 0; pass < 200; pass += 1) {
        await rendered.renderOnce();
        frame = rendered.captureCharFrame();
        if (frame.includes("reply 29")) break;
      }
      swapRecorder.stop();
      if (!frame.includes("reply 29"))
        throw new Error(
          `tail return remained blank: ${JSON.stringify({
            snapshot: history.snapshot(),
            diagnostics: history.diagnostics(),
            scrollbox: {
              scrollTop: scrollbox.scrollTop,
              scrollHeight: scrollbox.scrollHeight,
              viewportRows: scrollbox.viewport.height,
              stickyScroll: scrollbox.stickyScroll,
            },
            owners: history.snapshot().activeBatchIds.map((id) => {
              const owner = rendered.renderer.root.findDescendantById(`history:${id}`);
              return owner === undefined
                ? { id, missing: true }
                : {
                    id,
                    opacity: owner.opacity,
                    y: owner.y,
                    screenY: owner.screenY,
                    height: owner.height,
                    destroyed: owner.isDestroyed,
                  };
            }),
          })}`,
        );
      expect(swapRecorder.recordedFrames.length).toBeGreaterThan(0);
      expect(
        swapRecorder.recordedFrames.every((recorded) =>
          /ask \d+|reply \d+|f0\.ts/.test(
            committedHistoryRows(rendered.renderer.root, recorded.frame),
          ),
        ),
      ).toBe(true);
      expect(history.snapshot()).toMatchObject({
        end: history.snapshot().batchIds.length,
        followingTail: true,
        laterUnknown: 0,
      });
      expect(rendered.renderer.root.findDescendantById("history-newer-indicator")).toBeUndefined();
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("rapid page and wheel navigation keep the prepared page visible until admission", async () => {
    const { rendered, scrollbox, history } = await renderFixture(transcript(80, 2));
    try {
      const pageResults = Array.from({ length: 20 }, () => history.scrollBy(-12));
      expect(pageResults).toContain("preparing");
      expect(history.snapshot().candidate).not.toBeNull();
      await rendered.renderOnce();
      const pageFrame = committedHistoryRows(rendered.renderer.root, rendered.captureCharFrame());
      expect(pageFrame).toMatch(/ask \d+|reply \d+|f\d+\.ts/);

      wheel(scrollbox, "up", 120);
      await rendered.renderOnce();
      const wheelFrame = committedHistoryRows(rendered.renderer.root, rendered.captureCharFrame());
      expect(wheelFrame).toMatch(/ask \d+|reply \d+|f\d+\.ts/);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("an early upward prefetch prepends without changing any painted anchor cell", async () => {
    const width = 120;
    const { rendered, scrollbox, history } = await renderFixture(transcript(80, 0));
    try {
      const initial = history.snapshot();
      expect(initial).toMatchObject({
        candidate: null,
        prefetchDirection: "earlier",
      });
      expect(initial.earlierUnknown).toBeGreaterThan(0);
      const activeStart = (initial.earlierUnknown > 0 ? 1 : 0) + initial.beforeRows;
      const preparedEarlier = initial.scrollTop - activeStart;
      const upwardRows = Math.max(1, preparedEarlier - initial.viewportRows * 2 + 1);

      wheel(scrollbox, "up", upwardRows);
      await rendered.renderOnce();
      await Promise.resolve();
      const preparing = history.snapshot();
      expect(preparing.scrollTop).toBeLessThan(initial.scrollTop);
      expect(preparing).toMatchObject({
        prefetchDirection: "earlier",
        candidate: { reason: "prefetch-earlier" },
      });

      const recorder = new TestRecorder(rendered.renderer, {
        recordBuffers: { fg: true, bg: true, attributes: true },
      });
      recorder.rec();
      await rendered.renderOnce();
      const baseline = recorder.recordedFrames.at(-1);
      if (baseline === undefined) throw new Error("baseline frame was not recorded");
      const token = visibleSemanticToken(baseline, rendered.renderer.root);
      const baselineCells = tokenCells(baseline, token, width);

      for (let pass = 0; pass < 1_000; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await rendered.renderOnce();
        const snapshot = history.snapshot();
        if (
          snapshot.start < initial.start &&
          snapshot.candidate === null &&
          history.diagnostics().pendingScrollDelta === 0
        )
          break;
      }
      recorder.stop();

      expect(history.snapshot().start).toBeLessThan(initial.start);
      expect(history.diagnostics()).toMatchObject({
        pendingScrollDelta: 0,
        lastCommit: { accepted: true, navigationDelta: 0 },
      });
      expect(recorder.recordedFrames.length).toBeGreaterThan(1);
      expect(
        recorder.recordedFrames.every(
          (recorded) =>
            JSON.stringify(tokenCells(recorded, token, width)) === JSON.stringify(baselineCells),
        ),
      ).toBe(true);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("an 80 to 81 column reflow preserves the reader cells until one atomic marker swap", async () => {
    const oldWidth = 80;
    const newWidth = 81;
    const height = 24;
    const { rendered, scrollbox, history } = await renderFixture(transcript(60, 0), {
      width: oldWidth,
      height,
    });
    try {
      wheel(scrollbox, "up", 8);
      for (let pass = 0; pass < 1_000; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await rendered.renderOnce();
        if (
          !history.snapshot().followingTail &&
          history.snapshot().candidate === null &&
          history.diagnostics().pendingScrollDelta === 0
        )
          break;
      }
      expect(history.snapshot()).toMatchObject({ followingTail: false, candidate: null });
      const oldColumns = history.snapshot().columns;
      const residentOwners = new Map(
        history
          .snapshot()
          .activeBatchIds.map((id) => [
            id,
            rendered.renderer.root.findDescendantById(`history:${id}`),
          ]),
      );
      expect([...residentOwners.values()].every((owner) => owner !== undefined)).toBe(true);

      const recorder = new TestRecorder(rendered.renderer, {
        recordBuffers: { fg: true, bg: true, attributes: true },
      });
      recorder.rec();
      await rendered.renderOnce();
      const baseline = recorder.recordedFrames.at(-1);
      if (baseline === undefined) throw new Error("width baseline frame was not recorded");
      const token = visibleSemanticToken(baseline, rendered.renderer.root);
      const baselineCells = tokenCells(baseline, token, oldWidth);

      rendered.renderer.resize(newWidth, height);
      let sawGeometryTransition = false;
      for (let pass = 0; pass < 2_000; pass += 1) {
        await rendered.renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 1));
        const snapshot = history.snapshot();
        const clones = descendants(rendered.renderer.root).filter(
          (node) => node.id.startsWith("history-geometry-candidate:") && !node.isDestroyed,
        );
        const diagnostics = history.diagnostics();
        expect(clones.length).toBeLessThanOrEqual(1);
        expect(diagnostics.geometryMeasurementOwners).toBeLessThanOrEqual(
          diagnostics.geometryMeasurementOwnerLimit,
        );
        expect(diagnostics.geometryMeasurementOwnerPeak).toBeLessThanOrEqual(
          diagnostics.geometryMeasurementOwnerLimit,
        );
        if (snapshot.geometryTransition) {
          sawGeometryTransition = true;
          expect(snapshot.displayColumns).toBe(oldColumns);
          for (const [id, owner] of residentOwners)
            expect(rendered.renderer.root.findDescendantById(`history:${id}`)).toBe(owner);
        }
        if (
          sawGeometryTransition &&
          !snapshot.geometryTransition &&
          snapshot.candidate === null &&
          diagnostics.pendingScrollDelta === 0 &&
          clones.length === 0
        )
          break;
      }
      recorder.stop();

      expect(sawGeometryTransition).toBe(true);
      expect(history.snapshot()).toMatchObject({
        columns: oldColumns + 1,
        displayColumns: oldColumns + 1,
        geometryTransition: false,
        candidate: null,
      });
      expect(history.diagnostics()).toMatchObject({
        pendingScrollDelta: 0,
        geometryMeasurementOwners: 0,
        geometryMeasurementOwnerPeak: 1,
        geometryMeasurementOwnerLimit: 1,
      });
      const retainedGeometryOwners = descendants(rendered.renderer.root)
        .filter((node) => node.id.startsWith("history-geometry-candidate:") && !node.isDestroyed)
        .map((node) => ({
          id: node.id,
          opacity: node.opacity,
          parent: node.parent?.id,
          width: node.width,
          height: node.height,
        }));
      if (retainedGeometryOwners.length > 0)
        throw new Error(`retained geometry owners: ${JSON.stringify(retainedGeometryOwners)}`);
      expect(recorder.recordedFrames.length).toBeGreaterThan(1);
      const drift = recorder.recordedFrames
        .map((recorded, index) => {
          const bufferWidth = Math.trunc(recorded.buffers!.fg!.length / height / 4);
          const cells = tokenCells(recorded, token, bufferWidth);
          return { index, bufferWidth, cells };
        })
        .find(({ cells }) => JSON.stringify(cells) !== JSON.stringify(baselineCells));
      if (drift !== undefined)
        throw new Error(`reader cells drifted: ${JSON.stringify({ token, baselineCells, drift })}`);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test("fractional trackpad scrolling loads both edges and returns transparently to the tail", async () => {
    const { rendered, scrollbox, history } = await renderFixture(transcript(30, 1));
    try {
      const initial = history.snapshot();
      const initialScrollTop = scrollbox.scrollTop;
      expect(initial.followingTail).toBe(true);
      expect(initial.laterUnknown).toBe(0);

      for (let event = 0; event < 4; event += 1) wheel(scrollbox, "up", 0.25);
      await rendered.renderOnce();
      expect(scrollbox.scrollTop).toBeLessThan(initialScrollTop);
      expect(history.snapshot().followingTail).toBe(false);

      const initialStart = history.snapshot().start;
      for (
        let pass = 0;
        pass < 1_000 &&
        (history.snapshot().start >= initialStart ||
          history.snapshot().end >= history.snapshot().batchIds.length);
        pass += 1
      ) {
        wheel(scrollbox, "up", 48);
        await rendered.renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (history.snapshot().start >= initialStart) {
        const candidate = history.snapshot().candidate;
        const owner =
          candidate === null
            ? undefined
            : rendered.renderer.root.findDescendantById(`history:${candidate.batchId}`);
        throw new Error(
          `native upward scroll did not admit older history: ${JSON.stringify({ snapshot: history.snapshot(), diagnostics: history.diagnostics(), scrollTop: scrollbox.scrollTop, scrollHeight: scrollbox.scrollHeight, viewportRows: scrollbox.viewport.height, owner: owner === undefined ? null : { id: owner.id, opacity: owner.opacity, x: owner.x, y: owner.y, width: owner.width, height: owner.height, destroyed: owner.isDestroyed, descendants: descendants(owner).map((child) => ({ id: child.id, opacity: child.opacity, width: child.width, height: child.height, type: child.constructor.name })) } })}`,
        );
      }
      expect(history.snapshot().end).toBeLessThan(history.snapshot().batchIds.length);
      expect(history.diagnostics().lastCommit?.navigationDelta).toBe(0);
      expect(rendered.renderer.root.findDescendantById("history-newer-indicator")).toBeDefined();
      expect(rendered.renderer.root.findDescendantById("history-boundary-later")).toBeUndefined();

      for (let pass = 0; pass < 2_000; pass += 1) {
        wheel(scrollbox, "down", 12);
        await rendered.renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 1));
        const snapshot = history.snapshot();
        if (snapshot.followingTail && snapshot.laterUnknown === 0 && snapshot.candidate === null)
          break;
      }
      expect(history.snapshot()).toMatchObject({
        followingTail: true,
        laterUnknown: 0,
        candidate: null,
      });
      expect(history.diagnostics().lastCommit?.navigationDelta).toBe(0);
      expect(rendered.captureCharFrame()).toContain("f0.ts");
      expect(rendered.renderer.root.findDescendantById("history-newer-indicator")).toBeUndefined();
    } finally {
      rendered.renderer.destroy();
    }
  });
});
