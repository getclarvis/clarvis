import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { serveKernelOverStdio } from "../../src/transport/stdio.ts";

for (const outcome of ["written", "cancelled", "failed", "callback_failed"] as const) {
  test(`responseSent follows complete local write: ${outcome}`, async () => {
    const input = new PassThrough();
    const started = Promise.withResolvers<void>();
    let finish: ((error?: Error | null) => void) | undefined;
    let writes = 0;
    let callbacks = 0;
    let closed = 0;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writes++;
        finish = callback;
        started.resolve();
      },
    });
    output.on("error", () => undefined);
    const pump = serveKernelOverStdio(
      {
        connect: () => ({
          async handle() {
            return { ready: true };
          },
          responseSent(method, result) {
            expect(method).toBe("hello");
            expect(result).toEqual({ ready: true });
            callbacks++;
            if (outcome === "callback_failed") throw new Error("fixture callback failure");
          },
          close() {
            closed++;
          },
        }),
      },
      { input, output },
    );
    try {
      input.write(JSON.stringify({ t: "req", id: 1, method: "hello", params: {} }) + "\n");
      await started.promise;
      expect(callbacks).toBe(0);
      if (outcome === "cancelled") input.write(JSON.stringify({ t: "cancel", id: 1 }) + "\n");
      finish?.(outcome === "failed" ? new Error("fixture failed write") : undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callbacks).toBe(outcome === "written" || outcome === "callback_failed" ? 1 : 0);
      expect(writes).toBe(1);
      expect(closed).toBe(outcome === "failed" || outcome === "callback_failed" ? 1 : 0);
    } finally {
      pump.close();
      input.destroy();
      output.destroy();
    }
  });
}
