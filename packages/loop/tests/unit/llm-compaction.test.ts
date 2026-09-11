import { describe, it, expect } from "../bun-test.ts";
import { contentToText, NOOP_LOGGER } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";
import type {
  LLMProvider,
  LLMCallParams,
  LLMCallResult,
  ResolvedProviderConfig,
} from "@clarvis/capability";
import {
  createLiveContext,
  liveMessageChars,
  type CompactionConfig,
} from "../../src/runtime/context/index.ts";
import { createTokenLedger } from "../../src/runtime/budget/index.ts";
import {
  buildCompactionMessages,
  compactionOutputTokens,
  attemptCompaction,
  renderSpan,
  runCompaction,
  summarizeContext,
} from "../../src/runtime/context/index.ts";

const ON: CompactionConfig = {
  enabled: true,
  windowTokens: 1000,
  fraction: 0.8,
  targetFraction: 0.8,
  maxResultChars: 1_000_000,
  preserveRecentTokens: 1,
};

function overBudgetCtx() {
  const ctx = createLiveContext([{ role: "user", content: "seed task" }], ON, { agent: "lead" });
  ctx.appendAssistantToolCalls(
    "",
    Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: "delegate_task", arguments: {} })),
  );
  for (let i = 0; i < 5; i += 1) ctx.appendToolMessage(`c${i}`, `R${i}: ${"x".repeat(1000)}`);
  return ctx;
}

function fakeLLM(text: string): { llm: LLMProvider; calls: LLMCallParams[] } {
  const calls: LLMCallParams[] = [];
  const llm: LLMProvider = {
    async call(params: LLMCallParams): Promise<LLMCallResult> {
      calls.push(params);
      return {
        text,
        usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 },
      };
    },
  };
  return { llm, calls };
}

function capturingLLM(result: LLMCallResult): { llm: LLMProvider; calls: LLMCallParams[] } {
  const calls: LLMCallParams[] = [];
  return {
    calls,
    llm: {
      async call(params: LLMCallParams): Promise<LLMCallResult> {
        calls.push(params);
        return result;
      },
    },
  };
}

function throwingLLM(): { llm: LLMProvider; calls: LLMCallParams[] } {
  const calls: LLMCallParams[] = [];
  return {
    calls,
    llm: {
      async call(params: LLMCallParams): Promise<LLMCallResult> {
        calls.push(params);
        throw new Error("provider boom");
      },
    },
  };
}

describe("llm-compaction · renderSpan renders every message variant", () => {
  it("renders system, user, assistant-with-calls, assistant-bare and tool messages", () => {
    const span: LiveMessage[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "working",
        tool_calls: [{ id: "c1", name: "t", arguments: { a: 1 } }],
      },
      { role: "assistant", content: "", tool_calls: [] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    const out = renderSpan(span);
    expect(out).toContain("System: be terse");
    expect(out).toContain("User: do it");
    expect(out).toContain("Assistant: working");
    expect(out).toContain('[called: t({"a":1})]');
    expect(out).toContain("Assistant:");
    expect(out).toContain("Tool result:\nresult");
  });
});

describe("llm-compaction · buildCompactionMessages", () => {
  const span: LiveMessage[] = [
    {
      role: "assistant",
      content: "did stuff",
      tool_calls: [{ id: "c1", name: "t", arguments: {} }],
    },
    { role: "tool", tool_call_id: "c1", content: "tool said hi" },
  ];

  it("uses the caller prompt as the system instruction and appends the anchor when present", () => {
    const msgs = buildCompactionMessages({
      prompt: "Summarize faithfully.",
      anchor: { label: "Current status", body: "[status] t1 done" },
      span,
    });
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("Summarize faithfully.");
    expect(msgs[0]!.content).toContain("Current status:");
    expect(msgs[0]!.content).toContain("[status] t1 done");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toContain(renderSpan(span));
  });

  it("omits the anchor block when no anchor is given", () => {
    const msgs = buildCompactionMessages({ prompt: "Summarize.", span });
    expect(msgs[0]!.content).toBe("Summarize.");
  });
});

describe("llm-compaction · summarizeContext", () => {
  const span: LiveMessage[] = [{ role: "user", content: "hello" }];

  it("forwards providerConfig, signal, timeoutMs and anchor into the call", async () => {
    const providerConfig: ResolvedProviderConfig = { kind: "anthropic" };
    const controller = new AbortController();
    const { llm, calls } = capturingLLM({
      text: "  digest  ",
      usage: { input_tokens: 1, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
    });
    const res = await summarizeContext({
      llm,
      model: "m",
      provider: "anthropic",
      providerConfig,
      signal: controller.signal,
      timeoutMs: 1234,
      prompt: "Summarize.",
      anchor: { label: "Status", body: "[status]" },
      span,
    });
    expect(res.text).toBe("digest");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.providerConfig).toBe(providerConfig);
    expect(calls[0]!.signal).toBe(controller.signal);
    expect(calls[0]!.timeoutMs).toBe(1234);
    expect(calls[0]!.messages[0]!.content).toContain("Status:");
  });

  it("omits optional params when they are not provided", async () => {
    const { llm, calls } = capturingLLM({
      text: "ok",
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
    });
    await summarizeContext({ llm, model: "m", provider: "anthropic", prompt: "P", span });
    expect(calls[0]!.providerConfig).toBeUndefined();
    expect(calls[0]!.signal).toBeUndefined();
    expect(calls[0]!.timeoutMs).toBeUndefined();
  });

  it("throws when the model returns no text", async () => {
    const { llm } = capturingLLM({
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
    });
    await expect(
      summarizeContext({ llm, model: "m", provider: "anthropic", prompt: "P", span }),
    ).rejects.toThrow("compaction summary was empty");
  });

  it("throws when the returned text is only whitespace", async () => {
    const { llm } = capturingLLM({
      text: "   \n  ",
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
    });
    await expect(
      summarizeContext({ llm, model: "m", provider: "anthropic", prompt: "P", span }),
    ).rejects.toThrow("compaction summary was empty");
  });
});

describe("llm-compaction · runCompaction", () => {
  const baseArgs = () => ({
    llm: fakeLLM("SHORT SUMMARY").llm,
    model: "claude-x",
    provider: "anthropic",
    ledger: createTokenLedger(1_000_000),
    usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    logger: NOOP_LOGGER,
  });

  it("with no compaction prompt (prompt_mode: none): mechanical eviction, the LLM is NOT called", async () => {
    const ctx = overBudgetCtx();
    const { llm, calls } = throwingLLM();
    const ev = await runCompaction({ ...baseArgs(), llm, ctx });
    expect(calls).toHaveLength(0);
    expect(ev?.operation).toBe("eviction");
  });

  it("reaches the summarizer with the base prompt intact and the contributions after it", async () => {
    const ctx = overBudgetCtx();
    const { llm, calls } = fakeLLM("COMPACT SUMMARY");
    const ev = await runCompaction({
      ...baseArgs(),
      ctx,
      llm,
      compactionPrompt: "BASE PROMPT.",
      contributions: [
        { source: "hook", text: "keep the column mapping" },
        { source: "user", text: "and the failing assertion" },
      ],
    });
    const system = contentToText(calls[0]!.messages[0]!.content);
    expect(system.startsWith("BASE PROMPT.")).toBe(true);
    expect(system).toContain("keep the column mapping");
    expect(system.indexOf("keep the column mapping")).toBeLessThan(
      system.indexOf("and the failing assertion"),
    );
    expect(ev?.contribution_count).toBe(2);
  });

  it("ignores contributions when the agent opted out of summarization", async () => {
    const ctx = overBudgetCtx();
    const { llm, calls } = throwingLLM();
    const ev = await runCompaction({
      ...baseArgs(),
      ctx,
      llm,
      contributions: [{ source: "hook", text: "please keep this" }],
    });
    expect(calls).toHaveLength(0);
    expect(ev?.operation).toBe("eviction");
    expect(ev?.contribution_count).toBeUndefined();
  });

  it("rethrows (does not swallow) a failure when the signal is aborted during summarization", async () => {
    const ctx = overBudgetCtx();
    const ac = new AbortController();
    ac.abort();
    await expect(
      runCompaction({
        ...baseArgs(),
        ctx,
        compactionPrompt: "Summarize.",
        llm: throwingLLM().llm,
        signal: ac.signal,
      }),
    ).rejects.toThrow("provider boom");
  });

  it("with a compaction prompt: summarizes the span, folds usage, replaces it with the summary", async () => {
    const ctx = overBudgetCtx();
    const { llm, calls } = fakeLLM("COMPACT SUMMARY");
    const ledger = createTokenLedger(1_000_000);
    const usage = { input: 0, output: 0, cached: 0, cache_write: 0 };
    const ev = await runCompaction({
      ctx,
      compactionPrompt: "Summarize the transcript.",
      anchor: { label: "Current status", body: "[status]" },
      llm,
      model: "claude-x",
      provider: "anthropic",
      ledger,
      usage,
      logger: NOOP_LOGGER,
    });
    expect(calls).toHaveLength(1);
    expect(ev?.operation).toBe("summarization");
    const text = JSON.stringify(ctx.messages);
    expect(text).toContain("COMPACT SUMMARY");
    expect(text).not.toContain("R0: ");
    expect(usage).toEqual({ input: 5, output: 3, cached: 0, cache_write: 0 });
    expect(ledger.remaining()).toBe(1_000_000 - 8);
  });

  it("folds cache_write and cached tokens into the accumulator (all four fields)", async () => {
    const ctx = overBudgetCtx();
    const { llm } = capturingLLM({
      text: "COMPACT SUMMARY",
      usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 2, cache_write_tokens: 7 },
    });
    const usage = { input: 0, output: 0, cached: 0, cache_write: 0 };
    await runCompaction({
      ctx,
      compactionPrompt: "Summarize the transcript.",
      llm,
      model: "claude-x",
      provider: "anthropic",
      ledger: createTokenLedger(1_000_000),
      usage,
      logger: NOOP_LOGGER,
    });
    expect(usage).toEqual({ input: 5, output: 3, cached: 2, cache_write: 7 });
  });

  it("does NOT adopt a summary whose marker+text would not shrink the span (never grows context)", async () => {
    const cfg: CompactionConfig = {
      enabled: true,
      windowTokens: 375,
      fraction: 0.8,
      targetFraction: 0.8,
      maxResultChars: 1_000_000,
      preserveRecentTokens: 1,
    };
    const ctx = createLiveContext([{ role: "user", content: "seed" }], cfg, { agent: "lead" });
    ctx.appendAssistantToolCalls("", [{ id: "c0", name: "t", arguments: {} }]);
    ctx.appendToolMessage("c0", "x".repeat(1000));
    ctx.appendAssistantToolCalls("", [{ id: "c1", name: "t", arguments: {} }]);
    ctx.appendToolMessage("c1", "x".repeat(1000));

    const span = ctx.selectSummarizableSpan();
    expect(span).toBeDefined();
    const spanChars = span!.messages.reduce((n, m) => n + liveMessageChars(m), 0);
    const summary = "S".repeat(spanChars);
    const { llm, calls } = fakeLLM(summary);

    const ev = await runCompaction({
      ctx,
      compactionPrompt: "Summarize.",
      llm,
      model: "claude-x",
      provider: "anthropic",
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      logger: NOOP_LOGGER,
    });

    expect(calls).toHaveLength(1);
    expect(ev?.operation).toBe("eviction");
    expect(ev?.fallback_reason).toBe("summary_not_effective");
    expect(JSON.stringify(ctx.messages)).not.toContain("SSSSSSSSSS");
  });

  it("falls back to mechanical eviction when the summary call throws", async () => {
    const ctx = overBudgetCtx();
    const { llm } = throwingLLM();
    const ev = await runCompaction({
      ...baseArgs(),
      llm,
      ctx,
      compactionPrompt: "Summarize.",
    });
    expect(ev?.operation).toBe("eviction");
    expect(ev?.fallback_reason).toBe("summarization_failed");
  });

  it("keeps the context intact when an instructed forced summary fails", async () => {
    const ctx = overBudgetCtx();
    const before = JSON.stringify(ctx.messages);
    const outcome = await attemptCompaction({
      ...baseArgs(),
      ctx,
      llm: throwingLLM().llm,
      compactionPrompt: "Summarize.",
      contributions: [{ source: "user", text: "Keep the failing assertion." }],
      mode: "forced",
      fallbackOnFailure: false,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "summarization_failed" });
    expect(JSON.stringify(ctx.messages)).toBe(before);
  });

  it("keeps the context intact when an instructed forced summary would not shrink it", async () => {
    const ctx = overBudgetCtx();
    const before = JSON.stringify(ctx.messages);
    const outcome = await attemptCompaction({
      ...baseArgs(),
      ctx,
      llm: fakeLLM("S".repeat(100_000)).llm,
      compactionPrompt: "Summarize.",
      contributions: [{ source: "user", text: "Keep the failing assertion." }],
      mode: "forced",
      fallbackOnFailure: false,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "summary_not_effective" });
    expect(JSON.stringify(ctx.messages)).toBe(before);
  });

  it("evicts mechanically when there is no summarizable span", async () => {
    const ctx = createLiveContext([{ role: "user", content: "only seed" }], ON, { agent: "lead" });
    const { llm, calls } = capturingLLM({
      text: "x",
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
    });
    const ev = await runCompaction({
      ctx,
      compactionPrompt: "Summarize.",
      llm,
      model: "m",
      provider: "anthropic",
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      logger: NOOP_LOGGER,
    });
    expect(calls).toHaveLength(0);
    expect(ev === undefined || ev.operation === "eviction").toBe(true);
  });
});

describe("llm-compaction · a summary is never re-summarized", () => {
  /**
   * The mechanism is now that the anchor is non-evictable, so it never reaches
   * `evictableCandidates` at all — the `excludeSummaries` filter no longer has
   * to carry this on its own.
   */
  it("excludes the anchor from the next summarizable span, because it is not evictable", () => {
    const ctx = overBudgetCtx();
    const first = ctx.selectSummarizableSpan();
    expect(first).toBeDefined();
    ctx.replaceSpanWithSummary(first!.indices, "SUMMARY ONE");
    ctx.appendAssistantToolCalls("", [{ id: "d1", name: "t", arguments: {} }]);
    ctx.appendToolMessage("d1", `FRESH: ${"y".repeat(2000)}`);
    const second = ctx.selectSummarizableSpan();
    if (second) {
      expect(second.messages.some((m) => contentToText(m.content).includes("SUMMARY ONE"))).toBe(
        false,
      );
    }
    expect(JSON.stringify(ctx.messages)).toContain("SUMMARY ONE");
    expect(ctx.snapshot().find((e) => e.summary)!.evictable).toBe(false);
  });
});

describe("llm-compaction · compactionOutputTokens", () => {
  it("is ~2% of the window, clamped to [1024, 4096]", () => {
    expect(compactionOutputTokens(128_000)).toBe(2_560);
    expect(compactionOutputTokens(100_000)).toBe(2_000);
    expect(compactionOutputTokens(10_000)).toBe(1_024);
    expect(compactionOutputTokens(1_000_000)).toBe(4_096);
  });

  it("falls back to the floor for a zero or non-finite window", () => {
    expect(compactionOutputTokens(0)).toBe(1_024);
    expect(compactionOutputTokens(Number.NaN)).toBe(1_024);
    expect(compactionOutputTokens(-5)).toBe(1_024);
  });
});

describe("llm-compaction · the rolling anchor", () => {
  const args = (ctx: ReturnType<typeof createLiveContext>, llm: LLMProvider) => ({
    ctx,
    compactionPrompt: "Summarize.",
    llm,
    model: "claude-x",
    provider: "anthropic",
    windowTokens: ON.windowTokens,
    ledger: createTokenLedger(1_000_000),
    usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    logger: NOOP_LOGGER,
  });

  const grow = (ctx: ReturnType<typeof createLiveContext>, id: string): void => {
    ctx.appendAssistantToolCalls("", [{ id, name: "t", arguments: {} }]);
    ctx.appendToolMessage(id, `${id}: ${"z".repeat(2000)}`);
  };

  it("passes maxOutputTokens to the provider call", async () => {
    const ctx = overBudgetCtx();
    const { llm, calls } = fakeLLM("S");
    await runCompaction(args(ctx, llm));
    expect(calls[0]!.maxOutputTokens).toBe(compactionOutputTokens(ON.windowTokens));
  });

  /**
   * Without this the model's own default effort applies, and on the OpenAI
   * family those thinking tokens are charged against the very cap above — the
   * whole budget could go to reasoning, the text come back empty, and every
   * compaction be billed and then thrown away.
   */
  it("turns reasoning off explicitly rather than leaving it unset", async () => {
    const ctx = overBudgetCtx();
    const { llm, calls } = fakeLLM("S");
    await runCompaction(args(ctx, llm));
    expect(calls[0]!.reasoningEffort).toBe("off");
  });

  it("uses the supported provider default for subscription compaction", async () => {
    for (const kind of ["openai-codex", "xai-grok"] as const) {
      const ctx = overBudgetCtx();
      const { llm, calls } = fakeLLM("S");
      await runCompaction({
        ...args(ctx, llm),
        provider: kind,
        providerConfig: { kind },
      });
      expect(calls[0]!.reasoningEffort).toBeUndefined();
    }
  });

  it("refuses a summary the provider cut off at the cap, keeping the old anchor", async () => {
    const ctx = smallSpanCtx();
    await runCompaction(args(ctx, fakeLLM("A".repeat(100)).llm));

    addSmall(ctx, "r2");
    const truncating: LLMProvider = {
      async call(): Promise<LLMCallResult> {
        return {
          text: "B".repeat(50),
          finishReason: "length",
          usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    const ev = await runCompaction(args(ctx, truncating));

    expect(ev?.operation).toBe("eviction");
    expect(ctx.summaryAnchor()).toBe("A".repeat(100));
  });

  it("adopts a summary that stopped for any other reason", async () => {
    const ctx = smallSpanCtx();
    const complete: LLMProvider = {
      async call(): Promise<LLMCallResult> {
        return {
          text: "done",
          finishReason: "stop",
          usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    const ev = await runCompaction(args(ctx, complete));

    expect(ev?.operation).toBe("summarization");
    expect(ctx.summaryAnchor()).toBe("done");
  });

  it("keeps exactly one anchor across repeated compactions, holding the latest text", async () => {
    const ctx = overBudgetCtx();
    const first = await runCompaction(args(ctx, fakeLLM("SUMMARY ONE").llm));
    expect(first).toMatchObject({ operation: "summarization", anchor_updated: false });

    grow(ctx, "d1");
    const second = await runCompaction(args(ctx, fakeLLM("SUMMARY TWO").llm));
    expect(second).toMatchObject({ operation: "summarization", anchor_updated: true });

    const anchors = ctx.snapshot().filter((e) => e.summary && !e.evictable);
    expect(anchors).toHaveLength(1);
    expect(ctx.summaryAnchor()).toBe("SUMMARY TWO");
    expect(JSON.stringify(ctx.messages)).not.toContain("SUMMARY ONE");
  });

  it("feeds the existing anchor back to the summarizer so it merges instead of discarding", async () => {
    const ctx = overBudgetCtx();
    await runCompaction(args(ctx, fakeLLM("SUMMARY ONE").llm));
    grow(ctx, "d1");
    const { llm, calls } = fakeLLM("SUMMARY TWO");
    await runCompaction(args(ctx, llm));

    const system = contentToText(calls[0]!.messages[0]!.content);
    expect(system).toContain('Update "Summary so far" using the new transcript');
    expect(system).toContain("Return the complete merged summary, not a delta");
    expect(system).toContain("Summary so far:\nSUMMARY ONE");
  });

  it("omits the update block on the first pass, when there is no anchor yet", async () => {
    const ctx = overBudgetCtx();
    const { llm, calls } = fakeLLM("SUMMARY ONE");
    await runCompaction(args(ctx, llm));
    expect(contentToText(calls[0]!.messages[0]!.content)).not.toContain('Update "Summary so far"');
  });

  /**
   * A fixture whose spans are small relative to the anchor ceiling, so the delta
   * rule is what decides adoption rather than the ceiling. A large non-evictable
   * seed keeps the context over the high-water mark while each evictable result
   * stays cheap.
   */
  const smallSpanCtx = (): ReturnType<typeof createLiveContext> => {
    const cfg: CompactionConfig = { ...ON, preserveRecentTokens: 0 };
    const ctx = createLiveContext([{ role: "user", content: "S".repeat(3000) }], cfg, {
      agent: "lead",
    });
    for (const id of ["r0", "r1"]) {
      ctx.appendAssistantToolCalls("", [{ id, name: "t", arguments: {} }]);
      ctx.appendToolMessage(id, "y".repeat(300));
    }
    return ctx;
  };

  const addSmall = (ctx: ReturnType<typeof createLiveContext>, id: string): void => {
    ctx.appendAssistantToolCalls("", [{ id, name: "t", arguments: {} }]);
    ctx.appendToolMessage(id, "y".repeat(300));
  };

  /**
   * The saving is the anchor's *growth*, not its absolute size. Under the old
   * absolute comparison an anchor already carrying earlier passes would be
   * rejected on its total length even when the merge shrank the context.
   */
  it("adopts a merged anchor that grows by less than the span it absorbs", async () => {
    const ctx = smallSpanCtx();
    await runCompaction(args(ctx, fakeLLM("A".repeat(100)).llm));
    const before = ctx.summaryAnchor()!.length;
    addSmall(ctx, "r2");

    const ev = await runCompaction(args(ctx, fakeLLM("B".repeat(300)).llm));

    expect(ev?.operation).toBe("summarization");
    expect(ctx.summaryAnchor()).toBe("B".repeat(300));
    expect(ctx.summaryAnchor()!.length).toBeGreaterThan(before);
  });

  it("rejects a merged anchor that grows by more than the span, leaving the old text intact", async () => {
    const ctx = smallSpanCtx();
    await runCompaction(args(ctx, fakeLLM("A".repeat(100)).llm));
    addSmall(ctx, "r2");

    const ev = await runCompaction(args(ctx, fakeLLM("B".repeat(800)).llm));

    expect(ev?.operation).toBe("eviction");
    expect(ctx.summaryAnchor()).toBe("A".repeat(100));
  });

  /**
   * The anchor is reachable by neither compact() nor forceEvictOldest(), so an
   * oversized one would pin the context above its high-water mark forever. The
   * ceiling is the only point at which that is still recoverable.
   */
  it("refuses an anchor larger than a quarter of the window, and evicts instead", async () => {
    const cfg: CompactionConfig = { ...ON, windowTokens: 200 };
    const ctx = createLiveContext([{ role: "user", content: "seed task" }], cfg, { agent: "lead" });
    ctx.appendAssistantToolCalls(
      "",
      Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: "t", arguments: {} })),
    );
    for (let i = 0; i < 5; i += 1) ctx.appendToolMessage(`c${i}`, `R${i}: ${"x".repeat(1000)}`);

    const ev = await runCompaction({
      ...args(ctx, fakeLLM("W".repeat(1000)).llm),
      windowTokens: 200,
    });

    expect(ev?.operation).toBe("eviction");
    expect(ctx.summaryAnchor()).toBeUndefined();
  });
});
