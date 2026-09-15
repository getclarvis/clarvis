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
      kind: "conversation",
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
    const totalTurns = 80;
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

    for (let index = 0; index < totalTurns; index += 1) {
      await host.submitTurn(`question ${index}`);
      const turnCount = index + 1;
      if (turnCount < RESIDENT_TRANSCRIPT_TURN_LIMIT) continue;
      expect(host.memory()).toMatchObject({
        transcript_resident_turns: RESIDENT_TRANSCRIPT_TURN_LIMIT,
        transcript_folded_turns: turnCount - RESIDENT_TRANSCRIPT_TURN_LIMIT,
        session_turn_refs: turnCount,
      });
      expect(store.nodes.filter((node) => node.kind === "user")).toHaveLength(
        RESIDENT_TRANSCRIPT_TURN_LIMIT,
      );
    }

    const residentUsers = store.nodes.filter((node) => node.kind === "user");
    const foldNotices = store.nodes.filter(
      (node) => node.kind === "annotation" && node.text.includes("folded from this live view"),
    );
    expect(residentUsers).toHaveLength(RESIDENT_TRANSCRIPT_TURN_LIMIT);
    expect(foldNotices).toHaveLength(1);
    expect(foldNotices[0]!.text).toContain("60 earlier turns");
    expect(store.nodes.some((node) => node.text.includes("question 0"))).toBe(false);
    expect(store.nodes.some((node) => node.text.includes("question 79"))).toBe(true);
    expect(host.memory()).toMatchObject({
      transcript_resident_turns: RESIDENT_TRANSCRIPT_TURN_LIMIT,
      transcript_folded_turns: totalTurns - RESIDENT_TRANSCRIPT_TURN_LIMIT,
      session_turn_refs: totalTurns,
    });

    const readsBeforeExport = reads;
    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(reads - readsBeforeExport).toBe(totalTurns - RESIDENT_TRANSCRIPT_TURN_LIMIT);
    for (let index = 0; index < totalTurns; index += 1) {
      expect(exported).toContain(`question ${index}`);
      expect(exported).toContain(answerLine(index));
    }
    dispose();
  });

  test("a refused incremental fold falls back to one bounded current-turn suffix", async () => {
    let turnIndex = 0;
    const { host, store, dispose } = mount(() => Promise.resolve(null), {
      startRun: (input) => {
        const executionId = input.executionId!;
        const detail = detailFor(`exec_${turnIndex++}`);
        detail.execution_id = executionId;
        detail.result = { ...detail.result!, execution_id: executionId };
        return {
          executionId,
          cancel: async () => {},
          done: Promise.resolve(detail.result),
          closed: Promise.resolve(),
        };
      },
    });

    for (let index = 0; index < RESIDENT_TRANSCRIPT_TURN_LIMIT; index += 1) {
      await host.submitTurn(`question ${index}`);
    }
    const foldPrefixBefore = store.foldPrefixBefore.bind(store);
    let foldAttempts = 0;
    store.foldPrefixBefore = (beforeKey, notice) => {
      foldAttempts += 1;
      return foldAttempts === 1 ? false : foldPrefixBefore(beforeKey, notice);
    };
    await host.submitTurn("fold refused");

    expect(foldAttempts).toBe(2);
    expect(host.memory()).toMatchObject({
      transcript_resident_turns: 1,
      transcript_folded_turns: RESIDENT_TRANSCRIPT_TURN_LIMIT,
      session_turn_refs: RESIDENT_TRANSCRIPT_TURN_LIMIT + 1,
    });
    expect(store.nodes.filter((node) => node.kind === "user")).toHaveLength(1);
    expect(
      store
        .committedNodes()
        .filter((publication) => publication.key === "transcript:folded-prefix"),
    ).toHaveLength(1);
    expect(store.memory?.().sealed_records).toBeLessThanOrEqual(store.nodes.length);
    dispose();
  });

  test("two refused structural folds still roll back the speculative resident-turn ref", async () => {
    let turnIndex = 0;
    const { host, store, dispose } = mount(() => Promise.resolve(null), {
      startRun: (input) => {
        const executionId = input.executionId!;
        const detail = detailFor(`exec_${turnIndex++}`);
        detail.execution_id = executionId;
        detail.result = { ...detail.result!, execution_id: executionId };
        return {
          executionId,
          cancel: async () => {},
          done: Promise.resolve(detail.result),
          closed: Promise.resolve(),
        };
      },
    });

    for (let index = 0; index < RESIDENT_TRANSCRIPT_TURN_LIMIT; index += 1) {
      await host.submitTurn(`question ${index}`);
    }
    store.foldPrefixBefore = () => false;
    await host.submitTurn("fold refused twice");

    expect(host.memory()).toMatchObject({
      transcript_resident_turns: RESIDENT_TRANSCRIPT_TURN_LIMIT,
      transcript_folded_turns: 0,
      session_turn_refs: RESIDENT_TRANSCRIPT_TURN_LIMIT + 1,
    });
    dispose();
  });

  test("transcript-only skill runs use the same bounded canonical export index", async () => {
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
          detail.messages = [];
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

    for (let index = 0; index < 25; index += 1) {
      await host.submitSkillRun("explorer", `question ${index}`, "explorer");
    }

    expect(host.sessionMeta()?.turns.every((turn) => turn.kind === "transcript")).toBe(true);
    expect(store.nodes.filter((node) => node.kind === "user")).toHaveLength(
      RESIDENT_TRANSCRIPT_TURN_LIMIT,
    );
    expect(host.memory()).toMatchObject({
      transcript_resident_turns: RESIDENT_TRANSCRIPT_TURN_LIMIT,
      transcript_folded_turns: 5,
      session_turn_refs: 25,
    });

    const readsBeforeExport = reads;
    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(reads - readsBeforeExport).toBe(5);
    for (let index = 0; index < 25; index += 1) {
      expect(exported).toContain(`/explorer question ${index}`);
      expect(exported).toContain(answerLine(index));
    }
    dispose();
  });

  test("folded export reads the canonical turn index one item at a time", async () => {
    const reads: string[] = [];
    const requested: string[] = [];
    const { host, dispose } = mount((id) => {
      requested.push(id);
      return Promise.resolve(detailFor(id));
    });
    await host.loadSessionMeta(metaWith(25));
    requested.length = 0;

    const meta = host.sessionMeta()!;
    meta.turns[0] = {
      ...meta.turns[0]!,
      kind: "conversation",
      userPreview: "canonical question",
      executionId: "exec_canonical",
    };
    meta.turns = new Proxy(meta.turns, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const iterator = host.exportNodeBatches()[Symbol.asyncIterator]();
    expect(reads).toEqual([]);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(reads).toEqual(["0"]);
    expect(requested).toEqual(["exec_canonical"]);
    expect(renderTranscriptMarkdown(first.value)).toContain("question canonical");

    await iterator.return?.();
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

  test("a folded turn whose canonical metadata disappeared degrades in place", async () => {
    const { host, dispose } = mount((id) => Promise.resolve(detailFor(id)));
    await host.loadSessionMeta(metaWith(25));
    const turns = host.sessionMeta()!.turns as Array<SessionMeta["turns"][number] | undefined>;
    turns[0] = undefined;

    const iterator = host.exportNodeBatches()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(
      first.value.some(
        (node: TranscriptNode) =>
          node.kind === "annotation" &&
          node.text.includes("this turn's session metadata could not be reloaded"),
      ),
    ).toBe(true);
    await iterator.return?.();
    dispose();
  });

  test("a folded canonical turn without a trace id remains readable", async () => {
    const { host, dispose } = mount((id) => Promise.resolve(detailFor(id)));
    await host.loadSessionMeta(metaWith(25));
    delete host.sessionMeta()!.turns[0]!.executionId;

    const iterator = host.exportNodeBatches()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const exported = renderTranscriptMarkdown(first.value);
    expect(exported).toContain("question 0");
    expect(
      first.value.some(
        (node: TranscriptNode) =>
          node.kind === "annotation" &&
          node.text.includes("this turn has no persisted run to reload"),
      ),
    ).toBe(true);
    await iterator.return?.();
    dispose();
  });

  test("a folded conversation whose trace lost its prompt keeps the canonical preview", async () => {
    const { host, dispose } = mount((id) => Promise.resolve({ ...detailFor(id), messages: [] }));
    await host.loadSessionMeta(metaWith(25));

    const iterator = host.exportNodeBatches()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const exported = renderTranscriptMarkdown(first.value);
    expect(exported).toContain("question 0");
    expect(
      first.value.some(
        (node: TranscriptNode) =>
          node.kind === "annotation" && node.text.includes("complete prompt could not be reloaded"),
      ),
    ).toBe(true);
    await iterator.return?.();
    dispose();
  });

  test("a resident released block contains a persisted-read failure", async () => {
    let exportPhase = false;
    const { host, dispose } = mount(
      (id) =>
        exportPhase ? Promise.reject(new Error("storage offline")) : Promise.resolve(detailFor(id)),
      { proseTotalLimitBytes: 16 },
    );
    await host.loadSessionMeta(metaWith(3));
    exportPhase = true;

    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(exported).toContain("EXPORT INCOMPLETE");
    expect(exported).toContain("could not be fetched");
    dispose();
  });

  test("resident released prose reports missing prompt and reply projections", async () => {
    let exportPhase = false;
    const { host, dispose } = mount(
      (id) =>
        Promise.resolve(
          exportPhase ? { ...detailFor(id), messages: [], events: [] } : detailFor(id),
        ),
      { proseTotalLimitBytes: 16 },
    );
    await host.loadSessionMeta(metaWith(3));
    exportPhase = true;

    const exported = renderTranscriptMarkdown(await exportNodes(host));
    expect(exported).toContain("has no recoverable prompt");
    expect(exported).toContain("has no recoverable assistant block");
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
