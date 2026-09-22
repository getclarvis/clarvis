import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("binds a plain follow-up to the existing Goal in the same physical execution", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  f.setResponder(async () => ({
    name: "update_goal",
    arguments: { update: { action: "blocked", reason: "Previous attempt interrupted" } },
  }));
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "create",
    expected_revision: 0,
    action: {
      kind: "create",
      objective: "Deliver the artifact",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await f.until(() => f.host.stats().runs === 0);
  const before = (await f.client.goals.get("conversation")).state.current!;
  let step = 0;
  f.setResponder(async (request) => {
    step++;
    if (step === 1) {
      expect(request.tools?.map((tool) => tool.function.name)).toContain("attach_goal");
      return { name: "attach_goal", arguments: {} };
    }
    if (step === 2)
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Need an external artifact" } },
      };
    throw new Error("Unexpected additional inference");
  });
  const session = (await f.client.sessions.get("conversation"))!;
  const input = {
    session_id: "conversation",
    session_revision: session.revision!,
    kind: "conversation" as const,
    user_preview: "continue seu trabalho",
    params: {
      execution_id: "plain-followup",
      agent: "solo",
      messages: [{ role: "user" as const, content: "continue seu trabalho" }],
    },
  };
  const run = await f.client.hosting!.start(input);
  const outcome = await run.handle.done;
  expect(step, JSON.stringify(outcome)).toBe(2);
  await run.handle.closed;
  const after = (await f.client.goals.get("conversation")).state.current!;
  expect(after.goal_id).toBe(before.goal_id);
  expect(after.runs).toHaveLength(before.runs.length + 1);
  expect(after.runs.at(-1)?.execution_id).toBe("plain-followup");
  expect(after.consumption.input).toBeGreaterThan(before.consumption.input);
  const requests = f.requests.length;
  const replay = await f.client.hosting!.start(input);
  await replay.handle.done;
  expect(f.requests).toHaveLength(requests);
  expect(
    (await f.client.sessions.get("conversation"))!.turns.filter(
      (turn) => turn.execution_id === "plain-followup",
    ),
  ).toHaveLength(1);
});

it("retains new operator input behind physical closure and ignores a stale display revision", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.setResponder(async () => {
    entered.resolve();
    await release.promise;
    return { text: "First finished." };
  });
  const session = (await f.client.sessions.get("conversation"))!;
  const first = await f.client.hosting!.start({
    session_id: session.id,
    session_revision: session.revision!,
    kind: "conversation",
    user_preview: "first",
    params: {
      execution_id: "first",
      agent: "solo",
      intent: "operator",
      messages: [{ role: "user", content: "first" }],
    },
  });
  await entered.promise;
  const second = f.client.hosting!.start({
    session_id: session.id,
    session_revision: 0,
    kind: "conversation",
    user_preview: "second",
    params: {
      execution_id: "second",
      agent: "solo",
      intent: "operator",
      messages: [{ role: "user", content: "second" }],
    },
  });
  const third = f.client.hosting!.start({
    session_id: session.id,
    session_revision: 0,
    kind: "conversation",
    user_preview: "third",
    params: {
      execution_id: "third",
      agent: "solo",
      intent: "operator",
      messages: [{ role: "user", content: "third" }],
    },
  });
  void third.catch(() => undefined);
  try {
    await f.until(
      async () =>
        (await f.client.sessions.get(session.id))?.operator_intents?.some(
          (value) => value.execution_id === "third",
        ) === true,
    );
    expect(f.requests).toHaveLength(1);
  } finally {
    release.resolve();
  }
  await first.handle.closed;
  const admitted = await second;
  await admitted.handle.closed;
  await expect(third).rejects.toMatchObject({
    details: { submission: "admitted", execution_id: admitted.run.execution_id },
  });
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("third");
  expect(f.requests).toHaveLength(2);
  const stored = (await f.client.sessions.get(session.id))!;
  expect(stored.turns.map((turn) => turn.execution_id)).toEqual(["first", "second"]);
  expect(stored.operator_intents?.every((value) => value.admitted)).toBe(true);
});

it("reattaches manual resume to a healthy Goal run without duplicate inference", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.setResponder(async () => {
    entered.resolve();
    await release.promise;
    return {
      name: "update_goal",
      arguments: { update: { action: "blocked", reason: "External prerequisite" } },
    };
  });
  const created = await f.client.goals.control({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "create-live",
    action: { kind: "create", objective: "Retain live work", limits: { max_net_tokens: 1000000 } },
  });
  await entered.promise;
  try {
    const view = await f.client.goals.get("conversation");
    const resumed = await f.client.goals.control({
      session_id: "conversation",
      expected_revision: view.state.revision,
      operation_id: "resume-live",
      action: { kind: "resume" },
    });
    expect(resumed.execution_id).toBe(created.execution_id);
    expect(resumed.outcome).toBe("running");
    expect(f.requests).toHaveLength(1);
  } finally {
    release.resolve();
  }
  await f.until(() => f.host.stats().runs === 0);
});

it("persists consumed steering exactly once and acknowledges the original execution", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let step = 0;
  f.setResponder(async () => {
    if (++step === 1) {
      entered.resolve();
      await release.promise;
      return { name: "list_dir", arguments: { path: "." } };
    }
    return { text: "Steering delivered." };
  });
  const session = (await f.client.sessions.get("conversation"))!;
  const started = await f.client.hosting!.start({
    session_id: session.id,
    session_revision: session.revision!,
    kind: "conversation",
    user_preview: "work",
    params: {
      execution_id: "steered-run",
      agent: "solo",
      intent: "operator",
      messages: [{ role: "user", content: "work" }],
    },
  });
  await entered.promise;
  const message = {
    role: "user" as const,
    content: "Use the new instruction",
    steering_id: "unique-correction",
  };
  const steering = started.handle.steer(message);
  const duplicate = started.handle.steer(message);
  try {
    await f.until(
      async () => (await f.client.sessions.get(session.id))!.operator_intents?.length === 2,
    );
  } finally {
    release.resolve();
  }
  await Promise.all([steering, duplicate]);
  await started.handle.closed;
  const stored = (await f.client.sessions.get(session.id))!;
  expect(stored.operator_intents?.at(-1)).toMatchObject({
    execution_id: "steer_unique-correction",
    admitted: true,
    delivered_to: "steered-run",
  });
  expect(stored.turns).toHaveLength(1);
  expect(f.requests).toHaveLength(2);
});

it("retains a budget-limited resume and starts it only after its explicitly linked limit edit", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  f.setResponder(async () => ({
    name: "update_goal",
    arguments: { update: { action: "blocked", reason: "Controlled stop" } },
  }));
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "budget-create",
    expected_revision: 0,
    action: {
      kind: "create",
      objective: "Respect the material limit",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await f.until(() => f.host.stats().runs === 0);
  let view = await f.client.goals.get("conversation");
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "lower",
    expected_revision: view.state.revision,
    action: { kind: "edit", limits: { max_net_tokens: 1 } },
  });
  view = await f.client.goals.get("conversation");
  const resumeRequest = {
    session_id: "conversation",
    operation_id: "resume-budget",
    expected_revision: view.state.revision,
    action: { kind: "resume" as const },
  };
  const pending = await f.client.goals.control(resumeRequest);
  expect(await f.client.goals.control(resumeRequest)).toEqual(pending);
  expect(pending).toMatchObject({
    resume_pending: true,
    outcome: "needs_input",
    resume_condition: "token_limit",
  });
  expect(f.requests).toHaveLength(1);
  view = await f.client.goals.get("conversation");
  const edited = await f.client.goals.control({
    session_id: "conversation",
    operation_id: "raise",
    expected_revision: view.state.revision,
    action: {
      kind: "edit",
      resume_operation_id: pending.operation_id,
      limits: { max_net_tokens: 2000000 },
    },
  });
  expect(edited.execution_id).toBe(pending.execution_id);
  await f.until(() => f.host.stats().runs === 0);
  expect(f.requests).toHaveLength(2);
});

it("waits for a stopping stage and resumes it through the same execution", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.setResponder(async () => {
    entered.resolve();
    await release.promise;
    return { text: "Stage finished." };
  });
  const created = await f.client.goals.control({
    session_id: "conversation",
    operation_id: "create",
    expected_revision: 0,
    action: { kind: "create", objective: "Survive a stop", limits: { max_net_tokens: 1000000 } },
  });
  await entered.promise;
  const view = await f.client.goals.get("conversation");
  const paused = await f.client.goals.control({
    session_id: "conversation",
    operation_id: "pause",
    expected_revision: view.state.revision,
    action: { kind: "pause", running: true },
  });
  try {
    expect(paused).toMatchObject({ status: "paused" });
    // The resume is admitted only once the stopped execution has physically settled, and it
    // starts a fresh stage instead of pretending the cancelled one is still running.
    const resumed = await f.client.goals.control({
      session_id: "conversation",
      operation_id: "resume",
      expected_revision: (await f.client.goals.get("conversation")).state.revision,
      action: { kind: "resume" },
    });
    expect(resumed.outcome).toBe("running");
    expect(resumed.execution_id).not.toBe(created.execution_id);
  } finally {
    release.resolve();
  }
  await f.until(() => f.host.stats().runs === 0);
});

it("admits the operator's own turn while the Goal is blocked and starts no Goal stage", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  let step = 0;
  f.setResponder(async () => {
    step++;
    if (step === 1)
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Needs an operator decision" } },
      };
    if (step === 2) return { text: "Answered the operator's request." };
    throw new Error("Unexpected additional inference");
  });
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "create",
    expected_revision: 0,
    action: { kind: "create", objective: "Wait for input", limits: { max_net_tokens: 1000000 } },
  });
  await f.until(
    async () => (await f.client.goals.get("conversation")).state.current?.status === "blocked",
  );
  await f.until(() => f.host.stats().runs === 0);
  const session = (await f.client.sessions.get("conversation"))!;
  const turn = await f.client.hosting!.start({
    session_id: "conversation",
    session_revision: session.revision!,
    kind: "conversation",
    user_preview: "Answer directly",
    params: {
      execution_id: "operator-turn",
      agent: "solo",
      intent: "operator",
      messages: [{ role: "user", content: "Answer directly" }],
    },
  });
  await turn.handle.closed;
  expect(step).toBe(2);
  const after = await f.client.goals.get("conversation");
  // The person's own turn runs with the ordinary profile and budget; it is not a Goal stage.
  expect(after.state.current!.status).toBe("blocked");
  expect(after.state.current!.runs.some((run) => run.execution_id === "operator-turn")).toBe(false);
  const stored = (await f.client.sessions.get("conversation"))!;
  expect(stored.turns.at(-1)).toMatchObject({ execution_id: "operator-turn" });
});

it("answers a repeated execution identity from the accepted submission instead of starting twice", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  f.setResponder(async () => ({ text: "Finished once." }));
  const session = (await f.client.sessions.get("conversation"))!;
  const input = {
    session_id: session.id,
    session_revision: session.revision!,
    kind: "conversation" as const,
    user_preview: "Only once",
    params: {
      execution_id: "repeated-identity",
      agent: "solo",
      intent: "operator" as const,
      messages: [{ role: "user" as const, content: "Only once" }],
    },
  };
  const first = await f.client.hosting!.start(input);
  await first.handle.closed;
  const accepted = (await f.client.sessions.get(session.id))!.turns.at(-1)!.execution_id!;
  const replay = await f.client.hosting!.start({
    ...input,
    session_revision: (await f.client.sessions.get(session.id))!.revision!,
  });
  expect(replay.run.execution_id).toBe(accepted);
  await replay.handle.closed;
  expect(f.requests).toHaveLength(1);
});

it("replays a retained resume once the Goal can afford the stage again", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  f.setResponder(async () => ({
    name: "update_goal",
    arguments: { update: { action: "blocked", reason: "Controlled stop" } },
  }));
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "create",
    expected_revision: 0,
    action: {
      kind: "create",
      objective: "Afford the stage again",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await f.until(() => f.host.stats().runs === 0);
  let view = await f.client.goals.get("conversation");
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "lower",
    expected_revision: view.state.revision,
    action: { kind: "edit", limits: { max_net_tokens: 1 } },
  });
  view = await f.client.goals.get("conversation");
  const resume = {
    session_id: "conversation",
    operation_id: "resume-again",
    expected_revision: view.state.revision,
    action: { kind: "resume" as const },
  };
  const retained = await f.client.goals.control(resume);
  expect(retained).toMatchObject({
    resume_pending: true,
    outcome: "needs_input",
    resume_condition: "token_limit",
  });
  expect(f.requests).toHaveLength(1);

  // Restoring the allowance through a common edit does not itself grant the start.
  view = await f.client.goals.get("conversation");
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "restore",
    expected_revision: view.state.revision,
    action: { kind: "edit", limits: { max_net_tokens: 5000000 } },
  });
  expect(f.requests).toHaveLength(1);

  // A later control invalidates the retained resume instead of letting it start.
  const replayed = await f.client.goals.control(resume);
  expect(replayed).toMatchObject({ outcome: "superseded" });
  expect(f.requests).toHaveLength(1);
});

it("keeps a retained resume pending when its bound limit edit still cannot cover the gap", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  f.setResponder(async () => ({
    name: "update_goal",
    arguments: { update: { action: "blocked", reason: "Controlled stop" } },
  }));
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "create",
    expected_revision: 0,
    action: {
      kind: "create",
      objective: "Stay inside the bound",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await f.until(() => f.host.stats().runs === 0);
  let view = await f.client.goals.get("conversation");
  await f.client.goals.control({
    session_id: "conversation",
    operation_id: "lower",
    expected_revision: view.state.revision,
    action: { kind: "edit", limits: { max_net_tokens: 1 } },
  });
  view = await f.client.goals.get("conversation");
  const pending = await f.client.goals.control({
    session_id: "conversation",
    operation_id: "resume-bounded",
    expected_revision: view.state.revision,
    action: { kind: "resume" },
  });
  expect(pending).toMatchObject({ resume_pending: true, resume_condition: "token_limit" });

  // The edit is bound to that resume, and the allowance is still not enough to start it.
  view = await f.client.goals.get("conversation");
  const adapted = await f.client.goals.control({
    session_id: "conversation",
    operation_id: "adapt",
    expected_revision: view.state.revision,
    action: {
      kind: "edit",
      resume_operation_id: pending.operation_id,
      limits: { max_net_tokens: 2 },
    },
  });
  expect(adapted).toMatchObject({ outcome: "needs_input", status: "blocked" });
  expect(f.requests).toHaveLength(1);
});

it("preserves partial accounting through an independent turn and an idempotent attached follow-up", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  let step = 0;
  f.setResponder(async () => {
    step++;
    if (step === 1) return { name: "get_goal", arguments: {} };
    if (step === 2)
      return {
        name: "update_goal",
        arguments: {
          update: {
            action: "checkpoint",
            summary: "Useful work retained",
            next_step: "Finish remaining work",
          },
        },
        usage: "missing",
      };
    if (step === 3) return { text: "Independent answer delivered" };
    if (step === 4) return { name: "attach_goal", arguments: {} };
    if (step === 5)
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "External artifact still required" } },
      };
    throw new Error("Unexpected replay or automatic inference");
  });
  await f.client.goals.control({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "create-partial",
    action: {
      kind: "create",
      objective: "Deliver the remaining artifact",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await f.until(() => f.host.stats().runs === 0);
  const before = (await f.client.goals.get("conversation")).state.current!;
  expect(before.status).toBe("blocked");
  expect(before.runs[0]!.usage?.kind).toBe("partial");
  expect(before.consumption.input).toBeGreaterThan(0);
  const start = (execution_id: string, text: string) => ({
    session_id: "conversation",
    session_revision: 0,
    kind: "conversation" as const,
    user_preview: text,
    params: {
      execution_id,
      agent: "solo",
      intent: "operator" as const,
      messages: [{ role: "user" as const, content: text }],
    },
  });
  const independent = await f.client.hosting!.start(
    start("independent-partial", "Answer a different question"),
  );
  expect(await independent.handle.done).toMatchObject({ status: "completed" });
  await independent.handle.closed;
  const unchanged = (await f.client.goals.get("conversation")).state.current!;
  expect(unchanged.runs).toEqual(before.runs);
  expect(unchanged.consumption).toEqual(before.consumption);
  const input = start("attached-partial", "continue seu trabalho");
  const attached = await f.client.hosting!.start(input);
  await attached.handle.closed;
  const after = (await f.client.goals.get("conversation")).state.current!;
  expect(after.runs).toHaveLength(2);
  expect(after.runs[0]!.usage).toEqual(before.runs[0]!.usage);
  expect(after.runs[1]!.execution_id).toBe("attached-partial");
  expect(after.consumption.usage_accepted_runs).toContain(before.runs[0]!.execution_id);
  expect(after.limits).toEqual(before.limits);
  const stored = (await f.client.sessions.get("conversation"))!;
  const replay = await f.client.hosting!.start(input);
  await replay.handle.closed;
  expect(step).toBe(5);
  const measured = [...f.usages, ...f.stewardUsages];
  expect(stored.totals.input).toBe(measured.reduce((sum, usage) => sum + usage.input, 0));
  expect(stored.totals.output).toBe(measured.reduce((sum, usage) => sum + usage.output, 0));
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("Useful work retained");
  expect((await f.client.sessions.get("conversation"))!.totals).toEqual(stored.totals);
  expect(stored.turns.map((turn) => turn.execution_id)).toEqual([
    before.runs[0]!.execution_id,
    "independent-partial",
    "attached-partial",
  ]);
  expect(f.errors).toEqual([]);
});

it("continues useful work after three locally limited children and partial Goal consumption", async () => {
  const f = await createGoalFileHostFixture({
    childIterationLimit: 64,
    maxProviderCalls: 220,
    timeoutMs: 60000,
    budgetTokenLimit: 1000000,
  });
  cleanup.push(f.close);
  let leadStep = 0;
  let childCalls = 0;
  f.setResponder(async (request) => {
    const leader = request.tools?.some((tool) =>
      ["get_goal", "attach_goal"].includes(tool.function.name),
    );
    if (!leader) {
      childCalls++;
      return {
        name: "write_file",
        arguments: { path: "partial.txt", content: `Retained record ${String(childCalls)}` },
        commentary: `Partial record ${String(childCalls)}`,
      };
    }
    leadStep++;
    if (leadStep <= 3)
      return {
        name: "spawn_subagent",
        arguments: {
          title: `part ${String(leadStep)}`,
          task: "Inspect successive records and retain partial output",
          profile: "helper",
        },
      };
    if (leadStep === 4) {
      expect(childCalls).toBe(192);
      expect(
        JSON.stringify(request.messages).includes("own iteration limit after 64 iterations"),
      ).toBe(true);
      return {
        name: "update_goal",
        arguments: {
          update: {
            action: "checkpoint",
            summary: "Three partial inspections retained",
            next_step: "Consolidate retained records",
          },
        },
        usage: "missing",
      };
    }
    if (leadStep === 5) return { name: "attach_goal", arguments: {} };
    if (leadStep === 6)
      return {
        name: "write_file",
        arguments: {
          path: "consolidated.txt",
          content: await readFile(join(f.workspaceRoot, "partial.txt"), "utf8"),
        },
      };
    if (leadStep === 7)
      return {
        name: "update_goal",
        arguments: {
          update: {
            action: "blocked",
            reason: "Await external acceptance of the consolidated artifact",
          },
        },
      };
    throw new Error("Unexpected duplicate continuation");
  });
  await f.client.goals.control({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "combined-create",
    action: {
      kind: "create",
      objective: "Consolidate inspected records",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await f.until(() => f.host.stats().runs === 0);
  const before = (await f.client.goals.get("conversation")).state.current!;
  expect(leadStep).toBe(4);
  expect(before.runs[0]!.usage?.kind).toBe("partial");
  expect(before.runs[0]!.cause).not.toBe("unclassified");
  const input = {
    session_id: "conversation",
    session_revision: 0,
    kind: "conversation" as const,
    user_preview: "continue seu trabalho",
    params: {
      execution_id: "combined-followup",
      agent: "solo",
      intent: "operator" as const,
      messages: [{ role: "user" as const, content: "continue seu trabalho" }],
    },
  };
  const run = await f.client.hosting!.start(input);
  await run.handle.closed;
  expect(await readFile(join(f.workspaceRoot, "consolidated.txt"), "utf8")).toBe(
    "Retained record 192",
  );
  const after = (await f.client.goals.get("conversation")).state.current!;
  expect(after.runs).toHaveLength(2);
  expect(after.runs[0]!.usage).toEqual(before.runs[0]!.usage);
  expect(after.limits).toEqual(before.limits);
  const replay = await f.client.hosting!.start(input);
  await replay.handle.closed;
  expect(leadStep).toBe(7);
  expect(childCalls).toBe(192);
  expect(f.errors).toEqual([]);
});

it.each(["pause", "cancel", "replace"] as const)(
  "%s supersedes pending resume and rejects a late linked limit edit",
  async (kind) => {
    const f = await createGoalFileHostFixture();
    cleanup.push(f.close);
    f.setResponder(async () => ({
      name: "update_goal",
      arguments: { update: { action: "blocked", reason: "Controlled boundary" } },
    }));
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "fenced-create",
      action: {
        kind: "create",
        objective: "Preserve operator precedence",
        limits: { max_net_tokens: 1000000 },
      },
    });
    await f.until(() => f.host.stats().runs === 0);
    let view = await f.client.goals.get("conversation");
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: view.state.revision,
      operation_id: "fenced-lower",
      action: { kind: "edit", limits: { max_net_tokens: 1 } },
    });
    view = await f.client.goals.get("conversation");
    const request = {
      session_id: "conversation",
      expected_revision: view.state.revision,
      operation_id: "fenced-resume",
      action: { kind: "resume" as const },
    };
    const pending = await f.client.goals.control(request);
    expect(pending.outcome).toBe("needs_input");
    view = await f.client.goals.get("conversation");
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: view.state.revision,
      operation_id: "supersede",
      action:
        kind === "replace"
          ? {
              kind,
              objective: "Replacement objective owns later work",
              limits: { max_net_tokens: 1000000 },
            }
          : { kind },
    });
    if (kind === "replace") await f.until(() => f.host.stats().runs === 0);
    const stopped = await f.client.goals.get("conversation");
    expect((await f.client.goals.control(request)).outcome).toBe("superseded");
    await expect(
      f.client.goals.control({
        session_id: "conversation",
        expected_revision: stopped.state.revision,
        operation_id: "late-edit",
        action: {
          kind: "edit",
          resume_operation_id: pending.operation_id,
          limits: { max_net_tokens: 2000000 },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await f.client.goals.get("conversation")).state).toEqual(stopped.state);
    f.setResponder(async () => ({ text: "Independent work remains available" }));
    const run = await f.client.hosting!.start({
      session_id: "conversation",
      session_revision: 0,
      kind: "conversation",
      user_preview: "Do another task",
      params: {
        execution_id: "fenced-independent",
        agent: "solo",
        intent: "operator",
        messages: [{ role: "user", content: "Do another task" }],
      },
    });
    expect(await run.handle.done).toMatchObject({ status: "completed" });
    await run.handle.closed;
    expect(f.requests).toHaveLength(kind === "replace" ? 3 : 2);
    expect((await f.client.goals.get("conversation")).state.current!.runs).toHaveLength(1);
  },
);

it.each(["complete", "cancelled"] as const)(
  "reopens a %s Goal through explicit host control without replacing its audit",
  async (terminal) => {
    const f = await createGoalFileHostFixture();
    cleanup.push(f.close);
    let step = 0;
    let independentMode = false;
    f.setResponder(async () => {
      step++;
      if (independentMode) return { text: "Independent turn after terminal Goal" };
      if (terminal === "complete" && step === 1)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Initial result complete",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "Controlled provider produced the initial result",
                },
              ],
            },
          },
        };
      if (terminal === "complete" && step === 2) return { text: "Initial result complete" };
      return {
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Resumed attempt retained" } },
      };
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: `terminal-create-${terminal}`,
      action: {
        kind: "create",
        objective: "Preserve the original objective and audit",
        limits: { max_net_tokens: 1000000 },
      },
    });
    await f.until(() => f.host.stats().runs === 0);
    let view = await f.client.goals.get("conversation");
    if (terminal === "complete") {
      expect(view.state.current!.status).toBe("complete");
    } else {
      await f.client.goals.control({
        session_id: "conversation",
        expected_revision: view.state.revision,
        operation_id: "terminal-cancel",
        action: { kind: "cancel" },
      });
      view = await f.client.goals.get("conversation");
      expect(view.state.current!.status).toBe("cancelled");
    }
    const before = structuredClone(view.state.current!);
    independentMode = true;
    const independent = await f.client.hosting!.start({
      session_id: "conversation",
      session_revision: 0,
      kind: "conversation",
      user_preview: "Answer independently after terminal Goal",
      params: {
        execution_id: `terminal-independent-${terminal}`,
        agent: "solo",
        intent: "operator",
        messages: [{ role: "user", content: "Answer independently after terminal Goal" }],
      },
    });
    expect(await independent.handle.done).toMatchObject({ status: "completed" });
    await independent.handle.closed;
    expect((await f.client.goals.get("conversation")).state.current).toEqual(before);
    independentMode = false;
    const receipt = await f.client.goals.control({
      session_id: "conversation",
      expected_revision: view.state.revision,
      operation_id: `terminal-resume-${terminal}`,
      action: { kind: "resume" },
    });
    expect(receipt.execution_id).toBeString();
    await f.until(() => f.host.stats().runs === 0);
    const after = (await f.client.goals.get("conversation")).state.current!;
    expect(after.goal_id).toBe(before.goal_id);
    expect(after.objective).toBe(before.objective);
    expect(after.criteria).toEqual(before.criteria);
    expect(after.runs.slice(0, before.runs.length)).toEqual(before.runs);
    expect(after.runs).toHaveLength(before.runs.length + 1);
    expect(after.runs.at(-1)).toMatchObject({
      execution_id: receipt.execution_id,
      phase: "closed",
    });
  },
);

it("contains cancellation during delegated Goal work and keeps later operator work available", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  const childEntered = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  cleanup.push(async () => releaseChild.resolve());
  let independent = false;
  f.setResponder(async (request) => {
    const leader = request.tools?.some((tool) => tool.function.name === "get_goal");
    if (independent) return { text: "Independent task completed after cancellation" };
    if (leader)
      return {
        name: "spawn_subagent",
        arguments: {
          title: "Interrupted child",
          task: "Inspect the controlled artifact until the parent stops",
          profile: "helper",
        },
      };
    childEntered.resolve();
    await releaseChild.promise;
    return {
      name: "write_file",
      arguments: { path: "must-not-exist.txt", content: "late child effect" },
    };
  });
  await f.client.goals.control({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "delegated-cancel-create",
    action: {
      kind: "create",
      objective: "Contain cancellation of delegated work",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await childEntered.promise;
  const running = await f.client.goals.get("conversation");
  await f.client.goals.control({
    session_id: "conversation",
    expected_revision: running.state.revision,
    operation_id: "delegated-cancel",
    action: { kind: "cancel" },
  });
  releaseChild.resolve();
  await f.until(() => f.host.stats().runs === 0);
  const cancelled = (await f.client.goals.get("conversation")).state.current!;
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.runs).toHaveLength(1);
  expect(cancelled.runs[0]).toMatchObject({ phase: "closed", outcome: "cancelled" });
  expect(cancelled.runs[0]!.checkpoint).toBeUndefined();
  await expect(readFile(join(f.workspaceRoot, "must-not-exist.txt"), "utf8")).rejects.toMatchObject(
    {
      code: "ENOENT",
    },
  );
  independent = true;
  const run = await f.client.hosting!.start({
    session_id: "conversation",
    session_revision: 0,
    kind: "conversation",
    user_preview: "Do independent work",
    params: {
      execution_id: "after-delegated-cancel",
      agent: "solo",
      intent: "operator",
      messages: [{ role: "user", content: "Do independent work" }],
    },
  });
  expect(await run.handle.done).toMatchObject({ status: "completed" });
  await run.handle.closed;
  expect((await f.client.goals.get("conversation")).state.current!.runs).toHaveLength(1);
});

it("single-flights concurrent manual resumes into one successor execution", async () => {
  const f = await createGoalFileHostFixture();
  cleanup.push(f.close);
  f.setResponder(async () => ({
    name: "update_goal",
    arguments: { update: { action: "blocked", reason: "Controlled boundary" } },
  }));
  await f.client.goals.control({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "concurrent-create",
    action: {
      kind: "create",
      objective: "Admit exactly one resumed attempt",
      limits: { max_net_tokens: 1000000 },
    },
  });
  await f.until(() => f.host.stats().runs === 0);
  const view = await f.client.goals.get("conversation");
  const request = {
    session_id: "conversation",
    expected_revision: view.state.revision,
    operation_id: "concurrent-resume",
    action: { kind: "resume" as const },
  };
  const receipts = await Promise.all(
    Array.from({ length: 4 }, () => f.client.goals.control(request)),
  );
  const executionId = receipts[0]?.execution_id;
  if (executionId === undefined) throw new Error("Concurrent resume did not reserve an execution");
  expect(new Set(receipts.map((receipt) => receipt.execution_id)).size).toBe(1);
  expect(receipts.every((receipt) => receipt.operation_id === request.operation_id)).toBe(true);
  await f.until(() => f.host.stats().runs === 0);
  expect(f.requests).toHaveLength(2);
  const after = (await f.client.goals.get("conversation")).state.current!;
  expect(after.runs).toHaveLength(2);
  expect(after.runs[1]!.execution_id).toBe(executionId);
});
