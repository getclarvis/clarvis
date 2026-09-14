import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import {
  CONTAINER_CHANNEL_PREFIX,
  CONTAINER_FRAME_BYTES,
  createContainerChannel,
  type ContainerChannel,
} from "../../src/hosting/container-channel.ts";
import { createStdioTransport, serveKernelOverStdio } from "../../src/transport/stdio.ts";
import type { KernelServer } from "../../src/transport/server.ts";

const channels: ContainerChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
});

function pair() {
  const toGuest = new PassThrough();
  const toHost = new PassThrough();
  const host = createContainerChannel({ input: toHost, output: toGuest });
  const guest = createContainerChannel({ input: toGuest, output: toHost });
  channels.push(host, guest);
  return { host, guest, toHost, toGuest };
}

function frame(channel: number, bytes: Buffer): Buffer {
  const result = Buffer.alloc(5 + bytes.length);
  result[0] = channel;
  result.writeUInt32BE(bytes.length, 1);
  bytes.copy(result, 5);
  return result;
}

const echo: KernelServer = {
  connect: () => ({ handle: async (_method, params) => params, close() {} }),
};

function raw() {
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const channel = createContainerChannel({ input, output });
  channels.push(channel);
  return { channel, input, output };
}

function write(output: Writable, bytes: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) =>
    output.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
}

describe("Container physical channel", () => {
  test("reads prefix and header byte by byte, preserving UTF-8 payload bytes", async () => {
    const { channel, input } = raw();
    const received: Buffer[] = [];
    channel.kernel.input.on("data", (bytes: Buffer) => received.push(bytes));
    const text = Buffer.from("ação 🧭\n", "utf8");
    const bytes = Buffer.concat([Buffer.from(CONTAINER_CHANNEL_PREFIX), frame(1, text)]);
    for (const byte of bytes) await write(input, Buffer.from([byte]));
    await channel.ready;
    expect(Buffer.concat(received)).toEqual(text);
  });

  test("reuses public stdio fragmentation for histories above 8 MiB on all lanes", async () => {
    const { host, guest } = pair();
    await Promise.all([host.ready, guest.ready]);
    const history = "ç".repeat(5 * 1024 * 1024);
    for (const key of ["kernel", "control", "model"] as const) {
      serveKernelOverStdio(echo, guest[key]);
      const client = createStdioTransport(host[key]);
      expect(await client.request<{ history: string }>("echo", { history })).toEqual({ history });
      await client.close();
    }
  }, 60_000);

  test("keeps lane order while a control reply overtakes another lane's bulk write", async () => {
    const { host, guest } = pair();
    await Promise.all([host.ready, guest.ready]);
    const order: string[] = [];
    let bytes = 0;
    const large = Buffer.alloc(4 * CONTAINER_FRAME_BYTES, 65);
    guest.kernel.input.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      order.push("kernel");
    });
    guest.control.input.on("data", () => order.push("control"));
    await Promise.all([write(host.kernel.output, large), write(host.control.output, "stop")]);
    expect(bytes).toBe(large.length);
    expect(order.indexOf("control")).toBeLessThan(order.lastIndexOf("kernel"));
  });

  test.each([
    Buffer.from("WRONG-CONTAINER/1\n"),
    Buffer.concat([Buffer.from(CONTAINER_CHANNEL_PREFIX), frame(0, Buffer.from("x"))]),
    Buffer.concat([Buffer.from(CONTAINER_CHANNEL_PREFIX), frame(4, Buffer.from("x"))]),
    Buffer.concat([Buffer.from(CONTAINER_CHANNEL_PREFIX), frame(1, Buffer.alloc(0))]),
    Buffer.concat([Buffer.from(CONTAINER_CHANNEL_PREFIX), Buffer.from([1, 0, 1, 0, 1])]),
  ])("closes every lane on a corrupt physical frame", async (bytes) => {
    const { channel, input } = raw();
    input.end(bytes);
    await channel.closed;
    expect(channel.kernel.input.destroyed).toBe(true);
    expect(channel.control.input.destroyed).toBe(true);
    expect(channel.model.input.destroyed).toBe(true);
  });

  test.each([0, 1, 4, 5, 6])(
    "closes on EOF in a partial header or payload (%i)",
    async (length) => {
      const { channel, input } = raw();
      const bytes = Buffer.concat([
        Buffer.from(CONTAINER_CHANNEL_PREFIX),
        frame(1, Buffer.from("partial")).subarray(0, length),
      ]);
      input.end(bytes);
      await channel.closed;
      expect(channel.kernel.output.destroyed).toBe(true);
    },
  );

  test("tears down pending requests on all virtual clients after physical corruption", async () => {
    const { host, guest, toHost } = pair();
    await Promise.all([host.ready, guest.ready]);
    const clients = [host.kernel, host.control, host.model].map((io) => createStdioTransport(io));
    const pending = clients.map((client) =>
      client.request("pending").then(
        () => "unexpected",
        () => "closed",
      ),
    );
    toHost.write(frame(9, Buffer.from("invalid")));
    expect(await Promise.all(pending)).toEqual(["closed", "closed", "closed"]);
  });

  test.each([
    [2_000, 1],
    [600, CONTAINER_FRAME_BYTES],
  ])(
    "bounds an unread lane by frame count and bytes (%i frames of %i bytes)",
    async (count, size) => {
      const { channel, input } = raw();
      const payload = Buffer.alloc(size, 65);
      const packet = frame(1, payload);
      input.end(
        Buffer.concat([
          Buffer.from(CONTAINER_CHANNEL_PREFIX),
          ...Array.from({ length: count }, () => packet),
        ]),
      );
      await channel.ready;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.kernel.input.readableLength).toBe(size);
      expect(input.readableLength).toBeGreaterThan(0);
      let received = 0;
      channel.kernel.input.on("data", (bytes: Buffer) => {
        received += bytes.length;
      });
      await channel.closed;
      expect(received).toBe(count * size);
    },
  );

  test("rejects an oversized logical write and settles prefix waiters on early close", async () => {
    const early = raw();
    early.channel.close();
    early.channel.close();
    await expect(early.channel.ready).rejects.toThrow("before prefix exchange");
    const { host, guest } = pair();
    await Promise.all([host.ready, guest.ready]);
    await expect(write(host.kernel.output, Buffer.alloc(8 * 1024 * 1024 + 1))).rejects.toThrow(
      "line bound",
    );
    await host.closed;
  });

  test("empty writes send no invalid zero-length physical frame", async () => {
    const { host, guest } = pair();
    await Promise.all([host.ready, guest.ready]);
    await write(host.model.output, Buffer.alloc(0));
    serveKernelOverStdio(echo, guest.model);
    expect(await createStdioTransport(host.model).request<string>("echo", "after empty")).toBe(
      "after empty",
    );
  });

  test("public cancellation reaches its server through a virtual stream", async () => {
    const { host, guest } = pair();
    await Promise.all([host.ready, guest.ready]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cancelled!: () => void;
    const observed = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    serveKernelOverStdio(
      {
        connect: () => ({
          handle: (_method, _params, signal) =>
            new Promise((resolve) => {
              signal?.addEventListener(
                "abort",
                () => {
                  cancelled();
                  resolve(null);
                },
                { once: true },
              );
              entered();
            }),
          close() {},
        }),
      },
      guest.control,
    );
    const client = createStdioTransport(host.control);
    const controller = new AbortController();
    const pending = client.request("cancel", {}, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await observed;
  });

  test("strict client direction rejects a request without dispatch", async () => {
    const { host, guest } = pair();
    await Promise.all([host.ready, guest.ready]);
    const client = createStdioTransport(host.model, undefined, { strictDirection: true });
    const pending = client.request("pending");
    await write(guest.model.output, '{"t":"req","id":1,"method":"forbidden"}\n');
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await host.closed;
  });

  test("strict server direction rejects a response without handler side effects", async () => {
    const { host, guest } = pair();
    await Promise.all([host.ready, guest.ready]);
    let calls = 0;
    serveKernelOverStdio(
      {
        connect: () => ({
          handle: async () => {
            calls += 1;
          },
          close() {},
        }),
      },
      guest.control,
      undefined,
      { strictDirection: true },
    );
    await write(host.control.output, '{"t":"res","id":1,"result":null}\n');
    await guest.closed;
    expect(calls).toBe(0);
  });
});
