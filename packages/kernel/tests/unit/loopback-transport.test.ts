import { describe, expect, it } from "bun:test";
import { createLoopbackTransport } from "../../src/transport/loopback.ts";
import type { KernelServer } from "../../src/transport/server.ts";

describe("loopback transport notifications", () => {
  it("dispatches fire-and-forget notifications with wire-equivalent value isolation", async () => {
    let markHandled!: () => void;
    const handled = new Promise<void>((resolve) => {
      markHandled = resolve;
    });
    let observed: { method: string; params: unknown } | undefined;
    const server: KernelServer = {
      connect() {
        return {
          handle(method, params) {
            observed = { method, params };
            markHandled();
            return Promise.resolve({ ignored: true });
          },
          close() {},
        };
      },
    };
    const transport = createLoopbackTransport(server);
    const params = { nested: { value: 1 } };

    transport.notify("test.notification", params);
    params.nested.value = 2;
    await handled;

    expect(observed).toEqual({
      method: "test.notification",
      params: { nested: { value: 1 } },
    });
    await transport.close();
  });
});
