import { afterEach, describe, expect, it } from "bun:test";
import { createGoalCapability, goalRuntimePortOf, type GoalCriterion } from "@clarvis/goal";
import { loadEnv } from "@clarvis/capability";
import { createGoalRuntimePort } from "../../src/goals/runtime-port.ts";
import { createCapabilityBroker } from "../../src/runtime/authority-brokers.ts";
import {
  createHostGoalBridge,
  createGuestGoalCapability,
  RUNTIME_GOAL_MAX_BYTES,
  RUNTIME_GOAL_METHOD,
  validRuntimeGoalDescriptor,
} from "../../src/runtime/goal-bridge.ts";
import { createGuestLoopExecutor } from "../../src/runtime/guest-loop-executor.ts";
import { runtimeLoopPolicy } from "../../src/runtime/loop-policy.ts";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import { goalHostFixture } from "../helpers/goal-host.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(criteria: GoalCriterion[] = []) {
  const host = await goalHostFixture({ criteria });
  cleanup.push(host.close);
  await host.admit();
  const { port, evidence } = await host.runtime();
  const rawBody = { ...port.binding };
  const bound = createHostGoalBridge(port, rawBody, "first");
  const broker = createCapabilityBroker({
    generation: "generation",
    runId: "first",
    grants: [bound.grant],
    maxArgumentsBytes: RUNTIME_GOAL_MAX_BYTES,
    maxResultBytes: RUNTIME_GOAL_MAX_BYTES,
  });
  const calls: unknown[] = [];
  const bridge: GuestExecutionBridge = {
    model: async () => {
      throw new Error("This fixture must not call a model");
    },
    async capability(callId, request, signal) {
      calls.push(structuredClone(request));
      return structuredClone(
        await broker.invoke(
          { generation: "generation", runId: "first", callId },
          structuredClone(request),
          signal,
        ),
      );
    },
    event: async () => {},
    checkpoint: async () => {},
  };
  const capability = createGuestGoalCapability(
    bound.descriptor,
    bridge,
    new AbortController().signal,
  );
  return {
    host,
    port,
    evidence,
    rawBody,
    bound,
    broker,
    bridge,
    capability,
    calls,
    guest: goalRuntimePortOf(capability)!,
  };
}

describe("bound runtime goal bridge", () => {
  it("uses canonical entry authority and commits through the private host repository", async () => {
    const f = await fixture();
    expect(goalRuntimePortOf({ ...createGoalCapability(f.port) })).toBeUndefined();
    expect(validRuntimeGoalDescriptor(f.bound.descriptor, f.rawBody)).toBe(true);
    expect(f.capability.required).toBe(true);
    expect(f.capability.reservedWireNames).toEqual(["get_goal", "update_goal"]);
    expect(await f.guest.read()).toEqual(await f.port.read());
    await f.guest.progress({ summary: "Inspected the result", evidence_ids: [] });
    const checkpoint = await f.guest.checkpoint({
      summary: "Stage checked",
      next_step: "Verify outcome",
      evidence_ids: [],
    });
    expect(checkpoint.progress_accepted).toBe(false);
    const validation = await f.guest.candidate({
      summary: "Outcome verified",
      assessments: [
        {
          criterion_id: "objective",
          kind: "qualitative",
          justification: "Synthetic fixture was checked",
          evidence_ids: [],
        },
      ],
    });
    expect(validation).toMatchObject({ valid: true, qualitative_criteria: ["objective"] });
    expect(await f.guest.validateCompletion()).toEqual(validation);
    const persisted = (await f.host.reopen().get("session"))!.goal_state!;
    expect(persisted.current!.status).toBe("active");
    expect(persisted.current!.runs[0]!.checkpoint).toEqual(checkpoint);
    expect(persisted.current!.runs[0]!.progress!.summary).toBe("Inspected the result");
    expect(JSON.stringify(f.calls)).not.toContain("expected_revision");
    await f.guest.blocked("Missing user decision");
    expect((await f.host.repository.read("session"))!.current!.status).toBe("blocked");
    await expect(f.guest.read()).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses forged scope, controls, identity and replay without changing host state", async () => {
    const f = await fixture();
    const before = await f.host.repository.read("session");
    const scope = { ...f.port.binding, role: "entry" };
    let index = 0;
    const invoke = (args: unknown, overrides = {}) =>
      f.broker.invoke(
        {
          generation: "generation",
          runId: "first",
          callId: `call-${index++}`,
          ...overrides,
        },
        { method: RUNTIME_GOAL_METHOD, revision: "v1", arguments: args },
      );
    const request = {
      scope,
      operation: "progress",
      input: { summary: "Forged", evidence_ids: [] },
    };
    for (const changed of [
      { role: "child" },
      { session_id: "foreign" },
      { agent_instance_id: "child" },
      { execution_id: "foreign" },
      { goal_id: "foreign" },
      { objective_revision: 0 },
      { owner: "foreign" },
    ])
      await expect(invoke({ ...request, scope: { ...scope, ...changed } })).rejects.toBeDefined();
    for (const operation of ["resume", "complete", "create", "cancel", "extend_budget", "start"])
      await expect(invoke({ scope, operation })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      invoke({ ...request, input: { ...request.input, execution_id: "foreign" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(invoke(request, { generation: "old" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(invoke(request, { runId: "child" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(await f.host.repository.read("session")).toEqual(before);
    await invoke(request, { callId: "once" });
    const committed = await f.host.repository.read("session");
    await expect(invoke(request, { callId: "once" })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(await f.host.repository.read("session")).toEqual(committed);
    f.broker.revoke();
    await expect(f.guest.read()).rejects.toMatchObject({ code: "unauthorized" });
    expect(() =>
      createHostGoalBridge(f.port, { ...f.rawBody, agent_instance_id: "child" }, "first"),
    ).toThrow("admitted entry identity");
  });

  it.each(["operation", "revocation"])("fences %s during a queued host mutation", async (mode) => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = createGoalRuntimePort({
      binding: f.port.binding,
      evidence: f.evidence,
      repository: {
        read: (sessionId) => f.host.repository.read(sessionId),
        async transact(sessionId, mutation) {
          entered();
          await wait;
          return f.host.repository.transact(sessionId, mutation);
        },
      },
    });
    const bound = createHostGoalBridge(port, f.rawBody, "first");
    const broker = createCapabilityBroker({
      generation: "g",
      runId: "first",
      grants: [bound.grant],
      maxArgumentsBytes: RUNTIME_GOAL_MAX_BYTES,
      maxResultBytes: RUNTIME_GOAL_MAX_BYTES,
    });
    const signal = new AbortController();
    const before = await f.host.repository.read("session");
    const pending = broker
      .invoke(
        { generation: "g", runId: "first", callId: "pending" },
        {
          method: RUNTIME_GOAL_METHOD,
          revision: "v1",
          arguments: {
            scope: { ...port.binding, role: "entry" },
            operation: "progress",
            input: { summary: "Late mutation", evidence_ids: [] },
          },
        },
        signal.signal,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error: error as unknown }),
      );
    await ready;
    if (mode === "operation") signal.abort();
    else broker.revoke();
    release();
    expect(await pending).toMatchObject({ error: { code: "cancelled" } });
    expect(await f.host.repository.read("session")).toEqual(before);
  });

  it("transfers a large bounded objective intact without session receipts or archives", async () => {
    const f = await fixture(
      Array.from({ length: 32 }, (_, index) => ({
        id: `criterion-${index}`,
        kind: "qualitative",
        description: "界".repeat(3500),
      })),
    );
    const snapshot = await f.guest.read();
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(256 * 1024);
    expect(snapshot).toEqual(await f.port.read());
    expect(snapshot).not.toHaveProperty("receipts");
    expect(snapshot).not.toHaveProperty("archive");
    const broken = createGuestGoalCapability(
      f.bound.descriptor,
      { ...f.bridge, capability: async () => ({ valid: "true" }) },
      new AbortController().signal,
    );
    await expect(goalRuntimePortOf(broken)!.validateCompletion()).rejects.toMatchObject({
      code: "invalid_request",
    });
    const oversized = createGuestGoalCapability(
      f.bound.descriptor,
      { ...f.bridge, capability: async () => "x".repeat(RUNTIME_GOAL_MAX_BYTES) },
      new AbortController().signal,
    );
    await expect(goalRuntimePortOf(oversized)!.read()).rejects.toMatchObject({
      code: "resource_exhausted",
    });
  });

  it("refuses missing, stale and contradictory guest projection before model execution", async () => {
    const f = await fixture();
    const envelope = {
      owner: "owner",
      rawBody: f.rawBody,
      modelLeaseId: "lease",
      toolPolicy: { enabled: false, confine: true, maxGrant: "none" },
      loopPolicy: runtimeLoopPolicy(loadEnv({})),
      hostCapabilities: ["goal"],
      goal: f.bound.descriptor,
    };
    const executor = createGuestLoopExecutor();
    for (const overrides of [
      { goal: undefined },
      { hostCapabilities: [] },
      { hostCapabilities: null },
      { goal: { ...f.bound.descriptor, revision: "old" } },
      { rawBody: { ...f.rawBody, agent_instance_id: "child" } },
      { parentRunId: "parent" },
      { workflow: {} },
    ])
      await expect(
        executor.execute(
          "first",
          { ...envelope, ...overrides },
          f.bridge,
          new AbortController().signal,
        ),
      ).rejects.toThrow("guest run envelope is invalid");
    await expect(
      executor.execute("child", envelope, f.bridge, new AbortController().signal),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.calls).toEqual([]);
  });
});
