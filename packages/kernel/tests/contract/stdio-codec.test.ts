import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "bun:test";
import { kernelError } from "../../src/core/errors.ts";
import type { KernelServer } from "../../src/transport/server.ts";
import {
  MAX_WIRE_FRAME_BYTES,
  createStdioTransport,
  decodeFrame,
  serveKernelOverStdio,
} from "../../src/transport/stdio.ts";
import { recordingLogger } from "../helpers/logger.ts";

class GatedWritable extends Writable {
  readonly chunks: string[] = [];
  private readonly releases: Array<() => void> = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString("utf8"));
    this.releases.push(() => callback());
  }

  releaseOne(): void {
    this.releases.shift()?.();
  }
}

describe("stdio NDJSON codec", () => {
  it("reassembles chunked frames and dispatches notifications", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport({ input, output });
    const notifications: unknown[] = [];
    transport.onNotification("probe.note", (params) => notifications.push(params));

    const result = transport.request<{ ok: boolean }>("probe.request", { value: 1 });
    input.write('{"t":"note","method":"probe.note","params":{"part":');
    input.write('1}}\n{"t":"res","id":1,"result":{"ok":');
    input.write("true}}\n");

    expect(await result).toEqual({ ok: true });
    expect(notifications).toEqual([{ part: 1 }]);
    await transport.close();
  });

  it("closes fail-closed on malformed, oversized, primitive, or extra-field frames", async () => {
    expect(decodeFrame(null)).toBeNull();
    expect(decodeFrame("request")).toBeNull();
    expect(decodeFrame({ t: "req", id: 1, method: "probe", extra: true })).toBeNull();
    expect(decodeFrame({ t: "res", id: 1 })).toBeNull();
    expect(decodeFrame({ t: "res", id: 1, result: {}, error: {} })).toBeNull();
    expect(decodeFrame({ t: "cancel", id: 1 })).toEqual({ t: "cancel", id: 1 });
    expect(decodeFrame({ t: "note", method: "probe", params: {} })).toEqual({
      t: "note",
      method: "probe",
      params: {},
    });
    expect(
      decodeFrame({ t: "res", id: 1, error: { code: "not-real", message: "bad" } }),
    ).toBeNull();

    for (const invalid of ["not-json\n", `${"x".repeat(MAX_WIRE_FRAME_BYTES + 1)}`]) {
      const input = new PassThrough();
      const output = new PassThrough();
      const transport = createStdioTransport({ input, output });
      const pending = transport.request("probe.request");
      input.write(invalid);
      await expect(pending).rejects.toMatchObject({ code: "unavailable" });
      await transport.close();
    }
  });

  it("server-side malformed input disconnects and destroys both wire streams", async () => {
    let closes = 0;
    const server: KernelServer = {
      connect() {
        return {
          handle: () => Promise.resolve({}),
          close: () => {
            closes += 1;
          },
        };
      },
    };
    const input = new PassThrough();
    const output = new PassThrough();
    serveKernelOverStdio(server, { input, output });

    input.write("not-json\n");
    await Bun.sleep(0);

    expect(closes).toBe(1);
    expect(input.destroyed).toBe(true);
    expect(output.destroyed).toBe(true);
  });

  it("rejects a pre-aborted request and ignores notifications after close", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport({ input, output });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.request("probe", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await transport.close();
    expect(() => transport.notify("probe.note", {})).not.toThrow();
  });

  it("serializes a server error and reconstructs its code and details", async () => {
    const server: KernelServer = {
      connect() {
        return {
          handle() {
            return Promise.reject(
              kernelError("not_found", "missing over stdio", { resource: "run" }),
            );
          },
          close() {},
        };
      },
    };
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    serveKernelOverStdio(server, { input: toServer, output: toClient });
    const transport = createStdioTransport({ input: toClient, output: toServer });

    await expect(transport.request("probe.missing")).rejects.toMatchObject({
      code: "not_found",
      message: "missing over stdio",
      details: { resource: "run" },
    });
    await transport.close();
  });

  it("round-trips resource exhaustion without misclassifying the wire", async () => {
    const server: KernelServer = {
      connect() {
        return {
          handle() {
            return Promise.reject(
              kernelError("resource_exhausted", "owner capacity reached", { limit: 128 }),
            );
          },
          close() {},
        };
      },
    };
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    serveKernelOverStdio(server, { input: toServer, output: toClient });
    const transport = createStdioTransport({ input: toClient, output: toServer });

    await expect(transport.request("probe.capacity")).rejects.toMatchObject({
      code: "resource_exhausted",
      message: "owner capacity reached",
      details: { limit: 128 },
    });
    await transport.close();
  });

  it("normalizes, redacts, and bounds untrusted server error envelopes", async () => {
    const server: KernelServer = {
      connect() {
        return {
          handle() {
            return Promise.reject(
              Object.assign(new Error(`\u001b[2JBearer secret-token\u0007${"x".repeat(20_000)}`), {
                code: "remote_vendor_code",
                details: {
                  authorization: "Bearer another-secret",
                  note: "\u001b[31munsafe\u0007",
                },
              }),
            );
          },
          close() {},
        };
      },
    };
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    serveKernelOverStdio(server, { input: toServer, output: toClient });
    const transport = createStdioTransport({ input: toClient, output: toServer });

    const error = await transport.request("probe.error").catch((caught) => caught);
    expect(error).toMatchObject({
      code: "internal",
      details: { authorization: "Bearer [redacted]", note: "unsafe" },
    });
    expect((error as Error).message.length).toBeLessThanOrEqual(16_384);
    expect((error as Error).message).not.toContain("\u001b");
    expect((error as Error).message).not.toContain("secret-token");
    await transport.close();
  });

  it("retains task reconciliation flags when oversized error details are truncated", async () => {
    const server: KernelServer = {
      connect() {
        return {
          handle() {
            return Promise.reject(
              kernelError("unavailable", "task response was lost", {
                task_code: "task_outcome_unknown",
                current_revision: "18",
                current_task: { description: "x".repeat(100_000) },
                outcome_unknown: true,
              }),
            );
          },
          close() {},
        };
      },
    };
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    serveKernelOverStdio(server, { input: toServer, output: toClient });
    const transport = createStdioTransport({ input: toClient, output: toServer });

    const error = await transport.request("tasks.transition").catch((caught) => caught);
    expect(error).toMatchObject({
      code: "unavailable",
    });
    expect((error as { details?: unknown }).details).toEqual({
      task_code: "task_outcome_unknown",
      current_revision: "18",
      outcome_unknown: true,
      truncated: true,
    });
    await transport.close();
  });

  it("does not publish a queued request after the transport closes", async () => {
    const input = new PassThrough();
    const output = new GatedWritable();
    const transport = createStdioTransport({ input, output });
    const first = transport.request("probe.first");
    const second = transport.request("probe.second");
    const settled = Promise.allSettled([first, second]);
    await Bun.sleep(0);
    expect(output.chunks).toHaveLength(1);

    await transport.close();
    output.releaseOne();
    await settled;
    await Bun.sleep(0);

    expect(output.chunks).toHaveLength(1);
  });

  it("fails a stalled writer at the bounded transport timeout", async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const output = new GatedWritable();
      const transport = createStdioTransport({ input, output });
      const request = transport.request("probe.stalled");
      await Promise.resolve();
      vi.advanceTimersByTime(30_000);
      await expect(request).rejects.toMatchObject({ code: "unavailable" });
      await transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the transport cleanly when a frame cannot be serialized", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport({ input, output });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(transport.request("probe.cyclic", cyclic)).rejects.toMatchObject({
      code: "unavailable",
    });
    await transport.close();
  });

  it("rejects pending requests as unavailable when input reaches EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport({ input, output });
    const request = transport.request("never-answered");

    input.end();

    await expect(request).rejects.toMatchObject({ code: "unavailable" });
  });

  it("cancels one in-flight request on both sides without closing the connection", async () => {
    let seenSignal: AbortSignal | undefined;
    const server: KernelServer = {
      connect() {
        return {
          handle(method, _params, signal) {
            if (method === "probe.fast") return Promise.resolve({ ok: true });
            seenSignal = signal;
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(kernelError("cancelled", "provider call cancelled")),
                { once: true },
              );
            });
          },
          close() {},
        };
      },
    };
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    serveKernelOverStdio(server, { input: toServer, output: toClient });
    const transport = createStdioTransport({ input: toClient, output: toServer });
    const controller = new AbortController();
    const pending = transport.request("probe.slow", {}, { signal: controller.signal });

    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await Bun.sleep(0);
    expect(seenSignal?.aborted).toBeTrue();
    await expect(transport.request("probe.fast")).resolves.toEqual({ ok: true });
    await transport.close();
  });

  it("closes on a duplicate in-flight request id without dispatching it twice", async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    let closes = 0;
    const server: KernelServer = {
      connect() {
        return {
          handle(_method, _params, signal) {
            calls += 1;
            firstSignal = signal;
            return new Promise(() => {});
          },
          close() {
            closes += 1;
          },
        };
      },
    };
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    serveKernelOverStdio(server, { input: toServer, output: toClient });

    toServer.write('{"t":"req","id":1,"method":"probe.slow"}\n');
    toServer.write('{"t":"req","id":1,"method":"probe.duplicate"}\n');
    await Bun.sleep(0);

    expect(calls).toBe(1);
    expect(firstSignal?.aborted).toBeTrue();
    expect(closes).toBe(1);
  });
});

describe("transport.frame_dropped", () => {
  async function dropReason(write: (input: PassThrough) => void): Promise<unknown> {
    const logger = recordingLogger();
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport({ input, output }, logger);
    const pending = transport.request("probe.request");
    write(input);
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await transport.close();
    return logger.events("transport.frame_dropped")[0];
  }

  it("names an unterminated frame past the size cap", async () => {
    expect(
      await dropReason((input) => input.write("x".repeat(MAX_WIRE_FRAME_BYTES + 1))),
    ).toMatchObject({ direction: "inbound", reason: "oversize_unterminated" });
  });

  it("names a terminated frame past the size cap", async () => {
    expect(
      await dropReason((input) => input.write(`${"x".repeat(MAX_WIRE_FRAME_BYTES + 1)}\n`)),
    ).toMatchObject({ direction: "inbound", reason: "oversize" });
  });

  it("names a line that is not JSON", async () => {
    expect(await dropReason((input) => input.write("not-json\n"))).toMatchObject({
      direction: "inbound",
      reason: "invalid_json",
    });
  });

  it("names a frame whose shape the decoder refuses", async () => {
    expect(await dropReason((input) => input.write('{"t":"nope"}\n'))).toMatchObject({
      direction: "inbound",
      reason: "invalid_shape",
    });
  });

  it("names an outbound frame the writer refuses as oversized", async () => {
    const logger = recordingLogger();
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const transport = createStdioTransport({ input, output }, logger);
    await expect(
      transport.request("probe.request", { blob: "y".repeat(MAX_WIRE_FRAME_BYTES) }),
    ).rejects.toThrow(/exceeds/);
    expect(logger.events("transport.frame_dropped")[0]).toMatchObject({
      direction: "outbound",
      reason: "oversize",
    });
    await transport.close();
  });

  it("names an outbound frame the backpressure queue refuses", async () => {
    const logger = recordingLogger();
    const input = new PassThrough();
    const output = new GatedWritable();
    const transport = createStdioTransport({ input, output }, logger);
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 2_000; i++) {
      pending.push(transport.request("probe.request").catch(() => undefined));
    }
    await Promise.all(pending);
    expect(logger.events("transport.frame_dropped").at(-1)).toMatchObject({
      direction: "outbound",
      reason: "queue_full",
    });
    await transport.close();
  });
});
