import { describe, expect, it } from "bun:test";
import {
  createToolInterruptRegistry,
  isOperatorInterruptedTool,
  OPERATOR_INTERRUPTED_TOOL,
  wasOperatorInterrupted,
} from "../../src/runtime/tools/tool-interrupt.ts";

describe("tool interrupt registry", () => {
  it("accepts the first request, coalesces repeats, and rejects unknown tokens", () => {
    const registry = createToolInterruptRegistry();
    const controller = new AbortController();
    registry.register({ toolExecutionId: "tok_1", callId: "call", controller });

    let first: string | undefined;
    registry.deliver({
      toolExecutionId: "tok_1",
      settle(status) {
        first = status;
      },
    });
    expect(first).toBe("accepted");
    expect(isOperatorInterruptedTool(controller.signal.reason)).toBe(true);

    let second: string | undefined;
    registry.deliver({
      toolExecutionId: "tok_1",
      settle(status) {
        second = status;
      },
    });
    expect(second).toBe("already_requested");

    let missing: string | undefined;
    registry.deliver({
      toolExecutionId: "tok_missing",
      settle(status) {
        missing = status;
      },
    });
    expect(missing).toBe("not_running");
  });

  it("returns not_running after unregister and close", () => {
    const registry = createToolInterruptRegistry();
    const controller = new AbortController();
    registry.register({ toolExecutionId: "tok_1", callId: "call", controller });
    registry.unregister("tok_1");
    let status: string | undefined;
    registry.deliver({
      toolExecutionId: "tok_1",
      settle(next) {
        status = next;
      },
    });
    expect(status).toBe("not_running");
    expect(controller.signal.aborted).toBe(false);

    registry.register({ toolExecutionId: "tok_2", callId: "call", controller });
    registry.close();
    registry.deliver({
      toolExecutionId: "tok_2",
      settle(next) {
        status = next;
      },
    });
    expect(status).toBe("not_running");
  });

  it("does not classify a run cancel as an operator interrupt", () => {
    const run = new AbortController();
    const tool = new AbortController();
    tool.abort(OPERATOR_INTERRUPTED_TOOL);
    run.abort({ source: "cancel" });
    expect(wasOperatorInterrupted(run.signal, tool.signal)).toBe(false);
    expect(wasOperatorInterrupted(undefined, tool.signal)).toBe(true);
  });
});
