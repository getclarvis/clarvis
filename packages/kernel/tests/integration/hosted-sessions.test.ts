import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunDetail,
  RunResult,
  Session,
  StartHostedTurnParams,
  StartRunParams,
  HostedRunRef,
  HostedRecoveryResolution,
} from "@clarvis/protocol";
import { createSessionService, type HostSessionStore } from "../../src/sessions/session-service.ts";
import {
  createHostedSessionCoordinator,
  type HostedSessionOptions,
} from "../../src/hosting/sessions.ts";
import { applyGoalControl, admitGoalRun, prepareGoalSettlement } from "@clarvis/goal";
import { goalStateToDto } from "../../src/goals/session-state.ts";
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
    root,
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

const recoveryRow = (): HostedRunRef => ({
  execution_id: "run-1",
  session_id: "conversation",
  workspace_id: "workspace",
  host_generation: "previous",
  title: "Recovered turn",
  config: { agent: "solo" },
  created_at: 1,
  updated_at: 2,
  revision: 2,
  control_epoch: 1,
  control: "available",
  disconnect_policy: "continue",
  execution_state: "unknown",
  attention: "none",
  outcome: {
    status: "completed",
    usage: { iterations: 1, elapsed_ms: 10, input_tokens: 17, output_tokens: 3, cached_tokens: 2 },
  },
});
const recoveryCheckpoint = {
  operation: "reconcile" as const,
  state: "ready" as const,
  attempt: 1,
  physical_closed: true as const,
  controller_epoch: 1,
};

describe("host-owned conversation transactions", () => {
  test("repairs a physically closed ordinary turn after restart without another execution or charge", async () => {
    const f = await fixture();
    await (await f.prepareTurn()).commitIntent();
    const restarted = createHostedSessionCoordinator({
      sessions: f.base,
      projectId: "project",
      workspaceId: "workspace",
      occupied: () => false,
      redact: (text) => text,
      now: () => 30,
      priceFor: () => ({ input: 2, output: 4, cache_read: 1 }),
      guardUsageFor: () => ({
        cacheUnknown: false,
        usage: {
          iterations: 0,
          elapsed_ms: 0,
          by_agent: [
            {
              role: "subagent",
              model: "priced",
              input_tokens: 10,
              output_tokens: 2,
              cached_tokens: 5,
              cache_write_tokens: 0,
            },
          ],
        },
      }),
      async prepareExecution() {
        throw new Error("recovery must not execute");
      },
    });
    const save = f.base.saveHost.bind(f.base);
    let lost = false;
    const write = spyOn(f.base, "saveHost").mockImplementation(async (value) => {
      await save(value);
      if (!lost) {
        lost = true;
        throw new Error("acknowledgement lost after session commit");
      }
    });
    try {
      await expect(restarted.recoverSettlement(recoveryRow(), recoveryCheckpoint)).rejects.toThrow(
        "acknowledgement lost",
      );
      expect(await restarted.recoverSettlement(recoveryRow(), recoveryCheckpoint)).toBe(true);
      const stored = (await f.base.get("conversation"))!;
      expect(stored.turns[0]).toMatchObject({ status: "done", ended_at: 30 });
      expect(stored.totals).toMatchObject({ input: 27, output: 5, cached: 7 });
      expect(stored.totals.cost_usd).toBeCloseTo(0.000023);
      expect(write).toHaveBeenCalledTimes(1);
      expect(f.starts()).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  test("recovers prepared Goal settlement after a lost write acknowledgement without losing usage gaps", async () => {
    const f = await fixture();
    await (await f.prepareTurn()).commitIntent();
    const session = (await f.base.get("conversation"))!;
    const created = applyGoalControl(
      undefined,
      {
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Preserve work",
          criteria: [],
          limits: { max_net_tokens: 10000 },
        },
      },
      { session_id: session.id, new_goal_id: "goal", now: 1, physically_busy: false },
    ).state;
    const admitted = admitGoalRun(created, {
      goal_id: "goal",
      execution_id: "run-1",
      admission_id: "run-1",
      automatic: false,
      expected_revision: created.revision,
      control_revision: created.current!.control_revision,
      now: 2,
    });
    const preparation = {
      outcome: "failed" as const,
      disposition: "final" as const,
      usage: {
        kind: "partial" as const,
        input: 23,
        output: 5,
        gaps: [{ cause: "no_usage" as const, calls: 1, call_ids: ["missing-call"] }],
      },
      activity_unavailable: true,
    };
    session.goal_state = goalStateToDto(
      prepareGoalSettlement(admitted, {
        goal_id: "goal",
        execution_id: "run-1",
        preparation,
        now: 3,
      }),
    );
    await f.base.saveHost(session);
    const restarted = createHostedSessionCoordinator({
      sessions: f.base,
      projectId: "project",
      workspaceId: "workspace",
      occupied: () => false,
      redact: (text) => text,
      now: () => 30,
      async prepareExecution() {
        throw new Error("recovery must not execute");
      },
    });
    const row = recoveryRow();
    row.outcome = {
      ...row.outcome!,
      status: "failed",
      error: { code: "provider_error", message: "temporary", kind: "transient" },
    };
    const save = f.base.saveHost.bind(f.base);
    const write = spyOn(f.base, "saveHost").mockImplementation(async (value) => {
      await save(value);
      throw new Error("acknowledgement lost");
    });
    try {
      await expect(restarted.recoverSettlement(row, recoveryCheckpoint)).rejects.toThrow(
        "acknowledgement lost",
      );
      expect(await restarted.recoverSettlement(row, recoveryCheckpoint)).toBe(true);
      const stored = (await f.base.get(session.id))!;
      expect(stored.turns[0]).toMatchObject({ status: "error", ended_at: 30 });
      expect(stored.totals).toMatchObject({ input: 23, output: 5 });
      expect(stored.goal_state!.current!.runs[0]).toMatchObject({
        phase: "closed",
        usage: preparation.usage,
        activity_unavailable: true,
      });
      expect(stored.goal_state!.current!.runs[0]!.settlement_preparation).toBeUndefined();
      expect(stored.goal_state!.current!.status).not.toBe("complete");
      expect(write).toHaveBeenCalledTimes(1);
      expect(f.starts()).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  test("recovery refuses a missing physical result and leaves guided creation or transcript semantics pending", async () => {
    for (const kind of ["conversation", "transcript"] as const) {
      const f = await fixture();
      await (await f.prepareTurn({ ...input(), kind })).commitIntent();
      if (kind === "conversation") {
        const session = (await f.base.get("conversation"))!;
        session.goal_state = {
          version: 1,
          revision: 1,
          archive: [],
          receipts: [],
          creation_intent: {
            seed: "A goal",
            execution_id: "run-1",
            operation_id: "create",
            phase: "formulating",
            admitted_at: 1,
          },
        };
        await f.base.saveHost(session);
      }
      const before = await f.base.get("conversation");
      expect(await f.recoverSettlement(recoveryRow(), recoveryCheckpoint)).toBe(false);
      const missing = recoveryRow();
      delete missing.outcome;
      await expect(f.recoverSettlement(missing, recoveryCheckpoint)).rejects.toThrow(
        "physical checkpoint",
      );
      expect(await f.base.get("conversation")).toEqual(before);
      expect(f.starts()).toBe(0);
    }
  });

  test.each(["persisted", "missing"])(
    "durably archives unknown turns with %s intent without inventing outcomes or replay",
    async (intent) => {
      const f = await fixture();
      if (intent === "persisted") {
        const prepared = await f.prepareTurn();
        await prepared.commitIntent();
      }
      const row: HostedRunRef = {
        execution_id: "run-1",
        session_id: "conversation",
        workspace_id: "workspace",
        host_generation: "old",
        title: "Unknown turn",
        config: { agent: "solo" },
        created_at: 1,
        updated_at: 10,
        revision: 1,
        control_epoch: 0,
        control: "available",
        execution_state: "unknown",
        attention: "none",
        disconnect_policy: "continue",
      };
      const resolution: HostedRecoveryResolution = {
        kind: "operator_verified_physical_closure",
        disposition: "archive",
        previous_host_generation: "old",
        resolving_host_generation: "new",
        operator_connection_id: "operator",
        resolved_at: 20,
      };
      expect(await f.archiveRecovery(row, resolution)).toEqual(resolution);
      const stored = (await f.base.get("conversation"))!;
      expect(stored.turns[0]).toMatchObject({
        status: "interrupted",
        recovery_resolution: resolution,
      });
      expect(stored.turns[0]!.ended_at).toBeUndefined();
      if (intent === "missing") {
        expect(stored.turns[0]).toEqual({
          kind: "transcript",
          execution_id: row.execution_id,
          user_preview: row.title,
          status: "interrupted",
          recovery_resolution: resolution,
        });
      }
      expect(stored.totals).toEqual({ input: 0, output: 0, cached: 0 });
      expect(await f.sessions.list()).toMatchObject([
        { id: "conversation", revision: stored.revision },
      ]);
      expect(await f.archiveRecovery(row, { ...resolution, resolved_at: 30 })).toEqual(resolution);
      expect((await f.base.get("conversation"))!.revision).toBe(stored.revision);
      await expect(
        f.archiveRecovery({ ...row, host_generation: "unrelated" }, resolution),
      ).rejects.toThrow("different host generation");
      await expect(f.prepareTurn(input(stored.revision!, "later"))).rejects.toThrow("archived");
      expect(f.starts()).toBe(0);
      const metadata = { ...stored, title: "Archived evidence" };
      await f.sessions.save(metadata);
      expect((await f.base.get("conversation"))!.turns[0]!.recovery_resolution).toEqual(resolution);
    },
  );

  test("reopens a resolved conversation for a successor only when the operator asked to continue", async () => {
    const f = await fixture();
    const prepared = await f.prepareTurn();
    await prepared.commitIntent();
    const row: HostedRunRef = {
      execution_id: "run-1",
      session_id: "conversation",
      workspace_id: "workspace",
      host_generation: "old",
      title: "Unknown turn",
      config: { agent: "solo" },
      created_at: 1,
      updated_at: 10,
      revision: 1,
      control_epoch: 0,
      control: "available",
      execution_state: "unknown",
      attention: "none",
      disconnect_policy: "continue",
    };
    await f.archiveRecovery(row, {
      kind: "operator_verified_physical_closure",
      disposition: "continue",
      previous_host_generation: "old",
      resolving_host_generation: "new",
      operator_connection_id: "operator",
      resolved_at: 20,
    });
    const stored = (await f.base.get("conversation"))!;
    // The interrupted turn stays as the base the successor continues from.
    expect(stored.turns[0]).toMatchObject({ status: "interrupted" });

    await f.prepareTurn(input(stored.revision!, "later"));

    expect(f.params()!.session_id).toBe("conversation");
    expect(f.params()!.execution_id).not.toBe("run-1");
  });

  test("rebuilds the released conversation's context from the recovered turn", async () => {
    const f = await fixture({
      readRun: async (executionId) =>
        executionId === "run-1"
          ? ({
              messages: [{ role: "user", content: "Earlier work" }],
              result: { result: "Earlier answer" },
              events: [],
            } as unknown as RunDetail)
          : null,
    });
    const prepared = await f.prepareTurn();
    await prepared.commitIntent();
    const row: HostedRunRef = {
      execution_id: "run-1",
      session_id: "conversation",
      workspace_id: "workspace",
      host_generation: "old",
      title: "Unknown turn",
      config: { agent: "solo" },
      created_at: 1,
      updated_at: 10,
      revision: 1,
      control_epoch: 0,
      control: "available",
      execution_state: "unknown",
      attention: "none",
      disconnect_policy: "continue",
    };
    await f.archiveRecovery(row, {
      kind: "operator_verified_physical_closure",
      disposition: "continue",
      previous_host_generation: "old",
      resolving_host_generation: "new",
      operator_connection_id: "operator",
      resolved_at: 20,
    });
    const stored = (await f.base.get("conversation"))!;
    await f.prepareTurn(input(stored.revision!, "successor"));

    const messages = f.params()!.messages!;
    // The canonical history is restored, and the successor is told the outcome may be incomplete.
    expect(messages.some((message) => message.content === "Earlier answer")).toBe(true);
    expect(
      messages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("physically closed"),
      ),
    ).toBe(true);
    // Continuing from the recovered execution is refused: the successor starts from the history.
    expect(f.params()!.continue_from).toBeUndefined();
  });

  test("refuses a recovered conversation whose history exceeds its context bound", async () => {
    const f = await fixture({
      readRun: async (executionId) =>
        executionId === "run-1"
          ? ({
              messages: [{ role: "user", content: "x".repeat(600 * 1024) }],
              result: {},
              events: [],
            } as unknown as RunDetail)
          : null,
    });
    const prepared = await f.prepareTurn();
    await prepared.commitIntent();
    const row: HostedRunRef = {
      execution_id: "run-1",
      session_id: "conversation",
      workspace_id: "workspace",
      host_generation: "old",
      title: "Unknown turn",
      config: { agent: "solo" },
      created_at: 1,
      updated_at: 10,
      revision: 1,
      control_epoch: 0,
      control: "available",
      execution_state: "unknown",
      attention: "none",
      disconnect_policy: "continue",
    };
    await f.archiveRecovery(row, {
      kind: "operator_verified_physical_closure",
      disposition: "continue",
      previous_host_generation: "old",
      resolving_host_generation: "new",
      operator_connection_id: "operator",
      resolved_at: 20,
    });
    const stored = (await f.base.get("conversation"))!;
    await expect(f.prepareTurn(input(stored.revision!, "oversized"))).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "Recovered conversation exceeds its context bound",
    });
  });

  test("recovers a steer's consumption from the canonical history instead of replaying it", async () => {
    const f = await fixture({
      readRun: async (executionId) =>
        executionId === "run-1"
          ? ({
              events: [
                {
                  type: "steering_applied",
                  at: 5,
                  agent: "lead",
                  message: "Use it",
                  id: "steer_lost",
                },
              ],
            } as unknown as RunDetail)
          : null,
    });
    const prepared = await f.prepareTurn(input(1, "run-1"));
    await prepared.commitIntent();
    // The submission was durably accepted, and the run applied it without the receipt being confirmed.
    expect(await f.acceptOperator(input(1, "steer_lost"))).toBe("pending");
    await expect(f.prepareOperator("conversation", "steer_lost")).rejects.toMatchObject({
      code: "conflict",
      message: "Submission consumption recovered from canonical history",
      details: { submission: "admitted", execution_id: "run-1" },
    });
    const stored = (await f.base.get("conversation"))!;
    expect(
      stored.operator_intents?.find((value) => value.execution_id === "steer_lost"),
    ).toMatchObject({ admitted: true, delivered_to: "run-1" });
  });

  test.each([false, true])(
    "restart scopes steering reconciliation to its persisted destination, consumed: %s",
    async (consumed) => {
      const f = await fixture();
      const prepared = await f.prepareTurn(input());
      await prepared.commitIntent();
      await f.acceptOperator(input(1, "steer_targeted"), "run-1");
      const stored = (await f.base.get("conversation"))!;
      stored.turns.unshift({
        kind: "conversation",
        execution_id: "unrelated-missing-trace",
        user_preview: "older work",
        status: "error",
      });
      await f.base.saveHost(stored);
      const base = createSessionService({
        dir: f.root,
        owner: "owner",
        projectId: "project",
        workspaceId: "workspace",
      });
      let available = false;
      const reads: string[] = [];
      const recovered = createHostedSessionCoordinator({
        sessions: base,
        projectId: "project",
        workspaceId: "workspace",
        occupied: () => false,
        redact: (text) => text,
        async prepareExecution() {
          throw new Error("receipt recovery must not execute work");
        },
        async readRun(id) {
          reads.push(id);
          if (!available) return null;
          return {
            status: "completed",
            events: consumed ? [{ type: "steering_applied", id: "steer_targeted" }] : [],
          } as unknown as RunDetail;
        },
      });
      expect((await base.get("conversation"))!.operator_intents![0]!.steering_target).toBe("run-1");
      expect(
        (await recovered.pendingOperators("conversation")).map(
          (value) => value.params.execution_id,
        ),
      ).toEqual(["steer_targeted"]);
      await expect(
        recovered.prepareOperator("conversation", "steer_targeted"),
      ).rejects.toMatchObject({
        code: "unavailable",
        details: { submission: "recovering" },
      });
      await expect(
        recovered.deliverOperator("conversation", "steer_targeted", "foreign-run"),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        recovered.acceptOperator(input(1, "steer_targeted"), "foreign-run"),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await recovered.discoverDeliveries(recoveryRow())).toEqual([]);
      available = true;
      expect(await recovered.discoverDeliveries(recoveryRow())).toEqual(
        consumed ? ["steer_targeted"] : [],
      );
      if (consumed) {
        await expect(
          recovered.prepareOperator("conversation", "steer_targeted"),
        ).rejects.toMatchObject({
          details: { submission: "admitted", execution_id: "run-1" },
        });
        expect((await base.get("conversation"))!.operator_intents![0]).toMatchObject({
          admitted: true,
          delivered_to: "run-1",
          steering_target: "run-1",
        });
      } else {
        expect(
          (await recovered.prepareOperator("conversation", "steer_targeted")).params.execution_id,
        ).toBe("steer_targeted");
      }
      expect((await recovered.pendingOperators("conversation")).length).toBe(consumed ? 0 : 1);
      expect(reads).toEqual(["run-1", "run-1", "run-1", "run-1"]);
      expect(f.starts()).toBe(0);
    },
  );

  test("preserves accepted operator submissions across a coordinated save", async () => {
    const f = await fixture();
    expect(await f.acceptOperator(input(1, "operator-1"))).toBe("pending");
    const stored = (await f.base.get("conversation"))!;
    // A caller's copy is written without the submissions it never held; the durable ones stay.
    await f.saveDuringActivity(
      {
        ...stored,
        operator_intents: undefined,
        operator_sequence: undefined,
      },
      () => false,
    );
    const after = (await f.base.get("conversation"))!;
    expect(after.operator_intents?.map((value) => value.execution_id)).toEqual(["operator-1"]);
    expect(after.operator_sequence).toBe(1);
  });

  test("prepares an unconfirmed steer as its own turn when the history is silent about it", async () => {
    const f = await fixture({
      readRun: async () => ({ status: "completed", events: [] }) as unknown as RunDetail,
    });
    const prepared = await f.prepareTurn(input(1, "run-1"));
    await prepared.commitIntent();
    expect(await f.acceptOperator(input(1, "steer_quiet"))).toBe("pending");
    // Nothing in the canonical history claims this message, so it is prepared as its own turn.
    const preparedInput = await f.prepareOperator("conversation", "steer_quiet");
    expect(preparedInput).toMatchObject({
      session_id: "conversation",
      params: { execution_id: "steer_quiet", continue_from: "run-1" },
    });
  });

  test.each(["missing", "running", "damaged", "reader_absent"] as const)(
    "retains steering when canonical history is %s and retries only the lookup",
    async (condition) => {
      let restored = false;
      const f = await fixture({
        readRun:
          condition === "reader_absent"
            ? undefined
            : async () => {
                if (!restored && condition === "missing") return null;
                return {
                  status: !restored && condition === "running" ? "running" : "completed",
                  events: [],
                  ...(!restored && condition === "damaged"
                    ? { recovery: { skipped_lines: 1, synthesized_tool_calls: 0 } }
                    : {}),
                } as unknown as RunDetail;
              },
      });
      const prepared = await f.prepareTurn(input());
      await prepared.commitIntent();
      await f.acceptOperator(input(1, "steer_uncertain"));
      await expect(f.prepareOperator("conversation", "steer_uncertain")).rejects.toMatchObject({
        code: "unavailable",
        details: { submission: "recovering", execution_id: "steer_uncertain" },
      });
      const stored = (await f.base.get("conversation"))!;
      expect(stored.operator_intents?.[0]?.admitted).not.toBe(true);
      expect(f.starts()).toBe(0);
      await f.acceptOperator(input(1, "independent-operator"));
      expect(
        (await f.prepareOperator("conversation", "independent-operator")).params.execution_id,
      ).toBe("independent-operator");
      expect(
        (await f.base.get("conversation"))!.operator_intents?.find(
          (intent) => intent.execution_id === "steer_uncertain",
        )?.admitted,
      ).not.toBe(true);
      restored = true;
      if (condition !== "reader_absent")
        expect(
          (await f.prepareOperator("conversation", "steer_uncertain")).params.execution_id,
        ).toBe("steer_uncertain");
    },
  );

  test("finds steering consumption older than sixteen turns despite a missing newer trace", async () => {
    const f = await fixture({
      readRun: async (id) =>
        id === "run-1"
          ? ({
              status: "completed",
              events: [
                {
                  type: "steering_applied",
                  id: "steer_old",
                  at: 5,
                  agent: "lead",
                  message: "Synthetic",
                },
              ],
            } as unknown as RunDetail)
          : null,
    });
    const prepared = await f.prepareTurn(input());
    await prepared.commitIntent();
    await f.acceptOperator(input(1, "steer_old"));
    const stored = (await f.base.get("conversation"))!;
    const first = stored.turns[0]!;
    for (let index = 0; index < 20; index++)
      stored.turns.push({ ...first, execution_id: `later-${index}` });
    await f.base.saveHost(stored);
    await expect(f.prepareOperator("conversation", "steer_old")).rejects.toMatchObject({
      code: "conflict",
      details: { submission: "admitted", execution_id: "run-1" },
    });
    expect((await f.base.get("conversation"))!.operator_intents?.[0]).toMatchObject({
      admitted: true,
      delivered_to: "run-1",
    });
    expect(f.starts()).toBe(0);
  });

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
      guardUsageFor: () => ({
        cacheUnknown: false,
        usage: {
          iterations: 0,
          elapsed_ms: 0,
          by_agent: [
            {
              role: "subagent",
              model: "priced",
              input_tokens: 500,
              output_tokens: 20,
              cached_tokens: 300,
              cache_write_tokens: 0,
            },
          ],
        },
      }),
    });
    const before = (await f.sessions.get("conversation"))!;
    expect(before.revision).toBe(1);
    const prepared = await f.prepareTurn();
    expect(f.starts()).toBe(0);
    expect(prepared.title).toBe("Discussion with [REDACTED]");
    expect(f.params()).not.toHaveProperty("configuration_session_id");
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
    expect(after.totals).toMatchObject({ input: 1800, output: 270, cached: 700 });
    expect(after.totals.cost_usd).toBeCloseTo(0.00348);
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

  test("keeps Guard tokens without pricing an unknown cache breakdown", async () => {
    const f = await fixture({
      priceFor: () => ({ input: 2, output: 4, cache_read: 1 }),
      guardUsageFor: () => ({
        cacheUnknown: true,
        usage: {
          iterations: 0,
          elapsed_ms: 0,
          by_agent: [
            {
              role: "subagent",
              model: "priced",
              input_tokens: 500,
              output_tokens: 20,
              cached_tokens: 300,
              cache_write_tokens: 0,
            },
          ],
        },
      }),
    });
    const prepared = await f.prepareTurn();
    await prepared.commitIntent();
    const handle = await prepared.start();
    await handle.closed;
    await prepared.reconcile(completed);

    const totals = (await f.sessions.get("conversation"))!.totals;
    expect(totals).toMatchObject({ input: 500, output: 20 });
    expect(totals.cached).toBeUndefined();
    expect(totals.cost_usd).toBeUndefined();
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
      const service: HostSessionStore = {
        ...f.base,
        async saveHost(value) {
          if (fail && value.turns.length > 0) {
            fail = false;
            if (afterCommit) await f.base.saveHost(value);
            throw new Error("injected disk failure");
          }
          await f.base.saveHost(value);
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
