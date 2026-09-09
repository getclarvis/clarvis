import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult, Session, StartHostedTurnParams, StartRunParams } from "@clarvis/protocol";
import {
  createSessionService,
  type FileSessionService,
} from "../../src/sessions/session-service.ts";
import {
  createHostedSessionCoordinator,
  type HostedSessionOptions,
} from "../../src/hosting/sessions.ts";
import { createManagedRun } from "../../src/runs/managed-run.ts";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const document = (): Session => ({
  id: "conversation",
  title: "Discussion with SECRET",
  project_id: "project",
  workspace: "workspace",
  created_at: 1,
  updated_at: 1,
  turns: [],
  totals: { input: 0, output: 0, cached: 0 },
  pending: [{ role: "user", content: "Earlier shell observation" }],
});
const input = (revision = 1, executionId = "run-1"): StartHostedTurnParams => ({
  session_id: "conversation",
  session_revision: revision,
  kind: "conversation",
  user_preview: "Inspect SECRET",
  params: {
    execution_id: executionId,
    configuration_session_id: "forged-consent",
    messages: [{ role: "user", content: "Inspect it" }],
  },
});
const completed: RunResult = { execution_id: "run-1", status: "completed" };

async function fixture(overrides: Partial<HostedSessionOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-hosted-sessions-"));
  cleanup.push(root);
  const base = createSessionService({
    dir: root,
    owner: "owner",
    projectId: "project",
    workspaceId: "workspace",
  });
  let occupied = false;
  let starts = 0;
  let bound: StartRunParams | undefined;
  const coordinator = createHostedSessionCoordinator({
    sessions: base,
    projectId: "project",
    workspaceId: "workspace",
    now: () => 10,
    occupied: () => occupied,
    redact: (text) => text.replaceAll("SECRET", "[REDACTED]"),
    async prepareExecution(params) {
      bound = params;
      return {
        config: { agent: "solo", model: "test/model" },
        detachable: true,
        async start() {
          const stored = (await base.get("conversation"))!;
          expect(stored.turns.at(-1)!.execution_id).toBe(params.execution_id);
          expect(stored.turns.at(-1)!.status).toBe("running");
          starts++;
          return createManagedRun({
            executionId: params.execution_id!,
            async execute() {
              return { ...completed, execution_id: params.execution_id! };
            },
          });
        },
      };
    },
    ...overrides,
  });
  await coordinator.sessions.save(document());
  return {
    base,
    ...coordinator,
    starts: () => starts,
    params: () => bound,
    setOccupied(value: boolean) {
      occupied = value;
    },
    prepareTurn: (value = input(), signal = new AbortController().signal) =>
      coordinator.prepare(value, { scope: "host-consent", signal }),
  };
}

describe("host-owned conversation transactions", () => {
  test("inserts pending observations after historical context and before the fresh prompt", async () => {
    const f = await fixture();
    const request = input();
    request.params.messages = [
      { role: "user", content: "An earlier prompt" },
      { role: "assistant", content: "An earlier answer" },
      { role: "user", content: "The new prompt" },
    ];
    await f.prepareTurn(request);
    expect(f.params()!.messages.map((message) => message.content)).toEqual([
      "An earlier prompt",
      "An earlier answer",
      "Earlier shell observation",
      "The new prompt",
    ]);
    expect((await f.base.get("conversation"))!.pending).toHaveLength(1);
    expect(f.starts()).toBe(0);
  });

  test("keeps historical context ahead of pending observations when a skill renders the new seed", async () => {
    const f = await fixture();
    const request = input();
    request.params.messages = [{ role: "user", content: "Historical prompt" }];
    request.params.skill = { name: "review", task: "Inspect changes" };
    await f.prepareTurn(request);
    expect(f.params()!.messages.map((message) => message.content)).toEqual([
      "Historical prompt",
      "Earlier shell observation",
    ]);
  });

  test("persists a standalone skill digest once without changing the conversation agent", async () => {
    const f = await fixture();
    const current = (await f.sessions.get("conversation"))!;
    await f.sessions.save({ ...current, agent_profile: "conversation-agent" });
    const request = input(2);
    request.kind = "transcript";
    request.params.skill = { name: "review", task: "Inspect changes" };
    const prepared = await f.prepareTurn(request);
    await prepared.commitIntent();
    const handle = await prepared.start();
    await handle.closed;
    const result = { ...completed, result: "Checked the implementation." };
    await prepared.reconcile(result);
    const stored = (await f.base.get("conversation"))!;
    expect(stored.agent_profile).toBe("conversation-agent");
    expect(stored.turns).toMatchObject([{ kind: "transcript", status: "done" }]);
    expect(stored.pending).toEqual([
      ...document().pending!,
      { role: "assistant", content: "[/review → solo, exec run-1]\nChecked the implementation." },
    ]);
    await prepared.reconcile(result);
    expect(await f.base.get("conversation")).toEqual(stored);
  });

  test("commits intent before model work and reconciles token/cost totals once", async () => {
    const f = await fixture({
      priceFor: (model) =>
        model === "priced" ? { input: 2, output: 4, cache_read: 1, cache_write: 3 } : undefined,
    });
    const before = (await f.sessions.get("conversation"))!;
    expect(before.revision).toBe(1);
    const prepared = await f.prepareTurn();
    expect(f.starts()).toBe(0);
    expect(prepared.title).toBe("Discussion with [REDACTED]");
    expect(f.params()!.configuration_session_id).toBe("host-consent");
    expect(f.params()!.messages.map((message) => message.content)).toEqual([
      "Earlier shell observation",
      "Inspect it",
    ]);
    expect(() => prepared.start()).toThrow("not committed");
    await prepared.commitIntent();
    const intent = (await f.base.get("conversation"))!;
    expect(intent.agent_profile).toBe("solo");
    expect(intent.pending).toBeUndefined();
    expect(intent.turns.at(-1)!.user_preview).toBe("Inspect [REDACTED]");
    expect(JSON.stringify(intent)).not.toContain("host-consent");
    const handle = await prepared.start();
    await handle.closed;
    expect(() => prepared.start()).toThrow("cannot start twice");
    const result: RunResult = {
      ...completed,
      usage: {
        iterations: 1,
        elapsed_ms: 10,
        by_agent: [
          {
            role: "lead",
            model: "priced",
            input_tokens: 1000,
            output_tokens: 200,
            cached_tokens: 400,
            cache_write_tokens: 100,
          },
          {
            role: "subagent",
            model: "unpriced",
            input_tokens: 300,
            output_tokens: 50,
            cached_tokens: 0,
            cache_write_tokens: 0,
          },
        ],
      },
    };
    await prepared.reconcile(result);
    const after = (await f.sessions.get("conversation"))!;
    expect(after.revision).toBe(3);
    expect(after.turns.at(-1)).toMatchObject({ status: "done", ended_at: 10 });
    expect(after.totals).toMatchObject({ input: 1300, output: 250, cached: 400 });
    expect(after.totals.cost_usd).toBeCloseTo(0.0027);
    await prepared.reconcile(result);
    expect(await f.sessions.get("conversation")).toEqual(after);
    await expect(f.sessions.save({ ...before, title: "Stale title" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.sessions.save({ ...after, turns: [] })).rejects.toMatchObject({
      code: "conflict",
    });
    await f.sessions.save({ ...after, title: "New title" });
    expect((await f.sessions.get("conversation"))!.revision).toBe(4);
  });

  test("active work prevents interactive saves/deletes and stale/foreign continuation admission", async () => {
    const f = await fixture();
    f.setOccupied(true);
    await expect(f.sessions.save((await f.sessions.get("conversation"))!)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.sessions.delete("conversation")).rejects.toMatchObject({ code: "conflict" });
    await expect(f.prepareTurn(input(0))).rejects.toMatchObject({ code: "conflict" });
    const foreign = input();
    foreign.params.continue_from = "another-conversation-run";
    await expect(f.prepareTurn(foreign)).rejects.toMatchObject({ code: "conflict" });
    expect(f.starts()).toBe(0);
    f.setOccupied(false);
    await expect(
      f.sessions.save({ ...document(), id: "foreign", workspace: "foreign" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await f.sessions.delete("conversation")).toBe(true);
  });

  test("transcript turns preserve pending context and flat usage never invents a cache split or price", async () => {
    const f = await fixture();
    const value = { ...input(), kind: "transcript" as const };
    const prepared = await f.prepareTurn(value);
    expect(f.params()!.messages).toEqual(value.params.messages);
    await prepared.commitIntent();
    await prepared.reconcile({
      ...completed,
      usage: { iterations: 1, elapsed_ms: 1, input_tokens: 4, output_tokens: 2 },
    });
    const stored = (await f.sessions.get("conversation"))!;
    expect(stored.pending).toEqual(document().pending);
    expect(stored.turns.at(-1)!.kind).toBe("transcript");
    expect(stored.totals).toEqual({ input: 4, output: 2 });
  });

  test("revoked preparation and concurrent session changes cannot commit an intent", async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({
      async prepareExecution() {
        waiting.resolve();
        await release.promise;
        return {
          config: { agent: "solo" },
          detachable: true,
          async start() {
            throw new Error("must not start");
          },
        };
      },
    });
    const controller = new AbortController();
    const pending = f.prepareTurn(input(), controller.signal);
    const outcome = pending.then(
      () => "prepared",
      () => "revoked",
    );
    await waiting.promise;
    await expect(f.prepareTurn()).rejects.toMatchObject({ code: "conflict" });
    controller.abort();
    release.resolve();
    expect(await outcome).toBe("revoked");
    expect((await f.sessions.get("conversation"))!.turns).toEqual([]);
    const prepared = await f.prepareTurn();
    const before = (await f.base.get("conversation"))!;
    await f.base.save({ ...before, title: "Changed externally" });
    await expect(prepared.commitIntent()).rejects.toMatchObject({ code: "conflict" });
    expect((await f.sessions.get("conversation"))!.turns).toEqual([]);
  });

  for (const afterCommit of [false, true])
    test(`reconciles an intent write failure ${afterCommit ? "after" : "before"} canonical publication`, async () => {
      const f = await fixture();
      let fail = true;
      const service: FileSessionService = {
        ...f.base,
        async save(value) {
          if (fail && value.turns.length > 0) {
            fail = false;
            if (afterCommit) await f.base.save(value);
            throw new Error("injected disk failure");
          }
          await f.base.save(value);
        },
      };
      const coordinator = createHostedSessionCoordinator({
        sessions: service,
        projectId: "project",
        workspaceId: "workspace",
        occupied: () => true,
        redact: (text) => text,
        async prepareExecution() {
          return {
            config: { agent: "solo" },
            detachable: true,
            async start() {
              throw new Error("must not start");
            },
          };
        },
      });
      const prepared = await coordinator.prepare(input(), {
        scope: "scope",
        signal: new AbortController().signal,
      });
      await expect(prepared.commitIntent()).rejects.toThrow("injected disk failure");
      await prepared.reconcile({ ...completed, status: "failed" });
      const stored = (await f.sessions.get("conversation"))!;
      if (afterCommit) expect(stored.turns[0]!.status).toBe("error");
      else expect(stored.turns).toEqual([]);
    });

  test("keeps transport cancellation on hosted session catalog reads and rejects invalid persisted revisions", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.sessions.listPage({}, { signal: controller.signal })).rejects.toBeDefined();
    await expect(f.base.save({ ...document(), revision: 0.5 })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
