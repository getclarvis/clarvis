import { expect, test } from "bun:test";
import type { ElicitationRequest } from "@clarvis/protocol";
import type { GuardElicitParams } from "../../src/guard/guard-elicit.ts";
import { createElicitBridge } from "../../src/runs/elicit-bridge.ts";

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

test("structured guard detail rides the elicitation request to the client", async () => {
  const bridge = createElicitBridge("exec_guard");
  const params: GuardElicitParams = {
    message: "Approve?\n\n$ rm -rf build",
    kind: "guard_confirm",
    requestedSchema: { type: "object", properties: {}, required: [] },
    detail: { command: "rm -rf build", cwd: "/ws", reason: "Approve?" },
  };
  const result = bridge.elicit(params, {});
  let request: ElicitationRequest | undefined;
  bridge.onElicit((value) => {
    request = value;
  });

  expect(request?.detail).toEqual({ command: "rm -rf build", cwd: "/ws", reason: "Approve?" });
  bridge.respond({ id: request!.id, action: "accept", content: { decision: "allow" } });
  expect(await result).toEqual({ action: "accept", content: { decision: "allow" } });
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
