import { describe, it, expect } from "../bun-test.ts";
import { contentToText } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";
import {
  createLiveContext,
  DISABLED_COMPACTION,
  type CompactionConfig,
  type LiveSeedEntry,
} from "../../src/runtime/context/index.ts";

const ROOMY: CompactionConfig = {
  enabled: true,
  windowTokens: 1_000_000,
  fraction: 0.8,
  targetFraction: 0.8,
  maxResultChars: 1_000_000,
  preserveRecentTokens: 0,
};

const TIGHT: CompactionConfig = {
  enabled: true,
  windowTokens: 100,
  fraction: 0.5,
  targetFraction: 0.5,
  maxResultChars: 1_000_000,
  preserveRecentTokens: 0,
};

const SCOPE = { agent: "lead" as const };

function seedWithSystem(): LiveMessage[] {
  return [
    { role: "system", content: "you are the lead" },
    { role: "user", content: "the task" },
  ];
}

describe("LiveContext.snapshot — replaceable-entry identity", () => {
  it("persists note_kind and block_kind alongside the flags", () => {
    const ctx = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    ctx.setStableBlock("state_block", "spec v1");
    ctx.appendRuntimeNote("tokens_remaining", "[runtime: t=1]");

    const snap = ctx.snapshot();
    expect(snap.find((e) => contentToText(e.message.content) === "spec v1")?.block_kind).toBe(
      "state_block",
    );
    expect(snap.find((e) => contentToText(e.message.content) === "[runtime: t=1]")?.note_kind).toBe(
      "tokens_remaining",
    );
  });

  /**
   * Regression: without note_kind on the snapshot a continued run restored the
   * note as an anonymous entry, so appendRuntimeNote could no longer find it and
   * the next iteration appended a SECOND copy that then accumulated for the rest
   * of the run.
   */
  it("restores a note in place and appends the next observation", () => {
    const first = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    first.appendRuntimeNote("tokens_remaining", "[runtime: t=1]");

    const resumed = createLiveContext(first.snapshot() as LiveSeedEntry[], ROOMY, SCOPE);
    resumed.appendRuntimeNote("tokens_remaining", "[runtime: t=2]");

    const notes = resumed.messages
      .map((m) => contentToText(m.content))
      .filter((c) => c.startsWith("[runtime:"));
    expect(notes).toEqual(["[runtime: t=1]", "[runtime: t=2]"]);
  });

  it("restores a stable block so the next write supersedes it by appending", () => {
    const first = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    first.setStableBlock("state_block", "spec v1");
    first.appendAssistant("work");

    const resumed = createLiveContext(first.snapshot() as LiveSeedEntry[], ROOMY, SCOPE);
    resumed.setStableBlock("state_block", "spec v2");

    expect(resumed.messages.map((m) => contentToText(m.content))).toEqual([
      "the task",
      "spec v1",
      "work",
      "spec v2",
    ]);
  });

  it("restores the block's kind, so re-supplying identical content stays a no-op", () => {
    const first = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    first.setStableBlock("state_block", "spec v1");

    const resumed = createLiveContext(first.snapshot() as LiveSeedEntry[], ROOMY, SCOPE);
    resumed.setStableBlock("state_block", "spec v1");

    expect(resumed.messages.map((m) => contentToText(m.content))).toEqual(["the task", "spec v1"]);
  });
});

describe("LiveContext.snapshot", () => {
  it("round-trips reasoning continuation state without exposing it as message text", () => {
    const ctx = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    ctx.appendAssistant(
      "answer",
      [
        {
          text: "private reasoning",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "cipher" } },
        },
      ],
      [
        {
          text: "answer",
          phase: "final_answer",
          providerOptions: { openai: { itemId: "msg_1", phase: "final_answer" } },
        },
      ],
    );

    const resumed = createLiveContext(ctx.snapshot() as LiveSeedEntry[], ROOMY, SCOPE);
    const assistant = resumed.messages.find((message) => message.role === "assistant")!;
    expect(contentToText(assistant.content)).toBe("answer");
    expect("reasoning" in assistant ? assistant.reasoning : undefined).toEqual([
      {
        text: "private reasoning",
        providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "cipher" } },
      },
    ]);
    expect("text_parts" in assistant ? assistant.text_parts : undefined).toEqual([
      {
        text: "answer",
        phase: "final_answer",
        providerOptions: { openai: { itemId: "msg_1", phase: "final_answer" } },
      },
    ]);
  });

  it("excludes the system head and preserves order, flags and task_id", () => {
    const ctx = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    ctx.setCanonicalState("state v1");
    ctx.appendAssistantToolCalls("looking", [{ id: "c1", name: "grep", arguments: { q: "x" } }]);
    ctx.appendToolMessage("c1", "match found", { taskId: "t7" });
    ctx.appendAssistant("done");

    const snap = ctx.snapshot();
    expect(snap.map((e) => e.message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(snap.some((e) => e.message.role === "system")).toBe(false);

    const [task, canonical, calls, tool, final] = snap;
    expect(contentToText(task!.message.content)).toBe("the task");
    expect(task!.evictable).toBe(false);
    expect(canonical!.canonical).toBe(true);
    expect(contentToText(canonical!.message.content)).toBe("state v1");
    expect(calls!.message.role === "assistant" && "tool_calls" in calls!.message).toBe(true);
    expect(tool!.evictable).toBe(true);
    expect(tool!.task_id).toBe("t7");
    expect(contentToText(final!.message.content)).toBe("done");
  });

  it("round-trips through a new context: restored tool results stay evictable", () => {
    const ctx1 = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    ctx1.appendAssistantToolCalls("", [{ id: "c1", name: "read", arguments: {} }]);
    ctx1.appendToolMessage("c1", "x".repeat(500));
    ctx1.appendAssistant("turn 1 answer");
    const snap = ctx1.snapshot();

    const seed: LiveSeedEntry[] = [
      { role: "system", content: "fresh system" },
      ...snap,
      { role: "user", content: "turn 2 question" },
    ];
    const ctx2 = createLiveContext(seed, TIGHT, SCOPE);

    const event = ctx2.compact();
    expect(event).toMatchObject({ operation: "eviction" });
    const texts = ctx2.messages.map((m) => contentToText(m.content));
    expect(texts.some((t) => t.includes("x".repeat(500)))).toBe(false);
    expect(texts.some((t) => t === "turn 2 question")).toBe(true);
    expect(texts.some((t) => t === "turn 1 answer")).toBe(true);
  });

  it("bare seed messages restore as non-evictable even under pressure", () => {
    const big = "y".repeat(600);
    const seed: LiveSeedEntry[] = [
      { role: "system", content: "s" },
      { role: "user", content: big },
    ];
    const ctx = createLiveContext(seed, TIGHT, SCOPE);
    expect(ctx.compact()).toBeUndefined();
    expect(ctx.messages.some((m) => contentToText(m.content) === big)).toBe(true);
  });

  it("restored canonical entry remains historical when a new state is appended", () => {
    const ctx1 = createLiveContext(seedWithSystem(), ROOMY, SCOPE);
    ctx1.setCanonicalState("state v1");
    const snap = ctx1.snapshot();

    const ctx2 = createLiveContext(
      [{ role: "system", content: "fresh" }, ...snap] as LiveSeedEntry[],
      ROOMY,
      SCOPE,
    );
    ctx2.setCanonicalState("state v2");

    const texts = ctx2.messages.map((m) => contentToText(m.content));
    expect(texts.filter((t) => t === "state v2")).toHaveLength(1);
    expect(texts.indexOf("state v1")).toBeLessThan(texts.indexOf("state v2"));
  });

  it("summary entries keep their flag across the round-trip", () => {
    const ctx1 = createLiveContext(seedWithSystem(), TIGHT, SCOPE);
    ctx1.appendAssistantToolCalls("", [{ id: "c1", name: "read", arguments: {} }]);
    ctx1.appendToolMessage("c1", "z".repeat(500));
    const span = ctx1.selectSummarizableSpan();
    expect(span).toBeDefined();
    ctx1.replaceSpanWithSummary(span!.indices, "the gist");

    const snap = ctx1.snapshot();
    const summaryEntry = snap.find((e) => e.summary);
    expect(summaryEntry).toBeDefined();
    expect(contentToText(summaryEntry!.message.content)).toContain("the gist");

    expect(summaryEntry!.evictable).toBe(false);

    const ctx2 = createLiveContext(snap, DISABLED_COMPACTION, SCOPE);
    expect(ctx2.snapshot().find((e) => e.summary)).toBeDefined();
  });

  /**
   * Flags surviving the round-trip is not enough: the anchor is identified by
   * `{summary, evictable}` rather than by a persisted field, so a resumed run
   * has to still *recognise* it — otherwise the next compaction mints a second
   * anchor and the first is stranded forever, non-evictable.
   */
  it("restores the anchor so a resumed run updates it instead of minting a second", () => {
    const first = createLiveContext(seedWithSystem(), TIGHT, SCOPE);
    first.appendAssistantToolCalls("", [{ id: "c1", name: "read", arguments: {} }]);
    first.appendToolMessage("c1", "z".repeat(500));
    first.replaceSpanWithSummary(first.selectSummarizableSpan()!.indices, "gist one");

    const resumed = createLiveContext(first.snapshot() as LiveSeedEntry[], TIGHT, SCOPE);
    expect(resumed.summaryAnchor()).toBe("gist one");

    resumed.appendAssistantToolCalls("", [{ id: "c2", name: "read", arguments: {} }]);
    resumed.appendToolMessage("c2", "w".repeat(500));
    resumed.replaceSpanWithSummary(resumed.selectSummarizableSpan()!.indices, "gist two");

    expect(resumed.snapshot().filter((e) => e.summary)).toHaveLength(1);
    expect(resumed.summaryAnchor()).toBe("gist two");
  });

  it("does not adopt a legacy evictable span summary as the anchor", () => {
    const legacy: LiveSeedEntry[] = [
      { role: "system", content: "s" },
      {
        message: { role: "user", content: "the task" },
        evictable: false,
        summary: false,
        canonical: false,
      },
      {
        message: { role: "user", content: "old span summary" },
        evictable: true,
        summary: true,
        canonical: false,
      },
    ];
    const ctx = createLiveContext(legacy, TIGHT, SCOPE);
    expect(ctx.summaryAnchor()).toBeUndefined();

    ctx.appendAssistantToolCalls("", [{ id: "c1", name: "read", arguments: {} }]);
    ctx.appendToolMessage("c1", "z".repeat(500));
    ctx.replaceSpanWithSummary(ctx.selectSummarizableSpan()!.indices, "fresh gist");

    expect(ctx.summaryAnchor()).toBe("fresh gist");
    expect(ctx.snapshot().filter((e) => e.summary && !e.evictable)).toHaveLength(1);
  });
});
