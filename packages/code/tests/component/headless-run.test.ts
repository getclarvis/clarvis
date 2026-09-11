import { expect, test } from "bun:test";
import type { RunEvent, Session, StartHostedTurnParams } from "@clarvis/protocol";
import { startHeadlessRun } from "../../src/adapters/headless-run.ts";
import { hostedAttachment, hostedRef, hostingFixture } from "../helpers/hosted-run.ts";

function fixture() {
  const f = hostingFixture();
  f.service.acknowledge = async () => {
    f.calls.push("acknowledge");
  };
  const writes: Session[] = [];
  const starts: StartHostedTurnParams[] = [];
  let ordinary = 0;
  const attachment = hostedAttachment();
  const kernel: Parameters<typeof startHeadlessRun>[0] = {
    hosting: f.service,
    project: { id: "prj_test" },
    workspace: { id: "ws_test", projectId: "prj_test", kind: "primary", label: "test" },
    sessions: {
      save: async (session) => {
        writes.push(session);
      },
      get: async () => (writes.length === 0 ? null : { ...writes[0]!, revision: 1 }),
    },
    runs: {
      start: async () => {
        ordinary++;
        throw new Error("unexpected ordinary run admission");
      },
    },
  };
  f.service.start = async (input) => {
    starts.push(input);
    return attachment;
  };
  return { ...f, kernel, attachment, writes, starts, ordinary: () => ordinary };
}

const params = {
  execution_id: "exec_background",
  agent: "ronin",
  messages: [{ role: "user" as const, content: "the exact prompt" }],
};

test("headless admission confirms an empty conversation before starting once through hosting", async () => {
  const f = fixture();
  await startHeadlessRun(f.kernel, params, "the exact prompt");
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({
    revision: 0,
    turns: [],
    agent_profile: "ronin",
    workspace: "ws_test",
  });
  expect(f.starts).toEqual([
    {
      session_id: f.writes[0]!.id,
      session_revision: 1,
      kind: "conversation",
      user_preview: "the exact prompt",
      params,
    },
  ]);
  expect(f.ordinary()).toBe(0);
});

test("a rejected hosted start is never retried through ordinary runs", async () => {
  const f = fixture();
  f.service.start = async () => {
    throw new Error("admission conflict");
  };
  await expect(startHeadlessRun(f.kernel, params, "the exact prompt")).rejects.toThrow(
    "admission conflict",
  );
  expect(f.ordinary()).toBe(0);
});

test("missing canonical revision prevents inference and redacts persisted prompt previews", async () => {
  const f = fixture();
  f.kernel.sessions.get = async () => null;
  await expect(
    startHeadlessRun(f.kernel, params, "api_key=secret_example_12345678901234567890"),
  ).rejects.toThrow("revision");
  expect(f.starts).toEqual([]);
  expect(f.writes[0]!.title).not.toContain("secret_example");
});

test("headless events include the immutable prefix before the live tail and keep physical closure", async () => {
  const f = fixture();
  const first: RunEvent = { type: "run_started", at: 1, lead_model: "test/model" };
  const second: RunEvent = {
    type: "iteration_started",
    at: 2,
    agent: "lead",
    iteration: 1,
    model: "test/model",
  };
  const bytes = Buffer.from(
    JSON.stringify({ first_sequence: 1, last_sequence: 1, event: first }) + "\n",
  );
  const physical = Promise.withResolvers<void>();
  f.attachment.snapshot.bytes = bytes.length;
  f.attachment.snapshot.cursor.sequence = 1;
  f.attachment.handle = {
    ...f.attachment.handle,
    closed: physical.promise,
    events: {
      async *[Symbol.asyncIterator]() {
        yield { first_sequence: 2, last_sequence: 2, event: second };
      },
    },
  };
  f.service.readSnapshot = async (snapshot_id, offset) => ({
    snapshot_id,
    offset,
    data_base64: bytes.toString("base64"),
  });
  const handle = await startHeadlessRun(f.kernel, params, "prompt");
  const events = [];
  for await (const event of handle.events) events.push(event);
  expect(events).toEqual([first, second]);
  expect(f.calls).toEqual(["snapshot.release"]);
  expect(await handle.done).toMatchObject({
    execution_id: hostedRef().execution_id,
    status: "completed",
  });
  let settled = false;
  void handle.closed.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  physical.resolve();
  await handle.closed;
  expect(f.calls).toEqual(["snapshot.release", "acknowledge", "observation.release"]);
});

test("abandoned print consumption retains its result for later inspection", async () => {
  const f = fixture();
  f.attachment.handle = {
    ...f.attachment.handle,
    events: {
      async *[Symbol.asyncIterator]() {
        yield {
          first_sequence: 1,
          last_sequence: 1,
          event: { type: "run_started", at: 1, lead_model: "test/model" },
        };
        throw new Error("observer failure");
      },
    },
  };
  const handle = await startHeadlessRun(f.kernel, params, "prompt");
  const failure = handle.closed.catch((error: unknown) => error);
  for await (const event of handle.events) {
    expect(event.type).toBe("run_started");
    break;
  }
  expect(await failure).toMatchObject({ message: "Headless observation was not fully consumed." });
  expect(f.calls).toEqual(["snapshot.release", "observation.release"]);
});
