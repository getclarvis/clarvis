import { describe, it, expect, vi, afterEach } from "../helpers/bun-test.ts";
import { withCallLogging } from "../../src/index.ts";
import { contentToText } from "@clarvis/capability";
import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeLogger(level?: string): {
  logger: Logger;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const debug = vi.fn();
  const warn = vi.fn();
  const logger = {
    debug,
    warn,
    info: vi.fn(),
    error: vi.fn(),
    ...(level !== undefined ? { level } : {}),
  };
  return { logger: logger as unknown as Logger, debug, warn };
}

const messages: LiveMessage[] = [{ role: "user", content: "hello" }];

/** A fresh params object, so the per-call attempt counter starts at one. */
function freshParams(over: Partial<LLMCallParams> = {}): LLMCallParams {
  return { model: "m", provider: "openai", messages, tools: [], ...over };
}

function events(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((c) => {
    const event = (c[0] as { event?: unknown }).event;
    return typeof event === "string" ? event : "";
  });
}

function recordFor(mock: ReturnType<typeof vi.fn>, event: string): Record<string, unknown> {
  const found = mock.mock.calls.find((c) => (c[0] as { event?: unknown }).event === event);
  expect(found).toBeDefined();
  return found![0] as Record<string, unknown>;
}

describe("withCallLogging — pending watchdog", () => {
  it("warns while a call is outstanding, then reports it done once it returns", async () => {
    vi.useFakeTimers();
    const { logger, debug, warn } = fakeLogger();

    let resolveInner: (r: LLMCallResult) => void = () => {};
    const inner: LLMProvider = {
      call: () => new Promise<LLMCallResult>((resolve) => (resolveInner = resolve)),
    };
    const wrapped = withCallLogging(inner, logger);

    const pending = wrapped.call(freshParams());
    expect(events(debug)).toContain("llm.call.start");
    expect(events(warn)).not.toContain("llm.call.pending");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(events(warn)).toContain("llm.call.pending");

    resolveInner({
      usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
    });
    await pending;
    const warnsBefore = warn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(warn.mock.calls.length).toBe(warnsBefore);
  });

  it("reports the failure and re-throws when the inner call rejects", async () => {
    const { logger, warn } = fakeLogger();
    const boom = new Error("provider exploded");
    const wrapped = withCallLogging({ call: () => Promise.reject(boom) }, logger);

    await expect(wrapped.call(freshParams())).rejects.toThrow("provider exploded");
    expect(recordFor(warn, "llm.call.failed").error).toBe("provider exploded");
  });

  it("stringifies a non-Error rejection reason in the failure log and re-throws it", async () => {
    const { logger, warn } = fakeLogger();
    const wrapped = withCallLogging(
      {
        call: async () => {
          throw "raw provider string";
        },
      },
      logger,
    );

    await expect(wrapped.call(freshParams())).rejects.toBe("raw provider string");
    expect(recordFor(warn, "llm.call.failed").error).toBe("raw provider string");
  });

  it("reports the call slow instead of done when it takes at least 30s", async () => {
    const { logger, debug, warn } = fakeLogger();
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(40_000);
    const result: LLMCallResult = {
      usage: { input_tokens: 1, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
    };
    const wrapped = withCallLogging({ call: () => Promise.resolve(result) }, logger);

    await wrapped.call(freshParams());

    expect(recordFor(warn, "llm.call.slow").duration_ms).toBe(39_000);
    expect(events(debug)).not.toContain("llm.call.done");
  });
});

describe("withCallLogging — the done record", () => {
  it("carries the usage split, the reasoning length and the finish reason", async () => {
    const { logger, debug } = fakeLogger();
    const result: LLMCallResult = {
      text: "answer",
      reasoning: "because",
      finishReason: "stop",
      toolCalls: [{ id: "1", name: "t", arguments: {} }],
      usage: { input_tokens: 11, output_tokens: 22, cached_tokens: 33, cache_write_tokens: 44 },
    };
    const wrapped = withCallLogging({ call: () => Promise.resolve(result) }, logger);

    await wrapped.call(freshParams());

    expect(recordFor(debug, "llm.call.done")).toMatchObject({
      provider: "openai",
      model: "m",
      input_tokens: 11,
      output_tokens: 22,
      cached_tokens: 33,
      cache_write_tokens: 44,
      tool_calls: 1,
      text_len: 6,
      reasoning_len: 7,
      finish_reason: "stop",
      attempt_of_call: 1,
    });
  });

  it("defaults the optional result fields when the provider returned none", async () => {
    const { logger, debug } = fakeLogger();
    const wrapped = withCallLogging(
      {
        call: () =>
          Promise.resolve({
            usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
          }),
      },
      logger,
    );

    await wrapped.call(freshParams());

    expect(recordFor(debug, "llm.call.done")).toMatchObject({
      tool_calls: 0,
      text_len: 0,
      reasoning_len: 0,
      finish_reason: undefined,
    });
  });

  it("counts the physical attempts one logical call has made", async () => {
    const { logger, debug } = fakeLogger();
    const shared = freshParams();
    const wrapped = withCallLogging(
      {
        call: () =>
          Promise.resolve({
            usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
          }),
      },
      logger,
    );

    await wrapped.call(shared);
    await wrapped.call(shared);
    await wrapped.call(freshParams());

    const attempts = debug.mock.calls
      .filter((c) => (c[0] as { event?: string }).event === "llm.call.start")
      .map((c) => (c[0] as { attempt_of_call: number }).attempt_of_call);
    expect(attempts).toEqual([1, 2, 1]);
  });
});

describe("withCallLogging — the cost of logging at silent (D3)", () => {
  /**
   * A transcript that reports being read. `content` is the only property the
   * character count touches, so a getter on it is the whole measurement.
   */
  function watchedMessages(): { messages: LiveMessage[]; reads: () => number } {
    let reads = 0;
    const make = (text: string): LiveMessage => {
      const message = { role: "user" } as unknown as LiveMessage;
      Object.defineProperty(message, "content", {
        enumerable: true,
        get(): string {
          reads += 1;
          return text;
        },
      });
      return message;
    };
    return { messages: [make("one"), make("two"), make("three")], reads: () => reads };
  }

  const ok: LLMCallResult = {
    usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
  };

  it("never walks the transcript when the logger discards everything", async () => {
    const { logger, debug, warn } = fakeLogger("silent");
    const watched = watchedMessages();
    const wrapped = withCallLogging({ call: () => Promise.resolve(ok) }, logger);

    await wrapped.call(freshParams({ messages: watched.messages }));

    expect(watched.reads()).toBe(0);
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("never walks it on the failure path at silent either", async () => {
    const { logger, warn } = fakeLogger("silent");
    const watched = watchedMessages();
    const wrapped = withCallLogging({ call: () => Promise.reject(new Error("nope")) }, logger);

    await expect(wrapped.call(freshParams({ messages: watched.messages }))).rejects.toThrow("nope");

    expect(watched.reads()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("arms no pending watchdog at silent", async () => {
    vi.useFakeTimers();
    const { logger, warn } = fakeLogger("silent");
    let resolveInner: (r: LLMCallResult) => void = () => {};
    const wrapped = withCallLogging(
      { call: () => new Promise<LLMCallResult>((resolve) => (resolveInner = resolve)) },
      logger,
    );

    const pending = wrapped.call(freshParams());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(warn).not.toHaveBeenCalled();
    resolveInner(ok);
    await pending;
  });

  it("walks it exactly once per call when debug is on, not once per record", async () => {
    const { logger, debug } = fakeLogger("debug");
    const watched = watchedMessages();
    const wrapped = withCallLogging({ call: () => Promise.resolve(ok) }, logger);

    await wrapped.call(freshParams({ messages: watched.messages }));

    expect(watched.reads()).toBe(watched.messages.length);
    expect(events(debug)).toEqual(["llm.call.start", "llm.call.done"]);
  });

  it("still walks it for a slow call when only warnings survive", async () => {
    const { logger, debug, warn } = fakeLogger("warn");
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(40_000);
    const watched = watchedMessages();
    const wrapped = withCallLogging({ call: () => Promise.resolve(ok) }, logger);

    await wrapped.call(freshParams({ messages: watched.messages }));

    expect(debug).not.toHaveBeenCalled();
    expect(recordFor(warn, "llm.call.slow").input_chars).toBe("one".length + 3 + 5);
  });

  it("reports the same character count contentToText would have produced", async () => {
    const { logger, debug } = fakeLogger("debug");
    const multipart: LiveMessage[] = [
      { role: "user", content: "plain string" },
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", image: "data:image/png;base64,AAAA" },
          { type: "text", text: "and this" },
        ],
      },
      { role: "tool", tool_call_id: "1", content: "tool result" },
    ];
    const expected = multipart.reduce((sum, m) => sum + contentToText(m.content).length, 0);
    const wrapped = withCallLogging({ call: () => Promise.resolve(ok) }, logger);

    await wrapped.call(freshParams({ messages: multipart }));

    expect(recordFor(debug, "llm.call.start").input_chars).toBe(expected);
  });
});
