import { describe, expect, it } from "../bun-test.ts";
import type { LiveMessage } from "@clarvis/capability";
import { createCompactionSelector } from "../../src/runtime/context/compaction-selection.ts";
import {
  rebuildDroppingTools,
  type RewriteEntry,
} from "../../src/runtime/context/context-rewrite.ts";
import { createLiveEntryStore } from "../../src/runtime/context/live-entry-store.ts";

describe("live entry store", () => {
  it("appends after runtime observations and snapshots their identity", () => {
    const store = createLiveEntryStore([{ role: "user", content: "seed" }]);
    store.appendDurable({
      message: { role: "user", content: "runtime" },
      chars: 7,
      evictable: false,
      canonical: false,
      summary: false,
      noteKind: "status",
    });
    store.push({ role: "assistant", content: "work" }, false);
    store.sync();

    expect(store.messages.map((message) => message.content)).toEqual(["seed", "runtime", "work"]);
    expect(store.snapshot()[1]?.note_kind).toBe("status");
    expect(store.totalChars()).toBe(15);
  });
});

describe("compaction selector", () => {
  it("selects oldest entries to low water while protecting the newest tail", () => {
    const messages: LiveMessage[] = [
      { role: "user", content: "seed" },
      { role: "tool", tool_call_id: "old", content: "x".repeat(160) },
      { role: "tool", tool_call_id: "new", content: "y".repeat(80) },
    ];
    const entries = messages.map((message, index) => ({
      message,
      chars: typeof message.content === "string" ? message.content.length : 0,
      evictable: index > 0,
      summary: false,
      canonical: false,
    }));
    const selector = createCompactionSelector({
      entries: () => entries,
      totalChars: () => entries.reduce((sum, entry) => sum + entry.chars, 0),
      config: {
        enabled: true,
        windowTokens: 100,
        fraction: 0.5,
        targetFraction: 0.25,
        maxResultChars: 1_000,
        preserveRecentTokens: 20,
      },
    });

    expect(selector.selectOldestEvictable(false)).toEqual([1]);
    expect(selector.evictableCandidates(false)).toEqual([1]);
  });

  it("anchors occupancy without changing marginal selection accounting", () => {
    const entries = [
      {
        message: { role: "user", content: "seed" } as LiveMessage,
        chars: 4,
        evictable: false,
        summary: false,
        canonical: false,
      },
    ];
    const selector = createCompactionSelector({
      entries: () => entries,
      totalChars: () => 4,
      config: {
        enabled: true,
        windowTokens: 1_000,
        fraction: 0.8,
        targetFraction: 0.5,
        maxResultChars: 1_000,
        preserveRecentTokens: 0,
      },
    });
    selector.observeUsage(321);
    expect(selector.estimateTokens()).toBe(321);
  });

  it("forced mode ignores the high-water threshold but still protects the recent tail", () => {
    const messages: LiveMessage[] = [
      { role: "user", content: "seed" },
      { role: "tool", tool_call_id: "old", content: "x".repeat(160) },
      { role: "tool", tool_call_id: "new", content: "y".repeat(80) },
    ];
    const entries = messages.map((message, index) => ({
      message,
      chars: typeof message.content === "string" ? message.content.length : 0,
      evictable: index > 0,
      summary: false,
      canonical: false,
    }));
    const selector = createCompactionSelector({
      entries: () => entries,
      totalChars: () => entries.reduce((sum, entry) => sum + entry.chars, 0),
      config: {
        enabled: true,
        windowTokens: 10_000,
        fraction: 0.8,
        targetFraction: 0.5,
        maxResultChars: 1_000,
        preserveRecentTokens: 20,
      },
    });

    expect(selector.selectOldestEvictable(false)).toEqual([]);
    expect(selector.selectOldestEvictable(false, "forced")).toEqual([1]);
  });
});

describe("pairing-preserving rewrite", () => {
  it("removes the dropped result and its owning call before inserting the replacement", () => {
    const entries = [
      {
        message: {
          role: "assistant" as const,
          content: "kept prose",
          tool_calls: [{ id: "call", name: "read", arguments: {} }],
        },
        chars: 20,
        evictable: false,
        canonical: false,
        summary: false,
      },
      {
        message: { role: "tool" as const, tool_call_id: "call", content: "result" },
        chars: 6,
        evictable: true,
        canonical: false,
        summary: false,
      },
    ];
    let rewritten: RewriteEntry[] = entries;
    const freed = rebuildDroppingTools({
      entries,
      drop: new Set([1]),
      insert: { content: "summary", evictable: false, summary: true },
      replace: (next) => {
        rewritten = next;
      },
    });

    expect(freed).toBe(6);
    expect(rewritten.map((entry) => entry.message.role)).toEqual(["assistant", "user"]);
    expect(rewritten[0]!.message).toEqual({ role: "assistant", content: "kept prose" });
  });
});
