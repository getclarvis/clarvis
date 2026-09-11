import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths, ownerSegment } from "@clarvis/paths";
import { admitGoalRun, applyGoalControl, emptyGoalState, type GoalControl } from "@clarvis/goal";
import type { RunResult, Session } from "@clarvis/protocol";
import { createGoalRepository } from "../../src/goals/repository.ts";
import { settleGoalSession } from "../../src/goals/settlement.ts";
import { createSessionService, type HostSessionStore } from "../../src/sessions/session-service.ts";
import {
  createHostedSessionCoordinator,
  type HostedSessionOptions,
} from "../../src/hosting/sessions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const document = (id = "conversation"): Session => ({
  id,
  title: "Objective work",
  project_id: "project",
  workspace: "workspace",
  created_at: 1,
  updated_at: 1,
  turns: [],
  totals: { input: 0, output: 0, cached: 0 },
});
const create: GoalControl = {
  expected_revision: 0,
  operation_id: "create-op",
  action: {
    kind: "create",
    objective: "Produce and verify a scoped result",
    criteria: [],
    limits: { max_net_tokens: 10000, max_auto_continuations: 8, max_no_progress_checkpoints: 3 },
  },
};

async function fixture(
  prepareExecution?: HostedSessionOptions["prepareExecution"],
  settleSession?: HostedSessionOptions["settleSession"],
) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-goal-repository-"));
  roots.push(root);
  const options = { dir: root, owner: "owner", projectId: "project", workspaceId: "workspace" };
  const base = createSessionService(options);
  let failure: "before" | "after" | undefined;
  let writes = 0;
  const store: HostSessionStore = {
    ...base,
    async saveHost(value) {
      writes++;
      if (failure === "before") throw new Error("before canonical write");
      await base.saveHost(value);
      if (failure === "after") throw new Error("after canonical write");
    },
  };
  const coordinator = createHostedSessionCoordinator({
    sessions: store,
    projectId: "project",
    workspaceId: "workspace",
    occupied: () => false,
    redact: (value) => value,
    now: () => 20,
    settleSession,
    prepareExecution:
      prepareExecution ??
      (async () => {
        throw new Error("unexpected preparation");
      }),
  });
  await coordinator.sessions.save(document());
  const repository = createGoalRepository(coordinator.sessions, coordinator);
  const control = (input: GoalControl = create, sessionId = "conversation") =>
    repository.transact(sessionId, (state) => {
      const result = applyGoalControl(state, input, {
        session_id: sessionId,
        new_goal_id: "goal-1",
        now: 10,
        physically_busy: false,
      });
      return { state: result.state, result };
    });
  return {
    root,
    base,
    coordinator,
    repository,
    control,
    options,
    writes: () => writes,
    fail: (value?: "before" | "after") => {
      failure = value;
    },
    path: join(
      globalPaths(root).sessionsDir,
      ownerSegment("owner"),
      `${ownerSegment("conversation")}.json`,
    ),
  };
}

describe("host-owned goal session repository", () => {
  test.each(["before", "after"] as const)(
    "settles goal, turn and usage atomically across a failure %s publication",
    async (failure) => {
      const f = await fixture(
        async () => ({
          config: { agent: "solo" },
          detachable: true,
          async start() {
            throw new Error("fixture cancels before starting physical work");
          },
        }),
        (session, result) =>
          settleGoalSession(
            session,
            result,
            { disposition: "final", completion_validated: false },
            20,
          ),
      );
      await f.control();
      await f.repository.transact("conversation", (state) => ({
        state: admitGoalRun(state!, {
          goal_id: "goal-1",
          expected_revision: 1,
          control_revision: 1,
          execution_id: "run-1",
          admission_id: "admission-1",
          automatic: false,
          now: 10,
        }),
        result: null,
      }));
      const prepared = await f.coordinator.prepare(
        {
          session_id: "conversation",
          session_revision: 3,
          kind: "conversation",
          user_preview: "Continue",
          params: { execution_id: "run-1", messages: [{ role: "user", content: "Continue" }] },
        },
        { scope: "scope", signal: new AbortController().signal },
      );
      await prepared.commitIntent();
      await f.control({ expected_revision: 2, operation_id: "cancel", action: { kind: "cancel" } });
      const before = (await f.base.get("conversation"))!;
      const result: RunResult = {
        execution_id: "run-1",
        status: "cancelled",
        usage: {
          iterations: 1,
          elapsed_ms: 1,
          input_tokens: 100,
          output_tokens: 20,
          cached_tokens: 80,
        },
      };
      f.fail(failure);
      await expect(prepared.reconcile(result)).rejects.toThrow(`${failure} canonical write`);
      const failed = (await f.base.get("conversation"))!;
      if (failure === "before") expect(failed).toEqual(before);
      else {
        expect(failed.turns[0]!.status).toBe("cancelled");
        expect(failed.goal_state!.current!.consumption.net_tokens).toBe(40);
      }
      f.fail();
      await prepared.reconcile(result);
      const committed = (await f.base.get("conversation"))!;
      expect(committed.goal_state!.current).toMatchObject({
        status: "cancelled",
        consumption: { net_tokens: 40 },
      });
      expect(committed.turns[0]!.status).toBe("cancelled");
      expect(committed.totals).toEqual({ input: 100, output: 20, cached: 80 });
      await prepared.reconcile(result);
      expect(await f.base.get("conversation")).toEqual(committed);
    },
  );

  test("reconciles unknown late usage into the archived goal and session once", async () => {
    const f = await fixture(
      async () => ({
        config: { agent: "solo" },
        detachable: true,
        async start() {
          throw new Error("fixture cancels before starting physical work");
        },
      }),
      (session, result) =>
        settleGoalSession(
          session,
          result,
          { disposition: "final", completion_validated: false },
          20,
        ),
    );
    await f.control();
    await f.repository.transact("conversation", (state) => ({
      state: admitGoalRun(state!, {
        goal_id: "goal-1",
        expected_revision: 1,
        control_revision: 1,
        execution_id: "run-1",
        admission_id: "admission-1",
        automatic: false,
        now: 10,
      }),
      result: null,
    }));
    const prepared = await f.coordinator.prepare(
      {
        session_id: "conversation",
        session_revision: 3,
        kind: "conversation",
        user_preview: "Continue",
        params: { execution_id: "run-1", messages: [{ role: "user", content: "Continue" }] },
      },
      { scope: "scope", signal: new AbortController().signal },
    );
    await prepared.commitIntent();
    const result: RunResult = { execution_id: "run-1", status: "cancelled" };
    await prepared.reconcile(result);
    const unknown = (await f.repository.read("conversation"))!;
    expect(unknown.current!.consumption.usage_unknown).toBe(true);
    await f.control({
      expected_revision: unknown.revision,
      operation_id: "clear",
      action: { kind: "clear" },
    });
    const late: RunResult = {
      ...result,
      usage: { iterations: 1, elapsed_ms: 1, input_tokens: 100, output_tokens: 20 },
    };
    await prepared.reconcile(late);
    const committed = (await f.base.get("conversation"))!;
    expect(committed.goal_state!.current).toBeUndefined();
    expect(committed.goal_state!.archive[0]!.consumption).toMatchObject({
      net_tokens: 120,
      usage_unknown: false,
      cache_estimated: true,
    });
    expect(committed.totals).toEqual({ input: 100, output: 20 });
    await prepared.reconcile(late);
    expect(await f.base.get("conversation")).toEqual(committed);
  });

  test("persists within the canonical session and restores the same identity and receipt", async () => {
    const f = await fixture();
    expect(await f.repository.read("conversation")).toBeUndefined();
    const first = await f.control();
    const stored = (await f.base.get("conversation"))!;
    expect(stored.revision).toBe(2);
    expect(stored.goal_state).toEqual(first.state);
    const restarted = createSessionService(f.options);
    expect((await restarted.get("conversation"))!.goal_state).toEqual(first.state);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(stored);
    const replay = await f.control();
    expect(replay).toMatchObject({ receipt: first.receipt, replayed: true, start: false });
    expect(f.writes()).toBe(1);
    expect(await f.base.get("conversation")).toEqual(stored);
    const altered = await f.repository.read("conversation");
    altered!.current!.objective = "local mutation";
    expect((await f.repository.read("conversation"))!.current!.objective).toBe(
      create.action.kind === "create" ? create.action.objective : "",
    );
  });

  test("refuses public insertion, rollback, deletion and forgery of current or archived state", async () => {
    const f = await fixture();
    await expect(
      f.base.save({ ...document(), goal_state: emptyGoalState() }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.coordinator.sessions.save({ ...document("forged"), goal_state: emptyGoalState() }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const original = await f.control();
    await f.control({
      expected_revision: 1,
      operation_id: "pause",
      action: { kind: "pause", running: false },
    });
    await f.control({ expected_revision: 2, operation_id: "clear", action: { kind: "clear" } });
    const stored = (await f.base.get("conversation"))!;
    const forged = structuredClone(stored);
    forged.goal_state!.archive[0]!.objective = "forge audit";
    for (const value of [
      { ...stored, goal_state: undefined },
      { ...stored, goal_state: original.state },
      forged,
    ]) {
      await expect(f.base.save(value)).rejects.toMatchObject({ code: "conflict" });
      await expect(f.coordinator.sessions.save(value)).rejects.toMatchObject({ code: "conflict" });
    }
    await f.coordinator.sessions.save({ ...stored, title: "Updated title" });
    expect((await f.base.get("conversation"))!.goal_state).toEqual(stored.goal_state);
  });

  test("isolates owners, workspaces and current or archived conversation bindings", async () => {
    const f = await fixture();
    await f.control();
    expect(
      await createSessionService({ ...f.options, owner: "another" }).get("conversation"),
    ).toBeNull();
    expect(
      await createSessionService({ ...f.options, workspaceId: "another" }).get("conversation"),
    ).toBeNull();
    await expect(f.repository.read("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(f.control(create, "missing")).rejects.toMatchObject({ code: "not_found" });
    const state = (await f.repository.read("conversation"))!;
    for (const archived of [false, true]) {
      const foreign = structuredClone(state);
      foreign.current!.session_id = "foreign";
      if (archived) {
        foreign.archive.push(foreign.current!);
        delete foreign.current;
      }
      await expect(
        f.repository.transact("conversation", () => ({ state: foreign, result: null })),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(await f.repository.read("conversation")).toEqual(state);
  });

  test("concurrent controls cannot overwrite the same revision", async () => {
    const f = await fixture();
    await f.control();
    const outcomes = await Promise.allSettled([
      f.control({
        expected_revision: 1,
        operation_id: "pause",
        action: { kind: "pause", running: false },
      }),
      f.control({ expected_revision: 1, operation_id: "cancel", action: { kind: "cancel" } }),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((value) => value.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    expect((await f.repository.read("conversation"))!.revision).toBe(2);
    await expect(
      f.control({ expected_revision: 1, operation_id: "later", action: { kind: "cancel" } }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test.each(["before", "after"] as const)(
    "recovers operation identity from a failure %s canonical publication",
    async (failure) => {
      const f = await fixture();
      f.fail(failure);
      await expect(f.control()).rejects.toThrow(`${failure} canonical write`);
      const state = await f.repository.read("conversation");
      expect(state?.receipts.length ?? 0).toBe(failure === "after" ? 1 : 0);
      f.fail();
      const retried = await f.control();
      expect(retried.replayed).toBe(failure === "after");
      expect(retried.start).toBe(failure === "before");
      expect(f.writes()).toBe(failure === "after" ? 1 : 2);
      expect((await f.base.get("conversation"))!.revision).toBe(2);
    },
  );

  test("mutation exceptions and exhausted bounds preserve the authoritative document", async () => {
    const f = await fixture();
    await f.control();
    const before = await readFile(f.path, "utf8");
    await expect(
      f.repository.transact("conversation", (state) => {
        state!.current!.objective = "not committed";
        throw new Error("invalid transition");
      }),
    ).rejects.toThrow("invalid transition");
    await expect(
      f.coordinator.transact("conversation", (session) => {
        session.pending = [{ role: "user", content: "x".repeat(8 * 1024 * 1024) }];
        return { session, result: null };
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect((await f.coordinator.sessions.listPage()).items).toHaveLength(1);
    await expect(
      f.coordinator.transact("conversation", (session) => ({
        session: { ...session, id: "other" },
        result: null,
      })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("refuses malformed persisted goal state instead of restoring a usable conversation", async () => {
    const f = await fixture();
    await f.control();
    const stored = (await f.base.get("conversation"))!;
    await expect(
      f.base.saveHost({
        ...stored,
        goal_state: { ...stored.goal_state!, version: 2 },
      } as unknown as Session),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await writeFile(
      f.path,
      JSON.stringify({ ...stored, goal_state: { ...stored.goal_state, version: 2 } }),
    );
    expect(await f.base.get("conversation")).toBeNull();
    await expect(f.repository.read("conversation")).rejects.toMatchObject({ code: "not_found" });
  });

  test("commits pause during delayed preparation and refuses the stale prepared run", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let starts = 0;
    const f = await fixture(async () => {
      entered.resolve();
      await release.promise;
      return {
        config: { agent: "solo" },
        detachable: true,
        async start() {
          starts++;
          throw new Error("stale start");
        },
      };
    });
    await f.control();
    const pending = f.coordinator.prepare(
      {
        session_id: "conversation",
        session_revision: 2,
        kind: "conversation",
        user_preview: "Continue",
        params: { execution_id: "run-1", messages: [{ role: "user", content: "Continue" }] },
      },
      { scope: "scope", signal: new AbortController().signal },
    );
    const outcome = pending.then(
      () => "unexpected preparation",
      (error: unknown) => error,
    );
    await entered.promise;
    try {
      await f.control({
        expected_revision: 1,
        operation_id: "pause",
        action: { kind: "pause", running: false },
      });
      expect((await f.repository.read("conversation"))!.current!.status).toBe("paused");
    } finally {
      release.resolve();
    }
    expect(await outcome).toMatchObject({ code: "conflict" });
    expect(starts).toBe(0);
    expect((await f.base.get("conversation"))!.turns).toEqual([]);
  });
});
