import { describe, expect, it } from "bun:test";
import {
  createServerStderrForwarder,
  drainStderrStream,
  DEFAULT_SERVER_STDERR_MAX_BYTES,
  type NodeStderrStream,
} from "../../src/server-stderr.ts";

function collect(maxBytes?: number): {
  push: (text: string) => void;
  flush: () => void;
  lines: string[];
  names: string[];
} {
  const lines: string[] = [];
  const names: string[] = [];
  const forwarder = createServerStderrForwarder({
    mcp: "github",
    sink: (mcp, line) => {
      names.push(mcp);
      lines.push(line);
    },
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return {
    push: (text: string): void => forwarder.push(text),
    flush: (): void => forwarder.flush(),
    lines,
    names,
  };
}

describe("server stderr forwarder", () => {
  it("releases a line only once it is whole", () => {
    const { push, lines } = collect();
    push("Error: GITHUB_");
    expect(lines).toEqual([]);
    push("TOKEN unset\n");
    expect(lines).toEqual(["Error: GITHUB_TOKEN unset"]);
  });

  it("attributes every line to the server that wrote it", () => {
    const { push, names } = collect();
    push("a\nb\n");
    expect(names).toEqual(["github", "github"]);
  });

  it("splits several lines arriving in one chunk", () => {
    const { push, lines } = collect();
    push("first\nsecond\nthird\n");
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("strips a carriage return so a Windows server does not log one", () => {
    const { push, lines } = collect();
    push("windows line\r\n");
    expect(lines).toEqual(["windows line"]);
  });

  it("drops blank lines rather than forwarding empty records", () => {
    const { push, lines } = collect();
    push("\n\nreal\n\n");
    expect(lines).toEqual(["real"]);
  });

  it("releases an unterminated tail on flush", () => {
    const { push, flush, lines } = collect();
    push("no trailing newline");
    expect(lines).toEqual([]);
    flush();
    expect(lines).toEqual(["no trailing newline"]);
  });

  it("strips a carriage return from a flushed tail too", () => {
    const { push, flush, lines } = collect();
    push("tail\r");
    flush();
    expect(lines).toEqual(["tail"]);
  });

  it("flushing with nothing pending emits nothing", () => {
    const { push, flush, lines } = collect();
    push("done\n");
    flush();
    flush();
    expect(lines).toEqual(["done"]);
  });

  it("stops after the ceiling, saying so exactly once", () => {
    const { push, lines } = collect(10);
    push("0123456789\n");
    push("dropped\n");
    push("also dropped\n");
    expect(lines).toEqual(["0123456789", "[further stderr suppressed after 10 characters]"]);
  });

  it("ignores a flush once suppressed", () => {
    const { push, flush, lines } = collect(4);
    push("abcd\n");
    push("efgh\n");
    push("pending tail");
    flush();
    expect(lines).toEqual(["abcd", "[further stderr suppressed after 4 characters]"]);
  });

  it("releases a runaway line with no newline rather than buffering it forever", () => {
    const { push, lines } = collect(1_000_000);
    push("x".repeat(9_000));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(9_000);
  });

  it("defaults its ceiling to 64 KiB", () => {
    expect(DEFAULT_SERVER_STDERR_MAX_BYTES).toBe(64 * 1024);
    const { push, lines } = collect();
    push(`${"y".repeat(100)}\n`);
    expect(lines).toEqual(["y".repeat(100)]);
  });
});

describe("draining a Node stdio transport's stderr", () => {
  function fakeStream(): {
    stream: NodeStderrStream;
    emit: (event: "data" | "end" | "close", chunk?: Uint8Array | string) => void;
  } {
    const listeners = new Map<string, ((chunk?: Uint8Array | string) => void)[]>();
    const stream: NodeStderrStream = {
      on(event: string, listener: (chunk?: Uint8Array | string) => void) {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
        return stream;
      },
    } as NodeStderrStream;
    return {
      stream,
      emit: (event, chunk) => {
        for (const listener of listeners.get(event) ?? []) listener(chunk);
      },
    };
  }

  function forwarderInto(lines: string[]) {
    return createServerStderrForwarder({ mcp: "local", sink: (_mcp, line) => lines.push(line) });
  }

  it("does nothing when the transport piped no stderr", () => {
    expect(() => {
      drainStderrStream(null, forwarderInto([]));
      drainStderrStream(undefined, forwarderInto([]));
    }).not.toThrow();
  });

  it("decodes byte chunks, including a multi-byte character split across two", () => {
    const lines: string[] = [];
    const { stream, emit } = fakeStream();
    drainStderrStream(stream, forwarderInto(lines));
    const encoded = new TextEncoder().encode("café\n");
    emit("data", encoded.slice(0, 4));
    emit("data", encoded.slice(4));
    expect(lines).toEqual(["café"]);
  });

  it("accepts an already-decoded string chunk", () => {
    const lines: string[] = [];
    const { stream, emit } = fakeStream();
    drainStderrStream(stream, forwarderInto(lines));
    emit("data", "plain\n");
    expect(lines).toEqual(["plain"]);
  });

  it("flushes an unterminated tail when the stream ends", () => {
    const lines: string[] = [];
    const { stream, emit } = fakeStream();
    drainStderrStream(stream, forwarderInto(lines));
    emit("data", "no newline");
    emit("end");
    expect(lines).toEqual(["no newline"]);
  });

  it("flushes on close, which is all a killed child emits", () => {
    const lines: string[] = [];
    const { stream, emit } = fakeStream();
    drainStderrStream(stream, forwarderInto(lines));
    emit("data", "killed mid-line");
    emit("close");
    expect(lines).toEqual(["killed mid-line"]);
  });

  it("settles once, so end followed by close does not double-flush", () => {
    const lines: string[] = [];
    const { stream, emit } = fakeStream();
    drainStderrStream(stream, forwarderInto(lines));
    emit("data", "tail");
    emit("end");
    emit("close");
    expect(lines).toEqual(["tail"]);
  });

  it("releases a dangling incomplete multi-byte sequence at end", () => {
    const lines: string[] = [];
    const { stream, emit } = fakeStream();
    drainStderrStream(stream, forwarderInto(lines));
    emit("data", new TextEncoder().encode("café").slice(0, 4));
    emit("end");
    expect(lines).toEqual(["caf�"]);
  });
});
