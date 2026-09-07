import { describe, expect, it } from "bun:test";
import { createKernelLifecycle } from "../../src/application/lifecycle.ts";

describe("createKernelLifecycle", () => {
  it("releases naturally closed resources and makes shutdown idempotent", async () => {
    const lifecycle = createKernelLifecycle();
    const closed: string[] = [];
    const releaseFirst = lifecycle.register({
      close: () => {
        closed.push("first");
      },
    });
    lifecycle.register({
      close: () => {
        closed.push("second");
      },
    });
    releaseFirst();

    const firstClose = lifecycle.close();
    expect(lifecycle.close()).toBe(firstClose);
    await firstClose;

    expect(closed).toEqual(["second"]);
    expect(lifecycle.state).toBe("closed");
  });

  it("attempts every close and retains failures for retry without reopening admission", async () => {
    const lifecycle = createKernelLifecycle();
    const attempted: string[] = [];
    lifecycle.register({
      close() {
        attempted.push("first");
        if (attempted.filter((value) => value === "first").length === 1)
          throw new Error("first failed");
      },
    });
    lifecycle.register({
      close() {
        attempted.push("second");
      },
    });

    await expect(lifecycle.close()).rejects.toBeInstanceOf(AggregateError);
    expect(attempted).toEqual(["second", "first"]);
    expect(lifecycle.state).toBe("closing");
    await lifecycle.close();
    expect(attempted).toEqual(["second", "first", "first"]);
    expect(lifecycle.state).toBe("closed");
    await lifecycle.close();
    expect(attempted).toEqual(["second", "first", "first"]);
  });

  it("closes a resource registered after admission has stopped", async () => {
    const lifecycle = createKernelLifecycle();
    await lifecycle.close();
    let closed = 0;

    lifecycle.register({
      close() {
        closed += 1;
      },
    });
    await Promise.resolve();

    expect(closed).toBe(1);
  });
});
