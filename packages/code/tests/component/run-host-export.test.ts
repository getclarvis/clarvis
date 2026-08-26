import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { RunDetail } from "@clarvis/protocol";
import {
  createRunHost,
  RESIDENT_TRANSCRIPT_TURN_LIMIT,
  type RunHost,
  type RunHostDeps,
} from "../../src/run-host.ts";
import {
  createTranscriptStore,
  TRANSCRIPT_PROSE_RELEASED_NOTICE,
  type TranscriptNode,
  type TranscriptStore,
} from "../../src/adapters/store.ts";
import { createActivityStore } from "../../src/adapters/activity-store.ts";
import { createElicitSlot } from "../../src/adapters/elicit-slot.ts";
import type { SessionMeta, SessionStore } from "../../src/adapters/session-store.ts";
import { renderTranscriptMarkdown } from "../../src/views/transcript-markdown.ts";
import { runEvent } from "../helpers/run-events.ts";

/**
 * A whole-line needle for turn `i`'s reply.
 *
 * @remarks Anchored on both sides because a bare `answer 2` is also a prefix of
 *   `answer 20`, which silently turns "this turn is absent" into a pass.
 */
const answerLine = (i: number): string => `\nanswer ${i}\n`;

const ev = runEvent;

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

/** A completed run whose trace carries one assistant reply naming its turn. */
function detailFor(executionId: string): RunDetail {
  const index = executionId.replace("exec_", "");
  return {
    execution_id: executionId,
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [{ role: "user", content: `question ${index}` }],
    events: [
      ev({ type: "run_started", at: 0 }),
      ev({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        at: 1,
        model: "m",
        response: `answer ${index}`,
        input_tokens: 1,
        output_tokens: 1,
      }),
    ],
    result: {
      execution_id: executionId,
      status: "completed",
      result: `answer ${index}`,
      usage: {
        iterations: 1,
        elapsed_ms: 1,
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: 0,
      },
    },
  };
}

function mount(
  getRun: (executionId: string) => Promise<RunDetail | null>,
  opts: {
    proseTotalLimitBytes?: number;
    startRun?: RunHostDeps["client"]["startRun"];
  } = {},
): {
  host: RunHost;
  store: TranscriptStore;
  dispose: () => void;
} {
  let host!: RunHost;
  let store!: TranscriptStore;
  const dispose = createRoot((d) => {
    store = createTranscriptStore({
      ...(opts.proseTotalLimitBytes === undefined
        ? {}
        : { proseTotalLimitBytes: opts.proseTotalLimitBytes }),
    });
    host = createRunHost({
      store,
      activity: createActivityStore(),
      sessionStore: fakeSessionStore(),
      history: { push: () => {}, seed: () => {} } as unknown as RunHostDeps["history"],
      client: {
        startRun:
          opts.startRun ??
          (() => {
            throw new Error("not used");
          }),
        steer: () => Promise.resolve({ status: "steered" }),
        compact: ({ executionId }) =>
          Promise.resolve({ status: "queued", execution_id: executionId }),
        getRun: (id) => getRun(id),
        files: { readImage: async () => null } as unknown as RunHostDeps["client"]["files"],
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
  return { host, store, dispose };
}

function metaWith(turns: number): SessionMeta {
  return {
    id: "session-export",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: Array.from({ length: turns }, (_, i) => ({
      userPreview: `question ${i}`,
      executionId: `exec_${i}`,
      status: "done" as const,
    })),
    totals: { input: 0, output: 0, cached: 0 },
  };
}

async function exportNodes(host: RunHost): Promise<TranscriptNode[]> {
  const nodes: TranscriptNode[] = [];
  for await (const batch of host.exportNodeBatches()) nodes.push(...batch);
  return nodes;
}

describe("exportNodeBatches", () => {
  test("a session with no folded turns exports exactly the live transcript", async () => {
    const { host, store, dispose } = mount((id) => Promise.resolve(detailFor(id)));
    await host.loadSessionMeta(metaWith(3));
    const iterator = host.exportNodeBatches()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(store.nodes);
    expect((await iterator.next()).done).toBe(true);
    dispose();
  });

  test("resident prose evictions are lazily restored from persisted runs", async () => {
    const { host, store, dispose } = mount((id) => Promise.resolve(detailFor(id)), {
      proseTotalLimitBytes: 16,
    });
    await host.loadSessionMeta(metaWith(3));

    expect(store.nodes.some((node) => node.text === TRANSCRIPT_PROSE_RELEASED_NOTICE)).toBe(true);

    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(exported).not.toContain(TRANSCRIPT_PROSE_RELEASED_NOTICE);
    expect(exported).not.toContain("EXPORT INCOMPLETE");
    for (let i = 0; i < 3; i += 1) {
      expect(exported).toContain(`question ${i}`);
      expect(exported).toContain(answerLine(i));
    }
    dispose();
  });

  test("a released block with no persisted trace is marked as an incomplete export", async () => {
    const reads = new Map<string, number>();
    const { host, store, dispose } = mount(
      async (id) => {
        const count = (reads.get(id) ?? 0) + 1;
        reads.set(id, count);
        return count === 1 ? detailFor(id) : null;
      },
      { proseTotalLimitBytes: 16 },
    );
    await host.loadSessionMeta(metaWith(3));
    expect(store.nodes.some((node) => node.text === TRANSCRIPT_PROSE_RELEASED_NOTICE)).toBe(true);

    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(exported).not.toContain(TRANSCRIPT_PROSE_RELEASED_NOTICE);
    expect(exported).toContain("EXPORT INCOMPLETE");
    expect(exported).toContain("is no longer retained");
    dispose();
  });

  test("a persisted prompt that differs from the displayed slash command is never exported as it", async () => {
    const { host, store, dispose } = mount(
      async (id) => ({
        ...detailFor(id),
        messages: [{ role: "user", content: "an earlier unrelated prompt" }],
      }),
      { proseTotalLimitBytes: 16 },
    );
    store.appendUserMessage("rendered skill body", "/speckit-plan auth", "exec_skill");
    store.appendUserMessage("newer prompt", undefined, "exec_newer");
    expect(store.nodes[0]!.text).toBe(TRANSCRIPT_PROSE_RELEASED_NOTICE);

    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(exported).toContain("EXPORT INCOMPLETE");
    expect(exported).toContain("persisted prompt does not match");
    expect(exported).not.toContain("an earlier unrelated prompt");
    dispose();
  });

  test("a resumed session's folded turns are rebuilt, not dropped", async () => {
    const { host, store, dispose } = mount((id) => Promise.resolve(detailFor(id)));
    await host.loadSessionMeta(metaWith(25));
    expect(host.runStatus()).toContain("5 folded");

    const live = renderTranscriptMarkdown(store.nodes);
    for (const i of [0, 1, 2, 3, 4]) expect(live).not.toContain(answerLine(i));

    const exported = renderTranscriptMarkdown(await exportNodes(host));
    for (let i = 0; i < 25; i += 1) {
      expect(exported, `turn ${i} missing from the export`).toContain(answerLine(i));
      expect(exported).toContain(`question ${i}`);
    }
    dispose();
  });

  test("a live session keeps 20 semantic turns and lazily exports its complete folded prefix", async () => {
    const details = new Map<string, RunDetail>();
    let reads = 0;
    let turnIndex = 0;
    const { host, store, dispose } = mount(
      async (executionId) => {
        reads += 1;
        return details.get(executionId) ?? null;
      },
      {
        startRun: (input) => {
          const index = turnIndex++;
          const executionId = input.executionId!;
          const detail = detailFor(`exec_${index}`);
          detail.execution_id = executionId;
          detail.result = { ...detail.result!, execution_id: executionId };
          details.set(executionId, detail);
          return {
            executionId,
            cancel: async () => {},
            done: Promise.resolve(detail.result),
            closed: Promise.resolve(),
          };
        },
      },
    );

    for (let index = 0; index < 25; index += 1) await host.submitTurn(`question ${index}`);

    const residentUsers = store.nodes.filter((node) => node.kind === "user");
    const foldNotices = store.nodes.filter(
      (node) => node.kind === "annotation" && node.text.includes("folded from this live view"),
    );
    expect(residentUsers).toHaveLength(RESIDENT_TRANSCRIPT_TURN_LIMIT);
    expect(foldNotices).toHaveLength(1);
    expect(foldNotices[0]!.text).toContain("5 earlier turns");
    expect(store.nodes.some((node) => node.text.includes("question 0"))).toBe(false);
    expect(store.nodes.some((node) => node.text.includes("question 24"))).toBe(true);

    const readsBeforeExport = reads;
    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(reads - readsBeforeExport).toBe(5);
    for (let index = 0; index < 25; index += 1) {
      expect(exported).toContain(`question ${index}`);
      expect(exported).toContain(answerLine(index));
    }
    dispose();
  });

  test("the rebuilt turns come first and each prompt appears once", async () => {
    const { host, dispose } = mount((id) => Promise.resolve(detailFor(id)));
    await host.loadSessionMeta(metaWith(25));
    const exported = renderTranscriptMarkdown(await exportNodes(host));

    for (let i = 0; i < 25; i += 1) {
      const prompt = `question ${i}\n`;
      expect(exported.split(prompt).length - 1, `question ${i} duplicated`).toBe(1);
    }
    const positions = Array.from({ length: 25 }, (_, i) => exported.indexOf(answerLine(i)));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    dispose();
  });

  test("a folded turn whose trace is gone degrades to a notice instead of failing", async () => {
    const { host, dispose } = mount((id) =>
      id === "exec_2" ? Promise.resolve(null) : Promise.resolve(detailFor(id)),
    );
    await host.loadSessionMeta(metaWith(25));
    const nodes = await exportNodes(host);
    const exported = renderTranscriptMarkdown(nodes);

    expect(exported).not.toContain(answerLine(2));
    expect(exported).toContain("question 2");
    for (const i of [0, 1, 3, 4]) expect(exported).toContain(answerLine(i));
    expect(
      nodes.some((n) => n.kind === "annotation" && n.text.includes("could not be reloaded")),
    ).toBe(true);
    dispose();
  });

  test("a getRun that throws during export is contained", async () => {
    const { host, dispose } = mount((id) =>
      id === "exec_1" ? Promise.reject(new Error("offline")) : Promise.resolve(detailFor(id)),
    );
    await host.loadSessionMeta(metaWith(25));
    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(exported).toContain(answerLine(0));
    expect(exported).not.toContain(answerLine(1));
    dispose();
  });

  test("clearing the session drops the folded-turn record", async () => {
    const { host, store, dispose } = mount((id) => Promise.resolve(detailFor(id)));
    await host.loadSessionMeta(metaWith(25));
    host.clearSession({ flush: false });
    const iterator = host.exportNodeBatches()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(store.nodes);
    expect((await iterator.next()).done).toBe(true);
    dispose();
  });

  test("folded turns are yielded one at a time before the bounded live window", async () => {
    const { host, dispose } = mount((id) => Promise.resolve(detailFor(id)));
    await host.loadSessionMeta(metaWith(25));
    const batches: (readonly TranscriptNode[])[] = [];
    for await (const batch of host.exportNodeBatches()) batches.push(batch);
    expect(batches).toHaveLength(6);
    for (const batch of batches.slice(0, 5))
      expect(batch.filter((node) => node.kind === "user")).toHaveLength(1);
    dispose();
  });
});
