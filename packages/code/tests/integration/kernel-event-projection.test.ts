import { expect, test } from "bun:test";
import { engineEventToProto, type TraceEvent } from "@clarvis/kernel/policy";
import { applyEvent, createTranscriptStore } from "../../src/adapters/store.ts";

test("the kernel projection feeds one engine iteration through code's protocol seam", () => {
  const engineEvent: TraceEvent = {
    type: "lead_iteration",
    iteration: 2,
    started_at: 10,
    ended_at: 30,
    model: "m",
    input_tokens: 100,
    output_tokens: 50,
    cached_tokens: 0,
    cache_write_tokens: 0,
    cache_read_ratio: 0,
    response: "wire-visible answer",
  };
  const protocolEvent = engineEventToProto(engineEvent);
  expect(protocolEvent).toMatchObject({
    type: "iteration_completed",
    at: 30,
    agent: "lead",
    response: "wire-visible answer",
  });
  if (protocolEvent === null) throw new Error("the representative engine event must project");

  const store = createTranscriptStore();
  applyEvent(store.openRun("exec_projection"), protocolEvent, "live");
  expect(store.nodes).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      text: "wire-visible answer",
      model: "m",
    }),
  );
});
