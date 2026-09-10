import { expect, test } from "bun:test";
import {
  CodeRenderable,
  DiffRenderable,
  getTreeSitterClient,
  MarkdownRenderable,
  MouseEvent,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import type { RunEvent } from "@clarvis/protocol";
import { MockTreeSitterClient, TestRecorder } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import { applyEvent, createTranscriptStore } from "../../src/adapters/store.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import type {
  TranscriptPublicationScheduler,
  TranscriptPublicationBatch,
} from "../../src/adapters/transcript-publication.ts";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { TranscriptRegion } from "../../src/views/app/TranscriptRegion.tsx";
import {
  CommittedHistory,
  TRANSCRIPT_SCROLLBAR_COLUMNS,
  type CommittedHistoryHandle,
} from "../../src/views/history/CommittedHistory.tsx";
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

function hasId(root: Renderable, id: string): boolean {
  return (
    descendants(root, (renderable): renderable is Renderable => renderable.id === id).length > 0
  );
}

function detachedLifecyclePasses(
  root: Renderable,
  lifecyclePasses: Iterable<Renderable>,
): readonly Renderable[] {
  return [...lifecyclePasses].filter((renderable) => {
    let current: Renderable | null = renderable;
    const visited = new Set<Renderable>();
    while (current !== null && !visited.has(current)) {
      if (current === root) return false;
      visited.add(current);
      current = current.parent as Renderable | null;
    }
    return true;
  });
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
  const seenCandidates: string[] = [];
  for (let pass = 0; pass < 5_000; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await rendered.renderOnce();
    const candidate = history.snapshot().candidate;
    const signature =
      candidate === null
        ? "none"
        : `${history.snapshot().layoutEpoch}:${candidate.batchId}:${candidate.reason}:${String((candidate as { requestedFoldRevision?: number }).requestedFoldRevision)}`;
    if (seenCandidates.at(-1) !== signature) seenCandidates.push(signature);
    if (
      history.snapshot().activeBatchIds.includes(batchId) &&
      rendered.captureCharFrame().includes(frameNeedle)
    )
      return;
  }
  const owners = descendants(rendered.renderer.root, (node): node is Renderable =>
    node.id.startsWith("history:publication:"),
  ).map((node) => ({
    id: node.id,
    opacity: node.opacity,
    width: node.width,
    height: node.height,
    descendants: descendants(node, (_child): _child is Renderable => true).map((child) => ({
      id: child.id,
      type: child.constructor.name,
      opacity: child.opacity,
      width: child.width,
      height: child.height,
    })),
  }));
  throw new Error(
    `physical publication stalled: ${JSON.stringify({ snapshot: history.snapshot(), marker: history.marker(batchId), diagnostics: history.diagnostics(), seenCandidates, owners })}`,
  );
}

async function waitForPhysicalFixedPoint(
  rendered: Awaited<ReturnType<typeof openRender>>,
  history: CommittedHistoryHandle,
): Promise<void> {
  for (let pass = 0; pass < 5_000; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await rendered.renderOnce();
    if (history.snapshot().candidate === null && history.diagnostics().pendingRevealKey === null) {
      await rendered.renderOnce();
      if (history.snapshot().candidate === null && history.diagnostics().pendingRevealKey === null)
        return;
    }
  }
  throw new Error(
    `physical history did not reach a fixed point: ${JSON.stringify({ snapshot: history.snapshot(), diagnostics: history.diagnostics() })}`,
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

function matchingRow(frame: string, pattern: RegExp): { text: string; row: number } | undefined {
  for (const [row, text] of frame.split("\n").entries())
    if (pattern.test(text)) return { text: text.trim(), row };
  return undefined;
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
    const stableRows = new Map(stable.map((entry) => [entry.id, historyHandle!.marker(entry.id)]));
    const expectStableOwners = (): void => {
      for (const entry of stable) {
        expect(byId(rendered.renderer.root, `history:${entry.id}`)).toBe(entry.owner);
        expect(historyHandle!.marker(entry.id)).toBe(stableRows.get(entry.id));
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

test("a painted write_memory body survives syntax-lease recovery during handoff", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({ publicationScheduler: scheduler });
  const sink = store.openRun("memory-handoff");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    toolCall(
      "memory",
      "write_memory",
      {
        path: "RECOVERY.md",
        content: "---\ntitle: Stable recovery\n---\n\nMEMORY_BODY_MUST_STAY_VISIBLE",
      },
      "Wrote RECOVERY.md.",
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
  const layout = createMutable({ sidebarVisible: false });
  let history: CommittedHistoryHandle | undefined;
  let stalledSyntax: MockTreeSitterClient | undefined;
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
          sidebarVisible: () => layout.sidebarVisible,
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
        historyMeasurementRecovery={{ leaseMs: 1, retries: 0 }}
      />
    ),
    { width: 100, height: 30 },
  );

  try {
    await rendered.waitForFrame((frame) => frame.includes("MEMORY_BODY_MUST_STAY_VISIBLE"));
    const recorder = new TestRecorder(rendered.renderer);
    recorder.rec();
    scheduler.flush();
    const publication = publicationForKey(store.publicationBatches, "memory-handoff::memory");
    await waitForPhysicalBatch(rendered, history!, publication.id, "MEMORY_BODY_MUST_STAY_VISIBLE");
    await settleSyntaxSurfaces(rendered);
    recorder.stop();

    const frames = recorder.recordedFrames.map((recorded) =>
      historyRows(rendered.renderer.root, recorded.frame),
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.includes("MEMORY_BODY_MUST_STAY_VISIBLE"))).toBe(true);
    expect(frames.every((frame) => !frame.includes("Syntax formatting was simplified"))).toBe(true);
    const owner = byId(rendered.renderer.root, `history:${publication.id}`);
    const stableSyntax = syntaxUnder(owner);
    const code = stableSyntax.find(
      (renderable): renderable is CodeRenderable => renderable instanceof CodeRenderable,
    );
    expect(code).toBeDefined();
    const filetype = code!.filetype ?? "markdown";
    const marker = history!.marker(publication.id);
    expect(marker).toBeDefined();

    stalledSyntax = new MockTreeSitterClient();
    code!.treeSitterClient = stalledSyntax;
    code!.filetype = undefined;
    code!.filetype = filetype;
    rendered.renderer.requestRender();
    await rendered.renderOnce();
    expect(code!.isHighlighting).toBe(true);

    const recovery = new TestRecorder(rendered.renderer);
    recovery.rec();
    layout.sidebarVisible = true;
    rendered.renderer.resize(82, 30);
    let sawGeometryTransition = false;
    for (let pass = 0; pass < 500; pass += 1) {
      await rendered.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 1));
      const snapshot = history!.snapshot();
      const diagnostics = history!.diagnostics();
      expect(diagnostics.geometryMeasurementOwners).toBeLessThanOrEqual(
        diagnostics.geometryMeasurementOwnerLimit,
      );
      expect(diagnostics.geometryMeasurementOwnerPeak).toBeLessThanOrEqual(
        diagnostics.geometryMeasurementOwnerLimit,
      );
      if (snapshot.geometryTransition) {
        sawGeometryTransition = true;
        expect(history!.marker(publication.id)).toBe(marker);
        expect(byId(rendered.renderer.root, `history:${publication.id}`)).toBe(owner);
        expect(syntaxUnder(owner)).toEqual(stableSyntax);
        expect(code!.isHighlighting).toBe(true);
      }
      const nextMarker = history!.marker(publication.id);
      if (
        sawGeometryTransition &&
        !snapshot.geometryTransition &&
        snapshot.candidate === null &&
        nextMarker !== undefined &&
        nextMarker.layoutEpoch !== marker!.layoutEpoch &&
        diagnostics.geometryMeasurementOwners === 0
      )
        break;
    }
    expect(sawGeometryTransition).toBe(true);
    expect(history!.snapshot()).toMatchObject({ geometryTransition: false, candidate: null });
    expect(history!.marker(publication.id)?.layoutEpoch).not.toBe(marker!.layoutEpoch);
    expect(history!.diagnostics()).toMatchObject({
      geometryMeasurementOwners: 0,
      geometryMeasurementOwnerPeak: 1,
      geometryMeasurementOwnerLimit: 1,
    });
    expect(byId(rendered.renderer.root, `history:${publication.id}`)).toBe(owner);
    expect(syntaxUnder(owner)).toEqual(stableSyntax);
    expect(code!.isHighlighting).toBe(true);

    stalledSyntax.resolveAllHighlightOnce();
    for (let pass = 0; pass < 100 && code!.isHighlighting; pass += 1) {
      await rendered.renderOnce();
      await Promise.resolve();
    }
    recovery.stop();

    const recoveredFrames = recovery.recordedFrames.map((recorded) => recorded.frame);
    expect(recoveredFrames.length).toBeGreaterThan(0);
    expect(recoveredFrames.every((frame) => frame.includes("MEMORY_BODY_MUST_STAY_VISIBLE"))).toBe(
      true,
    );
    expect(
      recoveredFrames.every((frame) => !frame.includes("Syntax formatting was simplified")),
    ).toBe(true);
    expect(byId(rendered.renderer.root, `history:${publication.id}`)).toBe(owner);
    expect(syntaxUnder(owner)).toEqual(stableSyntax);
    expect(code!.filetype).toBe(filetype);
    expect(code!.isHighlighting).toBe(false);
    expect(history!.marker(publication.id)?.layoutEpoch).not.toBe(marker!.layoutEpoch);
  } finally {
    rendered.renderer.destroy();
    await stalledSyntax?.destroy();
  }
});

test("a never-painted stalled syntax candidate first appears parser-free and ignores late highlights", async () => {
  const styleToken = "FALLBACK_STYLE_TOKEN";
  const codeLine = `${styleToken} = 1;`;
  const diffToken = "FALLBACK_DIFF_TOKEN";
  const markdownToken = "FALLBACK_MARKDOWN_TOKEN";
  const nodes = [
    {
      key: "fallback::write",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "builtin",
      toolName: "write_memory",
      args: { path: "fallback.ts", content: codeLine },
      result: "Wrote fallback.ts.",
      error: null,
    },
    {
      key: "fallback::diff",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "builtin",
      toolName: "edit_file",
      args: { path: "fallback.ts" },
      result: "Updated fallback.ts.",
      diff: [
        "--- fallback.ts",
        "+++ fallback.ts",
        "@@ -1 +1 @@",
        "-const previous = 0;",
        `+const ${diffToken} = 2;`,
      ].join("\n"),
      error: null,
    },
    {
      key: "fallback::markdown",
      kind: "assistant",
      status: "ok",
      text: `Markdown fallback\n\n\`\`\`ts\nconst ${markdownToken} = 3;\n\`\`\``,
    },
  ] satisfies TranscriptNode[];
  const publication: TranscriptPublicationBatch = {
    id: "fixture:stalled-syntax",
    kind: "tool_group",
    nodes,
    defaultFolded: Object.fromEntries(nodes.map((node) => [node.key, false])),
    toolGroups: {},
    sectionHeaders: {},
    sectionAnchors: {},
    sectionFoldedKeys: [],
    phase: "committed",
    ready: true,
  };
  const stalledSyntax = new MockTreeSitterClient();
  stalledSyntax.setMockResult({
    highlights: [[0, styleToken.length, "keyword"]],
  });
  const suiteSyntax = getTreeSitterClient();
  const originalHighlightOnce = suiteSyntax.highlightOnce.bind(suiteSyntax);
  suiteSyntax.highlightOnce = (content, filetype) => stalledSyntax.highlightOnce(content, filetype);
  const restoreSuiteSyntax = (): void => {
    suiteSyntax.highlightOnce = originalHighlightOnce;
  };

  try {
    let history: CommittedHistoryHandle | undefined;
    const rendered = await openRender(
      () => (
        <CommittedHistory
          store={{ publicationBatches: [publication] }}
          transcript={{
            semanticNodes: () => nodes,
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
          measurementRecovery={{ leaseMs: 100, retries: 0 }}
        />
      ),
      { width: 100, height: 40 },
    );

    try {
      expect(history).toBeDefined();
      for (let pass = 0; pass < 8 && !stalledSyntax.isHighlighting(); pass += 1)
        await rendered.renderOnce();
      const stalledOwner = byId(rendered.renderer.root, `history:${publication.id}`);
      const stalledTree = syntaxUnder(stalledOwner);
      const stalledCodes = stalledTree.filter(
        (surface): surface is CodeRenderable => surface instanceof CodeRenderable,
      );
      expect(stalledTree.length).toBeGreaterThan(0);
      expect(stalledCodes.some((surface) => surface.isHighlighting)).toBe(true);
      expect(stalledSyntax.isHighlighting()).toBe(true);
      const stalledFrameListeners = rendered.renderer.listenerCount("frame");
      const recorder = new TestRecorder(rendered.renderer, {
        recordBuffers: { fg: true, bg: true, attributes: true },
      });
      recorder.rec();
      for (let pass = 0; pass < 500; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await rendered.renderOnce();
        const frame = rendered.captureCharFrame();
        if (
          history!.snapshot().candidate === null &&
          frame.includes(styleToken) &&
          frame.includes(diffToken) &&
          frame.includes(markdownToken)
        )
          break;
      }
      expect(history!.snapshot().candidate).toBeNull();
      await settleSyntaxSurfaces(rendered);

      const owner = byId(rendered.renderer.root, `history:${publication.id}`);
      const syntax = syntaxUnder(owner);
      const codeSurfaces = syntax.filter(
        (surface): surface is CodeRenderable => surface instanceof CodeRenderable,
      );
      const diffSurfaces = syntax.filter(
        (surface): surface is DiffRenderable => surface instanceof DiffRenderable,
      );
      expect(owner.opacity).toBe(1);
      expect(history!.snapshot().candidate).toBeNull();
      expect(history!.marker(publication.id)?.rows).toBe(owner.height);
      expect(codeSurfaces.length).toBeGreaterThanOrEqual(3);
      expect(codeSurfaces.every((surface) => surface.filetype === undefined)).toBe(true);
      expect(codeSurfaces.every((surface) => !surface.isHighlighting)).toBe(true);
      expect(diffSurfaces.length).toBeGreaterThan(0);
      expect(diffSurfaces.every((surface) => surface.filetype === undefined)).toBe(true);
      expect(stalledSyntax.isHighlighting()).toBe(true);
      expect(stalledTree.every((surface) => surface.isDestroyed)).toBe(true);
      expect(syntax.every((surface) => !stalledTree.includes(surface))).toBe(true);
      expect(rendered.renderer.listenerCount("frame")).toBe(stalledFrameListeners + 1);

      const beforeResolve = recorder.recordedFrames;
      const firstVisibleIndex = beforeResolve.findIndex(
        ({ frame }) =>
          frame.includes(styleToken) && frame.includes(diffToken) && frame.includes(markdownToken),
      );
      expect(firstVisibleIndex).toBeGreaterThan(0);
      const firstVisible = beforeResolve[firstVisibleIndex]!;
      const semanticRows = (frame: string): string[] =>
        frame
          .split("\n")
          .map((row) => row.trimEnd())
          .filter((row) =>
            [styleToken, diffToken, markdownToken].some((needle) => row.includes(needle)),
          );
      const tokenBuffers = (
        recorded: (typeof beforeResolve)[number],
      ): { fg: number[]; bg: number[]; attributes: number[] } => {
        const rows = recorded.frame.split("\n");
        const row = rows.findIndex((value) => value.includes(styleToken));
        const column = row < 0 ? -1 : rows[row]!.indexOf(styleToken);
        expect(row).toBeGreaterThanOrEqual(0);
        expect(column).toBeGreaterThanOrEqual(0);
        expect(recorded.buffers?.fg).toBeDefined();
        expect(recorded.buffers?.bg).toBeDefined();
        expect(recorded.buffers?.attributes).toBeDefined();
        const start = row * 100 + column;
        const end = start + styleToken.length;
        return {
          fg: Array.from(recorded.buffers!.fg!.slice(start, end)),
          bg: Array.from(recorded.buffers!.bg!.slice(start, end)),
          attributes: Array.from(recorded.buffers!.attributes!.slice(start, end)),
        };
      };
      const firstRows = semanticRows(firstVisible.frame);
      const firstBuffers = tokenBuffers(firstVisible);
      expect(firstRows).toHaveLength(3);
      const framesBeforeLateResolve = beforeResolve.length;

      stalledSyntax.resolveAllHighlightOnce();
      for (let pass = 0; pass < 6; pass += 1) {
        await Promise.resolve();
        await rendered.renderOnce();
      }
      recorder.stop();

      const afterResolve = recorder.recordedFrames.slice(framesBeforeLateResolve);
      expect(afterResolve.length).toBeGreaterThan(0);
      expect(stalledSyntax.isHighlighting()).toBe(false);
      expect(
        afterResolve.every(({ frame }) => semanticRows(frame).join("\n") === firstRows.join("\n")),
      ).toBe(true);
      expect(
        afterResolve.every(
          (recorded) => JSON.stringify(tokenBuffers(recorded)) === JSON.stringify(firstBuffers),
        ),
      ).toBe(true);
      expect(stalledTree.every((surface) => surface.isDestroyed)).toBe(true);
      expect(byId(rendered.renderer.root, `history:${publication.id}`)).toBe(owner);
      expect(syntaxUnder(owner)).toEqual(syntax);
      expect(rendered.renderer.listenerCount("frame")).toBe(stalledFrameListeners);
    } finally {
      restoreSuiteSyntax();
      if (!rendered.renderer.isDestroyed) rendered.renderer.destroy();
    }
  } finally {
    restoreSuiteSyntax();
    await stalledSyntax.destroy();
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
        historyMeasurementRecovery={{ leaseMs: 1, retries: 0 }}
      />
    ),
    { width: 100, height: 30 },
  );

  try {
    await rendered.waitForFrame((frame) => frame.includes("HANDOFF_ORIGINAL.md"));
    await settleSyntaxSurfaces(rendered);
    expect(history).toBeDefined();
    const ownerId = "live-transcript-owner:handoff::authoritative";
    const liveOwner = byId(rendered.renderer.root, ownerId);
    const liveFrame = historyRows(rendered.renderer.root, rendered.captureCharFrame());
    const liveRow = liveFrame.split("\n").findIndex((row) => row.includes("HANDOFF_ORIGINAL.md"));
    expect(liveRow).toBeGreaterThanOrEqual(0);

    scheduler.flush();
    const publication = publicationForKey(store.publicationBatches, "handoff::authoritative");
    const snapshot = publication.nodes[0]!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(publication.defaultFolded["handoff::authoritative"]).toBe(true);

    sink.beginReconcile();
    applyEvent(sink, runStarted(), "replay");
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

    expect(byId(rendered.renderer.root, ownerId)).toBe(liveOwner);
    const mutable = store.nodes.find((node) => node.key === "handoff::authoritative");
    expect(mutable?.kind === "tool_call" ? mutable.args?.path : undefined).toBe(
      "HANDOFF_REPLAYED.md",
    );
    expect(snapshot.kind === "tool_call" ? snapshot.args?.path : undefined).toBe(
      "HANDOFF_ORIGINAL.md",
    );

    const recorder = new TestRecorder(rendered.renderer);
    recorder.rec();
    await waitForPhysicalBatch(rendered, history!, publication.id, "HANDOFF_ORIGINAL.md");
    recorder.stop();

    const frames = recorder.recordedFrames.map((recorded) =>
      historyRows(rendered.renderer.root, recorded.frame),
    );
    expect(frames.length).toBeGreaterThan(0);
    const discontinuities = frames.flatMap((frame, frameIndex) => {
      const originalCount = frame.match(/HANDOFF_ORIGINAL\.md/g)?.length ?? 0;
      const replayedCount = frame.match(/HANDOFF_REPLAYED\.md/g)?.length ?? 0;
      const leadCount = frame.match(/LEAD AFTER DELAYED HANDOFF/g)?.length ?? 0;
      const rows = frame.split("\n");
      const originalRow = rows.findIndex((row) => row.includes("HANDOFF_ORIGINAL.md"));
      const leadRow = rows.findIndex((row) => row.includes("LEAD AFTER DELAYED HANDOFF"));
      const leadContinuous = leadCount === 0 || (leadCount === 1 && leadRow > originalRow);
      return originalCount === 1 && originalRow === liveRow && replayedCount === 0 && leadContinuous
        ? []
        : [
            {
              frameIndex,
              originalCount,
              replayedCount,
              leadCount,
              originalRow,
              liveRow,
              leadRow,
              liveRows: liveFrame.split("\n").slice(0, 8),
              rows: rows.slice(0, 8),
            },
          ];
    });
    expect(discontinuities).toEqual([]);
    expect(frames.some((frame) => frame.includes("LEAD AFTER DELAYED HANDOFF"))).toBe(true);
    const finalFrame = frames.at(-1)!;
    expect(finalFrame.indexOf("HANDOFF_ORIGINAL.md")).toBeLessThan(
      finalFrame.indexOf("LEAD AFTER DELAYED HANDOFF"),
    );
  } finally {
    rendered.renderer.destroy();
  }
});

test("an out-of-order offscreen handoff keeps its spacer after every earlier live owner", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({ publicationScheduler: scheduler });
  for (let index = 0; index < 30; index += 1) store.appendUserMessage(`HANDOFF BACKLOG ${index}`);
  const sink = store.openRun("out-of-order-handoff");
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
      text: Array.from(
        { length: 90 },
        (_, index) => `EARLIER FRONTIER ROW ${String(index).padStart(2, "0")}`,
      ).join("\n\n"),
      reset: true,
    },
    "live",
  );
  applyEvent(
    sink,
    {
      type: "tool_call_started",
      at: 22,
      agent: "lead",
      call_id: "later-tool",
      server: "builtin",
      tool: "shell",
      arguments: { command: "printf LATER_OFFSCREEN_TOOL" },
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
        historyMeasurementRecovery={{ leaseMs: 1, retries: 0 }}
      />
    ),
    { width: 100, height: 30 },
  );

  try {
    await rendered.waitForFrame((frame) => frame.includes("LATER_OFFSCREEN_TOOL"), {
      maxPasses: 200,
    });
    expect(scrollbox).toBeDefined();
    expect(history).toBeDefined();
    const earlier = store.frontierNodes().find((node) => node.kind === "assistant");
    const later = store
      .frontierNodes()
      .find((node) => node.kind === "tool_call" && node.toolName === "shell");
    if (earlier === undefined || later === undefined)
      throw new Error("live owners were not staged");
    const earlierOwnerId = `live-transcript-owner:${earlier.key}`;
    const laterOwnerId = `live-transcript-owner:${later.key}`;
    for (let pass = 0; pass < 100; pass += 1) {
      wheel(scrollbox!, "up", 4);
      await rendered.renderOnce();
      const earlierCandidate = byId(rendered.renderer.root, earlierOwnerId);
      const laterCandidate = byId(rendered.renderer.root, laterOwnerId);
      const viewportStart = scrollbox!.viewport.screenY;
      const viewportEnd = viewportStart + scrollbox!.viewport.height;
      const earlierVisible =
        earlierCandidate.screenY < viewportEnd &&
        earlierCandidate.screenY + earlierCandidate.height > viewportStart;
      if (earlierVisible && laterCandidate.screenY >= viewportEnd) break;
    }
    const before = rendered.captureCharFrame();
    expect(before).toContain("EARLIER FRONTIER ROW");
    expect(before).not.toContain("LATER_OFFSCREEN_TOOL");
    expect(history!.snapshot().followingTail).toBe(false);

    const earlierOwner = byId(rendered.renderer.root, earlierOwnerId);
    const laterOwner = byId(rendered.renderer.root, laterOwnerId);
    expect(laterOwner.screenY).toBeGreaterThanOrEqual(
      scrollbox!.viewport.screenY + scrollbox!.viewport.height,
    );
    const earlierScreenY = earlierOwner.screenY;
    const beforeGeometry = {
      ownerY: earlierOwner.y,
      ownerHeight: earlierOwner.height,
      scrollTop: scrollbox!.scrollTop,
      scrollHeight: scrollbox!.scrollHeight,
      laterHeight: laterOwner.height,
    };

    applyEvent(
      sink,
      {
        type: "tool_call",
        at: 23,
        agent: "lead",
        call_id: "later-tool",
        server: "builtin",
        tool: "shell",
        arguments: { command: "printf LATER_OFFSCREEN_TOOL" },
        ok: true,
        result: "LATER_OFFSCREEN_TOOL",
      },
      "live",
    );
    scheduler.flush();
    for (let pass = 0; pass < 100; pass += 1) {
      await rendered.renderOnce();
      if (rendered.renderer.root.findDescendantById("live-transcript-handoff-spacer") !== undefined)
        break;
    }

    expect(rendered.renderer.root.findDescendantById(laterOwnerId)).toBeUndefined();
    expect(byId(rendered.renderer.root, earlierOwnerId)).toBe(earlierOwner);
    if (earlierOwner.screenY !== earlierScreenY)
      throw new Error(
        `earlier owner moved: ${JSON.stringify({ earlierScreenY, now: earlierOwner.screenY, beforeGeometry, afterGeometry: { ownerY: earlierOwner.y, ownerHeight: earlierOwner.height, scrollTop: scrollbox!.scrollTop, scrollHeight: scrollbox!.scrollHeight, spacerHeight: byId(rendered.renderer.root, "live-transcript-handoff-spacer").height } })}`,
      );
    const tailChildren = byId(rendered.renderer.root, "live-transcript-tail").getChildren();
    const earlierIndex = tailChildren.findIndex((child) => child.id === earlierOwnerId);
    const spacerIndex = tailChildren.findIndex(
      (child) => child.id === "live-transcript-handoff-spacer",
    );
    expect(earlierIndex).toBeGreaterThanOrEqual(0);
    expect(spacerIndex).toBeGreaterThan(earlierIndex);
  } finally {
    rendered.renderer.destroy();
  }
});

test("scrolling above a live tail preserves the reader while terminal updates stay physically bounded", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({
    publicationScheduler: scheduler,
    publicationToolGroupLatencyMs: 80,
  });
  for (let index = 0; index < 60; index += 1) store.appendUserMessage(`SCROLL BACKLOG ${index}`);
  const sink = store.openRun("scroll-tail");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    { type: "iteration_started", at: 20, agent: "lead", iteration: 1, model: "openai/gpt-5" },
    "live",
  );
  const longResponse = `${Array.from(
    { length: 72 },
    (_, index) => `streaming response row ${index}`,
  ).join("\n\n")}\n\nLIVE TAIL END`;
  applyEvent(
    sink,
    {
      type: "text_delta",
      at: 21,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: longResponse,
      reset: true,
    },
    "live",
  );
  applyEvent(
    sink,
    {
      type: "tool_call_started",
      at: 22,
      agent: "lead",
      call_id: "visible-tool",
      server: "builtin",
      tool: "shell",
      arguments: { command: "printf VISIBLE_TOOL_RESULT" },
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
        historyMeasurementRecovery={{ leaseMs: 1, retries: 0 }}
      />
    ),
    { width: 100, height: 30 },
  );

  try {
    await rendered.waitForFrame((frame) => frame.includes("LIVE TAIL END"), { maxPasses: 200 });
    expect(scrollbox).toBeDefined();
    expect(history).toBeDefined();
    const followedHeight = scrollbox!.scrollHeight;

    wheel(scrollbox!, "up", 2);
    await rendered.renderOnce();
    const visibleTool = store.nodes.find(
      (node) => node.kind === "tool_call" && node.toolName === "shell",
    );
    if (visibleTool === undefined)
      throw new Error(`visible tool was not projected:\n${rendered.captureCharFrame()}`);
    const visibleToolOwner = byId(
      rendered.renderer.root,
      `live-transcript-owner:${visibleTool.key}`,
    );
    applyEvent(
      sink,
      {
        type: "tool_call",
        at: 23,
        agent: "lead",
        call_id: "visible-tool",
        server: "builtin",
        tool: "shell",
        arguments: { command: "printf VISIBLE_TOOL_RESULT" },
        ok: true,
        result: "VISIBLE_TOOL_RESULT",
      },
      "live",
    );
    scheduler.flush();
    expect(byId(rendered.renderer.root, `live-transcript-owner:${visibleTool.key}`)).toBe(
      visibleToolOwner,
    );
    await rendered.renderOnce();

    let anchor: { text: string; row: number } | undefined;
    for (let pass = 0; pass < 200 && anchor === undefined; pass += 1) {
      wheel(scrollbox!, "up", 12);
      await rendered.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 1));
      const frame = rendered.captureCharFrame();
      const tailBelowViewport = !frame.includes("streaming response row");
      if (tailBelowViewport && history!.snapshot().candidate === null)
        anchor = matchingRow(frame, /SCROLL BACKLOG \d+/);
    }
    if (anchor === undefined)
      throw new Error(`reader did not reach committed history:\n${rendered.captureCharFrame()}`);
    await waitForPhysicalFixedPoint(rendered, history!);
    anchor = matchingRow(rendered.captureCharFrame(), /SCROLL BACKLOG \d+/);
    if (anchor === undefined)
      throw new Error(
        `reader anchor disappeared after physical settlement:\n${rendered.captureCharFrame()}`,
      );
    expect(history!.snapshot().followingTail).toBe(false);
    expect(byId(rendered.renderer.root, "live-transcript-tail")).toBeDefined();
    expect(scrollbox!.scrollHeight).toBeGreaterThanOrEqual(followedHeight);
    expect(history!.diagnostics()).toMatchObject({ tailEntries: 1 });
    expect(history!.diagnostics().newerEntries).toBeGreaterThanOrEqual(1);
    expect(rendered.renderer.root.findDescendantById("history-newer-indicator")).toBeDefined();
    applyEvent(
      sink,
      {
        type: "iteration_completed",
        at: 22,
        agent: "lead",
        iteration: 1,
        model: "openai/gpt-5",
        response: longResponse,
        response_phase: "commentary",
        input_tokens: 10,
        output_tokens: 1_000,
      },
      "live",
    );
    scheduler.flush();
    for (let pass = 0; pass < 3; pass += 1) await rendered.renderOnce();

    expect(byId(rendered.renderer.root, "live-transcript-handoff-spacer").height).toBeGreaterThan(
      1,
    );
    expect(matchingRow(rendered.captureCharFrame(), /SCROLL BACKLOG \d+/)).toEqual(anchor);
    expect(rendered.renderer.root.findDescendantById("history-newer-indicator")).toBeDefined();

    const physicalOwnersBefore = descendants(rendered.renderer.root, (node): node is Renderable =>
      node.id.startsWith("history:publication:"),
    ).length;
    for (let index = 0; index < 64; index += 1) {
      applyEvent(
        sink,
        toolCall(`settled-${index}`, "read_file", { path: `bounded-${index}.ts` }, "ok"),
        "live",
      );
      scheduler.flush();
      await rendered.renderOnce();
    }
    const liveOwners = descendants(rendered.renderer.root, (node): node is Renderable =>
      node.id.startsWith("live-transcript-owner:"),
    );
    const physicalOwnersAfter = descendants(rendered.renderer.root, (node): node is Renderable =>
      node.id.startsWith("history:publication:"),
    ).length;
    expect(liveOwners).toHaveLength(0);
    expect(physicalOwnersAfter).toBeLessThanOrEqual(physicalOwnersBefore + 1);
    expect(matchingRow(rendered.captureCharFrame(), /SCROLL BACKLOG \d+/)).toEqual(anchor);

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
    await rendered.renderOnce();
    history!.returnToTail();
    await rendered.waitForFrame((frame) => frame.includes("FOLLOWUP LIVE RESPONSE"), {
      maxPasses: 500,
    });
    expect(history!.snapshot().followingTail).toBe(true);
    expect(
      rendered.renderer.root.findDescendantById("live-transcript-handoff-spacer"),
    ).toBeUndefined();
  } finally {
    rendered.renderer.destroy();
  }
});

test("expanding a tall committed tool cannot strand physical measurement or newer batches", async () => {
  const store = createTranscriptStore();
  const finish = store.beginLocalBash("emit a tall result");
  finish({
    exitCode: 0,
    stdout: Array.from({ length: 120 }, (_, index) => `EXPANDED TOOL ROW ${index + 1}`).join("\n"),
    stderr: "",
    signal: null,
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
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
        historyMeasurementRecovery={{ leaseMs: 5, retries: 0 }}
      />
    ),
    { width: 100, height: 30 },
  );

  try {
    expect(scrollbox).toBeDefined();
    expect(history).toBeDefined();
    await waitForPhysicalFixedPoint(rendered, history!);
    const tool = store.nodes.find((node) => node.kind === "tool_call");
    if (tool === undefined) throw new Error("local shell tool was not projected");
    transcript.toggleAt(tool.key);
    await waitForPhysicalFixedPoint(rendered, history!);
    expect(history!.marker(history!.snapshot().activeBatchIds[0]!)?.rows).toBeGreaterThan(100);

    const finishLater = store.beginLocalBash("emit a later result");
    finishLater({
      exitCode: 0,
      stdout: "LATER TOOL RESULT",
      stderr: "",
      signal: null,
      timedOut: false,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    history!.returnToTail();
    await waitForPhysicalFixedPoint(rendered, history!);
    await rendered.waitForFrame((frame) => frame.includes("local:shell(emit a later result)"), {
      maxPasses: 200,
    });
    expect(history!.snapshot()).toMatchObject({ followingTail: true, laterUnknown: 0 });
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
      text: "DRAFT FINAL ANSWER",
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
    await rendered.waitForFrame((frame) => frame.includes("DRAFT FINAL ANSWER"));
    const draftHistory = historyRows(rendered.renderer.root, rendered.captureCharFrame());
    const draftAnswerRow = draftHistory
      .split("\n")
      .findIndex((row) => row.includes("DRAFT FINAL ANSWER"));
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
    await rendered.waitForFrame((frame) => frame.includes("ATOMIC FINAL ANSWER"));
    const liveHistory = historyRows(rendered.renderer.root, rendered.captureCharFrame());
    const liveAnswerRow = liveHistory
      .split("\n")
      .findIndex((row) => row.includes("ATOMIC FINAL ANSWER"));
    expect(liveAnswerRow).toBeGreaterThanOrEqual(0);
    expect(liveAnswerRow).toBe(draftAnswerRow);
    const recorder = new TestRecorder(rendered.renderer);
    recorder.rec();
    applyEvent(
      sink,
      { type: "run_ended", at: 5, status: "completed", reason: "completed" },
      "live",
    );
    sink.complete();
    await settleSyntaxSurfaces(rendered);
    recorder.stop();

    const recordedHistory = recorder.recordedFrames.map((recorded) =>
      historyRows(rendered.renderer.root, recorded.frame),
    );
    const outcomeWithoutAnswer = recordedHistory.filter(
      (frame) => frame.includes("Completed") && !frame.includes("ATOMIC FINAL ANSWER"),
    );
    expect(outcomeWithoutAnswer).toEqual([]);
    const discontinuities = recordedHistory.flatMap((frame, frameIndex) => {
      const answerCount = frame.match(/ATOMIC FINAL ANSWER/g)?.length ?? 0;
      const answerRow = frame.split("\n").findIndex((row) => row.includes("ATOMIC FINAL ANSWER"));
      return answerCount === 1 && answerRow === liveAnswerRow
        ? []
        : [
            {
              frameIndex,
              answerCount,
              answerRow,
              liveAnswerRow,
              liveRows: liveHistory.split("\n").slice(0, 5),
              rows: frame.split("\n").slice(0, 5),
            },
          ];
    });
    expect(discontinuities).toEqual([]);
    const terminalFrame = [...recordedHistory]
      .reverse()
      .find((frame) => frame.includes("ATOMIC FINAL ANSWER") && frame.includes("Completed"));
    expect(terminalFrame).toBeDefined();
    expect(terminalFrame!.indexOf("ATOMIC FINAL ANSWER")).toBeLessThan(
      terminalFrame!.indexOf("Completed"),
    );
  } finally {
    rendered.renderer.destroy();
  }
});

test("a long terminal batch keeps its semantic renderers when syntax misses its lease", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({
    publicationScheduler: scheduler,
    publicationToolGroupLatencyMs: 80,
  });
  const sink = store.openRun("terminal-tail");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    toolCall(
      "memory",
      "write_memory",
      {
        path: "transcript-soak.md",
        content: `# Memory\n\n${Array.from({ length: 60 }, (_, index) => `- memory line ${index}`).join("\n")}`,
      },
      "Wrote transcript-soak.md.",
    ),
    "live",
  );
  applyEvent(
    sink,
    toolCall(
      "write",
      "write_file",
      {
        path: ".clarvis/transcript-soak.md",
        content: Array.from({ length: 90 }, (_, index) => `file line ${index}`).join("\n"),
      },
      "Wrote .clarvis/transcript-soak.md.",
    ),
    "live",
  );
  applyEvent(
    sink,
    toolCall(
      "edit",
      "edit_file",
      { path: ".clarvis/transcript-soak.md" },
      "Updated .clarvis/transcript-soak.md.",
      [
        "--- .clarvis/transcript-soak.md",
        "+++ .clarvis/transcript-soak.md",
        "@@ -1,40 +1,40 @@",
        ...Array.from({ length: 40 }, (_, index) =>
          index % 4 === 0 ? `+replacement line ${index}` : ` context line ${index}`,
        ),
      ].join("\n"),
    ),
    "live",
  );
  scheduler.flush();

  const activity = createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  }) as unknown as ActivityStore;
  const layout = createMutable({ sidebarVisible: false });
  const transcript = createTranscriptState({
    nodes: () => store.committedNodes(),
    preserveOrder: true,
    subagents: () => [],
    notify: () => {},
    defaultFolded: (key) => store.defaultFolded(key),
  });
  let history: CommittedHistoryHandle | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
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
          sidebarVisible: () => layout.sidebarVisible,
          sidebarWidth: () => 28,
          drawerOpen: () => false,
          contentInset: () => 0,
          width: () => 120,
          height: () => 36,
        }}
        contextWindow={() => 1_024_000}
        agent={() => "coder"}
        model={() => "openai/gpt-5"}
        notify={() => {}}
        openPlan={() => {}}
        onScrollbox={(value) => (scrollbox = value)}
        onHistoryHandle={(handle) => (history = handle)}
        historyMeasurementRecovery={{ leaseMs: 1, retries: 0 }}
      />
    ),
    { width: 120, height: 36 },
  );

  try {
    try {
      await settleSyntaxSurfaces(rendered);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; physical=${JSON.stringify(history?.snapshot())}; diagnostics=${JSON.stringify(history?.diagnostics())}`,
        { cause: error },
      );
    }
    expect(rendered.captureCharFrame()).not.toContain(
      "Syntax formatting was simplified because highlighting did not settle.",
    );
    expect(
      descendants(
        rendered.renderer.root,
        (node): node is MarkdownRenderable | DiffRenderable | CodeRenderable =>
          node instanceof MarkdownRenderable ||
          node instanceof DiffRenderable ||
          node instanceof CodeRenderable,
      ).length,
    ).toBeGreaterThan(0);
    expect(rendered.renderer.listenerCount("frame")).toBeLessThan(10);
    layout.sidebarVisible = true;
    await settleSyntaxSurfaces(rendered);
    expect(rendered.captureCharFrame()).not.toContain(
      "Syntax formatting was simplified because highlighting did not settle.",
    );

    const finalAnswer = `# Terminal answer\n\n${Array.from(
      { length: 48 },
      (_, index) =>
        `Paragraph ${index} proves that a long final Markdown response remains part of the newest physical transcript batch.`,
    ).join("\n\n")}\n\nTERMINAL_TAIL_TOKEN`;
    applyEvent(
      sink,
      {
        type: "iteration_completed",
        at: 80,
        agent: "lead",
        iteration: 1,
        model: "openai/gpt-5",
        response: finalAnswer,
        response_phase: "final_answer",
        input_tokens: 10,
        output_tokens: 1_000,
      },
      "live",
    );
    applyEvent(
      sink,
      { type: "run_ended", at: 81, status: "completed", reason: "completed" },
      "live",
    );
    sink.complete();

    const terminal = publicationForKey(store.publicationBatches, "terminal-tail::run");
    expect(history).toBeDefined();
    expect(scrollbox).toBeDefined();
    expect(scrollbox!.verticalScrollBar.visible).toBe(true);
    expect(scrollbox!.verticalScrollBar.width).toBe(TRANSCRIPT_SCROLLBAR_COLUMNS);
    await rendered.renderOnce();
    const preparing = history!.snapshot();
    if (preparing.candidate !== null) {
      expect(preparing.laterUnknown).toBeGreaterThan(0);
      expect(scrollbox!.viewportCulling).toBe(false);
    }
    await waitForPhysicalBatch(rendered, history!, terminal.id, "TERMINAL_TAIL_TOKEN");
    await settleSyntaxSurfaces(rendered);
    expect(history!.snapshot().laterUnknown).toBe(0);
    expect(scrollbox!.viewportCulling).toBe(true);
  } finally {
    rendered.renderer.destroy();
  }
});

test("physical navigation evicts whole owners and remounts a prepared immutable batch", async () => {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({
    publicationScheduler: scheduler,
    publicationToolGroupLatencyMs: 80,
  });
  const sink = store.openRun("pages");
  applyEvent(sink, runStarted(), "live");
  applyEvent(
    sink,
    toolCall(
      "old-memory",
      "write_memory",
      {
        path: "OLD.md",
        content: `# Older page\n\n\`\`\`ts\n${"const oldValue = 1;\n".repeat(30)}\`\`\`\n\nOLDER_PAGE_TOKEN`,
      },
      "Wrote OLD.md.",
    ),
    "live",
  );
  for (let index = 0; index < 120; index += 1) store.appendNotice(`sealed page filler ${index}`);
  applyEvent(
    sink,
    toolCall(
      "new-memory",
      "write_memory",
      {
        path: "NEW.md",
        content: `# Newer page\n\n\`\`\`ts\n${"const newValue = 2;\n".repeat(30)}\`\`\`\n\nNEWER_PAGE_TOKEN`,
      },
      "Wrote NEW.md.",
    ),
    "live",
  );
  scheduler.flush();

  const oldPublication = publicationForKey(store.publicationBatches, "pages::old-memory");
  const newPublication = publicationForKey(store.publicationBatches, "pages::new-memory");
  const oldSnapshot = oldPublication.nodes[0];
  const newSnapshot = newPublication.nodes[0];
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
          height: () => 48,
        }}
        contextWindow={() => 1_024_000}
        agent={() => "coder"}
        model={() => "openai/gpt-5"}
        notify={() => {}}
        openPlan={() => {}}
        onScrollbox={() => {}}
        onHistoryHandle={(handle) => (history = handle)}
        historyMeasurementRecovery={{ leaseMs: 1, retries: 0 }}
      />
    ),
    { width: 120, height: 48 },
  );

  try {
    await rendered.renderOnce();
    expect(history).toBeDefined();
    await waitForPhysicalBatch(rendered, history!, newPublication.id, "NEWER_PAGE_TOKEN");
    const stableLayoutEpoch = history!.snapshot().layoutEpoch;
    const firstNewOwner = byId(rendered.renderer.root, `history:${newPublication.id}`);
    const firstNewCode = syntaxUnder(firstNewOwner).find(
      (surface): surface is CodeRenderable => surface instanceof CodeRenderable,
    );
    expect(firstNewCode).toBeDefined();
    expect({
      filetype: firstNewCode!.filetype,
      highlighting: firstNewCode!.isHighlighting,
    }).toEqual({ filetype: undefined, highlighting: false });
    expect({
      oldMounted: hasId(rendered.renderer.root, `history:${oldPublication.id}`),
      physical: history!.snapshot(),
    }).toMatchObject({ oldMounted: false });

    expect(history!.revealKey("pages::old-memory")).toBe(true);
    await waitForPhysicalBatch(rendered, history!, oldPublication.id, "OLDER_PAGE_TOKEN");
    await waitForPhysicalFixedPoint(rendered, history!);
    expect(history!.snapshot().layoutEpoch).toBe(stableLayoutEpoch);

    expect({
      newMounted: hasId(rendered.renderer.root, `history:${newPublication.id}`),
      physical: history!.snapshot(),
    }).toMatchObject({ newMounted: false });
    const oldOwner = byId(rendered.renderer.root, `history:${oldPublication.id}`);
    expect(history!.marker(oldPublication.id)?.rows).toBe(oldOwner.height);
    const oldSyntax = syntaxUnder(oldOwner);
    expect(oldSyntax.length).toBeGreaterThan(0);
    expect(oldSyntax.every((surface) => surface.opacity === 1)).toBe(true);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));
    const oldLifecycleBaseline = rendered.renderer.getLifecyclePasses().size;

    expect(history!.revealKey("pages::new-memory")).toBe(true);
    await waitForPhysicalBatch(rendered, history!, newPublication.id, "NEWER_PAGE_TOKEN");
    await waitForPhysicalFixedPoint(rendered, history!);
    expect(history!.snapshot().layoutEpoch).toBe(stableLayoutEpoch);

    const secondNewOwner = byId(rendered.renderer.root, `history:${newPublication.id}`);
    expect(secondNewOwner).not.toBe(firstNewOwner);
    const secondNewCode = syntaxUnder(secondNewOwner).find(
      (surface): surface is CodeRenderable => surface instanceof CodeRenderable,
    );
    expect(secondNewCode).toBeDefined();
    expect(secondNewCode).not.toBe(firstNewCode);
    expect(secondNewCode!.filetype).toBeUndefined();
    expect(secondNewCode!.isHighlighting).toBe(false);
    expect(history!.marker(newPublication.id)?.rows).toBe(secondNewOwner.height);
    const newSyntax = syntaxUnder(secondNewOwner);
    expect(newSyntax.length).toBeGreaterThan(0);
    expect(newSyntax.every((surface) => surface.opacity === 1)).toBe(true);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));
    const newLifecycleBaseline = rendered.renderer.getLifecyclePasses().size;
    const lifecycleSamples: Array<{
      target: string;
      size: number;
      detached: number;
      candidate: string | null;
    }> = [];

    for (let cycle = 0; cycle < 4; cycle += 1) {
      expect(history!.revealKey("pages::old-memory")).toBe(true);
      await waitForPhysicalBatch(rendered, history!, oldPublication.id, "OLDER_PAGE_TOKEN");
      await waitForPhysicalFixedPoint(rendered, history!);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      await new Promise<void>((resolve) => process.nextTick(resolve));
      lifecycleSamples.push({
        target: "old",
        size: rendered.renderer.getLifecyclePasses().size,
        detached: detachedLifecyclePasses(
          rendered.renderer.root,
          rendered.renderer.getLifecyclePasses(),
        ).length,
        candidate: history!.snapshot().candidate?.batchId ?? null,
      });

      expect(history!.revealKey("pages::new-memory")).toBe(true);
      await waitForPhysicalBatch(rendered, history!, newPublication.id, "NEWER_PAGE_TOKEN");
      await waitForPhysicalFixedPoint(rendered, history!);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      await new Promise<void>((resolve) => process.nextTick(resolve));
      lifecycleSamples.push({
        target: "new",
        size: rendered.renderer.getLifecyclePasses().size,
        detached: detachedLifecyclePasses(
          rendered.renderer.root,
          rendered.renderer.getLifecyclePasses(),
        ).length,
        candidate: history!.snapshot().candidate?.batchId ?? null,
      });
    }
    expect(lifecycleSamples.every((sample) => sample.detached === 0)).toBe(true);
    expect(
      lifecycleSamples.every(
        (sample) =>
          sample.size <= Math.max(oldLifecycleBaseline, newLifecycleBaseline) + 1 &&
          sample.size >= Math.min(oldLifecycleBaseline, newLifecycleBaseline),
      ),
    ).toBe(true);
    expect(publicationForKey(store.publicationBatches, "pages::old-memory").nodes[0]).toBe(
      oldSnapshot,
    );
    expect(publicationForKey(store.publicationBatches, "pages::new-memory").nodes[0]).toBe(
      newSnapshot,
    );
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(
      detachedLifecyclePasses(rendered.renderer.root, rendered.renderer.getLifecyclePasses()).map(
        (renderable) => ({
          id: renderable.id,
          type: renderable.constructor.name,
          destroyed: renderable.isDestroyed,
        }),
      ),
    ).toEqual([]);
    expect(history!.diagnostics().syntaxPolicyCount).toBeGreaterThan(0);
    store.clear();
    await rendered.renderOnce();
    expect(history!.diagnostics().syntaxPolicyCount).toBe(0);
  } finally {
    rendered.renderer.destroy();
  }
});
