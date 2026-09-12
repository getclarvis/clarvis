import { describe, expect, it } from "bun:test";
import { createToolInterruptChannel } from "../../src/runs/tool-interrupt-channel.ts";
import { KernelException } from "../../src/core/errors.ts";
import type { ToolInterruptDelivery } from "@clarvis/loop";

describe("tool interrupt channel", () => {
  it("shares a single repeat promise under a same-token flood", async () => {
    const channel = createToolInterruptChannel();
    let delivery!: ToolInterruptDelivery;
    channel.subscribe((value) => {
      delivery = value;
    });
    const first = channel.interruptTool("tok_flood");
    const repeated = channel.interruptTool("tok_flood");
    for (let i = 0; i < 100_000; i += 1) {
      expect(channel.interruptTool("tok_flood")).toBe(repeated);
    }
    delivery.settle("accepted");
    expect((await first).status).toBe("accepted");
    expect((await repeated).status).toBe("already_requested");
    channel.close();
  });

  it("times out queued requests and removes them before subscription", async () => {
    const channel = createToolInterruptChannel(5);
    const requests = Array.from({ length: 16 }, (_, i) => channel.interruptTool(`tok_${i}`));
    const repeats = Array.from({ length: 16 }, (_, i) => channel.interruptTool(`tok_${i}`));
    for (const result of await Promise.all([...requests, ...repeats])) {
      expect(result.status).toBe("not_running");
    }
    const deliveries: ToolInterruptDelivery[] = [];
    channel.subscribe((value) => {
      deliveries.push(value);
    });
    expect(deliveries).toHaveLength(0);
    const next = channel.interruptTool("tok_next");
    deliveries[0]!.settle("accepted");
    expect((await next).status).toBe("accepted");
    channel.close();
  });

  it("ignores old deliveries after timeout and re-admission of the same token", async () => {
    const channel = createToolInterruptChannel(5);
    const deliveries: ToolInterruptDelivery[] = [];
    channel.subscribe((value) => {
      deliveries.push(value);
    });
    await expect(channel.interruptTool("tok_same")).rejects.toThrow("timed out");
    const next = channel.interruptTool("tok_same");
    deliveries[0]!.settle("accepted");
    deliveries[0]!.fail(new Error("late error"));
    deliveries[1]!.settle("not_running");
    expect((await next).status).toBe("not_running");
    channel.close();
  });

  it("expires delivered first and repeat promises and releases every pending slot", async () => {
    const channel = createToolInterruptChannel(5);
    const deliveries: ToolInterruptDelivery[] = [];
    channel.subscribe((delivery) => deliveries.push(delivery));
    const first = Array.from({ length: 16 }, (_, i) => channel.interruptTool(`tok_${i}`));
    const repeated = Array.from({ length: 16 }, (_, i) => channel.interruptTool(`tok_${i}`));
    const results = await Promise.allSettled([...first, ...repeated]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.code).toBe("unavailable");
    }
    const next = Array.from({ length: 16 }, (_, i) => channel.interruptTool(`tok_${i}`));
    for (const delivery of deliveries.slice(0, 16)) delivery.settle("accepted");
    channel.close();
    for (const result of await Promise.all(next)) expect(result.status).toBe("not_running");
  });

  it("rejects both promises with sanitized delivery failures and releases capacity", async () => {
    const channel = createToolInterruptChannel();
    let delivery!: ToolInterruptDelivery;
    channel.subscribe((value) => {
      delivery = value;
    });
    const first = channel.interruptTool("tok_fail");
    const repeated = channel.interruptTool("tok_fail");
    delivery.fail(new Error("failed Bearer secret-token"));
    for (const result of await Promise.allSettled([first, repeated])) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason.code).toBe("unavailable");
        expect(result.reason.message).not.toContain("secret-token");
      }
    }
    const next = channel.interruptTool("tok_fail");
    delivery.settle("already_requested");
    expect((await next).status).toBe("already_requested");
    channel.close();
  });

  it("closes delivered repeats idempotently and ignores late replies and subscriptions", async () => {
    const channel = createToolInterruptChannel(5);
    let delivery!: ToolInterruptDelivery;
    channel.subscribe((value) => {
      delivery = value;
    });
    const first = channel.interruptTool("tok_close");
    const repeated = channel.interruptTool("tok_close");
    channel.close();
    channel.close();
    delivery.fail(new Error("late"));
    delivery.settle("accepted");
    channel.subscribe(() => {
      throw new Error("closed channel delivered work");
    });
    expect((await first).status).toBe("not_running");
    expect((await repeated).status).toBe("not_running");
    await Bun.sleep(10);
  });

  it("rejects a throwing subscriber rather than retaining a pending request", async () => {
    const channel = createToolInterruptChannel();
    channel.subscribe(() => {
      throw new Error("listener refused");
    });
    await expect(channel.interruptTool("tok_throw")).rejects.toThrow("listener refused");
    channel.close();
  });

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
