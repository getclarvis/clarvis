import { describe, expect, it } from "bun:test";
import { createStewardInput } from "../../src/goals/steward-input.ts";

describe("createStewardInput", () => {
  it("evicts the oldest events once the retained window is full", () => {
    const input = createStewardInput(
      Array.from({ length: 129 }, (_, index) => `operator message ${String(index)}`),
    );
    const snapshot = input.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.events).toHaveLength(128);
    expect(snapshot.events[0]?.text).toBe("operator message 1");
  });

  it("records an accepted lead elicitation as a bounded dialogue turn", () => {
    const input = createStewardInput(["Build it"]);
    input.observe({
      type: "user_question",
      agent: "lead",
      iteration_ref: 1,
      occurred_at: 2,
      question: "Did addition work?",
      outcome: "accept",
      answer: "Yes in the browser",
    });
    expect(input.snapshot().events.at(-1)).toMatchObject({
      actor: "elicitation",
      text: "Yes in the browser",
    });
  });
});
