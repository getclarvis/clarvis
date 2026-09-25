import { expect, test } from "bun:test";
import type { ElicitParams } from "@clarvis/capability";
import type { ElicitationRequest } from "@clarvis/protocol";
import {
  createElicitBridge,
  MAX_ELICIT_WINDOW_MS,
  type ElicitWindowRuntime,
} from "../../src/runs/elicit-bridge.ts";

/** Controllable monotonic clock and scheduler, so no test waits on wall time. */
function fakeWindowRuntime(): {
  runtime: ElicitWindowRuntime;
  advance(ms: number): void;
  scheduled(): number;
} {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; task: () => void }>();
  return {
    runtime: {
      now: () => now,
      schedule(task, delayMs) {
        const id = next++;
        timers.set(id, { at: now + delayMs, task });
        return { cancel: () => void timers.delete(id) };
      },
    } satisfies ElicitWindowRuntime,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.task();
        }
      }
    },
    scheduled: () => timers.size,
  };
}

/** The engine's own question: provenance and naming both come from the tool. */
function modelAskUser(): ElicitParams {
  return {
    message: "Which option?",
    kind: "ask_user",
    origin: "model",
    requestedSchema: { type: "object", properties: {}, required: [] },
  };
}

test("the model's presented question receives a single deadline and expires as windowElapsed", async () => {
  const clock = fakeWindowRuntime();
  const bridge = createElicitBridge("exec_window", {
    policy: { ask_user_window_ms: 30_000 },
    runtime: clock.runtime,
  });
  const result = bridge.elicit(modelAskUser(), {});
  let request: ElicitationRequest | undefined;
  bridge.onElicit((value) => {
    request = value;
  });

  expect(request?.window_ms).toBe(30_000);
  clock.advance(30_000);
  expect(clock.scheduled()).toBe(0);
  expect(await Promise.race([result, Promise.resolve("still pending" as const)])).toBe(
    "still pending",
  );

  const confirmation = bridge.present({ id: request!.id, presenter: "tui-1" });
  expect(confirmation).toEqual({ accepted: true, remaining_ms: 30_000 });

  clock.advance(29_999);
  expect(await Promise.race([result, Promise.resolve("still pending" as const)])).toBe(
    "still pending",
  );
  clock.advance(1);
  expect(await result).toEqual({ action: "decline", windowElapsed: true });
});

test("presentation is idempotent and never restarts the deadline", async () => {
  const clock = fakeWindowRuntime();
  const bridge = createElicitBridge("exec_present", {
    policy: { ask_user_window_ms: 30_000 },
    runtime: clock.runtime,
  });
  const result = bridge.elicit(modelAskUser(), {});
  const ids: string[] = [];
  bridge.onElicit((request) => ids.push(request.id));

  expect(bridge.present({ id: ids[0]!, presenter: "tui-1" })).toEqual({
    accepted: true,
    remaining_ms: 30_000,
  });
  clock.advance(10_000);
  expect(bridge.present({ id: ids[0]!, presenter: "tui-1" })).toEqual({
    accepted: true,
    remaining_ms: 20_000,
  });
  expect(bridge.present({ id: ids[0]!, presenter: "tui-reconnected" })).toEqual({
    accepted: true,
    remaining_ms: 20_000,
  });
  expect(clock.scheduled()).toBe(1);

  clock.advance(20_000);
  expect(await result).toEqual({ action: "decline", windowElapsed: true });
  expect(bridge.present({ id: ids[0]!, presenter: "tui-late" })).toEqual({ accepted: false });
});

test("an answer before the deadline wins and a late answer is ignored", async () => {
  const clock = fakeWindowRuntime();
  const bridge = createElicitBridge("exec_answer", {
    policy: { ask_user_window_ms: 30_000 },
    runtime: clock.runtime,
  });
  const answered = bridge.elicit(modelAskUser(), {});
  const late = bridge.elicit(modelAskUser(), {});
  const ids: string[] = [];
  bridge.onElicit((request) => ids.push(request.id));
  bridge.present({ id: ids[0]!, presenter: "tui-1" });
  bridge.present({ id: ids[1]!, presenter: "tui-1" });

  clock.advance(5_000);
  bridge.respond({ id: ids[0]!, action: "accept", content: { choice: "b" } });
  expect(await answered).toEqual({ action: "accept", content: { choice: "b" } });
  expect(clock.scheduled()).toBe(1);

  clock.advance(25_000);
  expect(await late).toEqual({ action: "decline", windowElapsed: true });
  bridge.respond({ id: ids[1]!, action: "accept", content: { choice: "a" } });
  expect(clock.scheduled()).toBe(0);
});

test("a human cancellation before the deadline retires the window timer", async () => {
  const clock = fakeWindowRuntime();
  const bridge = createElicitBridge("exec_cancel", {
    policy: { ask_user_window_ms: 30_000 },
    runtime: clock.runtime,
  });
  const controller = new AbortController();
  const result = bridge.elicit(modelAskUser(), { signal: controller.signal });
  const ids: string[] = [];
  bridge.onElicit((request) => ids.push(request.id));
  bridge.present({ id: ids[0]!, presenter: "tui-1" });
  controller.abort();

  expect(await result).toEqual({ action: "cancel" });
  expect(clock.scheduled()).toBe(0);
  clock.advance(60_000);
  expect(bridge.present({ id: ids[0]!, presenter: "tui-1" })).toEqual({ accepted: false });
});

test("a question nobody presented never expires on its own", async () => {
  const clock = fakeWindowRuntime();
  const bridge = createElicitBridge("exec_unpresented", {
    policy: { ask_user_window_ms: 30_000 },
    runtime: clock.runtime,
  });
  const result = bridge.elicit(modelAskUser(), {});
  bridge.onElicit(() => {});

  clock.advance(10 * 60_000);
  expect(clock.scheduled()).toBe(0);
  expect(await Promise.race([result, Promise.resolve("still pending" as const)])).toBe(
    "still pending",
  );
  bridge.close();
  expect(await result).toEqual({ action: "cancel" });
});

test("only the model's own ask_user receives a window; provenance and naming are both required", async () => {
  const clock = fakeWindowRuntime();
  const bridge = createElicitBridge("exec_provenance", {
    policy: { ask_user_window_ms: 30_000 },
    runtime: clock.runtime,
  });
  const cases: ElicitParams[] = [
    { ...modelAskUser(), origin: "external" },
    { ...modelAskUser(), origin: undefined },
    { ...modelAskUser(), kind: "custom_review" },
    { ...modelAskUser(), kind: undefined },
  ];
  const results = cases.map((params) => bridge.elicit(params, {}));
  const requests: ElicitationRequest[] = [];
  bridge.onElicit((request) => requests.push(request));

  expect(requests.map((request) => request.window_ms)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(requests.map((request) => request.kind)).toEqual([
    "ask_user",
    "ask_user",
    "custom_review",
    "ask_user",
  ]);
  for (const request of requests) {
    expect(bridge.present({ id: request.id, presenter: "tui-1" })).toEqual({ accepted: true });
  }
  clock.advance(10 * 60_000);
  expect(clock.scheduled()).toBe(0);
  expect(
    (
      await Promise.all(results.map((result) => Promise.race([result, Promise.resolve(null)])))
    ).every((answer) => answer === null),
  ).toBe(true);
  bridge.close();
});

test("a policy without a representable positive window publishes none and schedules nothing", async () => {
  const clock = fakeWindowRuntime();
  for (const ask_user_window_ms of [
    0,
    -1,
    1.5,
    Number.NaN,
    MAX_ELICIT_WINDOW_MS + 1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 2,
  ]) {
    const bridge = createElicitBridge(`exec_invalid_${String(ask_user_window_ms)}`, {
      policy: { ask_user_window_ms },
      runtime: clock.runtime,
    });
    const result = bridge.elicit(modelAskUser(), {});
    const requests: ElicitationRequest[] = [];
    bridge.onElicit((request) => requests.push(request));
    expect(requests[0]?.window_ms).toBeUndefined();
    expect(bridge.present({ id: requests[0]!.id, presenter: "tui-1" })).toEqual({
      accepted: true,
    });
    expect(clock.scheduled()).toBe(0);
    bridge.close();
    expect(await result).toEqual({ action: "cancel" });
  }
});

test("the longest representable window is granted, so the ceiling is honored and not overshot", async () => {
  const clock = fakeWindowRuntime();
  const bridge = createElicitBridge("exec_ceiling", {
    policy: { ask_user_window_ms: MAX_ELICIT_WINDOW_MS },
    runtime: clock.runtime,
  });
  const result = bridge.elicit(modelAskUser(), {});
  const requests: ElicitationRequest[] = [];
  bridge.onElicit((request) => requests.push(request));

  expect(requests[0]?.window_ms).toBe(MAX_ELICIT_WINDOW_MS);
  expect(bridge.present({ id: requests[0]!.id, presenter: "tui-1" })).toEqual({
    accepted: true,
    remaining_ms: MAX_ELICIT_WINDOW_MS,
  });
  expect(clock.scheduled()).toBe(1);

  clock.advance(MAX_ELICIT_WINDOW_MS);
  expect(await result).toEqual({ action: "decline", windowElapsed: true });
});

test("an elicitation raised before onElicit registration is delivered when the handler attaches", async () => {
  const bridge = createElicitBridge("exec_early");
  const result = bridge.elicit(
    { message: "Approve?", requestedSchema: { type: "object", properties: {}, required: [] } },
    {},
  );
  let request: ElicitationRequest | undefined;

  bridge.onElicit((value) => {
    request = value;
  });

  expect(request?.prompt).toBe("Approve?");
  bridge.respond({ id: request!.id, action: "accept", content: { answer: "yes" } });
  expect(await result).toEqual({ action: "accept", content: { answer: "yes" } });
});

test("an aborted pending elicitation resolves as a cancellation", async () => {
  const bridge = createElicitBridge("exec_abort");
  const controller = new AbortController();
  const result = bridge.elicit(
    {
      message: "Still there?",
      requestedSchema: { type: "object", properties: {}, required: [] },
    },
    { signal: controller.signal },
  );
  controller.abort();
  expect(await result).toEqual({ action: "cancel" });
});

test("pre-aborted and retired bridges publish no question", async () => {
  const bridge = createElicitBridge("retired");
  const seen: string[] = [];
  bridge.onElicit((request) => seen.push(request.id));
  const params = {
    message: "Approve?",
    requestedSchema: { type: "object" as const, properties: {}, required: [] },
  };
  expect(await bridge.elicit(params, { signal: AbortSignal.abort() })).toEqual({
    action: "cancel",
  });
  bridge.close();
  expect(await bridge.elicit(params, {})).toEqual({ action: "cancel" });
  expect(seen).toEqual([]);
});

test("settlement retires pending questions once and subscriptions can be removed", async () => {
  const bridge = createElicitBridge("settlement");
  const params = {
    message: "Approve?",
    requestedSchema: { type: "object" as const, properties: {}, required: [] },
  };
  const controller = new AbortController();
  const answered = bridge.elicit(params, {});
  const aborted = bridge.elicit(params, { signal: controller.signal });
  const ids: string[] = [];
  const closed: string[] = [];
  const off = bridge.onElicit((request) => ids.push(request.id));
  const stop = bridge.onSettled((id) => closed.push(id));
  bridge.respond({ id: ids[0]!, action: "accept" });
  bridge.respond({ id: ids[0]!, action: "decline" });
  controller.abort();
  expect(await answered).toEqual({ action: "accept" });
  expect(await aborted).toEqual({ action: "cancel" });
  expect(closed).toEqual(ids);
  off();
  stop();
  const final = bridge.elicit(params, {});
  expect(ids).toHaveLength(2);
  const remaining: string[] = [];
  bridge.onElicit((request) => remaining.push(request.id));
  expect(remaining).toHaveLength(1);
  bridge.close();
  expect(await final).toEqual({ action: "cancel" });
  expect(closed).toHaveLength(2);
});

test("synchronous observer cancellation cannot leave a pending question behind", async () => {
  const bridge = createElicitBridge("synchronous");
  const controller = new AbortController();
  bridge.onElicit(() => controller.abort());
  let stale = 0;
  bridge.onElicit(() => {
    stale++;
  });
  expect(
    await bridge.elicit(
      { message: "Approve?", requestedSchema: { type: "object", properties: {}, required: [] } },
      { signal: controller.signal },
    ),
  ).toEqual({ action: "cancel" });
  expect(stale).toBe(0);
});

test("pending question and observer budgets do not discard already admitted work", async () => {
  const bridge = createElicitBridge("bounded");
  const params = {
    message: "Approve?",
    requestedSchema: { type: "object" as const, properties: {}, required: [] },
  };
  const waits = Array.from({ length: 64 }, () => bridge.elicit(params, {}));
  await expect(bridge.elicit(params, {})).rejects.toThrow("budget");
  const seen: string[] = [];
  bridge.onElicit((request) => seen.push(request.id));
  expect(seen).toHaveLength(64);
  bridge.close();
  expect((await Promise.all(waits)).every((answer) => answer.action === "cancel")).toBe(true);
  const observed = createElicitBridge("observers");
  const off = Array.from({ length: 16 }, () => observed.onElicit(() => {}));
  expect(() => observed.onElicit(() => {})).toThrow("observers");
  off[0]!();
  observed.onElicit(() => {});
  observed.close();
});
