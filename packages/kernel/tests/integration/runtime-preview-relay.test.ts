import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type AddressInfo, type Server } from "node:net";
import { PassThrough } from "node:stream";

import { runGuestPreviewCommand } from "../../src/runtime/preview-relay.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function echoServer(): Promise<number> {
  const server = createServer((socket) => {
    socket.on("data", (chunk: Buffer) => socket.write(chunk.toString("utf8").toUpperCase()));
    socket.on("end", () => socket.end());
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe("guest preview relay", () => {
  it("probes and relays a guest-local TCP listener", async () => {
    const port = await echoServer();
    await expect(
      runGuestPreviewCommand(["preview-probe", String(port)], new PassThrough(), new PassThrough()),
    ).resolves.toBe(0);

    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    const running = runGuestPreviewCommand(["preview-relay", String(port)], input, output);
    input.end("inside");
    await expect(running).resolves.toBe(0);
    expect(text).toBe("INSIDE");
  });

  it("leaves worker arguments alone and rejects malformed preview ports", async () => {
    await expect(
      runGuestPreviewCommand([], new PassThrough(), new PassThrough()),
    ).resolves.toBeNull();
    await expect(
      runGuestPreviewCommand(["preview-probe", "0"], new PassThrough(), new PassThrough()),
    ).resolves.toBe(64);
  });
});
