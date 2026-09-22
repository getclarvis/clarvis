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
