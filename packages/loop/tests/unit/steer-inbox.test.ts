import { describe, it, expect, vi } from "../bun-test.ts";
import { createSteerInbox } from "../../src/runtime/loop/steer-inbox.ts";
import type { Logger } from "@clarvis/capability";
import type { SteerMessage, SteerSource } from "@clarvis/capability";

function makeLogger(): { warn: ReturnType<typeof vi.fn>; logger: Logger } {
  const warn = vi.fn();
  const logger = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
  return { warn, logger };
}

function makeQueueSource(): { source: SteerSource; push: (m: SteerMessage) => void } {
  let pending: SteerMessage[] = [];
  return {
    source: {
      drain(): SteerMessage[] {
        if (pending.length === 0) return [];
        const out = pending;
        pending = [];
        return out;
      },
    },
    push: (m: SteerMessage) => pending.push(m),
  };
}

describe("createSteerInbox", () => {
  it("probe() reports false while the source is empty and true once something is queued", () => {
    const { source, push } = makeQueueSource();
    const inbox = createSteerInbox(source);

    expect(inbox.probe()).toBe(false);

    push({ content: "hi" });
    expect(inbox.probe()).toBe(true);
  });

  it("probe() does not consume — take() still returns what probe() observed", () => {
    const { source, push } = makeQueueSource();
    const inbox = createSteerInbox(source);
    push({ content: "hello" });

    expect(inbox.probe()).toBe(true);
    expect(inbox.probe()).toBe(true);

    const out = inbox.take();
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("hello");

    expect(inbox.probe()).toBe(false);
    expect(inbox.take()).toHaveLength(0);
  });

  it("take() accumulates across multiple pulls before it is called", () => {
    const { source, push } = makeQueueSource();
    const inbox = createSteerInbox(source);
    push({ content: "first" });
    inbox.probe();
    push({ content: "second" });

    const out = inbox.take();
    expect(out.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("a throwing drain() is swallowed, logged, and treated as empty by both probe() and take()", () => {
    const { warn, logger } = makeLogger();
    const source: SteerSource = {
      drain(): SteerMessage[] {
        throw new Error("boom");
      },
    };
    const inbox = createSteerInbox(source, logger);

    expect(inbox.probe()).toBe(false);
    expect(inbox.take()).toEqual([]);

    expect(warn).toHaveBeenCalledTimes(2);
    const [meta, message] = warn.mock.calls[0]!;
    expect(message).toBe("steer source drain threw; treating as empty");
    expect((meta as { err: string }).err).toBe("boom");
  });

  it("a throwing drain() with no logger supplied is swallowed silently", () => {
    const source: SteerSource = {
      drain(): SteerMessage[] {
        throw new Error("boom");
      },
    };
    const inbox = createSteerInbox(source);

    expect(() => inbox.probe()).not.toThrow();
    expect(inbox.probe()).toBe(false);
    expect(inbox.take()).toEqual([]);
  });

  it("a non-Error throw from drain() is stringified into the warn log", () => {
    const { warn, logger } = makeLogger();
    const source: SteerSource = {
      drain(): SteerMessage[] {
        throw "not an Error object";
      },
    };
    const inbox = createSteerInbox(source, logger);

    expect(inbox.probe()).toBe(false);
    const [meta] = warn.mock.calls[0]!;
    expect((meta as { err: string }).err).toBe("not an Error object");
  });

  it("a source that recovers after a throw resumes delivering normally", () => {
    const { warn, logger } = makeLogger();
    let shouldThrow = true;
    const source: SteerSource = {
      drain(): SteerMessage[] {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("transient");
        }
        return [{ content: "recovered" }];
      },
    };
    const inbox = createSteerInbox(source, logger);

    expect(inbox.probe()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    expect(inbox.probe()).toBe(true);
    expect(inbox.take()[0]!.content).toBe("recovered");
  });

  it("close() delegates to the source's close() when present", () => {
    const close = vi.fn();
    const source: SteerSource = {
      drain: () => [],
      close,
    };
    const inbox = createSteerInbox(source);
    inbox.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("close() is a no-op when the source has no close()", () => {
    const source: SteerSource = { drain: () => [] };
    const inbox = createSteerInbox(source);
    expect(() => inbox.close()).not.toThrow();
  });
});
