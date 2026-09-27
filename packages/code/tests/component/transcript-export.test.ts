import { expect, test } from "bun:test";
import { onCleanup } from "solid-js";
import type { RunDetail } from "@clarvis/protocol";
import {
  exportTranscriptBatches,
  type TranscriptExportSource,
} from "#src/adapters/transcript-export.ts";
import {
  createTranscriptStore,
  type TranscriptNode,
  type TranscriptStore,
} from "#src/adapters/store.ts";
import type { SessionMeta } from "#src/adapters/session-store.ts";
import { runEvent } from "../helpers/run-events.ts";

function turn(executionId: string): SessionMeta["turns"][number] {
  return {
    kind: "conversation",
    userPreview: `question ${executionId}`,
    executionId,
    status: "done",
  };
}

function detail(executionId: string): RunDetail {
  return {
    execution_id: executionId,
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [{ role: "user", content: `question ${executionId}` }],
    events: [
      runEvent({ type: "run_started", at: 0 }),
      runEvent({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        at: 1,
        model: "m",
        response: `answer ${executionId}`,
        input_tokens: 1,
        output_tokens: 1,
      }),
    ],
  };
}

function source(
  turns: SessionMeta["turns"],
  getRun: TranscriptExportSource["getRun"],
  createScratch?: TranscriptExportSource["createScratch"],
): TranscriptExportSource {
  return {
    snapshot: () => ({
      sessionId: "session-old",
      turns,
      foldedTurnCount: turns.length,
      foldState: () => ({
        foldedTurnCount: turns.length,
        foldedPrefix: turns.length === 0 ? 0 : 1,
      }),
      residentNodes: [],
      isolatedChildren: false,
    }),
    getRun,
    ...(createScratch === undefined ? {} : { createScratch }),
  };
}

test("a plain resident export preserves node identity without reading runs", async () => {
  const live = createTranscriptStore();
  live.appendUserMessage("shown prompt");
  const nodes = live.nodes;
  const iterator = exportTranscriptBatches({
    snapshot: () => ({
      sessionId: "session",
      turns: [],
      foldedTurnCount: 0,
      foldState: () => ({ foldedTurnCount: 0, foldedPrefix: 0 }),
      residentNodes: nodes,
      isolatedChildren: false,
    }),
    getRun: () => {
      throw new Error("unexpected read");
    },
  });
  expect((await iterator.next()).value).toBe(nodes);
  expect((await iterator.next()).done).toBe(true);
});

test("early return disposes the scratch root after one incremental folded batch", async () => {
  let disposed = 0;
  const iterator = exportTranscriptBatches(
    source(
      [turn("a"), turn("b")],
      async (id) => detail(id),
      () => {
        onCleanup(() => {
          disposed += 1;
        });
        return createTranscriptStore();
      },
    ),
  );
  const first = await iterator.next();
  expect(first.done).toBe(false);
  expect(first.value?.some((node: TranscriptNode) => node.text.includes("answer a"))).toBe(true);
  expect(disposed).toBe(0);
  await iterator.return(undefined);
  expect(disposed).toBe(1);
});

test("a failed persisted read degrades to a notice and disposes the scratch root", async () => {
  let disposed = 0;
  const iterator = exportTranscriptBatches(
    source(
      [turn("a")],
      () => Promise.reject(new Error("offline")),
      () => {
        onCleanup(() => {
          disposed += 1;
        });
        return createTranscriptStore();
      },
    ),
  );
  const first = await iterator.next();
  expect(
    first.value?.some((node: TranscriptNode) => node.text.includes("reply could not be reloaded")),
  ).toBe(true);
  expect((await iterator.next()).done).toBe(true);
  expect(disposed).toBe(1);
});

test("concurrent exports own separate scratch stores and disposal", async () => {
  const scratchStores: TranscriptStore[] = [];
  const disposed: number[] = [];
  const input = source(
    [turn("a"), turn("b")],
    async (id) => detail(id),
    () => {
      const index = scratchStores.length;
      onCleanup(() => {
        disposed.push(index);
      });
      const scratch = createTranscriptStore();
      scratchStores.push(scratch);
      return scratch;
    },
  );
  const first = exportTranscriptBatches(input);
  const second = exportTranscriptBatches(input);
  await first.next();
  await second.next();
  expect(scratchStores).toHaveLength(2);
  expect(scratchStores[0]).not.toBe(scratchStores[1]);
  await first.return(undefined);
  expect(disposed).toEqual([0]);
  await second.return(undefined);
  expect(disposed).toEqual([0, 1]);
});
