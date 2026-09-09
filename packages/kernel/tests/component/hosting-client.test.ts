import { describe, expect, test } from "bun:test";
import { NOOP_LOGGER } from "@clarvis/capability";
import type { ElicitationRequest, KernelTransport, RunEvent } from "@clarvis/protocol";
import { createHostingClient } from "../../src/transport/hosting-client.ts";
import type {
  HostedAttachmentReply,
  HostedObservationNote,
} from "../../src/transport/hosting-codec.ts";
import { M, N } from "../../src/transport/wire.ts";

function fixture() {
  let notify: ((value: unknown) => void) | undefined;
  let subscriptionId = "";
  const admission = Promise.withResolvers<HostedAttachmentReply>();
  const calls: string[] = [];
  const violations: string[] = [];
  const transport: KernelTransport = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push(method);
      if (method === M.hostingAttach) {
        subscriptionId = (params as { subscription_id: string }).subscription_id;
        return (await admission.promise) as T;
      }
      return undefined as T;
    },
    notify() {},
    onNotification(method, callback) {
      expect(method).toBe(N.hostedObservation);
      notify = callback;
      return () => {
        notify = undefined;
      };
    },
    close: async () => {},
  };
  const client = createHostingClient({
    transport,
    generation: "generation",
    workspaceId: "workspace",
    logger: NOOP_LOGGER,
    protocolViolation(message) {
      violations.push(message);
      client.close(new Error(message));
    },
  });
  const attach = () =>
    client.service.attach({
      execution_id: "run",
      host_generation: "generation",
      control: "observe",
    });
  const admit = (pending: ElicitationRequest[] = [], generation = "generation") =>
    admission.resolve({
      subscription_id: subscriptionId,
      observation_id: "observation",
      run: {
        execution_id: "run",
        session_id: "session",
        host_generation: generation,
        workspace_id: "workspace",
        title: "Hosted run",
        config: { agent: "solo" },
        created_at: 1,
        updated_at: 1,
        revision: 1,
        disconnect_policy: "continue",
        execution_state: "running",
        attention: "none",
        control_epoch: 1,
        control: "available",
      },
      snapshot: {
        snapshot_id: "snapshot",
        bytes: 0,
        cursor: { host_generation: "generation", execution_id: "run", sequence: 0 },
      },
      pending_elicitations: pending,
    });
  const emit = (note: Omit<HostedObservationNote, "subscription_id">) =>
    notify?.({ subscription_id: subscriptionId, ...note });
  const event = (sequence: number, event: RunEvent) =>
    notify?.({
      subscription_id: subscriptionId,
      kind: "event",
      frame: { first_sequence: sequence, last_sequence: sequence, event },
    });
  const question = (id: string): ElicitationRequest => ({
    id,
    execution_id: "run",
    kind: "ask_user",
    prompt: "Choose how to continue",
  });
  return {
    client,
    calls,
    violations,
    attach,
    admit,
    emit,
    event,
    question,
    ask: (id: string, executionId = "run") =>
      notify?.({
        subscription_id: subscriptionId,
        kind: "elicitation",
        request: { ...question(id), execution_id: executionId },
      }),
  };
}

describe("hosted observation client budgets and retirement", () => {
  test.each([
    {
      id: "foreign",
      executionId: "another-run",
      message: "hosted elicitation belongs to a different execution",
    },
    { id: "", executionId: "run", message: "invalid hosted observation notification" },
  ])(
    "refuses a question outside its observation authority: $message",
    async ({ id, executionId, message }) => {
      const f = fixture();
      const attaching = f.attach();
      f.admit();
      const { handle } = await attaching;
      const questions: string[] = [];
      handle.onElicit((request) => questions.push(request.id));
      f.ask(id, executionId);
      await expect(handle.done).rejects.toMatchObject({ code: "unavailable" });
      expect(f.violations).toEqual([message]);
      expect(questions).toEqual([]);
      expect(f.calls).not.toContain(M.hostingRespond);
    },
  );

  test("a successful reply from the wrong generation cannot bind an attachment", async () => {
    const f = fixture();
    const attaching = f.attach();
    f.admit([], "retired-generation");
    await expect(attaching).rejects.toMatchObject({ code: "unavailable" });
    expect(f.violations).toEqual(["invalid hosted attachment identity or snapshot"]);
    expect(f.calls).not.toContain(M.hostingCancel);
  });

  test("remote tail coalescing preserves text and sequence without inventing an outcome at stream end", async () => {
    const f = fixture();
    const attaching = f.attach();
    f.admit();
    const { handle } = await attaching;
    for (let sequence = 1; sequence <= 1025; sequence++)
      f.event(sequence, {
        type: "text_delta",
        at: sequence,
        agent: "lead",
        iteration: 1,
        channel: "text",
        text: "x",
        reset: false,
      });
    f.emit({ kind: "end" });
    const frames = await Array.fromAsync(handle.events);
    expect(frames.map((frame) => (frame.event as { text: string }).text).join("")).toBe(
      "x".repeat(1025),
    );
    expect(frames[0]!.first_sequence).toBe(1);
    expect(frames.at(-1)!.last_sequence).toBe(1025);
    f.client.close();
    await expect(handle.done).rejects.toMatchObject({ code: "unavailable" });
    expect(f.calls).not.toContain(M.hostingCancel);
  });

  test("an early notification flood retires admission and releases a late successful observation", async () => {
    const f = fixture();
    const attaching = f.attach();
    const result = attaching.then(
      () => null,
      (error: unknown) => error,
    );
    for (let index = 0; index <= 1024; index++) f.emit({ kind: "end" });
    f.admit();
    expect(await result).toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("closed during admission"),
    });
    expect(f.calls.filter((method) => method === "hosting.releaseObservation")).toHaveLength(1);
    expect(f.calls).not.toContain(M.hostingCancel);
    f.client.close();
  });

  test("a stalled event reader is bounded and failure does not cancel the source execution", async () => {
    const f = fixture();
    const attaching = f.attach();
    f.admit();
    const { handle } = await attaching;
    for (let sequence = 1; sequence <= 1025; sequence++)
      f.event(sequence, { type: "run_started", at: sequence });
    await expect(handle.done).rejects.toMatchObject({ code: "resource_exhausted" });
    await handle.closed;
    expect(f.calls).not.toContain(M.hostingCancel);
    expect(handle.buffered!().buffered_items).toBeLessThanOrEqual(1024);
    await expect(handle.cancel()).rejects.toMatchObject({ code: "unavailable" });
    f.client.close();
  });

  test("pending question limits fail closed without answering an elicitation", async () => {
    const f = fixture();
    const attaching = f.attach();
    f.admit();
    const { handle } = await attaching;
    for (let index = 0; index <= 64; index++) f.ask(`question-${index}`);
    await expect(handle.done).rejects.toMatchObject({ code: "resource_exhausted" });
    await handle.closed;
    expect(f.calls).not.toContain(M.hostingRespond);
    expect(f.calls).not.toContain(M.hostingCancel);
    f.client.close();
  });

  test("bounded listeners replay pending questions and one faulty listener cannot suppress the others", async () => {
    const f = fixture();
    const attaching = f.attach();
    f.admit([f.question("initial")]);
    const { handle } = await attaching;
    const seen: string[] = [];
    const offFaulty = handle.onElicit(() => {
      throw new Error("broken renderer");
    });
    const offSeen = handle.onElicit((question) => seen.push(question.id));
    const offOthers = Array.from({ length: 14 }, () => handle.onElicit(() => {}));
    expect(() => handle.onElicit(() => {})).toThrow("listener limit");
    f.ask("later");
    expect(seen).toEqual(["initial", "later"]);
    offSeen?.();
    offFaulty?.();
    for (const off of offOthers) off?.();
    await f.client.service.releaseObservation("observation");
    await expect(handle.done).rejects.toMatchObject({ code: "unavailable" });
    handle.onElicit(() => {
      throw new Error("retired listener invoked");
    });
    f.client.close();
  });

  test("closure before the reconciled outcome rejects observation without fabricating a result", async () => {
    const f = fixture();
    const attaching = f.attach();
    f.admit();
    const { handle } = await attaching;
    f.emit({ kind: "closed" });
    await expect(handle.done).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("before outcome reconciliation"),
    });
    await handle.closed;
    expect(f.calls).not.toContain(M.hostingCancel);
    f.client.close();
    await expect(f.attach()).rejects.toMatchObject({ code: "unavailable" });
  });

  test("a tail sequence gap closes the connection instead of silently losing observation history", async () => {
    const f = fixture();
    const attaching = f.attach();
    f.admit();
    const { handle } = await attaching;
    f.event(2, { type: "run_started", at: 1 });
    await expect(handle.done).rejects.toMatchObject({ code: "unavailable" });
    expect(f.violations).toEqual(["hosted tail sequence is not contiguous with its snapshot"]);
    expect(f.calls).not.toContain(M.hostingRespond);
  });
});
