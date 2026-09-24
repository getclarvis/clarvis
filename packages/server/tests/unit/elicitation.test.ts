import { describe, expect, it } from "bun:test";
import type { ElicitationRequest, ElicitationResponse, RunHandle } from "@clarvis/protocol";
import { createElicitationController, resolvePosture } from "../../src/mcp/elicitation.ts";
import { createManualTimeouts } from "../helpers/manual-timeouts.ts";
import { recordingLoggers } from "../helpers/harness.ts";

const ASK = {
  id: "q1",
  kind: "ask_user" as const,
  prompt: "Which environment?",
  schema: { type: "object", properties: { answer: { type: "string" } } },
};

/** A contract-only RunHandle containing exactly the controller's two ports. */
function fakeHandle(executionId: string): {
  handle: RunHandle;
  responses: ElicitationResponse[];
  raise: (request: Omit<ElicitationRequest, "execution_id">) => void;
} {
  const handlers: ((request: ElicitationRequest) => void)[] = [];
  const responses: ElicitationResponse[] = [];
  const handle: RunHandle = {
    execution_id: executionId,
    events: { [Symbol.asyncIterator]: async function* () {} },
    steer: () => Promise.resolve(),
    compact: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    interruptTool: (toolExecutionId) =>
      Promise.resolve({ tool_execution_id: toolExecutionId, status: "not_running" }),
    respond: (response) => {
      responses.push(response);
      return Promise.resolve();
    },
    onElicit: (handler) => {
      handlers.push(handler);
    },
    done: Promise.resolve({ execution_id: executionId, status: "completed" }),
    closed: Promise.resolve(),
  };
  return {
    handle,
    responses,
    raise: (request) => {
      const full: ElicitationRequest = { ...request, execution_id: executionId };
      for (const handler of handlers) handler(full);
    },
  };
}

describe("resolvePosture", () => {
  it("derives relay, tool and auto-decline from the declared channel and request", () => {
    expect(
      resolvePosture({
        clientDeclaresElicitation: true,
        requested: "auto_decline",
      }).elicitation,
    ).toBe("relay");
    expect(
      resolvePosture({
        clientDeclaresElicitation: false,
        requested: "await",
      }).elicitation,
    ).toBe("tool");
    expect(
      resolvePosture({
        clientDeclaresElicitation: false,
        requested: "auto_decline",
      }).elicitation,
    ).toBe("auto_decline");
  });

  it("downgrades plans:review only when no answer channel exists", () => {
    const declined = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "auto_decline",
      requestedPlans: "review",
    });
    expect(declined.plans_effective).toBe("on");
    expect(declined.downgrades.join(" ")).toContain("plans:review");

    expect(
      resolvePosture({
        clientDeclaresElicitation: true,
        requested: "await",
        requestedPlans: "review",
      }).plans_effective,
    ).toBe("review");
  });

  it("pins the short prompt-cache lifetime only for auto-decline", () => {
    const declined = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "auto_decline",
    });
    expect(declined.prompt_cache_ttl).toBe("5m");
    expect(declined.downgrades.some((note) => note.includes("prompt_cache_ttl"))).toBe(true);

    const viaTool = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "await",
    });
    const viaRelay = resolvePosture({
      clientDeclaresElicitation: true,
      requested: "await",
    });
    expect(viaTool.prompt_cache_ttl).toBeUndefined();
    expect(viaRelay.prompt_cache_ttl).toBeUndefined();
  });
});

describe("ElicitationController", () => {
  it("declines a tool question exactly when its injected deadline fires", () => {
    const timeouts = createManualTimeouts();
    const posture = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "await",
    });
    const controller = createElicitationController({
      posture,
      publish: () => {},
      toolWaitMs: 30,
      relayWaitMs: 5_000,
      scheduleTimeout: timeouts.schedule,
    });
    const { handle, responses, raise } = fakeHandle("r1");
    controller.attach(handle);

    raise(ASK);
    expect(responses).toHaveLength(0);
    expect(timeouts.pending).toBe(1);

    timeouts.fireNext();
    expect(responses).toEqual([{ id: "q1", action: "decline" }]);
    expect(posture.auto_answered).toBe(1);
  });

  it("dispose force-declines every pending question and counts each answer", () => {
    const posture = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "await",
    });
    const controller = createElicitationController({
      posture,
      publish: () => {},
      toolWaitMs: 60_000,
      relayWaitMs: 60_000,
    });
    const { handle, responses, raise } = fakeHandle("r1");
    controller.attach(handle);

    raise(ASK);
    raise({ ...ASK, id: "q2" });
    controller.dispose();

    expect(responses.map(({ id, action }) => ({ id, action }))).toEqual([
      { id: "q1", action: "decline" },
      { id: "q2", action: "decline" },
    ]);
    expect(posture.auto_answered).toBe(2);
  });

  it("dispose is idempotent and never re-answers an already settled question", () => {
    const posture = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "await",
    });
    const controller = createElicitationController({
      posture,
      publish: () => {},
      toolWaitMs: 60_000,
      relayWaitMs: 60_000,
    });
    const { handle, responses, raise } = fakeHandle("r1");
    controller.attach(handle);

    raise(ASK);
    expect(controller.respond({ id: "q1", action: "accept", content: { answer: "x" } })).toEqual({
      accepted: true,
    });
    controller.dispose();
    controller.dispose();

    expect(responses).toHaveLength(1);
    expect(posture.auto_answered).toBe(0);
  });

  it("records who answered a question, and whether the facade answered it", () => {
    const logs = recordingLoggers();
    const posture = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "await",
    });
    const controller = createElicitationController({
      posture,
      publish: () => {},
      toolWaitMs: 60_000,
      relayWaitMs: 60_000,
      logger: logs.loggers.log,
    });
    const { handle, raise } = fakeHandle("r1");
    controller.attach(handle);

    raise(ASK);
    controller.respond({ id: "q1", action: "accept", content: { answer: "x" } });
    raise({ ...ASK, id: "q2" });
    controller.dispose();

    const answered = logs.find("elicit.answered");
    expect(answered).toHaveLength(2);
    expect(answered.every((record) => record.level === "debug")).toBe(true);
    expect(answered[0]?.fields).toMatchObject({ posture: "tool", action: "accept", auto: false });
    expect(answered[1]?.fields).toMatchObject({ posture: "tool", action: "decline", auto: true });
  });

  it("records a relayed answer as the client's, not the facade's", async () => {
    const logs = recordingLoggers();
    const posture = resolvePosture({
      clientDeclaresElicitation: true,
      requested: "await",
    });
    const controller = createElicitationController({
      posture,
      publish: () => {},
      sendRequest: () => Promise.resolve({ action: "accept" as const }),
      toolWaitMs: 60_000,
      relayWaitMs: 60_000,
      logger: logs.loggers.log,
    });
    const { handle, raise } = fakeHandle("r1");
    controller.attach(handle);

    raise(ASK);
    for (let attempt = 0; attempt < 8 && logs.find("elicit.answered").length === 0; attempt += 1)
      await Promise.resolve();

    expect(logs.one("elicit.answered").fields).toMatchObject({
      posture: "relay",
      action: "accept",
      auto: false,
    });
  });
});
