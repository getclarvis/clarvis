import { describe, it, expect } from "../bun-test.ts";
import { createTrace } from "@clarvis/trace";
import { handleAskUserCall, type AskUser } from "../../src/runtime/tools/index.ts";
import type { LLMToolCall } from "@clarvis/capability";
import { createToolArgValidator } from "../../src/runtime/tools/tool-arg-validator.ts";
import { askUserAgentCapability } from "../../src/runtime/capabilities/ask-user.ts";
import { fakeAgentBuildContext } from "../../src/runtime/capabilities/testing.ts";

const validateArgs = createToolArgValidator().validate;

function call(over: Partial<LLMToolCall> = {}): LLMToolCall {
  return { id: "c1", name: "srv.tool", arguments: {}, ...over };
}

function userQuestion(trace: ReturnType<typeof createTrace>): unknown {
  return trace.entries().find((e) => e.kind === "user_question")?.detail;
}

describe("handleAskUserCall", () => {
  it("rejects a missing question with an error result and records nothing", async () => {
    const trace = createTrace();
    const res = await handleAskUserCall({
      call: call({ arguments: {} }),
      askUser: async () => ({ action: "accept", answer: "x" }),
      trace,
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.kind).toBe("result");
    if (res.kind === "result") {
      expect(res.text).toContain("Tool 'ask_user' result (error): InputValidationError");
      expect(res.error).toBe(true);
    }
    const kinds = trace.entries().map((e) => e.kind);
    expect(kinds).toEqual(["tool_call"]);
    const detail = trace.entries()[0]!.detail as unknown as Record<string, unknown>;
    expect(detail.call_id).toBe("c1");
    expect(detail.error).not.toBeNull();
  });

  it("defaults absent call arguments to an empty object", async () => {
    const res = await handleAskUserCall({
      call: { id: "c1", name: "ask_user", arguments: undefined as unknown as object },
      askUser: async () => ({ action: "accept", answer: "x" }),
      trace: createTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    if (res.kind === "result") expect(res.text).toContain("InputValidationError");
  });

  it("rejects a non-string question", async () => {
    const trace = createTrace();
    const res = await handleAskUserCall({
      call: call({ arguments: { question: 42 } }),
      askUser: async () => ({ action: "accept", answer: "x" }),
      trace,
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.kind).toBe("result");
    if (res.kind === "result") expect(res.text).toContain("InputValidationError");
  });

  it("rejects an empty-string question", async () => {
    const res = await handleAskUserCall({
      call: call({ arguments: { question: "" } }),
      askUser: async () => ({ action: "accept", answer: "x" }),
      trace: createTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    if (res.kind === "result") expect(res.text).toContain("InputValidationError");
  });

  it("returns the user's answer on accept and records the outcome with the answer", async () => {
    const trace = createTrace();
    const res = await handleAskUserCall({
      call: call({ arguments: { question: "name?" } }),
      askUser: async () => ({ action: "accept", answer: "Ada" }),
      trace,
      agent: "subagent",
      subagentInstanceId: "w1",
      iteration: 3,
      validateArgs,
    });
    expect(res).toEqual({ kind: "result", text: "Tool 'ask_user' result: User answered: Ada" });
    const detail = userQuestion(trace) as Record<string, unknown>;
    expect(detail.outcome).toBe("accept");
    expect(detail.answer).toBe("Ada");
    expect(detail.subagent_instance_id).toBe("w1");
    expect(detail.options).toBeUndefined();
    const kinds = trace.entries().map((e) => e.kind);
    expect(kinds).toEqual([
      "tool_call_started",
      "elicitation_requested",
      "user_question",
      "tool_call",
    ]);
    const started = trace.entries()[0]!.detail as unknown as Record<string, unknown>;
    const ended = trace.entries()[3]!.detail as unknown as Record<string, unknown>;
    expect(started.call_id).toBe("c1");
    expect(ended.call_id).toBe("c1");
    expect(ended.result).toBe("User answered: Ada");
    expect(ended.error).toBeNull();
  });

  it("rejects non-string options entries via the declared schema (no silent filtering)", async () => {
    const trace = createTrace();
    const res = await handleAskUserCall({
      call: call({ arguments: { question: "deploy?", options: ["prod", 7, "staging"] } }),
      askUser: async () => ({ action: "accept", answer: "prod" }),
      trace,
      agent: "lead",
      iteration: 1,
      validateArgs,
    });
    if (res.kind === "result") expect(res.text).toContain("InputValidationError");
    expect(userQuestion(trace)).toBeUndefined();
  });

  it("carries all-string options through to the trace", async () => {
    const trace = createTrace();
    await handleAskUserCall({
      call: call({ arguments: { question: "deploy?", options: ["prod", "staging"] } }),
      askUser: async () => ({ action: "accept", answer: "prod" }),
      trace,
      agent: "lead",
      iteration: 1,
      validateArgs,
    });
    const detail = userQuestion(trace) as Record<string, unknown>;
    expect(detail.options).toEqual(["prod", "staging"]);
  });

  it("maps a decline outcome and records no answer", async () => {
    const trace = createTrace();
    const res = await handleAskUserCall({
      call: call({ arguments: { question: "ok?" } }),
      askUser: async () => ({ action: "decline" }),
      trace,
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    if (res.kind === "result") expect(res.text).toContain("declined to answer");
    const detail = userQuestion(trace) as Record<string, unknown>;
    expect(detail.outcome).toBe("decline");
    expect("answer" in detail).toBe(false);
  });

  it("maps a cancel outcome", async () => {
    const res = await handleAskUserCall({
      call: call({ arguments: { question: "ok?" } }),
      askUser: async () => ({ action: "cancel" }),
      trace: createTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    if (res.kind === "result") expect(res.text).toContain("dismissed");
  });

  it("returns cancelled when askUser throws and the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const askUser: AskUser = async () => {
      throw new Error("aborted");
    };
    const trace = createTrace();
    const res = await handleAskUserCall({
      call: call({ arguments: { question: "ok?" } }),
      askUser,
      trace,
      agent: "subagent",
      iteration: 1,
      validateArgs,
      signal: controller.signal,
    });
    expect(res).toEqual({ kind: "cancelled" });
    const kinds = trace.entries().map((e) => e.kind);
    expect(kinds).toEqual(["tool_call_started", "elicitation_requested", "tool_call"]);
    const ended = trace.entries()[2]!.detail as unknown as Record<string, unknown>;
    expect(ended.error).toBe("cancelled");
  });

  it("degrades to a tool error when askUser throws without an aborted signal", async () => {
    const askUser: AskUser = async () => {
      throw new Error("boom");
    };
    const res = await handleAskUserCall({
      call: call({ arguments: { question: "ok?" } }),
      askUser,
      trace: createTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
      signal: new AbortController().signal,
    });
    expect(res.kind).toBe("result");
    if (res.kind === "result") {
      expect(res.text).toContain("could not reach the user");
      expect(res.text).toContain("boom");
    }
  });
});

describe("the ask_user handler built over the engine's own capability test fake", () => {
  // fakeAgentBuildContext must model the shape production always produces: run-agent.ts
  // sets validateArgs on every AgentBuildContext, and openCallEnvelope throws at
  // construction when a schema arrives without one — so a fake that omits it makes every
  // schema-carrying tool unreachable from a capability test, valid arguments included.
  const askUser: AskUser = async () => ({ action: "accept", answer: "Ada" });

  function handler() {
    const contribution = askUserAgentCapability(askUser).attach(fakeAgentBuildContext());
    const handlers = contribution.handlers ?? [];
    expect(handlers.length).toBe(1);
    return handlers[0]!;
  }

  it("validates arguments rather than throwing when the schema meets the fake", async () => {
    const verdict = await handler().handle({ id: "c1", name: "ask_user", arguments: {} }, 1);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toContain("Tool 'ask_user' result (error): InputValidationError");
      expect(verdict.progress).toBe(false);
    }
  });

  it("still lets a valid call through to the asker", async () => {
    const verdict = await handler().handle(
      { id: "c2", name: "ask_user", arguments: { question: "name?" } },
      1,
    );
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toBe("Tool 'ask_user' result: User answered: Ada");
    }
  });

  it("supplies a validator by default and still lets a caller override it", () => {
    expect(fakeAgentBuildContext().validateArgs).toBeDefined();
    const bc = fakeAgentBuildContext({ validateArgs: () => "InputValidationError: nope" });
    expect(bc.validateArgs?.({}, {})).toBe("InputValidationError: nope");
  });
});
