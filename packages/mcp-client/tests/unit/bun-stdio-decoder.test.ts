import { describe, expect, it } from "bun:test";
import { BunStdioClientTransport, MCPStdioFrameLimitError } from "@clarvis/mcp-client";
import { EventEmitter } from "node:events";

interface PrivateStreamReaders {
  readMessages(stream: ReadableStream<Uint8Array>): Promise<void>;
  readStderr(stream: ReadableStream<Uint8Array>): Promise<void>;
  writeStderr(text: string): Promise<void>;
  process?: unknown;
}

function asPrivate(transport: BunStdioClientTransport): PrivateStreamReaders {
  return transport as unknown as PrivateStreamReaders;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function splitMidCharacter(
  text: string,
  character: string,
): { chunk1: Uint8Array; chunk2: Uint8Array } {
  const bytes = new TextEncoder().encode(text);
  const charIndex = text.indexOf(character);
  if (charIndex === -1) throw new Error(`fixture text does not contain ${character}`);
  const offset = new TextEncoder().encode(text.slice(0, charIndex)).length;
  const splitAt = offset + 2;
  return { chunk1: bytes.slice(0, splitAt), chunk2: bytes.slice(splitAt) };
}

const OUT_EMOJI = "\u{1F389}";
const ERR_EMOJI = "\u{1F38A}";

describe("BunStdioClientTransport UTF-8 decoding across pipe chunk boundaries", () => {
  it("rejects an unterminated frame before retaining more than its byte budget", async () => {
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      maxFrameBytes: 8,
    });
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);

    await asPrivate(transport).readMessages(
      streamOf(new TextEncoder().encode("12345"), new TextEncoder().encode("6789")),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MCPStdioFrameLimitError);
  });

  it("reconstructs a character whose 4-byte UTF-8 encoding is split across two stdout chunks", async () => {
    const notification = {
      jsonrpc: "2.0" as const,
      method: "notifications/message",
      params: { data: `before ${OUT_EMOJI} after` },
    };
    const line = `${JSON.stringify(notification)}\n`;
    const { chunk1, chunk2 } = splitMidCharacter(line, OUT_EMOJI);

    const transport = new BunStdioClientTransport({ command: "unused-in-test" });
    const received: unknown[] = [];
    transport.onmessage = (message) => received.push(message);

    await asPrivate(transport).readMessages(streamOf(chunk1, chunk2));

    expect(received).toHaveLength(1);
    const params = (received[0] as { params: { data: string } }).params;
    expect(params.data).toBe(`before ${OUT_EMOJI} after`);
  });

  it("reconstructs a character whose 4-byte UTF-8 encoding is split across two stderr chunks", async () => {
    const text = `warning: ${ERR_EMOJI} reconnecting\n`;
    const { chunk1, chunk2 } = splitMidCharacter(text, ERR_EMOJI);

    let seen = "";
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      onStderr: (chunk) => {
        seen += chunk;
      },
    });

    await asPrivate(transport).readStderr(streamOf(chunk1, chunk2));

    expect(seen).toBe(text);
  });

  it("settles the stderr sink exactly once when the stream ends cleanly", async () => {
    let ends = 0;
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      onStderr: () => {},
      onStderrEnd: () => {
        ends += 1;
      },
    });

    await asPrivate(transport).readStderr(streamOf(new TextEncoder().encode("no newline here")));

    expect(ends).toBe(1);
  });

  it("settles the stderr sink when the stream faults", async () => {
    let ends = 0;
    const errors: Error[] = [];
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      onStderr: () => {},
      onStderrEnd: () => {
        ends += 1;
      },
    });
    transport.onerror = (error) => errors.push(error);

    await asPrivate(transport).readStderr(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("pipe broke"));
        },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(ends).toBe(1);
  });

  it("stops consuming child stderr until the parent writable drains", async () => {
    class BlockingWritable extends EventEmitter {
      readonly writes: string[] = [];
      write(text: string): boolean {
        this.writes.push(text);
        return this.writes.length > 1;
      }
    }
    const writable = new BlockingWritable();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("first"));
        else if (pulls === 2) controller.enqueue(new TextEncoder().encode("second"));
        else controller.close();
      },
    });
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      stderrWritable: writable,
    });

    const reading = asPrivate(transport).readStderr(stream);
    for (let spins = 0; spins < 10 && writable.writes.length === 0; spins += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(writable.writes).toEqual(["first"]);
    expect(pulls).toBeLessThanOrEqual(2);
    writable.emit("drain");
    await reading;
    expect(writable.writes).toEqual(["first", "second"]);
  });

  it("does not let a missing stderr drain keep transport close pending", async () => {
    class BlockedWritable extends EventEmitter {
      write(): boolean {
        return false;
      }
    }
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      stderrWritable: new BlockedWritable(),
    });
    const reading = asPrivate(transport).readStderr(
      streamOf(new TextEncoder().encode("blocked forever")),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    await transport.close();
    await reading;
  });

  it("rejects a backpressured stderr write when the parent sink faults", async () => {
    class FaultingWritable extends EventEmitter {
      write(): boolean {
        return false;
      }
    }
    const writable = new FaultingWritable();
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      stderrWritable: writable,
    });
    const writing = asPrivate(transport).writeStderr("blocked");
    writable.emit("error", new Error("parent stderr failed"));
    await expect(writing).rejects.toThrow("parent stderr failed");
  });

  it("swallows stdin and terminal-exit rejections during forced close", async () => {
    let rejectExit!: (error: Error) => void;
    const exited = new Promise<number>((_resolve, reject) => {
      rejectExit = reject;
    });
    const signals: string[] = [];
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      closeGraceMs: 0,
      terminateGraceMs: 0,
    });
    asPrivate(transport).process = {
      stdin: { end: () => Promise.reject(new Error("stdin already closed")) },
      exited,
      kill(signal: string) {
        signals.push(signal);
        if (signal === "SIGKILL") rejectExit(new Error("killed"));
      },
    };

    await transport.close();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps the stdout and stderr decoders independent under interleaved concurrent reads", async () => {
    const notification = {
      jsonrpc: "2.0" as const,
      method: "notifications/message",
      params: { data: `stdout ${OUT_EMOJI} tail` },
    };
    const outLine = `${JSON.stringify(notification)}\n`;
    const errText = `stderr ${ERR_EMOJI} tail\n`;
    const out = splitMidCharacter(outLine, OUT_EMOJI);
    const err = splitMidCharacter(errText, ERR_EMOJI);

    let outController!: ReadableStreamDefaultController<Uint8Array>;
    let errController!: ReadableStreamDefaultController<Uint8Array>;
    const outStream = new ReadableStream<Uint8Array>({
      start(controller) {
        outController = controller;
      },
    });
    const errStream = new ReadableStream<Uint8Array>({
      start(controller) {
        errController = controller;
      },
    });

    const received: unknown[] = [];
    let errAcc = "";
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      onStderr: (chunk) => {
        errAcc += chunk;
      },
    });
    transport.onmessage = (message) => received.push(message);

    const outDone = asPrivate(transport).readMessages(outStream);
    const errDone = asPrivate(transport).readStderr(errStream);

    outController.enqueue(out.chunk1);
    errController.enqueue(err.chunk1);
    outController.enqueue(out.chunk2);
    outController.close();
    errController.enqueue(err.chunk2);
    errController.close();

    await Promise.all([outDone, errDone]);

    expect(received).toHaveLength(1);
    const params = (received[0] as { params: { data: string } }).params;
    expect(params.data).toBe(`stdout ${OUT_EMOJI} tail`);
    expect(errAcc).toBe(errText);
  });
});
