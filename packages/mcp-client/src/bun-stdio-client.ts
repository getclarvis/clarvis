import { extname } from "node:path";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { executableOnPath } from "@clarvis/paths";
import type { Logger } from "@clarvis/capability";
import { NOOP_LOGGER, suppressSecondaryRejection } from "@clarvis/capability";

/** Extensions Windows will not spawn directly, and must route through `cmd`. */
const WINDOWS_SHELL_SCRIPTS = new Set([".cmd", ".bat"]);

/**
 * The argv that actually launches an MCP server on this host.
 *
 * @param command - the configured command, typically a bare name.
 * @param args - its configured arguments.
 * @param platform - host platform; injectable for tests.
 * @returns the argv to hand to `Bun.spawn`.
 * @remarks
 * On Windows the common MCP launchers - `npx`, `bunx`, `pnpm dlx` - are `.cmd`
 * shims, and a `.cmd` cannot be spawned directly: that path was closed as the
 * mitigation for a command-injection vulnerability in how arguments reached it.
 * Left unhandled, every `command: "npx"` server in a user's settings fails to
 * start with a bare `ENOENT`, on a host where `npx` plainly works in a terminal.
 *
 * `cmd /d /s /c` with the whole line quoted is the documented way to pass a path
 * containing spaces, and `windowsVerbatimArguments` stops the runtime re-quoting
 * a line `cmd` will parse itself.
 *
 * @throws {@link Error} if `command` or any argument contains a double quote.
 *   The line is parsed twice - once by `cmd.exe` itself, then again by the
 *   child's own argv parser - and those two parsers disagree on how an escaped
 *   quote is spelled. Guessing an escaping that satisfies both would silently
 *   hand the child a different argv than configured; refusing outright is
 *   safer than a corrupted command line that fails to start, or fails subtly,
 *   for a reason nothing here can explain. No real MCP server config needs a
 *   literal quote in a command or argument.
 */
export function mcpSpawnArgv(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { argv: string[]; verbatim: boolean } {
  if (platform !== "win32") return { argv: [command, ...args], verbatim: false };
  const resolved = executableOnPath(command, process.env.PATH, "win32") ?? command;
  if (!WINDOWS_SHELL_SCRIPTS.has(extname(resolved).toLowerCase())) {
    return { argv: [resolved, ...args], verbatim: false };
  }
  const parts = [resolved, ...args];
  const quoted = parts.find((part) => part.includes('"'));
  if (quoted !== undefined) {
    throw new Error(
      `MCP server command/argument contains a double quote, which cannot be passed ` +
        `safely through cmd.exe on Windows: ${quoted}`,
    );
  }
  const line = parts.map((a) => `"${a}"`).join(" ");
  return { argv: [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", line], verbatim: true };
}

/**
 * Spawn parameters for a {@link BunStdioClientTransport}: the `command` and
 * `args` to launch, optional `cwd`/`env` (env defaults to `process.env`), an
 * optional `onStderr` sink (child stderr is forwarded to the parent's stderr
 * when omitted) and the `onStderrEnd` settle signal that goes with it.
 */
export interface BunStdioClientParameters {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  onStderr?: (text: string) => void;
  /**
   * Called once when the child's stderr stream has ended, whether it drained
   * cleanly, faulted, or the child died.
   *
   * @remarks A stdio server's last words are frequently unterminated —
   *   `process.stderr.write("fatal: API key unset")` and then exit — and a
   *   line-oriented forwarder holds that text until something tells it there
   *   will be no newline. The SDK's Node transport gives its consumer an `end`
   *   to hang that on; this transport had no equivalent, so the one line worth
   *   reading was the one line always lost.
   */
  onStderrEnd?: () => void;
  /** Internal/test sink; defaults to the parent process stderr. */
  stderrWritable?: BunStderrWritable;
  /** Largest newline-delimited JSON-RPC frame accepted from stdout. */
  maxFrameBytes?: number;
  /** Grace period before an unresponsive child receives `SIGTERM`. */
  closeGraceMs?: number;
  /** Grace period after `SIGTERM` before the child receives `SIGKILL`. */
  terminateGraceMs?: number;
  /**
   * Where a refused frame is reported.
   *
   * @remarks Expected to carry this connection's `mcp` binding already; this
   *   transport is handed spawn parameters, not a server config, so it cannot
   *   name the server itself.
   */
  logger?: Logger;
}

/** Minimal backpressure surface required from the parent stderr sink. */
export interface BunStderrWritable {
  write(text: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "drain", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** Default maximum size of one inbound newline-delimited JSON-RPC frame (16 MiB). */
export const DEFAULT_MCP_STDIO_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const DEFAULT_TERMINATE_GRACE_MS = 500;

/** A hostile or broken stdio peer sent a frame too large to retain safely. */
export class MCPStdioFrameLimitError extends Error {
  readonly code = "mcp_stdio_frame_too_large" as const;
  constructor(readonly limit: number) {
    super(`MCP stdio frame exceeds the ${String(limit)}-byte limit.`);
    this.name = "MCPStdioFrameLimitError";
  }
}

/**
 * A Bun-native stdio MCP {@link Transport}: runs the server as a `Bun.spawn`
 * subprocess and frames newline-delimited JSON-RPC over its stdin/stdout. Used
 * in place of the SDK's Node-based stdio transport when running under Bun (see
 * {@link buildTransport}).
 *
 * @remarks Inbound bytes are buffered and split on `\n` (a trailing `\r` is
 *   stripped) with each line parsed via {@link JSONRPCMessageSchema} before
 *   `onmessage`; a parse or stream error surfaces on `onerror`. `close` ends
 *   stdin, waits up to 2s for a clean exit, then escalates through `SIGTERM`
 *   and `SIGKILL`, awaiting the child and both readers before resolving.
 *   `onclose` fires exactly once, on the first of subprocess exit or `close`.
 */
export class BunStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly frameChunks: Uint8Array[] = [];
  private frameBytes = 0;
  private closed = false;
  private discardStderr = false;
  private readonly stderrDrainReleases = new Set<() => void>();
  private process?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readers: Promise<void>[] = [];
  private closePromise?: Promise<void>;

  constructor(private readonly parameters: BunStdioClientParameters) {}

  /**
   * Spawn the subprocess and begin reading its stdout (messages) and stderr.
   *
   * @returns a resolved promise once the child is spawned and readers are armed.
   * @throws {@link Error} if called after the transport has already started.
   */
  start(): Promise<void> {
    if (this.process) throw new Error("BunStdioClientTransport already started");

    const { argv, verbatim } = mcpSpawnArgv(this.parameters.command, this.parameters.args ?? []);
    this.process = Bun.spawn(argv, {
      cwd: this.parameters.cwd,
      env: this.parameters.env ?? process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      onExit: (_process, _exitCode, _signalCode, error) => {
        if (error) this.onerror?.(error);
        this.finish();
      },
    });

    this.readers = [this.readMessages(this.process.stdout), this.readStderr(this.process.stderr)];
    for (const reader of this.readers) {
      suppressSecondaryRejection(reader, "transport.onerror");
    }
    return Promise.resolve();
  }

  /**
   * Write one JSON-RPC message to the child's stdin as a single newline-framed
   * line, then flush.
   *
   * @param message - the message to send.
   * @throws {@link Error} `"Not connected"` if the transport is not started.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.process?.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("Not connected");
    await stdin.write(`${JSON.stringify(message)}\n`);
    await stdin.flush();
  }

  /**
   * Shut the transport down: end the child's stdin, wait up to 2s for a graceful
   * exit, then `SIGTERM` if it has not exited, and fire `onclose` (once).
   */
  async close(): Promise<void> {
    this.closePromise ??= this.closeInner();
    return this.closePromise;
  }

  private async readMessages(stdout: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stdout) {
        let start = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          this.appendFrameChunk(chunk.subarray(start, index));
          this.emitFrame();
          start = index + 1;
        }
        this.appendFrameChunk(chunk.subarray(start));
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      suppressSecondaryRejection(this.close(), "transport.onerror");
    }
  }

  private appendFrameChunk(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const next = this.frameBytes + chunk.length;
    const limit = this.parameters.maxFrameBytes ?? DEFAULT_MCP_STDIO_MAX_FRAME_BYTES;
    if (next > limit) {
      (this.parameters.logger ?? NOOP_LOGGER).error(
        { event: "mcp.transport.frame_limit", limit, observed: next },
        "mcp server sent a json-rpc frame larger than the transport retains; the connection is " +
          "torn down and its tools stop answering",
      );
      throw new MCPStdioFrameLimitError(limit);
    }
    // `subarray` would keep the stream's whole backing chunk alive for a tiny
    // trailing fragment. Copy only the bytes charged to this bounded frame.
    this.frameChunks.push(chunk.slice());
    this.frameBytes = next;
  }

  private emitFrame(): void {
    if (this.frameBytes === 0) return;
    const bytes = new Uint8Array(this.frameBytes);
    let offset = 0;
    for (const chunk of this.frameChunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    this.frameChunks.length = 0;
    this.frameBytes = 0;
    const end = bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
    if (end === 0) return;
    const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
  }

  private async readStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stderr) {
        const text = decoder.decode(chunk, { stream: true });
        if (this.parameters.onStderr) this.parameters.onStderr(text);
        else await this.writeStderr(text);
      }
      const tail = decoder.decode();
      if (tail.length > 0) {
        if (this.parameters.onStderr) this.parameters.onStderr(tail);
        else await this.writeStderr(tail);
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.parameters.onStderrEnd?.();
    }
  }

  private async writeStderr(text: string): Promise<void> {
    if (this.closed || this.discardStderr) return;
    const writable: BunStderrWritable = this.parameters.stderrWritable ?? process.stderr;
    if (writable.write(text)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        this.stderrDrainReleases.delete(onDrain);
        writable.off("drain", onDrain);
        writable.off("error", onError);
      };
      this.stderrDrainReleases.add(onDrain);
      writable.once("drain", onDrain);
      writable.once("error", onError);
    });
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseStderrDrainWaiters();
    this.onclose?.();
  }

  private releaseStderrDrainWaiters(): void {
    for (const release of [...this.stderrDrainReleases]) release();
  }

  private async closeInner(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (child !== undefined) {
      if (child.stdin && typeof child.stdin !== "number") {
        await Promise.resolve(child.stdin.end()).catch(() => undefined);
      }
      if (
        !(await this.waitForExit(child, this.parameters.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS))
      ) {
        child.kill("SIGTERM");
        if (
          !(await this.waitForExit(
            child,
            this.parameters.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
          ))
        ) {
          child.kill("SIGKILL");
          await child.exited.catch(() => undefined);
        }
      }
    }
    // Once the child has exited there is no reason to let a permanently
    // backpressured parent stderr keep transport teardown alive. Existing
    // waiters are released and any already-buffered pipe tail is discarded.
    this.discardStderr = true;
    this.releaseStderrDrainWaiters();
    await Promise.allSettled(this.readers);
    this.frameChunks.length = 0;
    this.frameBytes = 0;
    this.finish();
  }

  private async waitForExit(
    child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
