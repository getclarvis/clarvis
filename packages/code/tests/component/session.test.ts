import { expect, test } from "bun:test";
import type {
  ActiveTaskBindingDto,
  Message,
  PlanRef,
  RunDetail,
  RunEvent,
  RunResult,
  RunUsage,
} from "@clarvis/protocol";
import {
  TURN_ERROR_MAX_CHARS,
  type SessionMeta,
  type SessionStore,
} from "../../src/adapters/session-store.ts";
import {
  buildSkillRunDigest,
  buildRecoveredContext,
  createSession,
  deleteSession,
  isContinuationUnavailable,
  resumeSession,
  SESSION_RESUME_MAX_PAYLOAD_CHARS,
} from "../../src/adapters/session.ts";

const INTERRUPTED_EVENTS: RunEvent[] = [
  {
    type: "elicitation_resolved",
    at: 1,
    agent: "lead",
    question: "Qual é o seu DNS do Tailscale?",
    outcome: "accept",
    answer: "fedora.airplane-mooneye.ts.net",
  },
  {
    type: "elicitation_resolved",
    at: 2,
    agent: "lead",
    question: "Qual banco?",
    outcome: "decline",
  },
];

const INTERRUPTED_PLAN_PATH = ".clarvis/plans/2026-07-25T14-08-31-app.md";

const INTERRUPTED_PLAN_REF: PlanRef = {
  id: INTERRUPTED_PLAN_PATH,
  provider_key: "markdown",
  path: INTERRUPTED_PLAN_PATH,
  final_revision: 7,
  final_spec_revision: 2,
  status: "active",
  retention: "keep",
};

function fakeStore(): SessionStore & { snapshots: SessionMeta[] } {
  const map = new Map<string, SessionMeta>();
  const snapshots: SessionMeta[] = [];
  return {
    snapshots,
    list: () => [...map.values()],
    get: (id) => map.get(id) ?? null,
    load: async (id) => map.get(id) ?? null,
    save: (m) => {
      map.set(m.id, structuredClone(m));
      snapshots.push(structuredClone(m));
    },
    delete: (id) => map.delete(id),
  };
}

function usage(i: number, o: number, c: number): RunUsage {
  return {
    iterations: 1,
    elapsed_ms: 1,
    by_agent: [
      {
        role: "lead",
        model: "m",
        input_tokens: i,
        output_tokens: o,
        cached_tokens: c,
        cache_write_tokens: 0,
        iterations: 1,
      },
    ],
  };
}

function wire(
  execId: string,
  status: "completed" | "error",
  result: string,
  u: RunUsage,
): RunResult {
  if (status === "error") {
    return {
      execution_id: execId,
      status: "failed",
      result,
      usage: u,
      error: { code: "run_failed", message: "boom" },
    };
  }
  return { execution_id: execId, status: "completed", result, usage: u };
}

function stored(
  execId: string,
  status: "completed" | "error",
  tokens: [number, number, number?],
  parts: {
    messages?: Message[];
    result?: string;
    events?: RunEvent[];
    planRef?: PlanRef;
    continueFrom?: string;
    activeTask?: ActiveTaskBindingDto;
    environment?: { id: string; fingerprint: string };
  } = {},
): RunDetail {
  const runStatus = status === "error" ? "failed" : "completed";
  return {
    execution_id: execId,
    status: runStatus,
    created_at: 1,
    ended_at: 2,
    ...(parts.continueFrom ? { continue_from: parts.continueFrom } : {}),
    messages: parts.messages ?? [],
    events: parts.events ?? [],
    ...(parts.planRef ? { plan_ref: parts.planRef } : {}),
    ...(parts.activeTask ? { active_task: parts.activeTask } : {}),
    ...(parts.environment ? { environment: parts.environment } : {}),
    result: {
      execution_id: execId,
      status: runStatus,
      result: parts.result ?? "",
      usage: {
        iterations: 1,
        elapsed_ms: 1,
        input_tokens: tokens[0],
        output_tokens: tokens[1],
        ...(tokens[2] !== undefined ? { cached_tokens: tokens[2] } : {}),
      },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("a turn snapshots its Environment and reconciliation trusts the persisted run", () => {
  const store = fakeStore();
  const initial = {
    id: "global:research",
    fingerprint: `sha256:${"a".repeat(64)}`,
  };
  const persisted = {
    id: "global:research",
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
  const s = createSession({
    store,
    owner: "clarvis",
    project: "prj_test",
    workspace: "/ws",
    environment: () => initial,
  });

  s.beginTurn("hi", "exec_environment");
  expect(s.meta()?.turns[0]?.environment).toEqual(initial);
  expect(s.meta()?.lastEnvironment).toEqual(initial);

  s.reconcile(stored("exec_environment", "completed", [0, 0, 0], { environment: persisted }));
  expect(s.meta()?.turns[0]?.environment).toEqual(persisted);
  expect(s.meta()?.lastEnvironment).toEqual(persisted);
});

test("a failed turn records why, and a later success clears it", () => {
  // The kernel preserves `error: {code, message}` on a failed run's envelope.
  // A run that fails before its trace record is written — a rejected
  // continuation, a failed persist, an unavailable kernel, a crash — leaves this
  // as the only account of why.
  const store = fakeStore();
  const s = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    { profile: "answerer" },
  );
  s.beginTurn("hi", "exec_1");
  s.endTurn(wire("exec_1", "error", "", usage(1, 0, 0)));
  expect(s.meta()?.turns[0]?.status).toBe("error");
  expect(s.meta()?.turns[0]?.error).toEqual({ code: "run_failed", message: "boom" });

  s.beginTurn("again", "exec_2");
  s.endTurn(wire("exec_2", "completed", "ok", usage(1, 1, 0)));
  expect(s.meta()?.turns[1]?.error).toBeUndefined();
});

function failed(execId: string, message: string): RunResult {
  return {
    execution_id: execId,
    status: "failed",
    result: "",
    usage: usage(0, 0, 0),
    error: { code: "provider_error", message },
  };
}

// The reason is now written to a session document, so it is bounded and masked
// where it is produced — the same place beginTurn masks a preview — which keeps
// the value held in memory identical to the one on disk.
test("a failed turn's reason is masked and bounded before it is recorded", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  s.beginTurn("hi", "exec_1");
  s.endTurn(failed("exec_1", "auth failed for sk-ABCDEF0123456789abcdef"));
  expect(s.meta()?.turns[0]?.error?.message).toBe("auth failed for sk-[redacted]");

  s.beginTurn("again", "exec_2");
  s.endTurn(failed("exec_2", "stack frame ".repeat(400)));
  expect(s.meta()?.turns[1]?.error?.message.length).toBeLessThanOrEqual(TURN_ERROR_MAX_CHARS);

  const persisted = store.snapshots.at(-1);
  expect(persisted?.turns[1]?.error).toEqual(s.meta()!.turns[1]!.error!);
});

// `redactPreviews: false` is a whole-session opt-out, not a preview-only one.
test("redactPreviews: false keeps a failed turn's reason verbatim", () => {
  const store = fakeStore();
  const s = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    { redactPreviews: false },
  );
  s.beginTurn("hi", "exec_1");
  s.endTurn(failed("exec_1", "auth failed for sk-ABCDEF0123456789abcdef"));
  expect(s.meta()?.turns[0]?.error?.message).toBe("auth failed for sk-ABCDEF0123456789abcdef");
});

test("createSession accumulates a multi-turn Message[] and totals", () => {
  const store = fakeStore();
  const s = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    { profile: "answerer" },
  );

  s.beginTurn("hi", "exec_1");
  expect(s.messages()).toEqual([{ role: "user", content: "hi" }]);
  expect(s.meta()?.title).toBe("hi");
  expect(s.meta()?.profile).toBe("answerer");
  expect(s.meta()?.turns[0]?.status).toBe("running");

  s.endTurn(wire("exec_1", "completed", "hello there", usage(10, 4, 0)));
  expect(s.messages()).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello there" },
  ]);
  expect(s.meta()?.turns[0]?.status).toBe("done");
  expect(s.meta()?.totals).toEqual({ input: 10, output: 4, cached: 0 });

  s.beginTurn("more", "exec_2");
  expect(s.messages().length).toBe(3);
  s.endTurn(wire("exec_2", "completed", "ok", usage(5, 2, 1)));
  expect(s.meta()?.totals).toEqual({ input: 15, output: 6, cached: 1 });
});

test("settlement preserves a missing cache split as unknown", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  s.beginTurn("hi", "exec_unknown");
  s.endTurn(
    wire("exec_unknown", "completed", "ok", {
      iterations: 1,
      elapsed_ms: 1,
      input_tokens: 10,
      output_tokens: 4,
    }),
  );
  expect(s.meta()?.totals).toEqual({ input: 10, output: 4 });
});

test("releaseHistory drops only the reconstructible message chain and restoreHistory rearms it", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  s.beginTurn("large prompt", "exec_1");
  s.endTurn(wire("exec_1", "completed", "large answer", usage(1, 1, 0)));

  expect(s.hasCompleteHistory()).toBe(true);
  expect(s.memory()).toMatchObject({
    session_messages: 2,
    session_history_complete: true,
  });
  expect(s.memory().session_payload_bytes).toBeGreaterThan(0);
  s.releaseHistory();
  expect(s.messages()).toEqual([]);
  expect(s.hasCompleteHistory()).toBe(false);
  expect(s.memory()).toMatchObject({
    session_messages: 0,
    session_payload_bytes: 0,
    session_history_complete: false,
  });

  s.appendObservation("pending local observation");
  expect(s.messages()).toEqual([{ role: "assistant", content: "pending local observation" }]);
  expect(s.hasCompleteHistory()).toBe(false);

  s.restoreHistory([
    { role: "user", content: "large prompt" },
    { role: "assistant", content: "large answer" },
    { role: "assistant", content: "pending local observation" },
  ]);
  expect(s.hasCompleteHistory()).toBe(true);
  expect(s.messages()).toHaveLength(3);
});

test("beginTurn returns the previous turn's executionId as the continuation base", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  expect(s.beginTurn("first", "exec_1")).toBeUndefined();
  s.endTurn(wire("exec_1", "completed", "a", usage(1, 1, 0)));
  expect(s.beginTurn("second", "exec_2")).toBe("exec_1");
  s.endTurn(undefined);
  expect(s.beginTurn("third", "exec_3")).toBe("exec_2");
});

test("setProfile persists only a changed profile on an established session", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });

  s.setProfile("before-first-turn");
  expect(store.snapshots).toHaveLength(0);

  s.beginTurn("first", "exec_1");
  const afterBegin = store.snapshots.length;
  s.setProfile("reviewer");
  expect(s.meta()?.profile).toBe("reviewer");
  expect(store.snapshots).toHaveLength(afterBegin + 1);

  s.setProfile("reviewer");
  expect(store.snapshots).toHaveLength(afterBegin + 1);
});

test("transcript-only runs are canonical without becoming continuation context", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  s.beginTurn("first", "exec_conversation");
  s.endTurn(wire("exec_conversation", "completed", "answer", usage(2, 1, 0)));

  s.beginTranscriptTurn("/explorer inspect", "exec_skill");
  s.endTranscriptTurn(wire("exec_skill", "completed", "internal result", usage(3, 2, 0)));

  expect(s.meta()?.turns).toMatchObject([
    { kind: "conversation", executionId: "exec_conversation", status: "done" },
    {
      kind: "transcript",
      executionId: "exec_skill",
      userPreview: "/explorer inspect",
      status: "done",
    },
  ]);
  expect(s.messages()).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
  ]);
  expect(s.meta()?.totals).toEqual({ input: 5, output: 3, cached: 0 });
  expect(s.beginTurn("second", "exec_next")).toBe("exec_conversation");
});

test("a resumed session continues from the last stored turn", () => {
  const store = fakeStore();
  const meta: SessionMeta = {
    id: "s1",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        kind: "conversation",
        userPreview: "one",
        executionId: "exec_a",
        status: "done",
        startedAt: 1,
      },
      {
        kind: "conversation",
        userPreview: "two",
        executionId: "exec_b",
        status: "error",
        startedAt: 2,
      },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  const s = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    { meta, messages: [{ role: "user", content: "one" }] },
  );
  expect(s.beginTurn("three", "exec_c")).toBe("exec_b");
});

test("isContinuationUnavailable matches only the continuation_unavailable error envelope", () => {
  expect(isContinuationUnavailable(undefined)).toBe(false);
  expect(isContinuationUnavailable(wire("e1", "completed", "ok", usage(1, 1, 0)))).toBe(false);
  const otherError: RunResult = {
    execution_id: "e2",
    status: "failed",
    error: { code: "provider_error", message: "boom" },
    usage: usage(1, 0, 0),
  };
  expect(isContinuationUnavailable(otherError)).toBe(false);
  const unavailable: RunResult = {
    execution_id: "e3",
    status: "failed",
    error: { code: "continuation_unavailable", message: "gone" },
    usage: usage(0, 0, 0),
  };
  expect(isContinuationUnavailable(unavailable)).toBe(true);
});

test("reconcile does not double-count an already-counted turn", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  s.beginTurn("hi", "exec_1");
  s.endTurn(wire("exec_1", "completed", "x", usage(10, 4, 0)));
  s.reconcile(stored("exec_1", "completed", [10, 4, 0]));
  expect(s.meta()?.totals).toEqual({ input: 10, output: 4, cached: 0 });
});

test("reconcile counts a turn whose endTurn had no envelope (error path)", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  s.beginTurn("boom", "exec_9");
  s.endTurn(undefined);
  expect(s.meta()?.turns[0]?.status).toBe("error");
  s.reconcile(stored("exec_9", "error", [7, 0, 0]));
  expect(s.meta()?.totals.input).toBe(7);
  expect(s.meta()?.turns[0]?.status).toBe("error");
});

test("reconcile does not collapse an absent persisted cache split to zero", () => {
  const store = fakeStore();
  const s = createSession({ store, owner: "clarvis", project: "prj_test", workspace: "/ws" });
  s.beginTurn("boom", "exec_unknown");
  s.endTurn(undefined);
  s.reconcile(stored("exec_unknown", "completed", [7, 2]));
  expect(s.meta()?.totals).toEqual({ input: 7, output: 2 });
});

test("resumeSession rehydrates from the last available trace and flags degraded turns", async () => {
  const meta: SessionMeta = {
    id: "sid",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "q1", executionId: "exec_a", status: "done" },
      { kind: "conversation", userPreview: "q2", executionId: "exec_b", status: "running" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };

  const rendered: { executionId?: string; hasEvents: boolean }[] = [];
  const resumed = await resumeSession(meta, {
    getRun: async (id) =>
      id === "exec_a"
        ? stored("exec_a", "completed", [1, 1, 0], {
            messages: [{ role: "user", content: "q1" }],
            result: "a1",
            events: [{ type: "run_started", at: 1 }],
          })
        : null,
    renderTurn: ({ executionId, events }) =>
      rendered.push({ executionId, hasEvents: !!events && events.length > 0 }),
  });

  expect(resumed.messages).toEqual([
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ]);
  expect(resumed.degraded).toEqual([{ executionId: "exec_b", reason: "interrupted" }]);
  expect(rendered).toEqual([
    { executionId: "exec_a", hasEvents: true },
    { executionId: "exec_b", hasEvents: false },
  ]);
});

test("resumeSession accumulates slim continue_from turns instead of replacing the history", async () => {
  const meta: SessionMeta = {
    id: "sid",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "q1", executionId: "exec_a", status: "done" },
      { kind: "conversation", userPreview: "q2", executionId: "exec_b", status: "done" },
      { kind: "conversation", userPreview: "q3", executionId: "exec_c", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  const runs: Record<string, RunDetail> = {
    exec_a: stored("exec_a", "completed", [1, 1, 0], {
      messages: [{ role: "user", content: "q1" }],
      result: "a1",
    }),
    exec_b: stored("exec_b", "completed", [1, 1, 0], {
      messages: [{ role: "user", content: "q2" }],
      result: "a2",
      continueFrom: "exec_a",
    }),
    exec_c: stored("exec_c", "completed", [1, 1, 0], {
      messages: [{ role: "user", content: "q3" }],
      result: "a3",
      continueFrom: "exec_b",
    }),
  };
  const resumed = await resumeSession(meta, {
    getRun: async (id) => runs[id] ?? null,
    renderTurn: () => {},
  });
  expect(resumed.messages).toEqual([
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "q3" },
    { role: "assistant", content: "a3" },
  ]);
  expect(resumed.degraded).toEqual([]);
});

test("resumeSession renders transcript-only runs without adding them to continuation", async () => {
  const meta: SessionMeta = {
    id: "sid-mixed",
    title: "mixed",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "q1", executionId: "exec_a", status: "done" },
      {
        kind: "transcript",
        userPreview: "/explorer inspect",
        executionId: "exec_skill",
        status: "done",
      },
      { kind: "conversation", userPreview: "q2", executionId: "exec_b", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  const skillTask: ActiveTaskBindingDto = {
    id: "SHOULD-NOT-BIND",
    provider_key: "mcp:test:tasks",
    mode: "work",
  };
  const runs: Record<string, RunDetail> = {
    exec_a: stored("exec_a", "completed", [1, 1, 0], {
      messages: [{ role: "user", content: "q1" }],
      result: "a1",
    }),
    exec_skill: stored("exec_skill", "completed", [9, 9, 0], {
      messages: [{ role: "user", content: "internal skill prompt" }],
      result: "internal skill result",
      activeTask: skillTask,
    }),
    exec_b: stored("exec_b", "completed", [1, 1, 0], {
      messages: [{ role: "user", content: "q2" }],
      result: "a2",
      continueFrom: "exec_a",
    }),
  };
  const rendered: { executionId?: string; userContent: Message["content"] }[] = [];
  const resumed = await resumeSession(meta, {
    getRun: async (id) => runs[id] ?? null,
    renderTurn: ({ executionId, userContent }) => rendered.push({ executionId, userContent }),
  });

  expect(resumed.messages).toEqual([
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);
  expect(resumed.activeTask).toBeUndefined();
  expect(rendered).toEqual([
    { executionId: "exec_a", userContent: "q1" },
    { executionId: "exec_skill", userContent: "/explorer inspect" },
    { executionId: "exec_b", userContent: "q2" },
  ]);
});

test("resumeSession restores the newest persisted task binding", async () => {
  const meta: SessionMeta = {
    id: "sid-task",
    title: "task",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 2,
    turns: [
      { kind: "conversation", userPreview: "q1", executionId: "exec_a", status: "done" },
      { kind: "conversation", userPreview: "q2", executionId: "exec_b", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  const binding: ActiveTaskBindingDto = {
    id: "CLAR-42",
    provider_key: "mcp:jira-work:tasks:abc",
    mode: "work",
  };

  const resumed = await resumeSession(meta, {
    getRun: async (id) =>
      stored(id, "completed", [1, 1, 0], {
        messages: [{ role: "user", content: id }],
        ...(id === "exec_b" ? { activeTask: binding, continueFrom: "exec_a" } : {}),
      }),
    renderTurn: () => {},
  });

  expect(resumed.activeTask).toEqual(binding);
});

test("resumeSession: a full-wire retry turn replaces the accumulated history (authoritative)", async () => {
  const meta: SessionMeta = {
    id: "sid",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "q1", executionId: "exec_a", status: "done" },
      { kind: "conversation", userPreview: "q2", executionId: "exec_b", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  const runs: Record<string, RunDetail> = {
    exec_a: stored("exec_a", "completed", [1, 1, 0], {
      messages: [{ role: "user", content: "q1" }],
      result: "a1",
    }),
    exec_b: stored("exec_b", "completed", [1, 1, 0], {
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
      result: "a2",
    }),
  };
  const resumed = await resumeSession(meta, {
    getRun: async (id) => runs[id] ?? null,
    renderTurn: () => {},
  });
  expect(resumed.messages).toEqual([
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);
});

function manyTurns(n: number): SessionMeta {
  return {
    id: "sid",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: Array.from({ length: n }, (_, i) => ({
      kind: "conversation",
      userPreview: `q${i}`,
      executionId: `exec_${i}`,
      status: "done" as const,
    })),
    totals: { input: 0, output: 0, cached: 0 },
  };
}

function chainedRuns(n: number): Record<string, RunDetail> {
  const runs: Record<string, RunDetail> = {};
  for (let i = 0; i < n; i++) {
    runs[`exec_${i}`] = stored(`exec_${i}`, "completed", [1, 1, 0], {
      messages: [{ role: "user", content: `q${i}` }],
      result: `a${i}`,
      events: [{ type: "run_started", at: 1 }],
      ...(i > 0 ? { continueFrom: `exec_${i - 1}` } : {}),
    });
  }
  return runs;
}

test("resumeSession stops fetching once it reaches a turn that carries no continue_from", async () => {
  const meta = manyTurns(14);
  const runs = chainedRuns(14);
  runs["exec_12"] = stored("exec_12", "completed", [1, 1, 0], {
    messages: [{ role: "user", content: "q12" }],
    result: "a12",
  });

  const fetched: string[] = [];
  const resumed = await resumeSession(
    meta,
    {
      getRun: async (id) => {
        fetched.push(id);
        return runs[id] ?? null;
      },
      renderTurn: () => {},
    },
    { renderWindow: 2 },
  );

  expect(fetched).toHaveLength(6);
  expect(fetched).toContain("exec_12");
  expect(fetched).toContain("exec_13");
  expect(fetched).not.toContain("exec_0");
  expect(fetched).not.toContain("exec_7");
  expect(resumed.messages).toEqual([
    { role: "user", content: "q12" },
    { role: "assistant", content: "a12" },
    { role: "user", content: "q13" },
    { role: "assistant", content: "a13" },
  ]);
});

test("resumeSession folds turns outside the render window and reports how many", async () => {
  const meta = manyTurns(5);
  const runs = chainedRuns(5);

  const rendered: { executionId?: string; hasEvents: boolean; collapsed?: true }[] = [];
  const resumed = await resumeSession(
    meta,
    {
      getRun: async (id) => runs[id] ?? null,
      renderTurn: ({ executionId, events, collapsed }) =>
        rendered.push({
          executionId,
          hasEvents: !!events?.length,
          ...(collapsed ? { collapsed } : {}),
        }),
    },
    { renderWindow: 2 },
  );

  expect(resumed.collapsed).toBe(3);
  expect(rendered.map((r) => r.executionId)).toEqual([
    "exec_0",
    "exec_1",
    "exec_2",
    "exec_3",
    "exec_4",
  ]);
  expect(rendered.slice(0, 3).every((r) => r.collapsed === true && !r.hasEvents)).toBe(true);
  expect(rendered.slice(3).every((r) => r.collapsed === undefined && r.hasEvents)).toBe(true);
});

test("resumeSession hands a recovered turn's counts to the renderer, without degrading it", async () => {
  const meta = manyTurns(3);
  const runs = chainedRuns(3);
  runs["exec_1"] = {
    ...runs["exec_1"]!,
    recovery: { skipped_lines: 4, synthesized_tool_calls: 2 },
  };
  runs["exec_0"] = {
    ...runs["exec_0"]!,
    recovery: { skipped_lines: 1, synthesized_tool_calls: 0 },
  };

  const rendered: { id?: string; recovery?: unknown; hasEvents: boolean }[] = [];
  const resumed = await resumeSession(
    meta,
    {
      getRun: async (id) => runs[id] ?? null,
      renderTurn: ({ executionId, recovery, events }) =>
        rendered.push({ id: executionId, recovery, hasEvents: !!events?.length }),
    },
    { renderWindow: 2 },
  );

  expect(resumed.degraded).toEqual([]);
  expect(rendered).toEqual([
    { id: "exec_0", recovery: undefined, hasEvents: false },
    { id: "exec_1", recovery: { skipped_lines: 4, synthesized_tool_calls: 2 }, hasEvents: true },
    { id: "exec_2", recovery: undefined, hasEvents: true },
  ]);
});

test("resumeSession never marks a folded turn as degraded", async () => {
  const meta = manyTurns(4);
  const runs = chainedRuns(4);

  const resumed = await resumeSession(
    meta,
    { getRun: async (id) => runs[id] ?? null, renderTurn: () => {} },
    { renderWindow: 1 },
  );

  expect(resumed.degraded).toEqual([]);
  expect(resumed.collapsed).toBe(3);
});

test("resumeSession counts a folded-but-pruned turn as degraded only, never as both", async () => {
  const meta = manyTurns(4);
  const runs = chainedRuns(4);
  delete runs["exec_0"];

  const rendered: { degraded?: string; collapsed?: true }[] = [];
  const resumed = await resumeSession(
    meta,
    {
      getRun: async (id) => runs[id] ?? null,
      renderTurn: ({ degraded, collapsed }) => rendered.push({ degraded, collapsed }),
    },
    { renderWindow: 1 },
  );

  expect(resumed.degraded).toEqual([{ executionId: "exec_0", reason: "trace_pruned" }]);
  expect(resumed.collapsed).toBe(2);
  expect(resumed.collapsed + resumed.degraded.length).toBe(3);
  expect(rendered[0]).toEqual({ degraded: "trace_pruned", collapsed: undefined });
});

test("resumeSession keeps the message chain in turn order despite concurrent fetches", async () => {
  const meta = manyTurns(9);
  const runs = chainedRuns(9);
  const requests = new Map<string, ReturnType<typeof deferred<RunDetail | null>>>();
  const firstBatchRequested = deferred<void>();
  const finalRequestStarted = deferred<void>();

  const pending = resumeSession(
    meta,
    {
      getRun: async (id) => {
        const request = deferred<RunDetail | null>();
        requests.set(id, request);
        if (requests.size === 6) firstBatchRequested.resolve(undefined);
        if (requests.size === 9) finalRequestStarted.resolve(undefined);
        return request.promise;
      },
      renderTurn: () => {},
    },
    { renderWindow: 100 },
  );

  await firstBatchRequested.promise;
  for (let i = 3; i <= 8; i++) {
    const id = `exec_${i}`;
    requests.get(id)!.resolve(runs[id] ?? null);
  }
  await finalRequestStarted.promise;
  for (let i = 0; i <= 2; i++) {
    const id = `exec_${i}`;
    requests.get(id)!.resolve(runs[id] ?? null);
  }
  const resumed = await pending;

  expect(resumed.messages.map((m) => m.content)).toEqual([
    "q0",
    "a0",
    "q1",
    "a1",
    "q2",
    "a2",
    "q3",
    "a3",
    "q4",
    "a4",
    "q5",
    "a5",
    "q6",
    "a6",
    "q7",
    "a7",
    "q8",
    "a8",
  ]);
});

test("resumeSession releases fetched RunDetail objects before requesting the next batch", async () => {
  const meta = manyTurns(13);
  const secondBatchStarted = deferred<void>();
  const releaseSecondBatch = deferred<void>();
  const firstBatch = new Map<number, WeakRef<RunDetail>>();
  let inFlight = 0;
  let maxInFlight = 0;

  const pending = resumeSession(
    meta,
    {
      getRun: async (id) => {
        const index = Number(id.slice("exec_".length));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (index < 7) {
            secondBatchStarted.resolve(undefined);
            await releaseSecondBatch.promise;
          }
          const detail = stored(id, "completed", [1, 1, 0], {
            messages: [{ role: "user", content: `q${index}` }],
            result: `a${index}`,
            events: [
              {
                type: "model_error",
                at: 1,
                agent: "lead",
                iteration: 1,
                kind: "provider",
                message: id,
              },
            ],
            ...(index > 0 ? { continueFrom: `exec_${index - 1}` } : {}),
          });
          if (index >= 7) firstBatch.set(index, new WeakRef(detail));
          return detail;
        } finally {
          inFlight -= 1;
        }
      },
      renderTurn: () => {},
    },
    { renderWindow: 1 },
  );

  await secondBatchStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  Bun.gc(true);
  expect([...firstBatch.values()].filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
  expect(maxInFlight).toBeLessThanOrEqual(6);

  releaseSecondBatch.resolve(undefined);
  const resumed = await pending;
  expect(resumed.messages.at(-1)?.content).toBe("a12");
});

test("resumeSession rejects an oversized continuation chain before fetching the next batch", async () => {
  const meta = manyTurns(30);
  const sharedPayload = "x".repeat(900_000);
  const fetched: string[] = [];
  let renders = 0;

  const resumed = resumeSession(meta, {
    getRun: async (id) => {
      fetched.push(id);
      const index = Number(id.slice("exec_".length));
      return stored(id, "completed", [1, 1, 0], {
        messages: [{ role: "user", content: sharedPayload }],
        ...(index > 0 ? { continueFrom: `exec_${String(index - 1)}` } : {}),
      });
    },
    renderTurn: () => {
      renders += 1;
    },
  });

  await expect(resumed).rejects.toMatchObject({
    code: "resource_exhausted",
    reason: "session_resume_history_limit",
    dimension: "payload_chars",
    limit: SESSION_RESUME_MAX_PAYLOAD_CHARS,
  });
  // Three six-run batches are enough to cross 16M. The remaining twelve
  // traces are never fetched, and rendering is atomic because projection did
  // not finish successfully.
  expect(fetched).toHaveLength(18);
  expect(renders).toBe(0);
});

test("resumeSession does not mutate a fetched run's own messages array", async () => {
  const meta = manyTurns(2);
  const runs = chainedRuns(2);
  const first = runs["exec_0"]!.messages;

  await resumeSession(
    meta,
    { getRun: async (id) => runs[id] ?? null, renderTurn: () => {} },
    { renderWindow: 100 },
  );

  expect(first).toEqual([{ role: "user", content: "q0" }]);
});

test("appendObservation buffers a framed digest into history without becoming the continuation base", () => {
  const store = fakeStore();
  const s = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    { profile: "coder" },
  );
  s.beginTurn("hi", "exec_1");
  s.endTurn(wire("exec_1", "completed", "a", usage(1, 1, 0)));

  s.appendObservation("[/commit → coder] committed abc123");
  expect(s.messages().at(-1)).toEqual({
    role: "assistant",
    content: "[/commit → coder] committed abc123",
  });

  expect(s.beginTurn("next", "exec_2")).toBe("exec_1");
  expect(s.takePending()).toEqual([
    { role: "assistant", content: "[/commit → coder] committed abc123" },
  ]);
  expect(s.takePending()).toEqual([]);
});

test("pending observations survive quit/resume via the persisted meta", () => {
  const store = fakeStore();
  const s = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    { profile: "coder" },
  );
  s.beginTurn("hi", "exec_1");
  s.endTurn(wire("exec_1", "completed", "a", usage(1, 1, 0)));
  s.appendObservation("<bash-input>ls</bash-input>", "user");

  const saved = store.get(s.meta()!.id)!;
  expect(saved.pending).toEqual([{ role: "user", content: "<bash-input>ls</bash-input>" }]);

  const resumed = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    {
      meta: saved,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "a" },
      ],
    },
  );
  expect(resumed.messages().at(-1)).toEqual({
    role: "user",
    content: "<bash-input>ls</bash-input>",
  });
  expect(resumed.takePending()).toEqual([{ role: "user", content: "<bash-input>ls</bash-input>" }]);
  expect(store.get(saved.id)!.pending).toBeUndefined();
});

test("appendObservation with a user role queues a user message for the next run", () => {
  const store = fakeStore();
  const s = createSession(
    { store, owner: "clarvis", project: "prj_test", workspace: "/ws" },
    { profile: "coder" },
  );
  s.beginTurn("hi", "exec_1");
  s.endTurn(wire("exec_1", "completed", "a", usage(1, 1, 0)));

  s.appendObservation("<bash-input>ls</bash-input>", "user");
  expect(s.messages().at(-1)).toEqual({ role: "user", content: "<bash-input>ls</bash-input>" });
  expect(s.takePending()).toEqual([{ role: "user", content: "<bash-input>ls</bash-input>" }]);
  expect(s.takePending()).toEqual([]);
});

test("buildSkillRunDigest tags the result with the skill, its agent and the execution id", () => {
  const digest = buildSkillRunDigest(
    "commit",
    "coder",
    wire("exec_w", "completed", "Committed abc123 'refactor auth'", usage(1, 1, 0)),
    null,
  );
  expect(digest).toContain("[/commit → coder, exec exec_w]");
  expect(digest).toContain("Committed abc123 'refactor auth'");
});

test("buildSkillRunDigest falls back to the recovered-context salvage when there is no result", () => {
  const st = stored("exec_w", "error", [1, 0, 0], {
    events: INTERRUPTED_EVENTS,
    planRef: INTERRUPTED_PLAN_REF,
  });
  const digest = buildSkillRunDigest(
    "commit",
    "coder",
    wire("exec_w", "error", "", usage(0, 0, 0)),
    st,
  );
  expect(digest).toContain("[/commit → coder, exec exec_w]");
  expect(digest).toContain(INTERRUPTED_PLAN_PATH);
});

test("buildRecoveredContext names provider, id and optional locator", () => {
  const digest = buildRecoveredContext(INTERRUPTED_EVENTS, INTERRUPTED_PLAN_REF)!;
  expect(digest).toContain("Recovered context");
  expect(digest).toContain("fedora.airplane-mooneye.ts.net");
  expect(digest).not.toContain("Qual banco?");
  expect(digest).toContain("Plan left active at revision 7");
  expect(digest).toContain("Provider: markdown");
  expect(digest).toContain(`ID: ${INTERRUPTED_PLAN_REF.id}`);
  expect(digest).toContain(`Locator: ${INTERRUPTED_PLAN_PATH}`);
  expect(digest).toContain(INTERRUPTED_PLAN_PATH);
  expect(digest).toContain("read_plan");
  expect(digest).toContain("do not");
});

test("pathless recovered context falls back to provider and id without rendering undefined", () => {
  const { path: _path, ...pathless } = INTERRUPTED_PLAN_REF;
  const digest = buildRecoveredContext([], { ...pathless, id: "remote-plan-42" })!;
  expect(digest).toContain("Provider: markdown");
  expect(digest).toContain("ID: remote-plan-42");
  expect(digest).not.toContain("Locator:");
  expect(digest).not.toContain("undefined");
});

test("recovered context explains how to restore a plan from a previously selected provider", () => {
  const digest = buildRecoveredContext(
    [],
    { ...INTERRUPTED_PLAN_REF, provider_key: "plugin:linear", id: "LIN-42" },
    "markdown",
  )!;
  expect(digest).toContain("currently selected provider is markdown");
  expect(digest).toContain("Select plugin:linear again");
  expect(digest).toContain("before read_plan can return this document");
  expect(digest).toContain("do not open another document as if it were the active plan");
});

test("buildRecoveredContext returns null when there is no plan ref and no decisions", () => {
  expect(buildRecoveredContext([{ type: "run_started", at: 1 }])).toBeNull();
  expect(
    buildRecoveredContext([{ type: "run_started", at: 1 }], {
      ...INTERRUPTED_PLAN_REF,
      status: "completed",
    }),
  ).toBeNull();
});

test("resumeSession injects recovered context for an interrupted turn with no result", async () => {
  const meta: SessionMeta = {
    id: "sid",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "plan the app", executionId: "exec_x", status: "error" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };

  const resumed = await resumeSession(meta, {
    getRun: async () =>
      stored("exec_x", "error", [5, 0, 0], {
        messages: [{ role: "user", content: "plan the app" }],
        events: INTERRUPTED_EVENTS,
        planRef: INTERRUPTED_PLAN_REF,
      }),
    renderTurn: () => {},
  });

  expect(resumed.messages).toHaveLength(2);
  expect(resumed.messages[0]).toEqual({ role: "user", content: "plan the app" });
  const recovered = resumed.messages[1]!;
  expect(recovered.role).toBe("assistant");
  expect(recovered.content).toContain("fedora.airplane-mooneye.ts.net");
  expect(recovered.content).toContain(INTERRUPTED_PLAN_PATH);
});

test("resumeSession threads the host's known current plan provider into recovery", async () => {
  const meta: SessionMeta = {
    id: "sid-provider",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        kind: "conversation",
        userPreview: "continue",
        executionId: "exec_provider",
        status: "error",
      },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  const resumed = await resumeSession(meta, {
    getRun: async () =>
      stored("exec_provider", "error", [1, 0, 0], {
        messages: [{ role: "user", content: "continue" }],
        planRef: { ...INTERRUPTED_PLAN_REF, provider_key: "plugin:linear", id: "LIN-42" },
      }),
    currentPlanProviderKey: () => "markdown",
    renderTurn: () => {},
  });
  expect(resumed.messages[1]?.content).toContain("Select plugin:linear again");
});

test("deleteSession removes the session file and cascades delete_run per turn", async () => {
  const store = fakeStore();
  const meta: SessionMeta = {
    id: "sid",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "q1", executionId: "exec_a", status: "done" },
      { kind: "conversation", userPreview: "q2", executionId: "exec_b", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  store.save(meta);

  const deleted: string[] = [];
  const res = await deleteSession(meta, store, async (id) => {
    deleted.push(id);
    return true;
  });
  expect(deleted).toEqual(["exec_a", "exec_b"]);
  expect(res.session).toBe(true);
  expect(res.traces).toEqual([
    { executionId: "exec_a", deleted: true },
    { executionId: "exec_b", deleted: true },
  ]);
  expect(store.list()).toEqual([]);
});

test("deleteSession records a missing trace and still removes the session", async () => {
  const store = fakeStore();
  const meta: SessionMeta = {
    id: "sid-missing-trace",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "q", executionId: "exec_missing", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  store.save(meta);

  const result = await deleteSession(meta, store, async () => false);

  expect(result).toEqual({
    session: true,
    traces: [{ executionId: "exec_missing", deleted: false }],
  });
  expect(store.list()).toEqual([]);
});

test("deleteSession preserves the session when a trace deletion rejects", async () => {
  const store = fakeStore();
  const meta: SessionMeta = {
    id: "sid-trace-error",
    title: "t",
    workspace: "/ws",
    owner: "clarvis",
    createdAt: 1,
    updatedAt: 1,
    turns: [{ kind: "conversation", userPreview: "q", executionId: "exec_error", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };
  store.save(meta);

  await expect(
    deleteSession(meta, store, async () => {
      throw new Error("trace store unavailable");
    }),
  ).rejects.toThrow("trace store unavailable");
  expect(store.get(meta.id)).toEqual(meta);
});
