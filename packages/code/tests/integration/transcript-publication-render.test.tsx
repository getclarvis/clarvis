import { expect, test } from "bun:test";
import {
  CodeRenderable,
  DiffRenderable,
  MarkdownRenderable,
  MouseEvent,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import type { RunEvent } from "@clarvis/protocol";
import { TestRecorder } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import { applyEvent, createTranscriptStore } from "../../src/adapters/store.ts";
import type {
  TranscriptPublicationScheduler,
  TranscriptPublicationBatch,
} from "../../src/adapters/transcript-publication.ts";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { TranscriptRegion } from "../../src/views/app/TranscriptRegion.tsx";
import type { CommittedHistoryHandle } from "../../src/views/history/CommittedHistory.tsx";
import { createTranscriptState } from "../../src/views/transcript-state.ts";
import {
  StableMarkdown,
  SyntaxPublicationBoundary,
  type SyntaxPublicationMeasurement,
} from "../../src/ui/patterns/stable-syntax.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";

const REAL_DIFF = [
  "--- a.ts",
  "+++ a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
].join("\n");

class ManualPublicationScheduler implements TranscriptPublicationScheduler {
  readonly #jobs = new Map<number, () => void>();
  #next = 0;

  schedule(callback: () => void): number {
    const id = this.#next++;
    this.#jobs.set(id, callback);
    return id;
  }

  cancel(handle: unknown): void {
    if (typeof handle === "number") this.#jobs.delete(handle);
  }

  flush(): void {
    const jobs = [...this.#jobs.values()];
    this.#jobs.clear();
    for (const job of jobs) job();
  }
}

test("syntax publication self-schedules consecutive confirming frames", async () => {
  let measurement: SyntaxPublicationMeasurement | undefined;
  let measuredRevision: number | undefined;
  const rendered = await openRender(
    () => (
      <SyntaxPublicationBoundary
        measurementRevision={17}
        onReady={(value, revision) => {
          measurement = value;
          measuredRevision = revision;
        }}
      >
        <StableMarkdown content="# settled\n\n```ts\nconst answer = 42;\n```" streaming={false} />
      </SyntaxPublicationBoundary>
    ),
    { width: 80, height: 12 },
  );
  try {
    for (let pass = 0; pass < 50 && measurement === undefined; pass += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(measurement).toMatchObject({ columns: 80, rows: expect.any(Number) });
    expect(measuredRevision).toBe(17);
  } finally {
    rendered.renderer.destroy();
  }
});
test("syntax publication re-arms after an inactive measurement revision", async () => {
  const [revision, setRevision] = createSignal<number | undefined>(17);
  const measured: Array<number | undefined> = [];
  const rendered = await openRender(
    () => (
      <SyntaxPublicationBoundary
        measurementRevision={revision()}
        onReady={(_measurement, value) => measured.push(value)}
      >
        <StableMarkdown content="# stable revision" streaming={false} />
      </SyntaxPublicationBoundary>
    ),
    { width: 80, height: 12 },
  );
  const waitForRevision = async (expected: number): Promise<void> => {
    for (let pass = 0; pass < 50 && !measured.includes(expected); pass += 1) {
      await rendered.renderOnce();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  };
  try {
    await waitForRevision(17);
    setRevision(undefined);
    await rendered.renderOnce();
    setRevision(23);
    await waitForRevision(23);
    expect(measured).toEqual([17, 23]);
  } finally {
    rendered.renderer.destroy();
  }
});

function runStarted(): RunEvent {
  return { type: "run_started", at: 1, lead_model: "openai/gpt-5" };
}

function toolCall(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  result: string,
  diff?: string,
  subagentId?: string,
): RunEvent {
  return {
    type: "tool_call",
    at: 10,
    agent: subagentId === undefined ? "lead" : "subagent",
    ...(subagentId === undefined ? {} : { subagent_id: subagentId }),
    call_id: callId,
    tool,
    server: "builtin",
    arguments: args,
    ok: true,
    result,
    ...(diff === undefined ? {} : { diff }),
  };
}

function descendants<T extends Renderable>(
  root: Renderable,
  predicate: (renderable: Renderable) => renderable is T,
): T[] {
  const found: T[] = [];
  const visit = (renderable: Renderable): void => {
    if (predicate(renderable)) found.push(renderable);
    for (const child of renderable.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

function byId(root: Renderable, id: string): Renderable {
  const found = descendants(
    root,
    (renderable): renderable is Renderable => renderable.id === id,
  )[0];
  if (found === undefined) throw new Error(`renderable ${id} not found`);
  return found;
}

function publicationForKey(
  publications: readonly TranscriptPublicationBatch[],
  key: string,
): TranscriptPublicationBatch {
  const found = publications.find((publication) =>
    publication.nodes.some((node) => node.key === key),
  );
  if (found === undefined) throw new Error(`publication for ${key} not found`);
  return found;
}

function syntaxUnder(root: Renderable): readonly Renderable[] {
  return descendants(
    root,
    (renderable): renderable is MarkdownRenderable | DiffRenderable | CodeRenderable =>
      renderable instanceof MarkdownRenderable ||
      renderable instanceof DiffRenderable ||
      renderable instanceof CodeRenderable,
  );
}

async function waitForPhysicalBatch(
  rendered: Awaited<ReturnType<typeof openRender>>,
  history: CommittedHistoryHandle,
  batchId: string,
  frameNeedle: string,
): Promise<void> {
  for (let pass = 0; pass < 5_000; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await rendered.renderOnce();
    if (
      history.snapshot().activeBatchIds.includes(batchId) &&
      rendered.captureCharFrame().includes(frameNeedle)
    )
      return;
  }
  throw new Error(
    `publication stalled: ${JSON.stringify({ snapshot: history.snapshot(), diagnostics: history.diagnostics(), frame: rendered.captureCharFrame() })}`,
  );
}

async function waitForPhysicalFixedPoint(
  rendered: Awaited<ReturnType<typeof openRender>>,
  history: CommittedHistoryHandle,
): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1) {
    await rendered.renderOnce();
    if (history.diagnostics().pendingRevealKey === null) return;
  }
  throw new Error(
    `history did not reach a fixed point: ${JSON.stringify({ snapshot: history.snapshot(), diagnostics: history.diagnostics() })}`,
  );
}

function historyRows(root: Renderable, frame: string): string {
  const history = byId(root, "committed-history");
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

test.each([0, 30])(
  "keeps fast checkpoint stages in chronological flow after an inactive goal view (%i extra rows)",
  async (extraRows) => {
    const store = createTranscriptStore();
    const [active, setActive] = createSignal(false);
    const activity = createMutable({
      subagents: [],
      plan: null,
      usage: null,
      context: null,
    }) as unknown as ActivityStore;
    const transcript = createTranscriptState({
      nodes: () => store.committedNodes(),
      preserveOrder: true,
      subagents: () => [],
      notify: () => {},
      defaultFolded: (key) => store.defaultFolded(key),
    });
    let history: CommittedHistoryHandle | undefined;
    const rendered = await openRender(
      () => (
        <TranscriptRegion
          store={store}
          transcript={transcript}
          activity={activity}
          interaction={
            {
              keymap: createFakeKeymap().keymap,
              pushOverlayContext: () => {},
              popOverlayContext: () => {},
              syncContext: () => {},
            } as unknown as Interaction
          }
          run={{ elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null }}
          layout={{
            mode: () => "wide",
            sidebarVisible: () => false,
            sidebarWidth: () => 28,
            drawerOpen: () => false,
            contentInset: () => 0,
            width: () => 120,
            height: () => 20,
          }}
          active={active}
          contextWindow={() => 32768}
          agent={() => "coder"}
          model={() => "fixture"}
          openPlan={() => {}}
          notify={() => {}}
          onScrollbox={() => {}}
          onHistoryHandle={(value) => (history = value)}
        />
      ),
      { width: 120, height: 20 },
    );
    try {
      for (let stage = 1; stage <= 3; stage++) {
        const id = `stage-${stage}`;
        store.appendUserMessage(
          `GOAL_STAGE_${stage}\n${"fixture detail\n".repeat(extraRows)}`,
          undefined,
          id,
        );
        const sink = store.openRun(id);
        sink.beginReconcile();
        applyEvent(sink, runStarted(), "replay");
        await rendered.renderOnce();
        applyEvent(
          sink,
          toolCall(
            "update",
            "update_goal",
            { action: stage < 3 ? "checkpoint" : "candidate" },
            "Saved",
          ),
          "replay",
        );
        applyEvent(
          sink,
          {
            type: "run_ended",
            at: 20,
            status: "completed",
            ...(stage < 3 ? { disposition: "checkpoint" as const } : {}),
          },
          "replay",
        );
        sink.endReconcile();
        sink.complete();
        await rendered.renderOnce();
      }
      setActive(true);
      await waitForPhysicalFixedPoint(rendered, history!);
      const initial = rendered.captureCharFrame();
      const publications = store.publicationBatches;
      const rank = new Map(
        publications.flatMap((publication, index) =>
          publication.nodes.map((node) => [node.key, index] as const),
        ),
      );
      const lastHistory = history!.snapshot().end - 1;
      const tailOwners = descendants(
        byId(rendered.renderer.root, "live-transcript-tail"),
        (node): node is Renderable => node.id.startsWith("live-transcript-owner:"),
      );
      for (const owner of tailOwners) {
        const key = owner.id.slice("live-transcript-owner:".length);
        expect(rank.get(key) ?? publications.length).toBeGreaterThan(lastHistory);
      }
      const initialRows = initial.split("\n");
      const initialCompleted = initialRows.findIndex((row) => row.includes("Completed"));
      expect(initialCompleted).toBeGreaterThanOrEqual(0);
      expect(
        initialRows.slice(initialCompleted + 1).some((row) => row.includes("Checkpoint saved")),
      ).toBe(false);
      for (const key of ["stage-1::run", "stage-2::run"]) {
        history!.revealKey(key);
        await waitForPhysicalFixedPoint(rendered, history!);
        expect(rendered.captureCharFrame()).toContain("Checkpoint saved");
      }
      const snapshot = history!.snapshot();
      const owners = snapshot.activeBatchIds.map((id) =>
        byId(rendered.renderer.root, `history:${id}`),
      );
      expect(owners.map((owner) => owner.y)).toEqual(
        owners.map((owner) => owner.y).toSorted((a, b) => a - b),
      );
      history!.returnToTail();
      await waitForPhysicalFixedPoint(rendered, history!);
      expect(rendered.captureCharFrame()).toContain("Completed");
      expect(store.publicationBatches).toEqual(publications);
    } finally {
      rendered.renderer.destroy();
    }
  },
);

test("production TranscriptRegion keeps committed memory, diff, and write syntax owners stable", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({
    publicationScheduler: scheduler,
    publicationToolGroupLatencyMs: 80,
  });
  const sink = store.openRun("exec");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    toolCall(
      "memory",
      "write_memory",
      { path: "PROFILE.md", content: "# Profile\n\n- immutable history" },
      "Wrote PROFILE.md.",
    ),
    "live",
  );
  applyEvent(
    sink,
    toolCall(
      "edit",
      "edit_file",
      { path: "a.ts", old_string: "two", new_string: "TWO" },
      "Edited a.ts.",
      REAL_DIFF,
    ),
    "live",
  );
  applyEvent(
    sink,
    toolCall(
      "write",
      "write_file",
      { path: "fresh.md", content: "# Fresh\n\nordinary write" },
      "Wrote fresh.md.",
    ),
    "live",
  );

  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const transcript = createTranscriptState({
    nodes: () => store.committedNodes(),
    preserveOrder: true,
    subagents: () => [],
    notify: () => {},
    defaultFolded: (key) => store.defaultFolded(key),
  });
  const interaction = {
    keymap: createFakeKeymap().keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
    syncContext: () => {},
  } as unknown as Interaction;
  let historyHandle: CommittedHistoryHandle | undefined;
  const rendered = await openRender(
    () => (
      <TranscriptRegion
        store={store}
        transcript={transcript}
        activity={activity}
        interaction={interaction}
        run={{ elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null }}
        layout={{
          mode: () => "wide",
          sidebarVisible: () => false,
          sidebarWidth: () => 28,
          drawerOpen: () => false,
          contentInset: () => 0,
          width: () => 120,
          height: () => 42,
        }}
        contextWindow={() => 1_024_000}
        agent={() => "coder"}
        model={() => "openai/gpt-5"}
        notify={() => {}}
        openPlan={() => {}}
        onScrollbox={() => {}}
        onHistoryHandle={(handle) => (historyHandle = handle)}
      />
    ),
    { width: 120, height: 42 },
  );

  try {
    await settleSyntaxSurfaces(rendered);
    for (const [key, token] of [
      ["exec::memory", "immutable history"],
      ["exec::edit", "TWO"],
      ["exec::write", "ordinary write"],
    ] as const) {
      const publication = publicationForKey(store.publicationBatches, key);
      await waitForPhysicalBatch(rendered, historyHandle!, publication.id, token);
    }
    await rendered.waitForFrame((frame) =>
      ["immutable history", "TWO", "ordinary write"].every((token) => frame.includes(token)),
    );

    const stable = ["exec::memory", "exec::edit", "exec::write"].map((key) => {
      const publication = publicationForKey(store.publicationBatches, key);
      const owner = byId(rendered.renderer.root, `history:${publication.id}`);
      const syntax = syntaxUnder(owner);
      expect(syntax.length).toBeGreaterThan(0);
      expect(syntax.every((surface) => surface.opacity === 1)).toBe(true);
      return { id: publication.id, owner, syntax };
    });
    const history = byId(rendered.renderer.root, "committed-history") as ScrollBoxRenderable;
    const tail = byId(rendered.renderer.root, "live-transcript-tail");
    const fixedBounds = {
      historyY: history.y,
      historyHeight: history.height,
    };
    expect(tail.parent).toBe(history.content);
    const expectFixedBounds = (): void => {
      expect(history.y).toBe(fixedBounds.historyY);
      expect(history.height).toBe(fixedBounds.historyHeight);
    };
    const expectStableOwners = (): void => {
      for (const entry of stable) {
        expect(byId(rendered.renderer.root, `history:${entry.id}`)).toBe(entry.owner);
        const currentSyntax = syntaxUnder(entry.owner);
        expect(currentSyntax).toHaveLength(entry.syntax.length);
        for (const [index, surface] of currentSyntax.entries()) {
          expect(surface).toBe(entry.syntax[index]!);
          expect(surface.opacity).toBe(1);
        }
      }
    };

    applyEvent(
      sink,
      { type: "iteration_started", at: 20, agent: "lead", iteration: 1, model: "openai/gpt-5" },
      "live",
    );
    for (let index = 0; index < 8; index += 1) {
      applyEvent(
        sink,
        {
          type: "text_delta",
          at: 21 + index,
          agent: "lead",
          iteration: 1,
          channel: "text",
          text: `later assistant output ${index}\n`,
          reset: index === 0,
        },
        "live",
      );
      await rendered.renderOnce();
      expectFixedBounds();
      expectStableOwners();
    }
    applyEvent(
      sink,
      {
        type: "iteration_completed",
        at: 30,
        agent: "lead",
        iteration: 1,
        model: "openai/gpt-5",
        response: Array.from({ length: 8 }, (_, index) => `later assistant output ${index}\n`).join(
          "",
        ),
        response_phase: "commentary",
        input_tokens: 20,
        output_tokens: 16,
      },
      "live",
    );
    await settleSyntaxSurfaces(rendered);
    expectStableOwners();

    applyEvent(
      sink,
      {
        type: "delegation_created",
        at: 40,
        delegation_id: "worker",
        title: "worker",
        task: "inspect unrelated code",
      },
      "live",
    );
    applyEvent(
      sink,
      { type: "delegation_started", at: 41, delegation_id: "worker", model: "openai/gpt-5" },
      "live",
    );
    applyEvent(
      sink,
      {
        type: "tool_input_delta",
        at: 42,
        agent: "subagent",
        subagent_id: "worker",
        call_id: "child-read",
        tool: "read_file",
        chars: 128,
      },
      "live",
    );
    await rendered.renderOnce();
    expectFixedBounds();

    applyEvent(sink, toolCall("read-a", "read_file", { path: "a.ts" }, "a contents"), "live");
    applyEvent(sink, toolCall("read-b", "read_file", { path: "b.ts" }, "b contents"), "live");
    scheduler.flush();
    await settleSyntaxSurfaces(rendered);
    expectFixedBounds();
    expectStableOwners();

    applyEvent(
      sink,
      toolCall(
        "child-read",
        "read_file",
        { path: "child.ts" },
        "child contents",
        undefined,
        "worker",
      ),
      "live",
    );
    await settleSyntaxSurfaces(rendered);
    const liveSubagent = historyRows(rendered.renderer.root, rendered.captureCharFrame());
    expect(liveSubagent).not.toContain("child.ts");
    const handoff = new TestRecorder(rendered.renderer);
    handoff.rec();
    applyEvent(
      sink,
      { type: "delegation_completed", at: 50, delegation_id: "worker", status: "completed" },
      "live",
    );
    await settleSyntaxSurfaces(rendered);
    handoff.stop();
    expect(
      handoff.recordedFrames.every(
        (recorded) => !historyRows(rendered.renderer.root, recorded.frame).includes("child.ts"),
      ),
    ).toBe(true);
    expectFixedBounds();
    expectStableOwners();

    applyEvent(
      sink,
      { type: "iteration_started", at: 51, agent: "lead", iteration: 2, model: "openai/gpt-5" },
      "live",
    );
    applyEvent(
      sink,
      {
        type: "text_delta",
        at: 52,
        agent: "lead",
        iteration: 2,
        channel: "text",
        text: "LEAD AFTER WORKER",
        reset: true,
      },
      "live",
    );
    await rendered.waitForFrame((frame) => frame.includes("LEAD AFTER WORKER"));
    const continued = historyRows(rendered.renderer.root, rendered.captureCharFrame());
    expect(continued).not.toContain("child.ts");
    expect(continued).toContain("LEAD AFTER WORKER");
    expectStableOwners();
  } finally {
    rendered.renderer.destroy();
  }
});

test("a delayed physical handoff renders one frozen snapshot while replay and later lead output continue", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({
    publicationScheduler: scheduler,
    publicationToolGroupLatencyMs: 80,
  });
  const sink = store.openRun("handoff");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    toolCall(
      "authoritative",
      "read_file",
      { path: "HANDOFF_ORIGINAL.md" },
      "ORIGINAL HANDOFF BODY",
    ),
    "live",
  );
  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const transcript = createTranscriptState({
    nodes: () => store.committedNodes(),
    preserveOrder: true,
    subagents: () => [],
    notify: () => {},
    defaultFolded: (key) => store.defaultFolded(key),
  });
  let history: CommittedHistoryHandle | undefined;
  const rendered = await openRender(
    () => (
      <TranscriptRegion
        store={store}
        transcript={transcript}
        activity={activity}
        interaction={
          {
            keymap: createFakeKeymap().keymap,
            pushOverlayContext: () => {},
            popOverlayContext: () => {},
            syncContext: () => {},
          } as unknown as Interaction
        }
        run={{ elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null }}
        layout={{
          mode: () => "wide",
          sidebarVisible: () => false,
          sidebarWidth: () => 28,
          drawerOpen: () => false,
          contentInset: () => 0,
          width: () => 100,
          height: () => 30,
        }}
        contextWindow={() => 1_024_000}
        agent={() => "coder"}
        model={() => "openai/gpt-5"}
        notify={() => {}}
        openPlan={() => {}}
        onScrollbox={() => {}}
        onHistoryHandle={(handle) => (history = handle)}
      />
    ),
    { width: 100, height: 30 },
  );
  try {
    await rendered.waitForFrame((frame) => frame.includes("HANDOFF_ORIGINAL.md"));
    scheduler.flush();
    const publication = publicationForKey(store.publicationBatches, "handoff::authoritative");
    expect(Object.isFrozen(publication.nodes[0])).toBe(true);
    sink.beginReconcile();
    applyEvent(
      sink,
      toolCall(
        "authoritative",
        "read_file",
        { path: "HANDOFF_REPLAYED.md" },
        "REPLAYED MUTABLE BODY",
      ),
      "replay",
    );
    sink.endReconcile();
    applyEvent(
      sink,
      { type: "iteration_started", at: 20, agent: "lead", iteration: 1, model: "openai/gpt-5" },
      "live",
    );
    applyEvent(
      sink,
      {
        type: "text_delta",
        at: 21,
        agent: "lead",
        iteration: 1,
        channel: "text",
        text: "LEAD AFTER DELAYED HANDOFF",
        reset: true,
      },
      "live",
    );
    await waitForPhysicalBatch(rendered, history!, publication.id, "HANDOFF_ORIGINAL.md");
    await rendered.waitForFrame((frame) => frame.includes("LEAD AFTER DELAYED HANDOFF"));
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("HANDOFF_ORIGINAL.md");
    expect(frame).not.toContain("HANDOFF_REPLAYED.md");
    expect(frame).toContain("LEAD AFTER DELAYED HANDOFF");
  } finally {
    rendered.renderer.destroy();
  }
});

test("scrolling above a live tail preserves the reader while terminal updates stay physically bounded", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({ publicationScheduler: scheduler });
  for (let index = 0; index < 60; index += 1) store.appendUserMessage(`SCROLL BACKLOG ${index}`);
  const sink = store.openRun("scroll-tail");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    { type: "iteration_started", at: 20, agent: "lead", iteration: 1, model: "openai/gpt-5" },
    "live",
  );
  applyEvent(
    sink,
    {
      type: "text_delta",
      at: 21,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: `${Array.from({ length: 40 }, (_, index) => `streaming response row ${index}`).join("\n\n")}\n\nLIVE TAIL END`,
      reset: true,
    },
    "live",
  );
  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const transcript = createTranscriptState({
    nodes: () => store.committedNodes(),
    preserveOrder: true,
    subagents: () => [],
    notify: () => {},
    defaultFolded: (key) => store.defaultFolded(key),
  });
  let scrollbox: ScrollBoxRenderable | undefined;
  let history: CommittedHistoryHandle | undefined;
  const rendered = await openRender(
    () => (
      <TranscriptRegion
        store={store}
        transcript={transcript}
        activity={activity}
        interaction={
          {
            keymap: createFakeKeymap().keymap,
            pushOverlayContext: () => {},
            popOverlayContext: () => {},
            syncContext: () => {},
          } as unknown as Interaction
        }
        run={{ elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null }}
        layout={{
          mode: () => "wide",
          sidebarVisible: () => false,
          sidebarWidth: () => 28,
          drawerOpen: () => false,
          contentInset: () => 0,
          width: () => 100,
          height: () => 30,
        }}
        contextWindow={() => 1_024_000}
        agent={() => "coder"}
        model={() => "openai/gpt-5"}
        notify={() => {}}
        openPlan={() => {}}
        onScrollbox={(value) => (scrollbox = value)}
        onHistoryHandle={(value) => (history = value)}
      />
    ),
    { width: 100, height: 30 },
  );
  try {
    await rendered.waitForFrame((frame) => frame.includes("LIVE TAIL END"), { maxPasses: 200 });
    const followedTop = scrollbox!.scrollTop;
    history!.scrollBy(-12);
    await rendered.renderOnce();
    expect(scrollbox!.scrollTop).toBeLessThan(followedTop);
    expect(history!.snapshot().followingTail).toBe(false);
    expect(byId(rendered.renderer.root, "live-transcript-tail")).toBeDefined();
    applyEvent(
      sink,
      { type: "iteration_started", at: 300, agent: "lead", iteration: 2, model: "openai/gpt-5" },
      "live",
    );
    applyEvent(
      sink,
      {
        type: "text_delta",
        at: 301,
        agent: "lead",
        iteration: 2,
        channel: "text",
        text: "FOLLOWUP LIVE RESPONSE",
        reset: true,
      },
      "live",
    );
    history!.returnToTail();
    await rendered.waitForFrame((frame) => frame.includes("FOLLOWUP LIVE RESPONSE"), {
      maxPasses: 200,
    });
    expect(history!.snapshot().followingTail).toBe(true);
  } finally {
    rendered.renderer.destroy();
  }
});

test("the final answer keeps its row while the terminal outcome appends after it", async () => {
  const store = createTranscriptStore();
  const sink = store.openRun("terminal");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    { type: "iteration_started", at: 2, agent: "lead", iteration: 1, model: "openai/gpt-5" },
    "live",
  );
  applyEvent(
    sink,
    {
      type: "text_delta",
      at: 3,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "ATOMIC FINAL ANSWER",
      reset: true,
    },
    "live",
  );
  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const transcript = createTranscriptState({
    nodes: () => store.committedNodes(),
    preserveOrder: true,
    subagents: () => [],
    notify: () => {},
    defaultFolded: (key) => store.defaultFolded(key),
  });
  const rendered = await openRender(
    () => (
      <TranscriptRegion
        store={store}
        transcript={transcript}
        activity={activity}
        interaction={
          {
            keymap: createFakeKeymap().keymap,
            pushOverlayContext: () => {},
            popOverlayContext: () => {},
            syncContext: () => {},
          } as unknown as Interaction
        }
        run={{ elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null }}
        layout={{
          mode: () => "wide",
          sidebarVisible: () => false,
          sidebarWidth: () => 28,
          drawerOpen: () => false,
          contentInset: () => 0,
          width: () => 100,
          height: () => 48,
        }}
        contextWindow={() => 1_024_000}
        agent={() => "coder"}
        model={() => "openai/gpt-5"}
        notify={() => {}}
        openPlan={() => {}}
        onScrollbox={() => {}}
      />
    ),
    { width: 100, height: 48 },
  );
  try {
    await rendered.waitForFrame((frame) => frame.includes("ATOMIC FINAL ANSWER"));
    applyEvent(
      sink,
      {
        type: "iteration_completed",
        at: 4,
        agent: "lead",
        iteration: 1,
        model: "openai/gpt-5",
        response: "ATOMIC FINAL ANSWER",
        response_phase: "final_answer",
        input_tokens: 10,
        output_tokens: 4,
      },
      "live",
    );
    applyEvent(
      sink,
      { type: "run_ended", at: 5, status: "completed", reason: "completed" },
      "live",
    );
    sink.complete();
    await rendered.waitForFrame(
      (frame) => frame.includes("ATOMIC FINAL ANSWER") && frame.includes("Completed"),
    );
    const frame = historyRows(rendered.renderer.root, rendered.captureCharFrame());
    expect(frame.indexOf("ATOMIC FINAL ANSWER")).toBeLessThan(frame.indexOf("Completed"));
  } finally {
    rendered.renderer.destroy();
  }
});

test("the live tail stays mounted after the reader leaves the sticky edge", async () => {
  const store = createTranscriptStore();
  for (let index = 0; index < 20; index += 1) store.appendUserMessage(`TAIL BACKLOG ${index}`);
  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const transcript = createTranscriptState({
    nodes: () => store.committedNodes(),
    preserveOrder: true,
    subagents: () => [],
    notify: () => {},
    defaultFolded: (key) => store.defaultFolded(key),
  });
  let scrollbox: ScrollBoxRenderable | undefined;
  let history: CommittedHistoryHandle | undefined;
  const rendered = await openRender(
    () => (
      <TranscriptRegion
        store={store}
        transcript={transcript}
        activity={activity}
        interaction={
          {
            keymap: createFakeKeymap().keymap,
            pushOverlayContext: () => {},
            popOverlayContext: () => {},
            syncContext: () => {},
          } as unknown as Interaction
        }
        run={{ elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null }}
        layout={{
          mode: () => "wide",
          sidebarVisible: () => false,
          sidebarWidth: () => 28,
          drawerOpen: () => false,
          contentInset: () => 0,
          width: () => 100,
          height: () => 24,
        }}
        contextWindow={() => 1_024_000}
        agent={() => "coder"}
        model={() => "openai/gpt-5"}
        notify={() => {}}
        openPlan={() => {}}
        onScrollbox={(value) => (scrollbox = value)}
        onHistoryHandle={(value) => (history = value)}
      />
    ),
    { width: 100, height: 24 },
  );
  try {
    expect(scrollbox).toBeDefined();
    expect(history).toBeDefined();
    expect(byId(rendered.renderer.root, "live-transcript-tail")).toBeDefined();
    wheel(scrollbox!, "up", 6);
    await rendered.renderOnce();
    expect(history!.snapshot().followingTail).toBe(false);
    expect(byId(rendered.renderer.root, "live-transcript-tail")).toBeDefined();
    expect(scrollbox!.stickyScroll).toBe(false);
  } finally {
    rendered.renderer.destroy();
  }
});
