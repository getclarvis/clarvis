import { describe, expect, test } from "bun:test";
import { installTerminalGuard } from "../../src/adapters/terminal-guard.ts";

function captureStderr(): { written: string[]; restore: () => void } {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    written,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

test("the guard withholds writes while the canvas owns the terminal, then flushes them", () => {
  const sink = captureStderr();
  try {
    const release = installTerminalGuard();
    process.stderr.write('{"level":30,"service":"@clarvis/loop"}\n');
    process.stderr.write("a stack trace\n");
    expect(sink.written).toEqual([]);
    release();
    expect(sink.written.join("")).toBe(
      '{"level":30,"service":"@clarvis/loop"}\n' + "a stack trace\n",
    );
  } finally {
    sink.restore();
  }
});

test("releasing twice neither restores a guard nor reprints its buffer", () => {
  const sink = captureStderr();
  try {
    const release = installTerminalGuard();
    process.stderr.write("once\n");
    release();
    release();
    expect(sink.written.join("")).toBe("once\n");
  } finally {
    sink.restore();
  }
});

test("the guard drops the oldest bytes rather than growing without bound", () => {
  const sink = captureStderr();
  try {
    const release = installTerminalGuard();
    for (let i = 0; i < 400; i++) process.stderr.write("x".repeat(1024));
    process.stderr.write("TAIL");
    release();
    const flushed = sink.written.join("");
    expect(flushed.endsWith("TAIL")).toBe(true);
    expect(flushed.length).toBeLessThanOrEqual(64 * 1024 + 1024);
  } finally {
    sink.restore();
  }
});

test("a write callback still runs, so a caller awaiting drain is not stranded", () => {
  const sink = captureStderr();
  try {
    const release = installTerminalGuard();
    let called = false;
    process.stderr.write("held\n", () => {
      called = true;
    });
    expect(called).toBe(true);
    release();
  } finally {
    sink.restore();
  }
});

describe("console methods", () => {
  test("withholds console.warn and console.error, which do not route through process.stderr.write", () => {
    const sink = captureStderr();
    try {
      const release = installTerminalGuard();
      // The gap this closes: in Bun these reach the terminal even with
      // process.stderr.write replaced. @opentui/core's reconciler emits exactly
      // this shape on a render race.
      console.warn("<id>::lead:4#reasoning being inserted, skipping insertBefore");
      console.error("and an error");
      console.log("and stdout noise");
      expect(sink.written).toEqual([]);
      release();
      const flushed = sink.written.join("");
      expect(flushed).toContain("skipping insertBefore");
      expect(flushed).toContain("and an error");
      expect(flushed).toContain("and stdout noise");
    } finally {
      sink.restore();
    }
  });

  test("formats console arguments rather than dropping all but the first", () => {
    const sink = captureStderr();
    try {
      const release = installTerminalGuard();
      console.warn("count=%d name=%s", 3, "leader");
      console.warn("object", { a: 1 });
      release();
      const flushed = sink.written.join("");
      expect(flushed).toContain("count=3 name=leader");
      expect(flushed).toContain("a: 1");
    } finally {
      sink.restore();
    }
  });

  test("restores every console method it took", () => {
    const before = { warn: console.warn, log: console.log, error: console.error };
    const release = installTerminalGuard();
    expect(console.warn).not.toBe(before.warn);
    release();
    expect(console.warn).toBe(before.warn);
    expect(console.log).toBe(before.log);
    expect(console.error).toBe(before.error);
  });
});
