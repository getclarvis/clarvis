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
        allowRemoteGuardApproval: false,
      }).elicitation,
    ).toBe("relay");
    expect(
      resolvePosture({
        clientDeclaresElicitation: false,
        requested: "await",
        allowRemoteGuardApproval: false,
      }).elicitation,
    ).toBe("tool");
    expect(
      resolvePosture({
        clientDeclaresElicitation: false,
        requested: "auto_decline",
        allowRemoteGuardApproval: false,
      }).elicitation,
    ).toBe("auto_decline");
  });

  it("downgrades plans:review only when no answer channel exists", () => {
    const declined = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "auto_decline",
      requestedPlans: "review",
      allowRemoteGuardApproval: false,
    });
    expect(declined.plans_effective).toBe("on");
    expect(declined.downgrades.join(" ")).toContain("plans:review");

    expect(
      resolvePosture({
        clientDeclaresElicitation: true,
        requested: "await",
        requestedPlans: "review",
        allowRemoteGuardApproval: false,
      }).plans_effective,
    ).toBe("review");
  });

  it("relays guard approval only when operator, role and answer channel all permit it", () => {
    const cases = [
      { client: true, request: "await", operator: false, role: true, expected: "denied" },
      { client: false, request: "auto_decline", operator: true, role: true, expected: "denied" },
      { client: true, request: "await", operator: true, role: false, expected: "denied" },
      { client: false, request: "await", operator: true, role: true, expected: "relayed" },
      { client: true, request: "await", operator: true, role: true, expected: "relayed" },
    ] as const;
    for (const testCase of cases) {
      expect(
        resolvePosture({
          clientDeclaresElicitation: testCase.client,
          requested: testCase.request,
          allowRemoteGuardApproval: testCase.operator,
          roleAllowsGuardApproval: testCase.role,
        }).guard_confirmations,
      ).toBe(testCase.expected);
    }
  });

  it("pins the short prompt-cache lifetime only for auto-decline", () => {
    const declined = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "auto_decline",
      allowRemoteGuardApproval: false,
    });
    expect(declined.prompt_cache_ttl).toBe("5m");
    expect(declined.downgrades.some((note) => note.includes("prompt_cache_ttl"))).toBe(true);

    const viaTool = resolvePosture({
      clientDeclaresElicitation: false,
      requested: "await",
      allowRemoteGuardApproval: false,
    });
    const viaRelay = resolvePosture({
      clientDeclaresElicitation: true,
      requested: "await",
      allowRemoteGuardApproval: false,
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
      allowRemoteGuardApproval: false,
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
      allowRemoteGuardApproval: false,
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
      allowRemoteGuardApproval: false,
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
      allowRemoteGuardApproval: false,
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
      allowRemoteGuardApproval: false,
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
    for (let attempt = 0; attempt < 50 && logs.find("elicit.answered").length === 0; attempt += 1) {
      await Bun.sleep(1);
    }

    expect(logs.one("elicit.answered").fields).toMatchObject({
      posture: "relay",
      action: "accept",
      auto: false,
    });
  });
});
