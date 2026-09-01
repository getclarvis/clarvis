import { expect, test } from "bun:test";
import type { Session, SessionService } from "@clarvis/protocol";
import {
  addUsageToTotals,
  createSessionStore,
  listSessionsForWorkspace,
  loadSessions,
  MAX_RESIDENT_FULL_SESSIONS,
  metaToSession,
  redactPreview,
  redactTurnError,
  runStatusToNode,
  sessionToMeta,
  TURN_ERROR_MAX_CHARS,
  uncachedInput,
  uuidv7,
  type SessionMeta,
  type SessionTotals,
} from "../../src/adapters/session-store.ts";

function fakeSessions(seed: Session[] = []): SessionService & { store: Map<string, Session> } {
  const store = new Map<string, Session>(seed.map((s) => [s.id, s]));
  return {
    store,
    listPage: async (page = {}) => {
      const sorted = [...store.values()].sort((a, b) => b.updated_at - a.updated_at);
      const start = page.cursor === undefined ? 0 : Number(page.cursor);
      const limit = page.limit ?? 50;
      return {
        items: sorted.slice(start, start + limit).map((session) => ({
          id: session.id,
          title: session.title,
          project_id: session.project_id,
          workspace: session.workspace,
          created_at: session.created_at,
          updated_at: session.updated_at,
          ...(session.profile === undefined ? {} : { profile: session.profile }),
          turn_count: session.turns.length,
          ...(session.turns.at(-1)?.status === undefined
            ? {}
            : { last_status: session.turns.at(-1)!.status }),
          ...(session.turns.at(-1)?.environment === undefined
            ? {}
            : { last_environment: session.turns.at(-1)!.environment }),
          totals: session.totals,
        })),
        ...(start + limit < sorted.length ? { next_cursor: String(start + limit) } : {}),
      };
    },
    list: async () => [...store.values()].sort((a, b) => b.updated_at - a.updated_at),
    get: async (id) => store.get(id) ?? null,
    save: async (s) => {
      store.set(s.id, s);
    },
    delete: async (id) => store.delete(id),
  };
}

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: over.id ?? uuidv7(),
    title: over.title ?? "t",
    projectId: over.projectId ?? "prj_test",
    workspace: over.workspace ?? "/ws",
    owner: over.owner ?? "clarvis",
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    profile: over.profile,
    turns: over.turns ?? [],
    ...(over.lastEnvironment === undefined ? {} : { lastEnvironment: over.lastEnvironment }),
    totals: over.totals ?? { input: 0, output: 0, cached: 0 },
  };
}

test("uuidv7 has version 7 and variant bits", () => {
  const id = uuidv7();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("metaToSession <-> sessionToMeta round-trips (camelCase <-> snake_case)", () => {
  const m = meta({
    profile: "coder",
    turns: [
      {
        kind: "conversation",
        userPreview: "hi",
        executionId: "exec_1",
        status: "done",
        startedAt: 1,
        endedAt: 2,
      },
    ],
    totals: { input: 10, output: 5, cached: 2, costUsd: 0.01 },
    pending: [{ role: "user", content: "note" }],
  });
  const wire = metaToSession(m);
  expect(wire.turns[0] as Session["turns"][number] & { kind: string }).toEqual({
    kind: "conversation",
    user_preview: "hi",
    execution_id: "exec_1",
    status: "done",
    started_at: 1,
    ended_at: 2,
  });
  expect(wire.totals).toEqual({ input: 10, output: 5, cached: 2, cost_usd: 0.01 });
  expect(sessionToMeta(wire, "clarvis")).toEqual(m);
});

test("an unknown cache split stays absent across the persisted session boundary", () => {
  const m = meta({ totals: { input: 10, output: 5 } });
  const wire = metaToSession(m);
  expect(wire.totals).toEqual({ input: 10, output: 5 });
  expect(sessionToMeta(wire, "clarvis")).toEqual(m);
});

test("transcript-only turn identity is persisted and stale undiscriminated turns are rejected", () => {
  const m = meta({
    turns: [
      {
        kind: "transcript",
        userPreview: "/explorer inspect",
        executionId: "exec_skill",
        status: "done",
      },
    ],
  });
  const wire = metaToSession(m);
  expect(wire.turns[0]).toMatchObject({
    kind: "transcript",
    user_preview: "/explorer inspect",
    execution_id: "exec_skill",
  });
  expect(sessionToMeta(wire, "clarvis")).toEqual(m);

  delete (wire.turns[0] as unknown as { kind?: string }).kind;
  expect(() => sessionToMeta(wire, "clarvis")).toThrow("session turn kind is required");
});

test("Environment identity round-trips on turns and bounded summaries", async () => {
  const environment = {
    id: "workspace:research",
    fingerprint: `sha256:${"a".repeat(64)}`,
  };
  const m = meta({
    turns: [
      {
        kind: "conversation",
        userPreview: "hi",
        executionId: "exec_1",
        environment,
        status: "done",
      },
    ],
    lastEnvironment: environment,
  });
  const wire = metaToSession(m);
  expect(wire.turns[0]?.environment).toEqual(environment);
  expect(sessionToMeta(wire, "clarvis")).toEqual(m);

  const [summary] = await loadSessions(fakeSessions([wire]), "clarvis");
  expect(summary?.lastEnvironment).toEqual(environment);
});

test("malformed persisted Environment identity is ignored at both session boundaries", async () => {
  const wire = metaToSession(
    meta({
      turns: [{ kind: "conversation", userPreview: "hi", executionId: "exec_1", status: "done" }],
    }),
  );
  (wire.turns[0] as unknown as { environment: unknown }).environment = {
    id: "workspace:research",
    fingerprint: "not-a-digest",
  };

  expect(sessionToMeta(wire, "clarvis").turns[0]?.environment).toBeUndefined();
  const [summary] = await loadSessions(fakeSessions([wire]), "clarvis");
  expect(summary?.lastEnvironment).toBeUndefined();
});

test("facade: save/list/get/delete over the cache, persisting to the service", async () => {
  const svc = fakeSessions();
  const store = createSessionStore(svc, "clarvis");
  const older = meta({ updatedAt: 1000, title: "older" });
  const newer = meta({ updatedAt: 2000, title: "newer" });
  store.save(older);
  store.save(newer);
  await store.flushPending?.();

  expect(store.memory?.()).toEqual({
    cached_sessions: 2,
    full_sessions: 2,
    pending_session_write_lanes: 0,
    queued_session_writes: 0,
  });
  expect(store.list().map((m) => m.title)).toEqual(["newer", "older"]);
  expect(store.get(newer.id)?.title).toBe("newer");
  expect(svc.store.has(newer.id)).toBe(true);
  expect(await store.load(newer.id)).toBe(store.get(newer.id));

  expect(store.delete(older.id)).toBe(true);
  expect(store.delete(older.id)).toBe(false);
  await store.flushPending?.();
  expect(store.list().map((m) => m.title)).toEqual(["newer"]);
  expect(svc.store.has(older.id)).toBe(false);
});

test("facade serializes save then delete and reports persistence failures", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const svc = fakeSessions();
  svc.save = async () => {
    calls.push("save:start");
    await saveGate;
    calls.push("save:end");
  };
  svc.delete = async () => {
    calls.push("delete");
    throw new Error("disk unavailable");
  };
  const store = createSessionStore(svc, "clarvis", [], {
    onError: (message) => errors.push(message),
  });
  const item = meta({ id: "ordered" });

  store.save(item);
  store.delete(item.id);
  await Promise.resolve();
  expect(calls).toEqual(["save:start"]);
  releaseSave();
  await store.flushPending?.();

  expect(calls).toEqual(["save:start", "save:end", "delete"]);
  expect(errors).toEqual(["session delete failed: disk unavailable"]);
});

test("facade coalesces a blocked stream of saves to the latest snapshot", async () => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const svc = fakeSessions();
  let first = true;
  svc.save = async (session) => {
    calls.push(session.title);
    if (first) {
      first = false;
      await firstGate;
    }
    svc.store.set(session.id, session);
  };
  const store = createSessionStore(svc, "clarvis");

  for (let index = 0; index < 1_000; index += 1) {
    store.save(
      meta({
        id: "coalesced",
        title: String(index),
        turns: Array.from({ length: index + 1 }, () => ({
          kind: "conversation",
          userPreview: "x",
          status: "done",
        })),
      }),
    );
  }

  expect(calls).toEqual(["0"]);
  releaseFirst();
  await store.flushPending?.();
  expect(calls).toEqual(["0", "999"]);
  expect(svc.store.get("coalesced")?.turns).toHaveLength(1_000);
});

test("facade does not lose a save queued as the prior lane settles", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const persisted: string[] = [];
  const svc = fakeSessions();
  svc.save = async (session) => {
    persisted.push(session.title);
    if (session.title === "first") await firstGate;
    svc.store.set(session.id, session);
  };
  const store = createSessionStore(svc, "clarvis");

  store.save(meta({ id: "settling-lane", title: "first" }));
  // The await continuation that drains the lane is registered before this
  // callback. When the gate resolves, this save lands after that drain has
  // observed an empty queue but before a chained promise-finally could run.
  void firstGate.then(() => {
    store.save(meta({ id: "settling-lane", title: "last" }));
  });
  releaseFirst();
  await store.flushPending?.();

  expect(persisted).toEqual(["first", "last"]);
  expect(svc.store.get("settling-lane")?.title).toBe("last");
});

test("cache demotes older full session documents to bounded summaries", async () => {
  const count = MAX_RESIDENT_FULL_SESSIONS + 1;
  const svc = fakeSessions(
    Array.from({ length: count }, (_, index) =>
      metaToSession(
        meta({
          id: `loaded-${index}`,
          updatedAt: count - index,
          turns: [{ kind: "conversation", userPreview: `turn-${index}`, status: "done" }],
        }),
      ),
    ),
  );
  let gets = 0;
  const serviceGet = (id: string) => svc.store.get(id) ?? null;
  svc.get = async (id) => {
    gets += 1;
    return serviceGet(id);
  };
  const store = createSessionStore(svc, "clarvis", await loadSessions(svc, "clarvis"));

  for (let index = 0; index < count; index += 1) {
    expect((await store.load(`loaded-${index}`))?.turns).toHaveLength(1);
  }

  const demoted = store.get("loaded-0")!;
  expect(demoted.turns).toEqual([]);
  expect(demoted.turnCount).toBe(1);
  expect(store.get(`loaded-${count - 1}`)?.turns).toHaveLength(1);
  expect(gets).toBe(count);

  expect((await store.load("loaded-0"))?.turns).toHaveLength(1);
  expect(gets).toBe(count + 1);
});

test("cache skips sessions with active persistence lanes while choosing an LRU victim", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const svc = fakeSessions();
  svc.save = async (value) => {
    await gate;
    svc.store.set(value.id, value);
  };
  const store = createSessionStore(svc, "clarvis");

  for (let index = 0; index <= MAX_RESIDENT_FULL_SESSIONS; index += 1) {
    store.save(
      meta({
        id: `busy-${index}`,
        updatedAt: index,
        turns: [{ kind: "conversation", userPreview: `turn-${index}`, status: "done" }],
      }),
    );
  }

  // The first eight rows are protected by active lanes. The newest row is the
  // only safe candidate until persistence catches up.
  expect(store.get(`busy-${MAX_RESIDENT_FULL_SESSIONS}`)).toMatchObject({
    turns: [],
    turnCount: 1,
  });

  release();
  await store.flushPending?.();
});

test("loading a summary removes it when the backing session disappeared", async () => {
  const svc = fakeSessions();
  const summary = { ...meta({ id: "gone", turns: [] }), turnCount: 2 };
  const store = createSessionStore(svc, "clarvis", [summary]);

  expect(await store.load("gone")).toBeNull();
  expect(store.get("gone")).toBeNull();
});

test("loadSessions seeds bounded summaries and fetches a full document only on demand", async () => {
  const svc = fakeSessions([metaToSession(meta({ id: "s1", title: "seeded", updatedAt: 5 }))]);
  const store = createSessionStore(svc, "clarvis", await loadSessions(svc, "clarvis"));
  expect(store.get("s1")?.title).toBe("seeded");
  expect(store.get("s1")?.turnCount).toBe(0);
  expect(store.get("s1")?.turns).toEqual([]);
  expect((await store.load("s1"))?.turnCount).toBeUndefined();
});

test("loadSessions requests at most one 200-row catalog page", async () => {
  const svc = fakeSessions(
    Array.from({ length: 250 }, (_, index) =>
      metaToSession(meta({ id: `s-${index}`, updatedAt: index })),
    ),
  );
  svc.list = async () => {
    throw new Error("legacy full-document listing must not be used");
  };

  expect(await loadSessions(svc, "clarvis")).toHaveLength(200);
});

test("listSessionsForWorkspace filters by exact workspace", async () => {
  const store = createSessionStore(fakeSessions(), "shared");
  store.save(meta({ workspace: "/ws/a", title: "a1", updatedAt: 3000 }));
  store.save(meta({ workspace: "/ws/b", title: "b1", updatedAt: 2000 }));
  store.save(meta({ workspace: "/ws/a", title: "a2", updatedAt: 1000 }));

  expect(listSessionsForWorkspace(store, "/ws/a").map((m) => m.title)).toEqual(["a1", "a2"]);
  expect(listSessionsForWorkspace(store, "/ws/b").map((m) => m.title)).toEqual(["b1"]);
  expect(listSessionsForWorkspace(store, "/ws/none")).toEqual([]);
});

test("redactPreview masks secrets, keeps first line, truncates", () => {
  expect(redactPreview("hello sk-ABCDEF0123456789abcdef world")).toContain("[redacted]");
  expect(redactPreview("line one\nline two")).toBe("line one");
  expect(redactPreview("word ".repeat(100)).length).toBe(200);
  expect(redactPreview("sk-ABCDEF0123456789abcdef", { redact: false })).not.toContain("[redacted]");
});

// A preview is persisted to disk as a session title, so it must carry the
// canonical rule set rather than a local subset of it. Each secret below passed
// the five-pattern local list untouched.
test("redactPreview applies the canonical rules a local pattern list used to miss", () => {
  expect(redactPreview("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def please")).toBe(
    "auth [redacted-jwt] please",
  );
  expect(redactPreview("key AIzaSyD-1234567890abcdefghij here")).toBe(
    "key [redacted-google-key] here",
  );
  expect(redactPreview("pat github_pat_11ABCDE0000abcdefghij here")).toBe(
    "pat [redacted-github-token] here",
  );
  expect(redactPreview('set password: "hunter2" now')).toBe("set password: [redacted] now");
  expect(redactPreview("curl -H 'authorization: Bearer abc.def' x")).not.toContain("abc.def");
});

// The canonical rules name what they matched; the local list used one uniform
// placeholder. The named form is what a title now shows.
test("redactPreview names the vendor a masked token belongs to", () => {
  expect(redactPreview("hello sk-ABCDEF0123456789abcdef world")).toBe("hello sk-[redacted] world");
  expect(redactPreview("aws AKIAIOSFODNN7EXAMPLE")).toBe("aws [redacted-aws-key]");
  expect(redactPreview("slack xoxb-1234567890-abcdefghij")).toBe("slack [redacted-slack-token]");
});

// Redaction runs before truncation: were the order reversed, a preview cut at
// `max` would keep whatever prefix of the secret fitted.
test("redactPreview redacts before truncating", () => {
  const out = redactPreview("hi AIzaSyD-1234567890abcdefghij tail", { max: 12 });
  expect(out).not.toContain("AIzaSy");
  expect(out).toStartWith("hi [redac");
  expect(out.length).toBeLessThanOrEqual(12);
});

test("addUsageToTotals sums by_agent", () => {
  const totals = { input: 0, output: 0, cached: 0 };
  addUsageToTotals(totals, {
    iterations: 1,
    elapsed_ms: 5,
    by_agent: [
      {
        role: "lead",
        model: "m",
        input_tokens: 10,
        output_tokens: 4,
        cached_tokens: 2,
        cache_write_tokens: 0,
        iterations: 1,
      },
      {
        role: "subagent",
        model: "m",
        input_tokens: 3,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    ],
  });
  expect(totals).toEqual({ input: 13, output: 5, cached: 2 });
});

test("flat usage makes the cumulative cache split unknown instead of fabricating zero", () => {
  const totals: SessionTotals = { input: 10, output: 4, cached: 2 };
  addUsageToTotals(totals, {
    iterations: 1,
    elapsed_ms: 5,
    input_tokens: 3,
    output_tokens: 1,
  });
  expect(totals).toEqual({ input: 13, output: 5 });

  addUsageToTotals(totals, {
    iterations: 1,
    elapsed_ms: 5,
    input_tokens: 2,
    output_tokens: 1,
    cached_tokens: 0,
  });
  expect(totals).toEqual({ input: 15, output: 6 });
});

test("the input a session reports having read excludes what the cache served", () => {
  expect(uncachedInput({ input: 13, output: 5, cached: 2 })).toBe(11);
  expect(uncachedInput({ input: 0, output: 0, cached: 0 })).toBe(0);
  expect(uncachedInput({ input: 13, output: 5 })).toBe(13);
});

test("a cached count above the gross input floors at zero rather than going negative", () => {
  expect(uncachedInput({ input: 10, output: 5, cached: 40 })).toBe(0);
});

test("cost does not double-charge cached tokens (fresh input at input rate, cached only at cache_read)", () => {
  const totals = { input: 0, output: 0, cached: 0, costUsd: 0 };
  addUsageToTotals(
    totals,
    {
      iterations: 31,
      elapsed_ms: 5,
      by_agent: [
        {
          role: "lead",
          model: "openrouter/z-ai/glm-5.2",
          input_tokens: 643076,
          output_tokens: 14030,
          cached_tokens: 573696,
          cache_write_tokens: 0,
          iterations: 31,
        },
      ],
    },
    () => ({ input: 0.42, output: 1.32, cache_read: 0.078 }),
  );
  const freshInput = 643076 - 573696;
  const expected = (freshInput / 1e6) * 0.42 + (14030 / 1e6) * 1.32 + (573696 / 1e6) * 0.078;
  expect(totals.costUsd).toBeCloseTo(expected, 9);
  const doubleCharged = (643076 / 1e6) * 0.42 + (14030 / 1e6) * 1.32 + (573696 / 1e6) * 0.078;
  expect(totals.costUsd).toBeLessThan(doubleCharged);
});

test("status normalization tables", () => {
  expect(runStatusToNode("completed")).toBe("done");
  expect(runStatusToNode("cancelled")).toBe("cancelled");
  expect(runStatusToNode("running")).toBe("running");
  expect(runStatusToNode("failed")).toBe("error");
  expect(runStatusToNode("failed", "soft_limit_declined")).toBe("cancelled");
});

// `TurnRef.error` was written by endTurn and then dropped by metaToSession, so
// a run that failed came back after a reload saying only that it failed. The
// JSON hop is load-bearing: it is what makes this a disk round trip rather than
// an object copy, matching what the kernel's session service actually does.
test("a failed turn's reason survives metaToSession -> disk JSON -> sessionToMeta", () => {
  const m = meta({
    turns: [
      {
        kind: "conversation",
        userPreview: "hi",
        executionId: "exec_1",
        status: "error",
        startedAt: 1,
        endedAt: 2,
        error: { code: "provider_error", message: "no credit balance" },
      },
    ],
  });
  const onDisk = JSON.parse(JSON.stringify(metaToSession(m))) as Session;
  expect(onDisk.turns[0]).toEqual({
    kind: "conversation",
    user_preview: "hi",
    execution_id: "exec_1",
    status: "error",
    started_at: 1,
    ended_at: 2,
    error: { code: "provider_error", message: "no credit balance" },
  } as Session["turns"][number]);
  expect(sessionToMeta(onDisk, "clarvis")).toEqual(m);

  // A turn that did not fail still serializes byte-identically to before: the
  // conditional spread emits no key at all, not an `error: undefined` one that
  // `toEqual` would happily ignore.
  const ok = metaToSession(
    meta({ turns: [{ kind: "conversation", userPreview: "hi", status: "done" }] }),
  );
  expect(Object.keys(ok.turns[0]!)).toEqual(["kind", "user_preview", "status"]);
});

// The same property through the adapter a reload actually uses: save into the
// backing service, round-trip the stored document through JSON the way the file
// does, then load it into a store whose cache has never seen the session.
test("a reloaded session still carries why its turn failed", async () => {
  const svc = fakeSessions();
  const writer = createSessionStore(svc, "clarvis");
  const m = meta({
    turns: [
      {
        kind: "conversation",
        userPreview: "hi",
        executionId: "exec_1",
        status: "error",
        error: { code: "continuation_unavailable", message: "prefix cache gone" },
      },
    ],
  });
  writer.save(m);
  await writer.flushPending?.();
  svc.store.set(m.id, JSON.parse(JSON.stringify(svc.store.get(m.id))) as Session);

  const reader = createSessionStore(svc, "clarvis");
  const back = await reader.load(m.id);
  expect(back?.turns[0]?.error).toEqual({
    code: "continuation_unavailable",
    message: "prefix cache gone",
  });
});

// A session document is the one input here no type describes. Anything that is
// not the {code, message} pair the producer writes degrades to "no reason
// recorded" rather than to a TurnRef whose `error` is not an error.
test("a persisted turn error that is not a {code, message} pair reads back as absent", () => {
  const wire = metaToSession(
    meta({ turns: [{ kind: "conversation", userPreview: "hi", status: "error" }] }),
  );
  const withTurnError = (error: unknown): Session => {
    const copy = JSON.parse(JSON.stringify(wire)) as unknown as {
      turns: Record<string, unknown>[];
    };
    copy.turns[0]!.error = error;
    return copy as unknown as Session;
  };

  expect(sessionToMeta(withTurnError("boom"), "clarvis").turns[0]?.error).toBeUndefined();
  expect(sessionToMeta(withTurnError({ code: 7 }), "clarvis").turns[0]?.error).toBeUndefined();
  expect(sessionToMeta(withTurnError(null), "clarvis").turns[0]?.error).toBeUndefined();
});

// This is the first free text from a provider that Clarvis writes into a
// session document, so it goes through the repo's error-message rule set, and
// it is bounded so that turn count — never one message — is what could push the
// document past the kernel's serialization cap.
test("redactTurnError masks a secret, keeps newlines, and bounds the message", () => {
  const masked = redactTurnError({
    code: "provider_error",
    message: "auth failed for sk-ABCDEF0123456789abcdef\n  at provider.ts:12",
  });
  expect(masked.code).toBe("provider_error");
  expect(masked.message).not.toContain("sk-ABCDEF0123456789abcdef");
  expect(masked.message).toContain("sk-[redacted]");
  expect(masked.message).toContain("\n  at provider.ts:12");

  const long = redactTurnError({ code: "e", message: "stack frame ".repeat(400) });
  expect(long.message.length).toBeLessThanOrEqual(TURN_ERROR_MAX_CHARS);
  expect(long.message).toStartWith("stack frame ");
});

// The same opt-out `redactPreviews: false` gives a preview: a user who has
// turned masking off gets the provider's message verbatim.
test("redactTurnError honours the redact opt-out and a custom bound", () => {
  const raw = redactTurnError(
    { code: "e", message: "auth failed for sk-ABCDEF0123456789abcdef" },
    { redact: false },
  );
  expect(raw.message).toBe("auth failed for sk-ABCDEF0123456789abcdef");
  expect(redactTurnError({ code: "e", message: "abcdefghij" }, { max: 5 }).message.length).toBe(5);
});
