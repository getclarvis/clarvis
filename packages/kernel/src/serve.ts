import type { Readable, Writable } from "node:stream";
import { createFileKernel, type CreateFileKernelOptions } from "./file-kernel.ts";
import { createKernelServer } from "./transport/server.ts";
import { serveKernelOverStdio } from "./transport/stdio.ts";

/**
 * Options for {@link serveFileKernelOverStdio}: file-kernel setup plus optional stdio streams.
 */
export interface ServeStdioOptions extends CreateFileKernelOptions {
  /** Inbound request stream; defaults to `process.stdin`. */
  input?: Readable;
  /** Outbound response/notification stream; defaults to `process.stdout`. */
  output?: Writable;
}

/** Handle returned while a file kernel is served over stdio. */
export interface ServeHandle {
  /** Stops the stdio pump and closes the underlying kernel. */
  close(): Promise<void>;
}

/**
 * The pino destination symbol, found by description rather than by import.
 *
 * @remarks `@clarvis/kernel` does not depend on pino and should not start:
 * `createLogger` is `@clarvis/loop`'s, and the {@link Logger} port deliberately
 * says nothing about where a record goes. The symbol's description is stable
 * across pino's major versions and an unrecognized backend simply reports no
 * descriptor, which degrades to the previous behaviour rather than to a false
 * refusal.
 */
const PINO_STREAM_SYMBOL = "Symbol(pino.stream)";

/**
 * The file descriptor a logger ultimately writes to, when it will say.
 *
 * @param logger - the caller-supplied logger, of unknown backing.
 * @returns the descriptor, or `undefined` for a logger that exposes none.
 * @remarks The whole prototype chain is walked, not the object's own symbols.
 *   A pino **child** is `Object.create(parent)` and owns only `chindings` and
 *   `formatters`; its stream lives on the ancestor it inherits from. Reading
 *   own symbols alone therefore admitted exactly the logger the composition
 *   root is told to build — `createLogger(level, { destination: 1 })
 *   .child({ component })` — and let it interleave records with the frames.
 *   Nearest definition wins, so a child that rebinds its own stream is read as
 *   that stream rather than as its parent's.
 */
function loggerDescriptor(logger: unknown): number | undefined {
  let node: unknown = logger;
  while (typeof node === "object" && node !== null) {
    for (const key of Object.getOwnPropertySymbols(node)) {
      if (key.toString() !== PINO_STREAM_SYMBOL) continue;
      return descriptorOf((node as Record<symbol, unknown>)[key]);
    }
    node = Object.getPrototypeOf(node) as unknown;
  }
  return undefined;
}

/** The `fd` a stream-like value carries, when it carries one. */
function descriptorOf(stream: unknown): number | undefined {
  if (typeof stream !== "object" || stream === null) return undefined;
  const fd = (stream as { fd?: unknown }).fd;
  return typeof fd === "number" ? fd : undefined;
}

/**
 * Refuse a logger that would write into this server's own wire.
 *
 * @param opts - the serve options, read for `logger` and `output`.
 * @throws an `Error` when the logger's descriptor is the one the NDJSON frames
 *   go to.
 * @remarks `CreateLoggerOptions.destination = 1` exists and this function's
 *   options pass straight through to `createFileKernel`, so a caller supplying
 *   `createLogger(level, { destination: 1 })` used to interleave pino records
 *   with the frames — corrupting every one of them, on the one channel the peer
 *   has no other way to read. Failing at construction is the only place this can
 *   be caught: once the pump starts, the corruption looks like a peer that sends
 *   malformed JSON.
 */
function refuseLoggerOnWire(opts: ServeStdioOptions): void {
  const fd = loggerDescriptor(opts.logger);
  if (fd === undefined) return;
  const wire = opts.output === undefined ? 1 : descriptorOf(opts.output);
  if (wire === undefined || wire !== fd) return;
  throw new Error(
    `serveFileKernelOverStdio: the supplied logger writes to file descriptor ${String(fd)}, ` +
      "which is this server's own NDJSON wire; give it a different destination",
  );
}

/**
 * Creates a file-backed kernel and serves it over newline-delimited JSON stdio.
 *
 * @param opts - file-kernel setup plus optional stdio streams; see {@link ServeStdioOptions}.
 * @returns a {@link ServeHandle} whose `close` stops the pump and closes the kernel.
 * @throws an `Error` before constructing anything when `opts.logger` writes to
 *   the same descriptor as the wire; see {@link refuseLoggerOnWire}.
 * @remarks Agent tools are advertised as a server capability unless the
 *   environment sets `CLARVIS_AGENT_TOOLS_ENABLED=false`.
 */
export async function serveFileKernelOverStdio(opts: ServeStdioOptions): Promise<ServeHandle> {
  refuseLoggerOnWire(opts);
  const kernel = await createFileKernel(opts);
  const server = createKernelServer(kernel, {
    capabilities: { agent_tools: process.env.CLARVIS_AGENT_TOOLS_ENABLED !== "false" },
  });
  const pump = serveKernelOverStdio(
    server,
    {
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout,
    },
    opts.logger,
  );
  kernel.startMemoryRecovery();
  return {
    async close(): Promise<void> {
      pump.close();
      await kernel.close();
    },
  };
}
