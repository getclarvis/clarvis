import { describe, expect, test } from "bun:test";
import { createComputed, createMemo, createRoot } from "solid-js";
import type { WorkspaceService } from "@clarvis/protocol";
import {
  applyEvent,
  createTranscriptStore,
  type TranscriptStore,
} from "../../src/adapters/store.ts";
import { createRunHost, type RunHost } from "../../src/run-host.ts";
import { createActivityStore } from "../../src/adapters/activity-store.ts";
import { createElicitSlot } from "../../src/adapters/elicit-slot.ts";
import type { SessionMeta, SessionStore } from "../../src/adapters/session-store.ts";
import type { PromptHistory } from "../../src/core/prompt-history.ts";
import { runEvent } from "../helpers/run-events.ts";

const ev = runEvent;

const EXEC = "exec_batch";

/**
 * Counts how many times a computation derived from `store.nodes` re-runs.
 *
 * @remarks The memo reads `status` on every node, which is what the real
 *   `grouped → toolGroups → focusables` chain reads, so its recomputation count
 *   is the thing batching is supposed to collapse.
 *
 *   `createComputed`, not `createEffect`: effects are queued and flushed after
 *   the enclosing synchronous block, so inside a `createRoot` body they have not
 *   run at all by the time the assertion reads the counter — which reports zero
 *   propagations no matter what the code under test does.
 */
function counting(store: TranscriptStore): () => number {
  let runs = 0;
  const derived = createMemo(() => store.nodes.map((n) => `${n.key}:${n.status}`).join("|"));
  createComputed(() => {
    derived();
    runs += 1;
  });
  return () => runs;
}

function fakeSessionStore(): SessionStore {
  const byId = new Map<string, SessionMeta>();
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
    load: async (id) => byId.get(id) ?? null,
    save: (meta) => void byId.set(meta.id, meta),
    delete: (id) => byId.delete(id),
  };
}

function fakeHistory(): PromptHistory {
  return {
    push: () => {},
    seed: () => {},
    prev: () => undefined,
    next: () => undefined,
    resetCursor: () => {},
    size: () => 0,
    flush: async () => {},
    persistenceDegraded: () => false,
  };
}

function fakeWorkspaceFiles(): WorkspaceService {
  return {
    listFiles: async () => [],
    readFile: async (path) => ({ path, content: "" }),
    readImage: async (path) => ({ path, mime: "image/png", data: "" }),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("reactive batching", () => {
  test("settling a run propagates once, not once per node", () => {
    createRoot((dispose) => {
      try {
        const store = createTranscriptStore();
        const sink = store.openRun(EXEC);
        applyEvent(sink, ev({ type: "run_started", at: 0 }), "live");
        for (let i = 0; i < 6; i += 1) {
          applyEvent(
            sink,
            ev({
              type: "tool_call_started",
              agent: "lead",
              call_id: `c${i}`,
              at: 1,
              server: "fs",
              tool: "grep",
              arguments: {},
            }),
            "live",
          );
        }
        const running = store.nodes.filter((n) => n.status === "running");
        expect(running.length).toBeGreaterThanOrEqual(5);

        const runs = counting(store);
        const before = runs();
        store.settleRun(EXEC, true);
        expect(runs() - before).toBe(1);
        expect(store.nodes.every((n) => n.status !== "running")).toBe(true);
      } finally {
        dispose();
      }
    });
  });

  test("one live event propagates once even though it writes several nodes", async () => {
    let store!: TranscriptStore;
    let host!: RunHost;
    const runStarted = deferred();
    const dispose = createRoot((d) => {
      store = createTranscriptStore();
      host = createRunHost({
        store,
        activity: createActivityStore(),
        sessionStore: fakeSessionStore(),
        history: fakeHistory(),
        client: {
          startRun: (input) => {
            runStarted.resolve();
            return {
              executionId: input.executionId ?? EXEC,
              cancel: () => Promise.resolve(),
              done: new Promise(() => {}),
              closed: new Promise(() => {}),
            };
          },
          steer: () => Promise.resolve({ status: "steered" }),
          compact: ({ executionId }) =>
            Promise.resolve({ status: "queued", execution_id: executionId }),
          getRun: () => Promise.resolve(null),
          files: fakeWorkspaceFiles(),
        },
        elicit: createElicitSlot(),
        owner: "test-owner",
        project: "prj_test",
        workspaceId: "ws_test",
        workspace: "/tmp",
        priceFor: () => undefined,
        activeProfile: () => "coder",
        setActiveProfile: () => {},
        guardMode: () => "on",
        judgePayload: () => ({}),
        memoryMode: () => "on",
      });
      return d;
    });

    try {
      /** A live run is what gives `onEvent` a sink to write through. */
      void host.submitTurn("go");
      await runStarted.promise;

      host.onEvent(ev({ type: "run_started", at: 0 }), "live");
      host.onEvent(
        ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
        "live",
      );
      expect(store.nodes.some((n) => n.kind === "thinking")).toBe(true);

      let propagations = 0;
      createRoot((d) => {
        const runs = counting(store);
        const before = runs();
        /**
         * A text delta removes the `thinking` node, upserts the assistant node and
         * patches its text: three store writes behind one event.
         */
        host.onEvent(
          ev({
            type: "text_delta",
            agent: "lead",
            iteration: 1,
            channel: "text",
            text: "hello",
            at: 2,
            reset: false,
          }),
          "live",
        );
        propagations = runs() - before;
        d();
      });

      expect(store.nodes.some((n) => n.kind === "assistant")).toBe(true);
      expect(store.nodes.some((n) => n.kind === "thinking")).toBe(false);
      expect(propagations).toBe(1);
    } finally {
      dispose();
    }
  });
});
