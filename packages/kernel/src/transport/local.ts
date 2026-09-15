import { mkdir, lstat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { DIR_MODE } from "@clarvis/paths";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { KernelTransport } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import type { KernelServer } from "./server.ts";
import { createStdioTransport, serveKernelOverStdio } from "./stdio.ts";
import { M } from "./wire.ts";

/** Resource limits of one reconnectable local RPC listener. Authentication belongs to the server. */
export interface LocalKernelListenerOptions {
  maxConnections?: number;
  helloTimeoutMs?: number;
  logger?: Logger;
}

/** Owns local IPC connections; closing it does not shut down the kernel implementation. */
export interface LocalKernelListener {
  readonly endpoint: string;
  connections(): number;
  close(): Promise<void>;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

async function prepareSocketDirectory(endpoint: string): Promise<void> {
  const usesNamedPipe = process.platform === "win32";
  if (usesNamedPipe) return;
  const directory = dirname(endpoint);
  await mkdir(directory, { mode: DIR_MODE }).catch((error: unknown) => {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
  });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== DIR_MODE
  ) {
    throw kernelError(
      "unauthorized",
      "local RPC socket directory must be private and owned by this account",
    );
  }
}

/**
 * Serve the existing kernel RPC over Unix sockets or Windows named pipes.
 *
 * A caller must supply a server with authenticated connection resolution and authorization before
 * publishing its endpoint. This adapter owns framing and connection limits, not operator policy.
 * It never removes an existing endpoint to steal a listener; stale recovery belongs to the host
 * lease holder. Each connection receives the same stream codec used by stdio, including its
 * request and writer budgets. Unauthenticated handshakes have a finite lifetime.
 */
export async function listenLocalKernel(
  server: KernelServer,
  endpoint: string,
  options: LocalKernelListenerOptions = {},
): Promise<LocalKernelListener> {
  const maxConnections = positive(options.maxConnections ?? 4, "maxConnections");
  const helloTimeoutMs = positive(options.helloTimeoutMs ?? 10_000, "helloTimeoutMs");
  const logger = options.logger ?? NOOP_LOGGER;
  await prepareSocketDirectory(endpoint);
  const sockets = new Map<Socket, { close(): void }>();
  let closing: Promise<void> | undefined;
  const listener = createServer((socket) => {
    if (closing !== undefined || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    const timeout = setTimeout(() => socket.destroy(), helloTimeoutMs);
    timeout.unref?.();
    const scoped: KernelServer = {
      connect(send, disconnect) {
        const connection = server.connect(send, disconnect);
        return {
          async handle(method, params, signal) {
            const result = await connection.handle(method, params, signal);
            if (method === M.hello) clearTimeout(timeout);
            return result;
          },
          close: () => connection.close(),
        };
      },
    };
    try {
      const pump = serveKernelOverStdio(scoped, { input: socket, output: socket }, logger);
      sockets.set(socket, pump);
      socket.once("close", () => {
        clearTimeout(timeout);
        pump.close();
        sockets.delete(socket);
      });
    } catch {
      clearTimeout(timeout);
      socket.destroy();
    }
  });
  listener.on("error", (error: NodeJS.ErrnoException) => {
    logger.warn("transport.local_listener_failed", { code: error.code ?? "unknown" });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    listener.once("error", failed);
    listener.listen({ path: endpoint, readableAll: false, writableAll: false }, () => {
      listener.off("error", failed);
      resolve();
    });
  });
  return {
    endpoint,
    connections: () => sockets.size,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const [socket, pump] of sockets) {
          pump.close();
          socket.destroy();
        }
        listener.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      return closing;
    },
  };
}

/** Connect a new local channel; use `connectKernelClient` to authenticate and negotiate the RPC. */
export async function connectLocalKernelTransport(
  endpoint: string,
  options: { timeoutMs?: number; logger?: Logger } = {},
): Promise<KernelTransport> {
  const timeoutMs = positive(options.timeoutMs ?? 5_000, "timeoutMs");
  const socket = createConnection({ path: endpoint });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(kernelError("unavailable", "local kernel connection timed out"));
      }, timeoutMs);
      const failed = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", failed);
        resolve();
      });
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
  const transport = createStdioTransport({ input: socket, output: socket }, options.logger);
  transport.onClose?.(() => socket.destroy());
  return {
    ...transport,
    async close() {
      await transport.close();
      socket.destroy();
    },
  };
}
