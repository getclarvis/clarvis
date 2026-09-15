import { describe, expect, it } from "../bun-test.ts";
import type { LiveMessage } from "@clarvis/capability";
import { createLiveContext, type CompactionConfig } from "../../src/runtime/context/index.ts";
import {
  createLiveEntryStore,
  type LiveEntry,
} from "../../src/runtime/context/live-entry-store.ts";
import { recordingLogger } from "../helpers/logging.ts";

const durable = (content: string): LiveEntry => ({
  message: { role: "user", content },
  chars: content.length,
  evictable: false,
  canonical: false,
  summary: false,
});

const note = (content: string): LiveEntry => ({ ...durable(content), noteKind: "status" });

describe("context.prefix_break — the store's mutating primitives", () => {
  it("prices a removal inside the durable prefix by the characters behind it", () => {
    const logger = recordingLogger();
    const store = createLiveEntryStore([], logger);
    store.appendDurable(durable("AAAA"));
    store.appendDurable(note("NN"));
    store.appendDurable(durable("BBBBBB"));

    store.removeAt(0);

    const [record] = logger.of("context.prefix_break");
    expect(record?.level).toBe("warn");
    expect(record?.fields).toMatchObject({
      cause: "remove",
      index: 0,
      entries: 3,
      char_offset: 0,
      chars_recharged: 12,
    });
  });

  it("reports removal of a historical runtime note", () => {
    const logger = recordingLogger();
    const store = createLiveEntryStore([], logger);
    store.appendDurable(durable("AAAA"));
    store.appendDurable(note("NN"));

    expect(store.durablePrefixEnd()).toBe(2);
    store.removeAt(1);
    expect(logger.of("context.prefix_break")).toHaveLength(1);
  });

  it("appends without shifting any historical entry", () => {
    const logger = recordingLogger();
    const store = createLiveEntryStore([], logger);
    store.appendDurable(durable("AAAA"));
    store.appendDurable(note("NN"));

    store.push({ role: "assistant", content: "work" }, false);

    expect(store.messages.map((m) => m.content)).toEqual(["AAAA", "NN", "work"]);
    expect(logger.of("context.prefix_break")).toHaveLength(0);
  });

  it("reports a replace whose first divergence is inside the prefix, at that index", () => {
    const logger = recordingLogger();
    const store = createLiveEntryStore([], logger);
    const kept = durable("AAAA");
    store.appendDurable(kept);
    store.appendDurable(durable("BBBBBB"));
    store.appendDurable(durable("CC"));

    store.replace([kept, durable("REWRITTEN"), store.entries[2]!]);

    const [record] = logger.of("context.prefix_break");
    expect(record?.level).toBe("warn");
    expect(record?.fields).toMatchObject({
      cause: "replace",
      index: 1,
      char_offset: 4,
      chars_recharged: 8,
    });
  });

  it("reports a replace that only truncates the prefix, at the new length", () => {
    const logger = recordingLogger();
    const store = createLiveEntryStore([], logger);
    const first = durable("AAAA");
    store.appendDurable(first);
    store.appendDurable(durable("BBBBBB"));

    store.replace([first]);

    expect(logger.of("context.prefix_break")[0]?.fields).toMatchObject({
      index: 1,
      char_offset: 4,
      chars_recharged: 6,
    });
  });

  it("says nothing when a replace preserves every entry's identity and order", () => {
    const logger = recordingLogger();
    const store = createLiveEntryStore([], logger);
    store.appendDurable(durable("AAAA"));
    store.appendDurable(durable("BBBB"));

    store.replace([...store.entries]);

    expect(logger.of("context.prefix_break")).toHaveLength(0);
  });

  it("demotes a compaction rewrite to debug, because that one is priced and deliberate", () => {
    const logger = recordingLogger();
    const store = createLiveEntryStore([], logger);
    const first = durable("AAAA");
    store.appendDurable(first);
    store.appendDurable(durable("BBBB"));

    store.replace([durable("SUMMARY")], "compaction");

    const [record] = logger.of("context.prefix_break");
    expect(record?.level).toBe("debug");
    expect(record?.fields.cause).toBe("compaction");
  });

  /**
   * The prefix-sum is the only work the report does, and a `debug`-level
   * compaction report is the common case, so the level guard has to come first.
   */
  it("computes nothing when the logger's level discards the record", () => {
    const logger = recordingLogger("info");
    const store = createLiveEntryStore([], logger);
    store.appendDurable(durable("AAAA"));
    store.appendDurable(durable("BBBB"));

    store.replace([durable("SUMMARY")], "compaction");
    expect(logger.records).toHaveLength(0);

    store.reportPrefixBreak(0, "remove");
    expect(logger.of("context.prefix_break")).toHaveLength(1);
  });
});

const ROOMY: CompactionConfig = {
  enabled: false,
  windowTokens: 0,
  fraction: 0.8,
  targetFraction: 0.5,
  maxResultChars: 1_000_000,
  preserveRecentTokens: 0,
};

const image = (chars: number): { data: string; mediaType: string } => ({
  data: "x".repeat(chars),
  mediaType: "image/png",
});

describe("context.prefix_break — the live context's in-place rewriters", () => {
  it("bounds a new image without modifying the previous request", () => {
    const logger = recordingLogger();
    const ctx = createLiveContext([], ROOMY, { agent: "lead", logger });
    ctx.appendAssistantToolCalls("", [
      { id: "a", name: "t", arguments: {} },
      { id: "b", name: "t", arguments: {} },
    ]);
    ctx.appendToolMessage("a", "first", { images: [image(7_000_000)] });
    expect(logger.of("context.prefix_break")).toHaveLength(0);

    ctx.appendToolMessage("b", "second", { images: [image(7_000_000)] });

    expect(logger.of("context.prefix_break")).toHaveLength(0);
    const results = ctx.messages.filter((message) => message.role === "tool");
    expect(results[0]?.images).toHaveLength(1);
    expect(results[1]?.images).toBeUndefined();
  });

  it("records the rolling summary anchor's rewrite at debug, never as a defect", () => {
    const logger = recordingLogger();
    const seed: LiveMessage[] = [{ role: "user", content: "task" }];
    const ctx = createLiveContext(seed, ROOMY, { agent: "lead", logger });
    ctx.appendAssistantToolCalls("", [
      { id: "a", name: "t", arguments: {} },
      { id: "b", name: "t", arguments: {} },
    ]);
    ctx.appendToolMessage("a", "R0");
    ctx.appendToolMessage("b", "R1");

    ctx.replaceSpanWithSummary([2], "first summary");
    expect(logger.of("context.prefix_break").filter((r) => r.level === "warn")).toHaveLength(0);

    ctx.replaceSpanWithSummary([3], "merged summary");

    expect(logger.of("context.prefix_break").filter((r) => r.level === "warn")).toHaveLength(0);
    const anchored = logger
      .of("context.prefix_break")
      .filter((r) => r.fields.cause === "summary_anchor");
    expect(anchored).toHaveLength(1);
    expect(anchored[0]?.level).toBe("debug");
  });

  it("records eviction's own rewrite at debug, under the compaction cause", () => {
    const logger = recordingLogger();
    const tight: CompactionConfig = {
      enabled: true,
      windowTokens: 200,
      fraction: 0.5,
      targetFraction: 0.2,
      maxResultChars: 1_000_000,
      preserveRecentTokens: 0,
    };
    const ctx = createLiveContext([{ role: "user", content: "task" }], tight, {
      agent: "lead",
      logger,
    });
    ctx.appendAssistantToolCalls("", [{ id: "a", name: "t", arguments: {} }]);
    ctx.appendToolMessage("a", "R".repeat(2000));

    expect(ctx.compact()).toBeDefined();

    const records = logger.of("context.prefix_break");
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("debug");
    expect(records[0]?.fields.cause).toBe("compaction");
  });

  it("stays silent for a context whose scope carries no logger", () => {
    const ctx = createLiveContext([], ROOMY, { agent: "lead" });
    expect(() => ctx.appendAssistant("no logger, no throw")).not.toThrow();
  });
});
