/** Receives one complete line an MCP server wrote to its own stderr. */
export type ServerStderrSink = (mcp: string, line: string) => void;

/** Default ceiling on how much of one connection's stderr is forwarded. */
export const DEFAULT_SERVER_STDERR_MAX_BYTES = 64 * 1024;

/**
 * Largest partial line held while waiting for a newline.
 *
 * @remarks A server that writes without ever terminating a line must not be
 * able to grow this buffer without bound; past the limit the pending text is
 * released as a line of its own.
 */
const MAX_PENDING_CHARS = 8 * 1024;

/** Options for {@link createServerStderrForwarder}. */
export interface ServerStderrForwarderOptions {
  /** The server's declared name, so a line can be attributed. */
  mcp: string;
  /** Where a complete line goes. */
  sink: ServerStderrSink;
  /** Ceiling on forwarded characters; defaults to {@link DEFAULT_SERVER_STDERR_MAX_BYTES}. */
  maxBytes?: number;
}

/** Accepts raw stderr chunks and releases whole lines. */
export interface ServerStderrForwarder {
  /** Absorb one decoded chunk. */
  push(text: string): void;
  /** Release any unterminated trailing text; call once at close. */
  flush(): void;
}

/**
 * Forward an MCP server's own stderr as whole, bounded, attributed lines.
 *
 * @param options - see {@link ServerStderrForwarderOptions}.
 * @returns a {@link ServerStderrForwarder}.
 * @remarks A stdio server's stderr is frequently the only place its real failure
 *   is stated — a missing credential, a bad argument, a stack trace — and it was
 *   previously written straight to the host's own stderr, because the
 *   `onStderr` hook existed and no caller passed one. Under the terminal UI that
 *   painted over the frame; routing it through a sink is what lets a silenced
 *   host actually silence it.
 *
 *   Chunks arrive at decoder boundaries, not line boundaries, so a raw forward
 *   would interleave fragments of one line with records from elsewhere. Past
 *   `maxBytes` one suppression line is emitted and the rest is dropped: a broken
 *   server can produce megabytes, and the failure worth reading is almost always
 *   in the first few lines rather than the last.
 */
export function createServerStderrForwarder(
  options: ServerStderrForwarderOptions,
): ServerStderrForwarder {
  const maxBytes = options.maxBytes ?? DEFAULT_SERVER_STDERR_MAX_BYTES;
  let pending = "";
  let forwarded = 0;
  let suppressed = false;

  const emit = (line: string): void => {
    if (suppressed || line.length === 0) return;
    if (forwarded >= maxBytes) {
      suppressed = true;
      options.sink(options.mcp, `[further stderr suppressed after ${String(maxBytes)} characters]`);
      return;
    }
    forwarded += line.length;
    options.sink(options.mcp, line);
  };

  return {
    push(text: string): void {
      if (suppressed) return;
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        emit(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_PENDING_CHARS) {
        emit(pending);
        pending = "";
      }
    },
    flush(): void {
      if (pending.length === 0) return;
      const tail = pending;
      pending = "";
      emit(tail.replace(/\r$/, ""));
    },
  };
}

/** The part of a Node readable stream {@link drainStderrStream} uses. */
export interface NodeStderrStream {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
}

/**
 * Drain a Node stdio transport's piped stderr into a forwarder.
 *
 * @param stream - the transport's `stderr`, when it was constructed with
 *   `stderr: "pipe"`.
 * @param forwarder - the sink for its whole lines.
 * @remarks Only the Bun transport takes an `onStderr` callback; the SDK's Node
 *   transport exposes a stream instead, and — because `parameters.stderr` was
 *   never set — defaulted to `"inherit"`, handing the child the host's own
 *   terminal with no layer able to capture it. Reading it here is what makes the
 *   two paths behave alike.
 *
 *   `end` and `close` both settle, because a killed child emits only the second;
 *   whichever arrives first flushes, and the other is ignored.
 */
export function drainStderrStream(
  stream: NodeStderrStream | null | undefined,
  forwarder: ServerStderrForwarder,
): void {
  if (!stream) return;
  const decoder = new TextDecoder();
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    const tail = decoder.decode();
    if (tail.length > 0) forwarder.push(tail);
    forwarder.flush();
  };
  stream.on("data", (chunk) => {
    forwarder.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  });
  stream.on("end", finish);
  stream.on("close", finish);
}
