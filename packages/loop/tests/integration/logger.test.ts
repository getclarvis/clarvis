import { symbols } from "pino";
import { describe, it, expect, vi } from "../bun-test.ts";
import { createLogger } from "../../src/logger.ts";

/**
 * Destroys the real stdout-bound SonicBoom destination a `destination: 1`
 * logger creates, via pino's own publicly-exported `symbols.streamSym`.
 *
 * @remarks `createLogger`'s stdout branch calls `pino(options)` with no stream
 *   argument, so pino builds a brand-new `SonicBoom` around fd 1 every time —
 *   there is no reuse/pooling. Left undestroyed, that handle stays alive (and
 *   its write-readiness watch registered) for the rest of the process; over a
 *   large test run that has repeatedly proved enough to collide with a later,
 *   unrelated fd-1 write elsewhere (observed as a `WriteStream` construction
 *   failing with `EEXIST` on `epoll_ctl` deep in Bun's runtime). Production
 *   code never hits this: `createLogger` is called once per process and the
 *   destination lives for the process's whole lifetime.
 */
function destroyStdoutDestination(logger: ReturnType<typeof createLogger>): void {
  const withStream = logger as unknown as { [symbols.streamSym]: { destroy(): void } };
  withStream[symbols.streamSym].destroy();
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("createLogger", () => {
  it("honours the requested level on the default (stderr) destination", () => {
    const logger = createLogger("warn");
    expect(logger.level).toBe("warn");
    expect(typeof logger.info).toBe("function");
    expect(() => logger.warn({ a: 1 }, "hello")).not.toThrow();
  });

  it("defaults to level 'info' when none is supplied", () => {
    expect(createLogger().level).toBe("info");
  });

  it("routes to stdout (not stderr) when destination is 1", () => {
    let logger!: ReturnType<typeof createLogger>;
    const onStderr = captureStderr(() => {
      logger = createLogger("debug", { destination: 1 });
      logger.debug({ n: 2 }, "on stdout");
    });
    expect(logger.level).toBe("debug");
    expect(typeof logger.child).toBe("function");
    expect(onStderr).not.toContain("on stdout");
    destroyStdoutDestination(logger);
  });

  it("routes to stderr for the explicit destination 2", () => {
    let logger!: ReturnType<typeof createLogger>;
    const onStderr = captureStderr(() => {
      logger = createLogger("error", { destination: 2 });
      logger.error({ e: true }, "on stderr");
    });
    expect(logger.level).toBe("error");
    expect(onStderr).toContain("on stderr");
  });
});
