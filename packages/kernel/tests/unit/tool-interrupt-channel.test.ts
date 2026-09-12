import { describe, expect, it } from "bun:test";
import { createToolInterruptChannel } from "../../src/runs/tool-interrupt-channel.ts";
import { KernelException } from "../../src/core/errors.ts";

describe("tool interrupt channel", () => {
  it("rejects malformed tokens as invalid_request", async () => {
    const channel = createToolInterruptChannel();
    expect(() => void channel.interruptTool("")).toThrow(KernelException);
    expect(() => void channel.interruptTool(" not a token")).toThrow(KernelException);
  });

  it("coalesces repeats while the first delivery awaits settlement", async () => {
    const channel = createToolInterruptChannel();
    const deliveries: Array<{ settle: (status: "accepted") => void }> = [];
    channel.subscribe((delivery) => {
      deliveries.push(delivery);
    });
    const first = channel.interruptTool("tok_live");
    const second = channel.interruptTool("tok_live");
    expect(deliveries).toHaveLength(1);
    deliveries[0]!.settle("accepted");
    await expect(first).resolves.toEqual({ tool_execution_id: "tok_live", status: "accepted" });
    await expect(second).resolves.toEqual({
      tool_execution_id: "tok_live",
      status: "already_requested",
    });
  });

  it("rejects a flood of distinct pending tokens", async () => {
    const channel = createToolInterruptChannel();
    for (let i = 0; i < 16; i += 1) void channel.interruptTool(`tok_${i}`);
    expect(() => void channel.interruptTool("tok_overflow")).toThrow(KernelException);
    channel.close();
  });

  it("settles undelivered requests as not_running on close", async () => {
    const channel = createToolInterruptChannel();
    const pending = channel.interruptTool("tok_queued");
    channel.close();
    await expect(pending).resolves.toEqual({
      tool_execution_id: "tok_queued",
      status: "not_running",
    });
    await expect(channel.interruptTool("tok_queued")).resolves.toEqual({
      tool_execution_id: "tok_queued",
      status: "not_running",
    });
  });
});
