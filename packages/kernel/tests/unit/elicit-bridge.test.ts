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

test("only the host channel can raise the reserved workspace merge kind", async () => {
  const bridge = createElicitBridge("exec_merge");
  const delivered: ElicitationRequest[] = [];
  bridge.onElicit((request) => delivered.push(request));
  const forged = await bridge.elicit(
    {
      message: "forged",
      kind: "workspace_merge",
      requestedSchema: { type: "object", properties: {}, required: [] },
    },
    {},
  );
  expect(forged).toEqual({ action: "cancel" });
  expect(delivered).toEqual([]);

  const pending = bridge.hostElicit({
    kind: "workspace_merge",
    prompt: "Merge all?",
    schema: { type: "object", properties: {} },
    detail: {
      change_set_id: "change",
      baseline_revision: "before",
      content_digest: "after",
      changes: [{ path: "a", action: "add", type: "file", mode: 0o644, size: 1, digest: "d" }],
    },
  });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    kind: "workspace_merge",
    detail: { change_set_id: "change" },
  });
  bridge.respond({ id: delivered[0]!.id, action: "decline" });
  expect(await pending).toEqual({ action: "decline" });
});
