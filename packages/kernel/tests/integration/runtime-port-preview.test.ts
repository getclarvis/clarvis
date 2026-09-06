import { afterEach, describe, expect, it } from "bun:test";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { PassThrough } from "node:stream";

import {
  createContainerRuntimePortPreview,
  createRuntimePortPreviewBroker,
} from "../../src/runtime/port-preview.ts";

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

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function relayProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (exit = resolve));
  stdin.on("data", (chunk: Buffer) => stdout.write(chunk.toString("utf8").toUpperCase()));
  stdin.on("end", () => {
    stdout.end();
    exit(0);
  });
  return {
    stdin,
    stdout,
    stderr,
    exited,
    kill() {
      stdin.end();
      stdout.end();
      stderr.end();
      exit(null);
    },
  };
}

function roundTrip(port: number, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let output = "";
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    socket.once("connect", () => socket.end(input));
    socket.once("close", () => resolve(output));
  });
}

describe("runtime port previews", () => {
  it("falls back from an occupied host port and relays only through loopback", async () => {
    const occupied = createServer();
    const guestPort = await listen(occupied);
    const probes: number[] = [];
    const attachments: number[] = [];
    const broker = createRuntimePortPreviewBroker({
      async probe(port) {
        probes.push(port);
      },
      attach(port) {
        attachments.push(port);
        return relayProcess();
      },
    });
    try {
      const first = await broker.expose(guestPort);
      expect(first).toEqual({
        guestPort,
        host: "127.0.0.1",
        hostPort: expect.any(Number),
        protocol: "http",
        url: `http://127.0.0.1:${String(first.hostPort)}/`,
      });
      expect(first.hostPort).not.toBe(guestPort);
      expect(await roundTrip(first.hostPort, "preview")).toBe("PREVIEW");
      const second = await broker.expose(guestPort, "https");
      expect(second.hostPort).toBe(first.hostPort);
      expect(second.url).toBe(`https://127.0.0.1:${String(first.hostPort)}/`);
      expect(probes).toEqual([guestPort]);
      expect(attachments).toEqual([guestPort]);
    } finally {
      await broker.close();
    }
  });

  it("uses only fixed engine exec arguments and enforces input bounds", async () => {
    const probeCalls: string[][] = [];
    const attachCalls: string[][] = [];
    const control = {
      async run(args: readonly string[]) {
        probeCalls.push([...args]);
        return { exitCode: args.at(-1) === "9001" ? 0 : 1 };
      },
      attach(args: readonly string[]) {
        attachCalls.push([...args]);
        return relayProcess();
      },
    };
    const broker = createContainerRuntimePortPreview(control, "clarvis-runtime-generation");
    try {
      const preview = await broker.expose(9001, "tcp");
      expect(probeCalls).toEqual([
        [
          "exec",
          "clarvis-runtime-generation",
          "/usr/local/bin/clarvis-runtime",
          "preview-probe",
          "9001",
        ],
      ]);
      expect(await roundTrip(preview.hostPort, "fixed")).toBe("FIXED");
      expect(attachCalls).toEqual([
        [
          "exec",
          "--interactive",
          "clarvis-runtime-generation",
          "/usr/local/bin/clarvis-runtime",
          "preview-relay",
          "9001",
        ],
      ]);
      await expect(broker.expose(0)).rejects.toThrow("1 through 65535");
      await expect(broker.expose(9002)).rejects.toThrow("not accepting connections");
    } finally {
      await broker.close();
    }
  });
});
