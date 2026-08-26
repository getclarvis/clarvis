import { describe, it, expect } from "../bun-test.ts";
import { buildElicitRelay } from "../../src/runtime/elicit-relay.ts";
import {
  ElicitTimeoutError,
  type Elicit,
  type ElicitRawResult,
} from "../../src/runtime/tools/ask-user-tool.ts";
import { createTrace } from "@clarvis/trace";
import type { ClockHolder } from "@clarvis/capability";
import type { TraceEntry } from "@clarvis/capability";

function build(elicit: Elicit): {
  relay: NonNullable<ReturnType<typeof buildElicitRelay>["relay"]>;
  entries: () => TraceEntry[];
} {
  const trace = createTrace(0);
  const clockHolder: ClockHolder = {};
  const { relay } = buildElicitRelay({
    elicit,
    clockHolder,
    trace,
    enabled: true,
    elicitWaitMs: 1000,
  });
  if (relay === undefined) throw new Error("expected a relay to be built");
  return { relay, entries: trace.entries };
}

describe("buildElicitRelay — relay.handle", () => {
  it("maps an ElicitTimeoutError from elicit to a silent decline", async () => {
    const { relay, entries } = build(async () => {
      throw new ElicitTimeoutError();
    });

    const result = await relay.handle({ message: "Proceed?" }, undefined);

    expect(result).toEqual({ action: "decline" });
    const requested = entries().find((e) => e.kind === "elicitation_requested");
    expect(requested).toBeDefined();
    expect((requested!.detail as { question: string }).question).toBe("Proceed?");
  });

  it("re-throws a non-timeout error from elicit instead of declining", async () => {
    const { relay } = build(async () => {
      throw new Error("transport exploded");
    });

    await expect(relay.handle({ message: "Proceed?" }, undefined)).rejects.toThrow(
      "transport exploded",
    );
  });

  it("passes an accepted elicitation result through unchanged", async () => {
    const raw: ElicitRawResult = { action: "accept", content: { response: "yes" } };
    const { relay } = build(async () => raw);

    const result = await relay.handle({ message: "Proceed?" }, undefined);

    expect(result).toEqual({ action: "accept", content: { response: "yes" } });
  });

  it("does not build a relay when elicitation is disabled", () => {
    const { relay } = buildElicitRelay({
      elicit: async () => ({ action: "accept" }),
      clockHolder: {},
      trace: createTrace(0),
      enabled: false,
      elicitWaitMs: 1000,
    });
    expect(relay).toBeUndefined();
  });
});
