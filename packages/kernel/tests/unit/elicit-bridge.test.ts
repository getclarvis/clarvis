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
