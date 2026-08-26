import { describe, it, expect } from "../helpers/bun-test.ts";
import { openCallEnvelope, handlerBaseOf } from "../../src/index.ts";
import type { AgentBuildContext, LLMToolCall, TracePort } from "../../src/index.ts";

interface Recorded {
  kind: string;
  detail: Record<string, unknown>;
}

function fakeTrace(): { port: TracePort; entries: Recorded[] } {
  const entries: Recorded[] = [];
  let clock = 1000;
  const port: TracePort = {
    now: () => (clock += 1),
    record: (kind: string, detail: unknown) => {
      entries.push({ kind, detail: detail as Record<string, unknown> });
    },
    child: () => port,
  } as unknown as TracePort;
  return { port, entries };
}

const call: LLMToolCall = { id: "call_1", name: "load_skill", arguments: { name: "review" } };

describe("openCallEnvelope", () => {
  it("records a start and a terminal tool_call, framing the model-facing text", () => {
    const { port, entries } = fakeTrace();
    const envelope = openCallEnvelope({
      call,
      name: "load_skill",
      trace: port,
      agent: "lead",
      iteration: 3,
    });

    expect(envelope.callId).toBe("call_1");
    expect(envelope.invalid).toBeNull();

    envelope.start();
    const text = envelope.ok("body");

    expect(text).toBe("Tool 'load_skill' result: body");
    expect(entries.map((e) => e.kind)).toEqual(["tool_call_started", "tool_call"]);
    expect(entries[1]!.detail.error).toBeNull();
    expect(entries[1]!.detail.iteration_ref).toBe(3);
  });

  it("records the message as the call's error on fail", () => {
    const { port, entries } = fakeTrace();
    const envelope = openCallEnvelope({
      call,
      name: "load_skill",
      trace: port,
      agent: "lead",
      iteration: 0,
    });

    expect(envelope.fail("nope")).toBe("Tool 'load_skill' result (error): nope");
    expect(entries[0]!.detail.error).toBe("nope");
    expect(entries[0]!.detail.result).toBe("nope");
  });

  it("mints a call id when the provider supplied none, and defaults absent arguments", () => {
    const { port, entries } = fakeTrace();
    const envelope = openCallEnvelope({
      call: { id: "", name: "load_skill" } as LLMToolCall,
      name: "load_skill",
      trace: port,
      agent: "subagent",
      subagentInstanceId: "sa_1",
      iteration: 1,
    });
    envelope.start();

    expect(envelope.callId).not.toBe("");
    expect(entries[0]!.detail.arguments).toEqual({});
    expect(entries[0]!.detail.subagent_instance_id).toBe("sa_1");
  });

  it("reports the validator's message as `invalid` without recording anything", () => {
    const { port, entries } = fakeTrace();
    const envelope = openCallEnvelope({
      call,
      name: "load_skill",
      trace: port,
      agent: "lead",
      iteration: 1,
      schema: { type: "object", required: ["missing"] },
      validate: () => "InputValidationError: arguments must have required property 'missing'",
    });

    expect(envelope.invalid).toContain("must have required property");
    expect(entries).toEqual([]);
  });

  it("treats a validator that returns undefined as valid", () => {
    const { port } = fakeTrace();
    const envelope = openCallEnvelope({
      call,
      name: "load_skill",
      trace: port,
      agent: "lead",
      iteration: 1,
      schema: { type: "object" },
      validate: () => undefined as unknown as null,
    });

    expect(envelope.invalid).toBeNull();
  });

  it("throws when a schema is supplied with no validator, rather than passing the call", () => {
    const { port } = fakeTrace();
    expect(() =>
      openCallEnvelope({
        call,
        name: "load_skill",
        trace: port,
        agent: "lead",
        iteration: 1,
        schema: { type: "object" },
      }),
    ).toThrow(/supplied an argument schema with no validator/);
  });
});

describe("handlerBaseOf", () => {
  const validateArgs = (): string | null => null;

  const bc = (extra: Partial<AgentBuildContext>): AgentBuildContext =>
    ({
      agent: "lead",
      ctx: {},
      state: { lastAssistantText: "" },
      trace: fakeTrace().port,
      guards: {},
      toolProgress: () => true,
      maybeCancelled: () => null,
      ...extra,
    }) as unknown as AgentBuildContext;

  it("projects only the ambient fields a handler needs", () => {
    const signal = new AbortController().signal;
    const base = handlerBaseOf(bc({ subagentInstanceId: "sa_9", signal, validateArgs }));

    expect(base.agent).toBe("lead");
    expect(base.subagentInstanceId).toBe("sa_9");
    expect(base.signal).toBe(signal);
    expect(base.validateArgs).toBe(validateArgs);
  });

  it("omits the optional fields rather than setting them undefined", () => {
    const base = handlerBaseOf(bc({}));

    expect("subagentInstanceId" in base).toBe(false);
    expect("signal" in base).toBe(false);
    expect("validateArgs" in base).toBe(false);
  });
});
