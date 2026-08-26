import { describe, it, expect } from "../bun-test.ts";
import { contentToText } from "@clarvis/capability";
import type { LiveMessage, ToolCallRef } from "@clarvis/capability";
import {
  createLiveContext,
  estimateTokensForChars,
  liveMessageChars,
  MAX_LIVE_TOOL_IMAGE_CHARS,
  MAX_TOOL_IMAGE_CHARS,
  MAX_TOOL_IMAGES_PER_RESULT,
  willTruncateToolResult,
  derivePreserveRecentTokens,
  DISABLED_COMPACTION,
  type CompactionConfig,
} from "../../src/runtime/context/index.ts";
import { prefixSurvival, renderForPrefix } from "../prefix-stability.ts";

const ON: CompactionConfig = {
  enabled: true,
  windowTokens: 1000,
  fraction: 0.8,
  targetFraction: 0.8,
  maxResultChars: 1_000_000,
  preserveRecentTokens: 1,
};

const SMALL_CAP: CompactionConfig = { ...ON, maxResultChars: 200 };

function seed(): LiveMessage[] {
  return [{ role: "user", content: "seed task" }];
}

function seedShort(): LiveMessage[] {
  return [{ role: "user", content: "seed" }];
}

function toolResult(name: string, chars: number): string {
  const prefix = `Tool '${name}' result: `;
  return prefix + "x".repeat(Math.max(0, chars - prefix.length));
}

function call(id: string): ToolCallRef {
  return { id, name: "t", arguments: {} };
}

function callNamed(id: string, name: string): ToolCallRef {
  return { id, name, arguments: {} };
}

function pairedIds(messages: LiveMessage[]): { calls: string[]; results: string[] } {
  return {
    calls: messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    ),
    results: messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
  };
}

function assertValidToolOrdering(messages: LiveMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    const prev = messages[i - 1];
    const ok =
      prev !== undefined &&
      (prev.role === "tool" || (prev.role === "assistant" && "tool_calls" in prev));
    expect(
      ok,
      `tool message at index ${i} (tool_call_id ${(m as { tool_call_id: string }).tool_call_id}) must ` +
        `follow an assistant-with-tool_calls or another tool, but follows ${prev?.role ?? "<start>"}`,
    ).toBe(true);
  }
}

describe("estimateTokensForChars", () => {
  it("is ceil(chars/4) and monotonic", () => {
    expect(estimateTokensForChars(0)).toBe(0);
    expect(estimateTokensForChars(1)).toBe(1);
    expect(estimateTokensForChars(4)).toBe(1);
    expect(estimateTokensForChars(5)).toBe(2);
    expect(estimateTokensForChars(4000)).toBeLessThan(estimateTokensForChars(4001));
  });

  it("estimate is order-independent (depends only on total chars)", () => {
    const a = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "subagent" });
    const b = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "subagent" });
    a.appendToolMessage("c1", "Tool 'x' result: aaaa");
    a.appendToolMessage("c2", "Tool 'y' result: bbbbbb");
    b.appendToolMessage("c2", "Tool 'y' result: bbbbbb");
    b.appendToolMessage("c1", "Tool 'x' result: aaaa");
    expect(a.estimateTokens()).toBe(b.estimateTokens());
  });
});

describe("inline image retained-size accounting", () => {
  it("charges user and tool image payloads to the live-context estimate", () => {
    const user: LiveMessage = {
      role: "user",
      content: [{ type: "image", image: "abcdef", mediaType: "image/png" }],
    };
    const tool: LiveMessage = {
      role: "tool",
      tool_call_id: "c1",
      content: "ok",
      images: [{ data: "123456", mediaType: "image/png" }],
    };
    expect(liveMessageChars(user)).toBeGreaterThanOrEqual(6 + "image/png".length);
    expect(liveMessageChars(tool)).toBeGreaterThanOrEqual(2 + 6 + "image/png".length);
  });

  it("releases older images before a context or final snapshot can grow without bound", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    const data = "x".repeat(7_000_000);
    ctx.appendToolMessage("old", "old image", {
      images: [{ data, mediaType: "image/png" }],
    });
    ctx.appendToolMessage("new", "new image", {
      images: [{ data, mediaType: "image/png" }],
    });

    const tools = ctx.messages.filter((m) => m.role === "tool");
    expect(tools[0]?.images).toBeUndefined();
    expect(tools[0]?.content).toContain("released to keep the live context");
    expect(tools[1]?.images).toHaveLength(1);
    const retained = tools
      .flatMap((m) => m.images ?? [])
      .reduce((n, image) => n + image.data.length, 0);
    expect(retained).toBeLessThanOrEqual(MAX_LIVE_TOOL_IMAGE_CHARS);
    expect(JSON.stringify(ctx.snapshot()).length).toBeLessThan(MAX_LIVE_TOOL_IMAGE_CHARS + 10_000);
  });

  it("bounds one result by image count and individual payload size", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    const oversized = "x".repeat(MAX_TOOL_IMAGE_CHARS + 1);
    ctx.appendToolMessage("c1", "images", {
      images: [
        { data: oversized, mediaType: "image/png" },
        ...Array.from({ length: MAX_TOOL_IMAGES_PER_RESULT + 1 }, () => ({
          data: "small",
          mediaType: "image/png",
        })),
      ],
    });
    const message = ctx.messages.at(-1)!;
    expect(message.role).toBe("tool");
    if (message.role !== "tool") throw new Error("expected tool message");
    expect(message.images).toHaveLength(MAX_TOOL_IMAGES_PER_RESULT);
    expect(message.images?.some((image) => image.data === oversized)).toBe(false);
    expect(message.content).toContain("inline tool images were released");
  });
});

describe("observeUsage (occupancy anchored to real input_tokens)", () => {
  it("before any measurement, the estimate is the plain chars/4 heuristic", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "subagent" });
    ctx.appendUser("x".repeat(40));
    expect(ctx.estimateTokens()).toBe(estimateTokensForChars(44));
  });

  it("anchors to the real token count and estimates only the delta since", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "subagent" });
    ctx.observeUsage(500);
    expect(ctx.estimateTokens()).toBe(500);
    ctx.appendUser("x".repeat(40));
    expect(ctx.estimateTokens()).toBe(500 + Math.ceil(40 / 4));
  });

  it("the estimate drops below the anchor when content is evicted", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "subagent" });
    ctx.appendToolMessage("c1", toolResult("x", 400));
    ctx.observeUsage(1000);
    const full = ctx.estimateTokens();
    expect(full).toBe(1000);
    ctx.forceEvictOldest();
    expect(ctx.estimateTokens()).toBeLessThan(full);
  });

  it("ignores a negative or non-finite measurement (keeps the prior anchor)", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "subagent" });
    ctx.observeUsage(500);
    ctx.observeUsage(-5);
    ctx.observeUsage(Number.NaN);
    expect(ctx.estimateTokens()).toBe(500);
  });
});

describe("LiveContext — native tool message construction", () => {
  it("an assistant(tool_calls) turn + tool messages yields a coherent paired sequence", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "subagent" });
    ctx.appendAssistantToolCalls("thinking", [call("c1"), call("c2")]);
    ctx.appendToolMessage("c1", "Tool 't' result: one");
    ctx.appendToolMessage("c2", "Tool 't' result: two");

    expect(ctx.messages).toEqual([
      { role: "user", content: "seed" },
      {
        role: "assistant",
        content: "thinking",
        tool_calls: [call("c1"), call("c2")],
      },
      { role: "tool", tool_call_id: "c1", content: "Tool 't' result: one" },
      { role: "tool", tool_call_id: "c2", content: "Tool 't' result: two" },
    ]);
  });

  it("every tool message pairs to a preceding assistant tool_call (no orphans, order preserved)", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "subagent" });
    ctx.appendAssistantToolCalls("", [call("a")]);
    ctx.appendToolMessage("a", "ra");
    ctx.appendAssistant("a plain reasoning turn");
    ctx.appendAssistantToolCalls("", [call("b")]);
    ctx.appendToolMessage("b", "rb");

    const callIds = ctx.messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    );
    const resultIds = ctx.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    expect(callIds).toEqual(["a", "b"]);
    expect(resultIds).toEqual(["a", "b"]);
    for (const id of callIds) {
      const callIdx = ctx.messages.findIndex(
        (m) =>
          m.role === "assistant" && "tool_calls" in m && m.tool_calls.some((tc) => tc.id === id),
      );
      const resIdx = ctx.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === id);
      expect(callIdx).toBeLessThan(resIdx);
    }
  });

  it("a plain assistant turn carries no tool_calls (discriminant stays clean)", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "subagent" });
    ctx.appendAssistant("just text");
    const last = ctx.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect("tool_calls" in last).toBe(false);
  });

  /**
   * An empty `tool_calls` array must not be carried onto the message: the
   * discriminant is the *presence* of the key, so an empty one would make a
   * text-only turn read as a tool turn everywhere that tests `"tool_calls" in m`
   * — including `rebuildDroppingTools`' ref-pruning and `liveMessageChars`.
   */
  it("an empty tool_calls array degrades to a plain assistant turn", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "subagent" });
    ctx.appendAssistantToolCalls("no calls this turn", []);
    const last = ctx.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect("tool_calls" in last).toBe(false);
    expect(contentToText(last.content)).toBe("no calls this turn");
  });
});

describe("canonical-state-driven compaction", () => {
  it("setCanonicalState keeps ONE canonical message and floats it to the tail on refresh", () => {
    const ctx = createLiveContext([{ role: "user", content: "seed" }], DISABLED_COMPACTION, {
      agent: "lead",
    });
    ctx.setCanonicalState("[state] v1");
    ctx.appendAssistant("thinking");
    ctx.setCanonicalState("[state] v2");
    const contents = ctx.messages.map((m) => contentToText(m.content));
    expect(contents.filter((c) => c.startsWith("[state]"))).toEqual(["[state] v2"]);
    expect(contents).toEqual(["seed", "thinking", "[state] v2"]);
    expect(contents.at(-1)).toBe("[state] v2");
  });

  it("a status refresh moves the block to the tail, leaving the prior prefix undisturbed", () => {
    const ctx = createLiveContext([{ role: "user", content: "seed" }], DISABLED_COMPACTION, {
      agent: "lead",
    });
    ctx.setCanonicalState("[state] t1 pending");
    ctx.appendAssistantToolCalls("work", [call("c1")]);
    ctx.appendToolMessage("c1", "did the work");
    ctx.setCanonicalState("[state] t1 done");
    const contents = ctx.messages.map((m) => contentToText(m.content));
    expect(contents).toEqual(["seed", "work", "did the work", "[state] t1 done"]);
    assertValidToolOrdering(ctx.messages);
  });
});

describe("LiveContext.cacheBreakpoints", () => {
  const lead = (): ReturnType<typeof createLiveContext> =>
    createLiveContext([{ role: "user", content: "seed" }], DISABLED_COMPACTION, { agent: "lead" });

  // A lead iteration in production order. beforeIteration installs the canonical
  // state block; the request is built THERE, which is when cacheBreakpoints() is
  // consulted. The model then answers with a tool batch, and beforeCheckpoint
  // replaces the tokens_remaining note. The canonical block and the note are
  // both spliced out and re-pushed at the tail next iteration, so neither may
  // carry the breakpoint.
  function beforeIteration(ctx: ReturnType<typeof createLiveContext>, n: number): void {
    ctx.setCanonicalState(`[state] v${n}`);
  }

  function dispatch(ctx: ReturnType<typeof createLiveContext>, n: number, toolCount: number): void {
    const calls = Array.from({ length: toolCount }, (_, i) => call(`c${n}-${i}`));
    ctx.appendAssistantToolCalls(`work ${n}`, calls);
    for (const c of calls) ctx.appendToolMessage(c.id, `result ${c.id}`);
    ctx.appendRuntimeNote("tokens_remaining", `[runtime: tokens_remaining=${1000 - n}]`);
  }

  /** The message contents a breakpoint at `index` would have the provider cache. */
  function cachedPrefix(ctx: ReturnType<typeof createLiveContext>, index: number): string[] {
    return ctx.messages.slice(0, index + 1).map((m) => contentToText(m.content));
  }

  it("returns the last message and no prior breakpoint for a bare seed", () => {
    const ctx = lead();
    expect(ctx.cacheBreakpoints()).toEqual({ stable: 0, prior: -1 });
  });

  it("never anchors on a system-role entry, which the provider lifts out of the array", () => {
    const ctx = createLiveContext(
      [
        { role: "user", content: "seed" },
        { role: "system", content: "sys" },
      ],
      DISABLED_COMPACTION,
      { agent: "lead" },
    );
    expect(ctx.cacheBreakpoints().stable).toBe(0);
  });

  it("skips the canonical block and the runtime note at the tail", () => {
    const ctx = lead();
    ctx.appendAssistant("thinking");
    ctx.appendRuntimeNote("tokens_remaining", "[runtime: t=1]");
    ctx.setCanonicalState("[state] v1");
    const { stable } = ctx.cacheBreakpoints();
    expect(contentToText(ctx.messages[stable]!.content)).toBe("thinking");
  });

  // The regression this whole change exists for. Raw indices shift between
  // requests because setCanonicalState splices the old block out of the middle,
  // so the property that matters is on CONTENT: the prefix request N marked must
  // still be a prefix of request N+1, or the provider can never read it back.
  it("re-marks in request N+1 the exact prefix request N cached", () => {
    const ctx = lead();
    beforeIteration(ctx, 1);
    const cachedByFirst = cachedPrefix(ctx, ctx.cacheBreakpoints().stable);
    dispatch(ctx, 1, 1);

    beforeIteration(ctx, 2);
    const second = ctx.cacheBreakpoints();
    expect(cachedPrefix(ctx, second.prior)).toEqual(cachedByFirst);
    expect(cachedPrefix(ctx, second.stable).slice(0, cachedByFirst.length)).toEqual(cachedByFirst);
  });

  it("holds that property across three iterations, once the tail is fully in steady state", () => {
    const ctx = lead();
    beforeIteration(ctx, 1);
    dispatch(ctx, 1, 1);
    beforeIteration(ctx, 2);
    const cachedBySecond = cachedPrefix(ctx, ctx.cacheBreakpoints().stable);
    dispatch(ctx, 2, 1);

    beforeIteration(ctx, 3);
    expect(cachedPrefix(ctx, ctx.cacheBreakpoints().prior)).toEqual(cachedBySecond);
  });

  it("keeps prior exact across a wide parallel tool batch, where a fixed offset would miss", () => {
    const ctx = lead();
    beforeIteration(ctx, 1);
    dispatch(ctx, 1, 1);
    beforeIteration(ctx, 2);
    const cachedBySecond = cachedPrefix(ctx, ctx.cacheBreakpoints().stable);
    dispatch(ctx, 2, 15);

    beforeIteration(ctx, 3);
    const third = ctx.cacheBreakpoints();
    // 15 tool results plus their assistant turn is 31 content blocks — beyond
    // the provider's 20-block backwards search — so this must be exact, not near.
    expect(cachedPrefix(ctx, third.prior)).toEqual(cachedBySecond);
    expect(contentToText(ctx.messages[third.stable]!.content)).toBe("result c2-14");
  });

  it("handles a text-only iteration with no tool calls", () => {
    const ctx = lead();
    ctx.appendAssistant("answer one");
    ctx.appendUser("follow up");
    ctx.appendAssistant("answer two");
    const { stable, prior } = ctx.cacheBreakpoints();
    expect(contentToText(ctx.messages[stable]!.content)).toBe("answer two");
    expect(contentToText(ctx.messages[prior]!.content)).toBe("follow up");
  });

  it("marks only the last message for a sub-agent, whose transcript is append-only", () => {
    const ctx = createLiveContext([{ role: "user", content: "task" }], DISABLED_COMPACTION, {
      agent: "subagent",
    });
    ctx.appendAssistantToolCalls("work", [call("c1")]);
    ctx.appendToolMessage("c1", "done");
    expect(ctx.cacheBreakpoints().stable).toBe(ctx.messages.length - 1);
  });

  it("degrades without throwing once compaction has evicted the prior position", () => {
    const ctx = createLiveContext(
      seed(),
      { ...ON, windowTokens: 1, preserveRecentTokens: 0 },
      {
        agent: "lead",
      },
    );
    beforeIteration(ctx, 1);
    dispatch(ctx, 1, 2);
    beforeIteration(ctx, 2);
    dispatch(ctx, 2, 2);
    ctx.compact();
    const { stable, prior } = ctx.cacheBreakpoints();
    expect(stable).toBeLessThan(ctx.messages.length);
    expect(prior).toBeLessThan(stable === -1 ? 1 : stable + 1);
  });
});

describe("LiveContext.setStableBlock", () => {
  it("appends a fresh copy per change, newest last", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    ctx.setStableBlock("state_block", "spec v2");
    expect(ctx.messages.map((m) => contentToText(m.content))).toEqual([
      "seed task",
      "spec v1",
      "spec v2",
    ]);
  });

  // Changed content is APPENDED; the superseded copy stays exactly where it is.
  // It must not be rewritten in place (that changes the bytes at the block's
  // position) and must not be removed (that shifts every entry behind it) —
  // either way an implicit prefix cache re-charges from there. See the
  // economics test below.
  it("appends on change and leaves the superseded copy untouched", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    ctx.appendAssistantToolCalls("work", [call("c1")]);
    ctx.appendToolMessage("c1", "did the work");

    ctx.setStableBlock("state_block", "spec v2");
    expect(ctx.messages.map((m) => contentToText(m.content))).toEqual([
      "seed task",
      "spec v1",
      "work",
      "did the work",
      "spec v2",
    ]);
    assertValidToolOrdering(ctx.messages);
  });

  it("keeps every superseded copy, newest last, so the model can be told the last wins", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    ctx.appendAssistant("a");
    ctx.setStableBlock("state_block", "spec v2");
    ctx.appendAssistant("b");
    ctx.setStableBlock("state_block", "spec v3");
    expect(ctx.messages.map((m) => contentToText(m.content))).toEqual([
      "seed task",
      "spec v1",
      "a",
      "spec v2",
      "b",
      "spec v3",
    ]);
  });

  it("compares against the newest copy, so re-supplying it is still a no-op", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    ctx.setStableBlock("state_block", "spec v2");
    const newest = ctx.messages.at(-1)!;
    ctx.setStableBlock("state_block", "spec v2");
    expect(ctx.messages.at(-1)).toBe(newest);
    expect(ctx.messages.filter((m) => contentToText(m.content).startsWith("spec ")).length).toBe(2);
  });

  it("lands ahead of the trailing volatile run, so a note never buries it", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    ctx.appendRuntimeNote("budget", "[runtime: n]");
    ctx.setCanonicalState("cas v1");

    ctx.setStableBlock("state_block", "spec v2");
    expect(ctx.messages.map((m) => contentToText(m.content))).toEqual([
      "seed task",
      "spec v1",
      "spec v2",
      "[runtime: n]",
      "cas v1",
    ]);
  });

  it("marks the superseded copy evictable so the accumulation stays self-limiting", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    ctx.setStableBlock("state_block", "spec v2");
    const entries = ctx.snapshot();
    const specs = entries.filter((e) => contentToText(e.message.content).startsWith("spec "));
    expect(specs.map((e) => e.evictable)).toEqual([true, false]);
  });

  /**
   * The regression this whole helper exists for: a revision must re-charge
   * nothing at all. The measured production defect rewrote the block in place at
   * 32% of the transcript, so every revision billed the other 67% fresh —
   * 2,929,430 tokens across one session.
   */
  it("a revision preserves the entire prefix, byte for byte", () => {
    const block = (v: number): string => `spec v${v} ${"y".repeat(2000)}`;
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    for (let i = 0; i < 200; i += 1) ctx.appendAssistant(`early ${i} ${"x".repeat(200)}`);
    ctx.setStableBlock("state_block", block(1));
    for (let i = 0; i < 200; i += 1) ctx.appendAssistant(`later ${i} ${"x".repeat(200)}`);
    const before = renderForPrefix(ctx.messages);

    ctx.setStableBlock("state_block", block(2));
    const after = renderForPrefix(ctx.messages);

    expect(prefixSurvival(before, after)).toBe(1);
    expect(after.startsWith(before)).toBe(true);
  });

  it("an unchanged block is a pure no-op: the whole prefix survives", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    for (let i = 0; i < 20; i += 1) ctx.appendAssistant(`entry ${i}`);
    const before = renderForPrefix(ctx.messages);

    ctx.setStableBlock("state_block", "spec v1");
    expect(prefixSurvival(before, renderForPrefix(ctx.messages))).toBe(1);
  });

  // Byte-identical content must not even rewrite the message object: a task
  // transition re-renders the same spec block every iteration, and the cached
  // prefix survives only while those bytes are untouched.
  it("is a no-op down to object identity when the content is unchanged", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    const first = ctx.messages[1]!;
    ctx.setStableBlock("state_block", "spec v1");
    expect(ctx.messages[1]).toBe(first);
  });

  it("counts as stable, so a breakpoint may anchor on it", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.setStableBlock("state_block", "spec v1");
    ctx.setCanonicalState("[state] header");
    const { stable } = ctx.cacheBreakpoints();
    expect(contentToText(ctx.messages[stable]!.content)).toBe("spec v1");
  });

  it("is never evicted, summarized, or force-dropped", () => {
    const ctx = createLiveContext(
      seed(),
      { ...ON, windowTokens: 1, preserveRecentTokens: 0 },
      {
        agent: "lead",
      },
    );
    ctx.setStableBlock("state_block", "spec v1");
    ctx.appendAssistantToolCalls("work", [call("c1")]);
    ctx.appendToolMessage("c1", toolResult("t", 4000));
    ctx.compact();
    ctx.forceEvictOldest();
    ctx.selectSummarizableSpan();
    expect(ctx.messages.map((m) => contentToText(m.content))).toContain("spec v1");
  });
});

describe("appendToolMessage — live-cap truncation", () => {
  it("does not truncate at or below the cap and returns no event", () => {
    const ctx = createLiveContext(seed(), SMALL_CAP, {
      agent: "subagent",
      subagent_instance_id: "w1",
    });
    const content = toolResult("small", 100);
    const out = ctx.appendToolMessage("c1", content);
    expect(out.truncated).toBe(false);
    expect(out.event).toBeUndefined();
    expect(out.fullText).toBe(content);
    expect(ctx.messages.at(-1)!.content).toBe(content);
  });

  it("truncates the result body above the cap and reports original size", () => {
    const ctx = createLiveContext(seed(), SMALL_CAP, {
      agent: "subagent",
      subagent_instance_id: "w1",
    });
    const content = toolResult("big", 1000);
    const out = ctx.appendToolMessage("c1", content);
    expect(out.truncated).toBe(true);
    expect(out.fullText).toBe(content);
    expect(out.event).toMatchObject({
      agent: "subagent",
      subagent_instance_id: "w1",
      operation: "truncation",
      original_chars: 1000,
      kept_chars: 200,
    });
    const last = ctx.messages.at(-1)!;
    expect(last.role).toBe("tool");
    expect(last.content).toContain("kept the first 100 and last 100 chars");
    expect(last.content).toContain("original ~1000 chars");
    expect(contentToText(last.content).startsWith(content.slice(0, 100))).toBe(true);
    expect(contentToText(last.content).endsWith(content.slice(-100))).toBe(true);
    expect(last.content.length).toBeLessThan(content.length);
  });

  it("names the spill path in the marker when the caller supplied one", () => {
    const ctx = createLiveContext(seed(), SMALL_CAP, { agent: "subagent" });
    const content = toolResult("big", 1000);
    ctx.appendToolMessage("c1", content, { spillPath: ".clarvis/toolout-a3f19c2e.txt" });
    expect(ctx.messages.at(-1)!.content).toContain(
      "original ~1000 chars; full output at .clarvis/toolout-a3f19c2e.txt]",
    );
  });

  it("keeps the marker free of a path when no spill happened", () => {
    const ctx = createLiveContext(seed(), SMALL_CAP, { agent: "subagent" });
    ctx.appendToolMessage("c1", toolResult("big", 1000));
    const body = contentToText(ctx.messages.at(-1)!.content);
    expect(body).toContain("original ~1000 chars]");
    expect(body).not.toContain("full output at");
  });

  it("keeps head and tail byte-identical whether or not a spill path is present", () => {
    const content = toolResult("big", 1000);
    const bare = createLiveContext(seed(), SMALL_CAP, { agent: "subagent" });
    const spilled = createLiveContext(seed(), SMALL_CAP, { agent: "subagent" });
    bare.appendToolMessage("c1", content);
    spilled.appendToolMessage("c1", content, { spillPath: ".clarvis/toolout-x.txt" });

    const halves = (m: string): [string, string] => {
      const lines = m.split("\n");
      return [lines[0]!, lines.at(-1)!];
    };
    expect(halves(contentToText(spilled.messages.at(-1)!.content))).toEqual(
      halves(contentToText(bare.messages.at(-1)!.content)),
    );
  });
});

describe("willTruncateToolResult", () => {
  it("agrees with appendToolMessage on both sides of the cap", () => {
    expect(willTruncateToolResult(toolResult("a", 1000), SMALL_CAP)).toBe(true);
    expect(willTruncateToolResult(toolResult("a", 200), SMALL_CAP)).toBe(false);
    expect(willTruncateToolResult(toolResult("a", 201), SMALL_CAP)).toBe(true);
  });

  it("is false for any size when compaction is disabled", () => {
    expect(willTruncateToolResult(toolResult("a", 1_000_000), DISABLED_COMPACTION)).toBe(false);
  });
});

describe("truncation keeps the tool pair", () => {
  it("an oversized result stays a `tool` message with its tool_call_id; only content shrinks", () => {
    const cfg: CompactionConfig = {
      enabled: true,
      windowTokens: 1000,
      fraction: 0.8,
      targetFraction: 0.8,
      maxResultChars: 200,
      preserveRecentTokens: 1,
    };
    const ctx = createLiveContext(seedShort(), cfg, {
      agent: "subagent",
      subagent_instance_id: "w1",
    });
    ctx.appendAssistantToolCalls("", [call("c1")]);
    const big = "Tool 't' result: " + "x".repeat(5000);
    const out = ctx.appendToolMessage("c1", big);

    expect(out.truncated).toBe(true);
    const last = ctx.messages.at(-1)!;
    expect(last.role).toBe("tool");
    expect((last as { tool_call_id: string }).tool_call_id).toBe("c1");
    expect(last.content.length).toBeLessThan(big.length);
    expect(last.content).toContain("truncated");
    const { calls, results } = pairedIds(ctx.messages);
    expect(new Set(calls)).toEqual(new Set(results));
  });
});

describe("compact — oldest-first eviction", () => {
  it("is a no-op when under budget (returns undefined, messages unchanged)", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    ctx.appendToolMessage("c1", toolResult("a", 100));
    const before = ctx.messages.map((m) => m.content);
    expect(ctx.compact()).toBeUndefined();
    expect(ctx.messages.map((m) => m.content)).toEqual(before);
  });

  it("evicts oldest-first until under budget, coalescing to one marker", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    for (let i = 0; i < 5; i += 1) ctx.appendToolMessage(`c${i}`, toolResult(`r${i}`, 1000));
    const ev = ctx.compact();
    expect(ev).toBeDefined();
    expect(ev!.operation).toBe("eviction");
    expect(ev!.agent).toBe("lead");
    expect(ev!.evicted_count).toBeGreaterThanOrEqual(1);
    expect(ev!.freed_chars).toBeGreaterThan(0);
    expect(ctx.estimateTokens()).toBeLessThanOrEqual(Math.floor(ON.windowTokens * ON.fraction));
    const markers = ctx.messages.filter((m) =>
      /earlier tool result.* evicted to fit context/.test(contentToText(m.content)),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.content).toMatch(
      /^\[runtime: \d+ earlier tool results? evicted to fit context\]$/,
    );
  });

  it("never evicts the seed, assistant turns, notes, or the most-recent result", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    ctx.appendAssistant("reasoning turn");
    for (let i = 0; i < 5; i += 1) ctx.appendToolMessage(`c${i}`, toolResult(`r${i}`, 1000));
    const newestResult = ctx.messages.at(-1)!.content;
    ctx.appendNote("[runtime: tokens_remaining=10]");
    ctx.compact();
    const contents = ctx.messages.map((m) => m.content);
    expect(contents).toContain("seed task");
    expect(contents).toContain("reasoning turn");
    expect(contents).toContain("[runtime: tokens_remaining=10]");
    expect(contents).toContain(newestResult);
  });

  it("is best-effort: if it cannot free enough it evicts what it can and returns", () => {
    const cfg: CompactionConfig = { ...ON, windowTokens: 4, fraction: 1, preserveRecentTokens: 10 };
    const ctx = createLiveContext(seed(), cfg, { agent: "subagent" });
    ctx.appendToolMessage("c1", toolResult("a", 1000));
    ctx.appendToolMessage("c2", toolResult("b", 1000));

    const ev = ctx.compact();
    expect(ev).toBeDefined();
    expect(ev!.evicted_count).toBe(1);
    expect(ctx.estimateTokens()).toBeGreaterThan(Math.floor(cfg.windowTokens * cfg.targetFraction));
    const ids = ctx.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(ids).toEqual(["c2"]);
  });
});

describe("preserveRecentTokens — the protected tail is a token budget", () => {
  const TAIL: CompactionConfig = { ...ON, targetFraction: 0.4, preserveRecentTokens: 200 };

  const ids = (ctx: ReturnType<typeof createLiveContext>): string[] =>
    ctx.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id: string }).tool_call_id);

  /**
   * The defect the token budget replaces: counting entries protected exactly two
   * of them however cheap the rest were, so a run of small recent results was
   * evicted out from under the model while one huge old result stayed eligible.
   * Under `preserveRecent: 2` this evicted `t1`..`t6` as well as `big`.
   */
  it("protects a whole run of cheap recent results, not just the newest two", () => {
    const tiny = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const ctx = createLiveContext([{ role: "user", content: "S".repeat(2400) }], TAIL, {
      agent: "lead",
    });
    ctx.appendAssistantToolCalls("", ["big", ...tiny].map(call));
    ctx.appendToolMessage("big", toolResult("big", 1200));
    for (const id of tiny) ctx.appendToolMessage(id, toolResult(id, 40));

    expect(ctx.needsCompaction()).toBe(true);
    expect(ctx.compact()!.evicted_count).toBe(1);
    expect(ids(ctx)).toEqual(tiny);
    assertValidToolOrdering(ctx.messages);
  });

  it("does not admit an entry that would push the tail span over budget", () => {
    const ctx = createLiveContext(seedShort(), TAIL, { agent: "lead" });
    ctx.appendToolMessage("old", toolResult("old", 4000));
    ctx.appendToolMessage("mid", toolResult("mid", 4000));
    ctx.appendToolMessage("new", toolResult("new", 400));
    ctx.compact();
    expect(ids(ctx)).toEqual(["new"]);
  });

  it("protects the newest result unconditionally, even when it alone exceeds the budget", () => {
    const cfg: CompactionConfig = { ...TAIL, preserveRecentTokens: 10 };
    const ctx = createLiveContext(seedShort(), cfg, { agent: "lead" });
    ctx.appendToolMessage("old", toolResult("old", 4000));
    ctx.appendToolMessage("new", toolResult("new", 4000));
    ctx.compact();
    expect(ids(ctx)).toEqual(["new"]);
  });

  /**
   * A superseded stable block is evictable and sits wherever it was appended, so
   * it can be the newest *evictable* entry while being, by definition, not what
   * the model just received. Charged against the reserve it consumes the whole
   * of it — one block is easily wider than the budget — and the recent results
   * behind it fall out of protection. Compaction then drops what the model is
   * working from and keeps a copy that has already been replaced, which is the
   * exact inversion of what the tail reserve is for.
   */
  it("does not spend the tail reserve on a superseded stable block", () => {
    const ctx = createLiveContext(seedShort(), TAIL, { agent: "lead" });
    ctx.appendToolMessage("old", toolResult("old", 4000));
    ctx.appendToolMessage("recent", toolResult("recent", 400));
    ctx.setStableBlock("state_block", "S".repeat(4000));
    ctx.setStableBlock("state_block", "S".repeat(4100));

    ctx.compact();
    // The superseded copy is a candidate; the result just handed to the model
    // is not.
    expect(ids(ctx)).toEqual(["recent"]);
    expect(ctx.messages.map((m) => contentToText(m.content))).toContain("S".repeat(4100));
    expect(ctx.messages.map((m) => contentToText(m.content))).not.toContain("S".repeat(4000));
  });

  it("protects nothing at a zero budget, the newest result included", () => {
    const cfg: CompactionConfig = { ...TAIL, windowTokens: 4, preserveRecentTokens: 0 };
    const ctx = createLiveContext(seedShort(), cfg, { agent: "lead" });
    for (let i = 0; i < 6; i += 1) ctx.appendToolMessage(`c${i}`, toolResult(`c${i}`, 1000));
    ctx.compact();
    expect(ids(ctx)).toEqual([]);
  });

  it("clamps the budget to half the low-water mark, so an absurd one cannot stall compaction", () => {
    const cfg: CompactionConfig = { ...TAIL, preserveRecentTokens: 1_000_000 };
    const ctx = createLiveContext(seedShort(), cfg, { agent: "lead" });
    for (let i = 0; i < 10; i += 1) ctx.appendToolMessage(`c${i}`, toolResult(`c${i}`, 400));

    expect(ctx.compact()).toBeDefined();
    expect(ctx.estimateTokens()).toBeLessThanOrEqual(
      Math.floor(cfg.windowTokens * cfg.targetFraction),
    );
    expect(ids(ctx)).not.toContain("c0");
    expect(ids(ctx)).toContain("c9");
  });

  /**
   * Regression guard for the design: the usage anchor corrects the *absolute*
   * estimate and must not move the tail boundary. An earlier proposal measured
   * the tail with the anchored estimator, which returns ~0 for a subset and
   * would have protected the entire evictable list.
   */
  it("keeps the tail boundary anchor-independent while the water marks stay anchored", () => {
    const build = (): ReturnType<typeof createLiveContext> => {
      const c = createLiveContext(seedShort(), TAIL, { agent: "lead" });
      for (let i = 0; i < 10; i += 1) c.appendToolMessage(`c${i}`, toolResult(`c${i}`, 400));
      return c;
    };
    const plain = build();
    const anchored = build();
    anchored.observeUsage(5000);
    expect(anchored.estimateTokens()).toBe(5000);

    plain.compact();
    anchored.compact();
    expect(ids(plain).slice(-2)).toEqual(["c8", "c9"]);
    expect(ids(anchored).slice(-2)).toEqual(["c8", "c9"]);
  });
});

describe("derivePreserveRecentTokens", () => {
  it("is 8% of the window, clamped to [4000, 32000]", () => {
    expect(derivePreserveRecentTokens(128_000)).toBe(10_240);
    expect(derivePreserveRecentTokens(200_000)).toBe(16_000);
    expect(derivePreserveRecentTokens(50_000)).toBe(4_000);
    expect(derivePreserveRecentTokens(8_000)).toBe(4_000);
    expect(derivePreserveRecentTokens(1)).toBe(4_000);
    expect(derivePreserveRecentTokens(1_000_000)).toBe(32_000);
  });
});

describe("needsCompaction", () => {
  it("is false under budget and when compaction is disabled", () => {
    const under = createLiveContext(seed(), ON, { agent: "lead" });
    under.appendToolMessage("c1", toolResult("a", 100));
    expect(under.needsCompaction()).toBe(false);

    const disabled = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    for (let i = 0; i < 5; i += 1) disabled.appendToolMessage(`c${i}`, toolResult(`r${i}`, 1000));
    expect(disabled.needsCompaction()).toBe(false);
  });

  it("is true exactly when compact() would evict, and false again afterwards", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    for (let i = 0; i < 5; i += 1) ctx.appendToolMessage(`c${i}`, toolResult(`r${i}`, 1000));
    expect(ctx.needsCompaction()).toBe(true);
    expect(ctx.compact()).toBeDefined();
    expect(ctx.needsCompaction()).toBe(false);
  });
});

describe("hysteresis (high-water trigger, low-water drain)", () => {
  const HYST: CompactionConfig = {
    enabled: true,
    windowTokens: 1000,
    fraction: 0.8,
    targetFraction: 0.4,
    maxResultChars: 1_000_000,
    preserveRecentTokens: 0,
  };

  const fillPairs = (ctx: ReturnType<typeof createLiveContext>, n: number): void => {
    for (let i = 0; i < n; i += 1) {
      ctx.appendAssistantToolCalls("", [call(`c${i}`)]);
      ctx.appendToolMessage(`c${i}`, toolResult("t", 400));
    }
  };

  it("one compact() drains from above high-water all the way down to <= low-water", () => {
    const ctx = createLiveContext(seedShort(), HYST, { agent: "subagent" });
    fillPairs(ctx, 10);
    expect(ctx.estimateTokens()).toBeGreaterThan(Math.floor(HYST.windowTokens * HYST.fraction));
    expect(ctx.compact()).toBeDefined();
    expect(ctx.estimateTokens()).toBeLessThanOrEqual(
      Math.floor(HYST.windowTokens * HYST.targetFraction),
    );
  });

  it("after a drain to low-water, modest growth does not re-trigger until high-water (no thrash)", () => {
    const ctx = createLiveContext(seedShort(), HYST, { agent: "subagent" });
    fillPairs(ctx, 10);
    ctx.compact();
    ctx.appendAssistantToolCalls("", [call("cX")]);
    ctx.appendToolMessage("cX", toolResult("t", 400));
    expect(ctx.estimateTokens()).toBeGreaterThan(
      Math.floor(HYST.windowTokens * HYST.targetFraction),
    );
    expect(ctx.estimateTokens()).toBeLessThanOrEqual(Math.floor(HYST.windowTokens * HYST.fraction));
    expect(ctx.compact()).toBeUndefined();
  });

  it("protects the recent tail even while draining deep to low-water", () => {
    const ctx = createLiveContext(
      seedShort(),
      { ...HYST, preserveRecentTokens: 200 },
      { agent: "subagent" },
    );
    fillPairs(ctx, 10);
    ctx.compact();
    const survivingToolIds = ctx.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(survivingToolIds).toContain("c8");
    expect(survivingToolIds).toContain("c9");
  });
});

describe("forceEvictOldest — overflow recovery, ignores the budget gate", () => {
  it("drops the oldest result even when under budget (where compact() is a no-op)", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    for (let i = 0; i < 3; i += 1) ctx.appendToolMessage(`c${i}`, toolResult(`r${i}`, 100));
    const oldest = ctx.messages.find((m) => m.role === "tool")!.content;
    expect(ctx.compact()).toBeUndefined();
    const ev = ctx.forceEvictOldest();
    expect(ev).toBeDefined();
    expect(ev!.operation).toBe("eviction");
    expect(ev!.agent).toBe("lead");
    expect(ev!.evicted_count).toBe(1);
    expect(ev!.freed_chars).toBeGreaterThan(0);
    const contents = ctx.messages.map((m) => contentToText(m.content));
    expect(contents).not.toContain(oldest);
    const markers = contents.filter((c) =>
      /^\[runtime: 1 earlier tool result evicted to fit context\]$/.test(c),
    );
    expect(markers).toHaveLength(1);
  });

  it("in emergency mode ignores the preserve-recent budget to evict even the protected tail", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    ctx.appendToolMessage("c0", toolResult("only", 100));
    const ev = ctx.forceEvictOldest();
    expect(ev).toBeDefined();
    expect(ev!.evicted_count).toBe(1);
    expect(ctx.messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("returns undefined when compaction is disabled", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "subagent" });
    for (let i = 0; i < 3; i += 1) ctx.appendToolMessage(`c${i}`, toolResult(`r${i}`, 100));
    expect(ctx.forceEvictOldest()).toBeUndefined();
  });

  it("keeps assistant↔tool pairing valid with no orphaned tool_calls", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    const ids = ["c0", "c1", "c2"];
    ctx.appendAssistantToolCalls("calling tools", ids.map(call));
    for (const id of ids) ctx.appendToolMessage(id, toolResult(id, 100));
    expect(ctx.forceEvictOldest()).toBeDefined();
    assertValidToolOrdering(ctx.messages);
    const toolIds = ctx.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    const callIds = ctx.messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    );
    expect(new Set(toolIds)).toEqual(new Set(callIds));
    expect(callIds.length).toBeLessThan(ids.length);
  });

  it("keeps freeing real results across repeated calls instead of re-evicting its own marker", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    for (let i = 0; i < 3; i += 1) {
      ctx.appendToolMessage(`c${i}`, toolResult(`c${i}`, 500));
      ctx.appendNote(`note ${i}`);
    }
    const freed: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ev = ctx.forceEvictOldest();
      expect(ev, `call ${i} must still find a real tool result to evict`).toBeDefined();
      freed.push(ev!.freed_chars ?? 0);
    }
    expect(ctx.messages.some((m) => m.role === "tool")).toBe(false);
    for (const f of freed) expect(f).toBeGreaterThan(200);
    expect(ctx.forceEvictOldest()).toBeUndefined();
  });
});

describe("pairing-preserving eviction", () => {
  it("drops an evicted result's tool_call from the owning assistant; no orphan remains", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    const ids = ["c0", "c1", "c2", "c3", "c4"];
    ctx.appendAssistantToolCalls("calling tools", ids.map(call));
    for (const id of ids) ctx.appendToolMessage(id, toolResult(id, 1000));
    ctx.compact();
    const toolIds = ctx.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    const callIds = ctx.messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    );
    expect(new Set(toolIds)).toEqual(new Set(callIds));
    expect(callIds.length).toBeLessThan(ids.length);
  });

  it("drops the assistant turn entirely when it loses all calls and has no prose", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    const ids = ["c0", "c1", "c2", "c3", "c4"];
    ctx.appendAssistantToolCalls("", ids.map(call));
    for (const id of ids) ctx.appendToolMessage(id, toolResult(id, 1000));
    ctx.compact();
    for (const m of ctx.messages) {
      if (m.role === "assistant" && "tool_calls" in m) {
        expect(m.tool_calls.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("pairing after eviction", () => {
  it("forcing eviction over a tool exchange leaves no orphan and exactly one trim marker", () => {
    const cfg: CompactionConfig = {
      enabled: true,
      windowTokens: 1000,
      fraction: 0.8,
      targetFraction: 0.8,
      maxResultChars: 1_000_000,
      preserveRecentTokens: 1,
    };
    const ctx = createLiveContext([{ role: "user", content: "seed" }], cfg, { agent: "lead" });
    const ids = ["e0", "e1", "e2", "e3", "e4"];
    ctx.appendAssistantToolCalls(
      "calling",
      ids.map((id) => ({ id, name: "t", arguments: {} })),
    );
    for (const id of ids) {
      ctx.appendToolMessage(id, `Tool 't' result: ${"x".repeat(1000)}`);
    }
    const ev = ctx.compact();
    expect(ev?.operation).toBe("eviction");

    const surviving = ctx.messages;
    const callIds = surviving.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    );
    const resultIds = surviving.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    expect(new Set(callIds)).toEqual(new Set(resultIds));
    expect(callIds.length).toBeLessThan(ids.length);
    const markers = surviving.filter((m) =>
      /evicted to fit context/.test(contentToText(m.content)),
    );
    expect(markers).toHaveLength(1);
  });
});

describe("summary replacement preserves assistant↔tool pairing", () => {
  it("replaces a span's tool message with a summary AND drops the matching ToolCallRef; no orphan", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendAssistantToolCalls("", [
      callNamed("c1", "delegate_task"),
      callNamed("c2", "delegate_task"),
    ]);
    ctx.appendToolMessage("c1", "Tool 'delegate_task' result: " + "A".repeat(500), {
      taskId: "t1",
    });
    ctx.appendToolMessage("c2", "Tool 'delegate_task' result: kept", { taskId: "t2" });

    const idxC1 = ctx.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "c1");
    const ev = ctx.replaceSpanWithSummary([idxC1], "summary-of-t1");
    expect(ev.operation).toBe("summarization");

    expect(ctx.messages.some((m) => m.role === "tool" && m.tool_call_id === "c1")).toBe(false);
    expect(ctx.messages.some((m) => m.role === "tool" && m.tool_call_id === "c2")).toBe(true);
    expect(ctx.messages.some((m) => contentToText(m.content).includes("summary-of-t1"))).toBe(true);

    const { calls, results } = pairedIds(ctx.messages);
    expect(calls).not.toContain("c1");
    expect(calls).toContain("c2");
    expect(new Set(calls)).toEqual(new Set(results));
    expect(ctx.snapshot().find((e) => e.summary)!.evictable).toBe(false);
  });

  /**
   * The update path drops its span with no insert, so `rebuildDroppingTools`'
   * forward-swap never runs. Pairing has to survive on the ref-pruning alone.
   */
  it("keeps pairing valid on the update path, where no entry is inserted", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendAssistantToolCalls("", [call("c1"), call("c2")]);
    ctx.appendToolMessage("c1", "first");
    ctx.appendToolMessage("c2", "second");
    const idxC1 = ctx.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "c1");
    ctx.replaceSpanWithSummary([idxC1], "gist one");

    ctx.appendAssistantToolCalls("", [call("c3"), call("c4")]);
    ctx.appendToolMessage("c3", "third");
    ctx.appendToolMessage("c4", "fourth");
    const idxC3 = ctx.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "c3");
    ctx.replaceSpanWithSummary([idxC3], "gist two");

    assertValidToolOrdering(ctx.messages);
    const { calls, results } = pairedIds(ctx.messages);
    expect(new Set(calls)).toEqual(new Set(results));
    expect(calls).not.toContain("c1");
    expect(calls).not.toContain("c3");
  });

  it("removes an assistant turn whose every result the span dropped", () => {
    const ctx = createLiveContext(seedShort(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendAssistantToolCalls("", [call("c1"), call("c2")]);
    ctx.appendToolMessage("c1", "first");
    ctx.appendToolMessage("c2", "second");
    const idx = ctx.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i !== -1);

    ctx.replaceSpanWithSummary(idx, "everything");

    assertValidToolOrdering(ctx.messages);
    const { calls, results } = pairedIds(ctx.messages);
    expect(calls).toEqual([]);
    expect(results).toEqual([]);
  });
});

describe("the rolling summary anchor", () => {
  const summarize = (ctx: ReturnType<typeof createLiveContext>, text: string): void => {
    const span = ctx.selectSummarizableSpan();
    expect(span).toBeDefined();
    ctx.replaceSpanWithSummary(span!.indices, text);
  };

  const overBudget = (): ReturnType<typeof createLiveContext> => {
    const ctx = createLiveContext(seed(), { ...ON, preserveRecentTokens: 0 }, { agent: "lead" });
    for (let i = 0; i < 5; i += 1) {
      ctx.appendAssistantToolCalls("", [call(`c${i}`)]);
      ctx.appendToolMessage(`c${i}`, toolResult(`r${i}`, 1000));
    }
    return ctx;
  };

  it("summaryAnchor() returns the body without the marker, and undefined before any pass", () => {
    const ctx = overBudget();
    expect(ctx.summaryAnchor()).toBeUndefined();
    summarize(ctx, "the gist");
    expect(ctx.summaryAnchor()).toBe("the gist");
  });

  it("stays a single entry across repeated passes, holding the latest text", () => {
    const ctx = overBudget();
    summarize(ctx, "one");
    for (const id of ["d1", "d2"]) {
      ctx.appendAssistantToolCalls("", [call(id)]);
      ctx.appendToolMessage(id, toolResult(id, 1000));
    }
    summarize(ctx, "two");
    ctx.appendAssistantToolCalls("", [call("d3")]);
    ctx.appendToolMessage("d3", toolResult("d3", 1000));
    summarize(ctx, "three");

    expect(ctx.snapshot().filter((e) => e.summary)).toHaveLength(1);
    expect(ctx.summaryAnchor()).toBe("three");
  });

  it("is rewritten in place, leaving every earlier entry where it was", () => {
    const ctx = overBudget();
    summarize(ctx, "one");
    const anchorIdx = ctx.messages.findIndex((m) =>
      contentToText(m.content).includes("rolling summary"),
    );
    const before = ctx.messages.slice(0, anchorIdx).map((m) => contentToText(m.content));

    ctx.appendAssistantToolCalls("", [call("d1")]);
    ctx.appendToolMessage("d1", toolResult("d1", 1000));
    summarize(ctx, "two");

    const nextIdx = ctx.messages.findIndex((m) =>
      contentToText(m.content).includes("rolling summary"),
    );
    expect(nextIdx).toBe(anchorIdx);
    expect(ctx.messages.slice(0, nextIdx).map((m) => contentToText(m.content))).toEqual(before);
  });

  /**
   * The update path rewrites `entry.chars` in place and leans on the following
   * rebuild to recompute the running total. If that debt ever goes unpaid the
   * estimate stops tracking the transcript, and this is what notices.
   */
  it("keeps the running total honest when a shorter summary replaces a longer one", () => {
    const ctx = overBudget();
    summarize(ctx, "L".repeat(400));
    const wide = ctx.estimateTokens();
    ctx.appendAssistantToolCalls("", [call("d1")]);
    ctx.appendToolMessage("d1", toolResult("d1", 1000));
    summarize(ctx, "S");

    expect(ctx.estimateTokens()).toBeLessThan(wide);
    expect(ctx.estimateTokens()).toBe(
      estimateTokensForChars(ctx.messages.reduce((n, m) => n + liveMessageChars(m), 0)),
    );
  });

  it("survives compact() and forceEvictOldest() under maximum pressure", () => {
    const ctx = overBudget();
    summarize(ctx, "durable gist");
    ctx.appendAssistantToolCalls("", [call("d1")]);
    ctx.appendToolMessage("d1", toolResult("d1", 1000));

    ctx.compact();
    ctx.forceEvictOldest();
    ctx.forceEvictOldest();

    expect(ctx.summaryAnchor()).toBe("durable gist");
  });

  it("is never offered back as a summarizable span", () => {
    const ctx = overBudget();
    summarize(ctx, "durable gist");
    ctx.appendAssistantToolCalls("", [call("d1")]);
    ctx.appendToolMessage("d1", toolResult("d1", 4000));

    const span = ctx.selectSummarizableSpan();
    expect(
      (span?.messages ?? []).some((m) => contentToText(m.content).includes("durable gist")),
    ).toBe(false);
  });

  it("counts as a stable entry, so it never breaks the cache-breakpoint scan", () => {
    const ctx = overBudget();
    summarize(ctx, "durable gist");
    const anchorIdx = ctx.messages.findIndex((m) =>
      contentToText(m.content).includes("rolling summary"),
    );
    expect(ctx.cacheBreakpoints().stable).toBeGreaterThanOrEqual(anchorIdx);
  });

  it("reports anchor_chars and anchor_updated, and only on summarization", () => {
    const ctx = overBudget();
    const first = ctx.selectSummarizableSpan()!;
    const created = ctx.replaceSpanWithSummary(first.indices, "one");
    expect(created.anchor_updated).toBe(false);
    expect(created.anchor_chars).toBeGreaterThan("one".length);

    ctx.appendAssistantToolCalls("", [call("d1")]);
    ctx.appendToolMessage("d1", toolResult("d1", 4000));
    const second = ctx.selectSummarizableSpan()!;
    const updated = ctx.replaceSpanWithSummary(second.indices, "two");
    expect(updated.anchor_updated).toBe(true);

    ctx.appendAssistantToolCalls("", [call("d2")]);
    ctx.appendToolMessage("d2", toolResult("d2", 4000));
    const evicted = ctx.compact();
    expect(evicted?.anchor_chars).toBeUndefined();
    expect(evicted?.anchor_updated).toBeUndefined();
  });
});

describe("compaction never splits an assistant turn from its surviving tool results", () => {
  it("evicting an OLDER parallel result keeps the marker out of the assistant→tool pair", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    const ids = ["c0", "c1", "c2", "c3", "c4"];
    ctx.appendAssistantToolCalls("calling tools", ids.map(call));
    for (const id of ids) ctx.appendToolMessage(id, toolResult(id, 1000));
    const ev = ctx.compact();
    expect(ev).toBeDefined();
    assertValidToolOrdering(ctx.messages);
    const toolIds = ctx.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    const callIds = ctx.messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    );
    expect(new Set(toolIds)).toEqual(new Set(callIds));
    expect(callIds.length).toBeLessThan(ids.length);
  });

  it("eviction across MULTIPLE turns (some partial) yields a wholly valid ordering", () => {
    const ctx = createLiveContext(seed(), { ...ON, preserveRecentTokens: 1 }, { agent: "lead" });
    ctx.appendAssistantToolCalls("A", [call("a0"), call("a1")]);
    ctx.appendToolMessage("a0", toolResult("a0", 1000));
    ctx.appendToolMessage("a1", toolResult("a1", 1000));
    ctx.appendAssistantToolCalls("B", [call("b0")]);
    ctx.appendToolMessage("b0", toolResult("b0", 1000));
    ctx.appendAssistantToolCalls("C", [call("c0"), call("c1")]);
    ctx.appendToolMessage("c0", toolResult("c0", 1000));
    ctx.appendToolMessage("c1", toolResult("c1", 1000));
    ctx.compact();
    assertValidToolOrdering(ctx.messages);
    const toolIds = ctx.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    const callIds = ctx.messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    );
    expect(new Set(toolIds)).toEqual(new Set(callIds));
  });

  it("stays valid with notes/canonical-state at turn boundaries (the realistic loop shape)", () => {
    const ctx = createLiveContext(seed(), { ...ON, preserveRecentTokens: 1 }, { agent: "lead" });
    ctx.setCanonicalState("[state] canonical state pinned");
    ctx.appendAssistantToolCalls("A", [call("a0"), call("a1")]);
    ctx.appendToolMessage("a0", toolResult("a0", 1000));
    ctx.appendToolMessage("a1", toolResult("a1", 1000));
    ctx.appendUser("[runtime: tokens_remaining=…]");
    ctx.appendAssistantToolCalls("B", [call("b0"), call("b1")]);
    ctx.appendToolMessage("b0", toolResult("b0", 1000));
    ctx.appendToolMessage("b1", toolResult("b1", 1000));
    ctx.appendNote("[runtime: another boundary note]");
    ctx.compact();
    assertValidToolOrdering(ctx.messages);
    const toolIds = ctx.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    const callIds = ctx.messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
    );
    expect(new Set(toolIds)).toEqual(new Set(callIds));
  });

  it("LLM-summary replacement of an OLDER parallel result keeps a valid ordering", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendAssistantToolCalls("", [call("c1"), call("c2")]);
    ctx.appendToolMessage("c1", "Tool 't' result: " + "A".repeat(500));
    ctx.appendToolMessage("c2", "Tool 't' result: kept");
    const idxC1 = ctx.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "c1");
    ctx.replaceSpanWithSummary([idxC1], "summary-of-c1");
    assertValidToolOrdering(ctx.messages);
    expect(ctx.messages.some((m) => contentToText(m.content).includes("summary-of-c1"))).toBe(true);
    expect(ctx.messages.some((m) => m.role === "tool" && m.tool_call_id === "c2")).toBe(true);
  });
});

describe("below-threshold / disabled ⇒ byte-identical projection", () => {
  it("disabled config: messages equal the raw push sequence and nothing truncates", () => {
    const cfg = DISABLED_COMPACTION;
    const ctx = createLiveContext(seed(), cfg, { agent: "subagent" });
    const huge = toolResult("big", 10_000);
    ctx.appendAssistantToolCalls("", [call("c1")]);
    const out = ctx.appendToolMessage("c1", huge);
    expect(out.truncated).toBe(false);
    expect(ctx.compact()).toBeUndefined();
    expect(ctx.messages).toEqual([
      { role: "user", content: "seed task" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", tool_call_id: "c1", content: huge },
    ]);
  });

  it("enabled but under threshold: projection equals the raw push sequence", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "subagent" });
    ctx.appendAssistantToolCalls("", [call("c1")]);
    ctx.appendToolMessage("c1", "Tool 'x' result: tiny");
    expect(ctx.compact()).toBeUndefined();
    expect(ctx.messages).toEqual([
      { role: "user", content: "seed task" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", tool_call_id: "c1", content: "Tool 'x' result: tiny" },
    ]);
  });
});

describe("appendRuntimeNote — replaceable per-kind runtime notes", () => {
  it("keeps at most one live note per kind, replacing the earlier value", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendRuntimeNote("tokens_remaining", "[runtime: tokens_remaining=100]");
    ctx.appendAssistant("working");
    ctx.appendRuntimeNote("tokens_remaining", "[runtime: tokens_remaining=50]");
    const notes = ctx.messages.filter(
      (m) => typeof m.content === "string" && m.content.includes("tokens_remaining="),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe("[runtime: tokens_remaining=50]");
    expect(ctx.messages[ctx.messages.length - 1]!.content).toBe("[runtime: tokens_remaining=50]");
  });

  it("notes of different kinds coexist and replace independently", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendRuntimeNote("tokens_remaining", "tokens v1");
    ctx.appendRuntimeNote("empty_response", "empty v1");
    ctx.appendRuntimeNote("tokens_remaining", "tokens v2");
    const texts = ctx.messages.map((m) => m.content);
    expect(texts).toContain("empty v1");
    expect(texts).toContain("tokens v2");
    expect(texts).not.toContain("tokens v1");
  });

  it("does not disturb plain appendNote notes (they still accumulate)", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendNote("note a");
    ctx.appendNote("note b");
    ctx.appendRuntimeNote("k", "runtime note");
    const texts = ctx.messages.map((m) => m.content);
    expect(texts).toContain("note a");
    expect(texts).toContain("note b");
    expect(texts).toContain("runtime note");
  });
});

describe("running character total stays equal to the sum of its entries", () => {
  const sumOfMessages = (ctx: ReturnType<typeof createLiveContext>): number =>
    ctx.messages.reduce((n, m) => n + liveMessageChars(m), 0);

  /**
   * `estimateTokens()` is `ceil(total / 4)` while no usage anchor has been
   * observed, so it is the only public read of the running total — and the
   * cheapest way to assert the invariant a desynced cache would break silently.
   */
  const totalFrom = (ctx: ReturnType<typeof createLiveContext>): number => ctx.estimateTokens();
  const expectedFrom = (ctx: ReturnType<typeof createLiveContext>): number =>
    estimateTokensForChars(sumOfMessages(ctx));

  it("holds across appends, tool results, runtime notes and canonical state", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.appendUser("a user turn");
    ctx.appendAssistantToolCalls("thinking", [call("c1")]);
    ctx.appendToolMessage("c1", toolResult("t", 500));
    ctx.appendNote("a note");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.appendRuntimeNote("k", "runtime v1");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.appendRuntimeNote("k", "runtime v2 which is a good deal longer than v1");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.setCanonicalState("canonical one");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.setCanonicalState("canonical two, replacing the first");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));
  });

  it("holds across setStableBlock, the one path that rewrites a message in place", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });

    ctx.setStableBlock("skills", "a short block");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.setStableBlock("skills", "a considerably longer block than the first one was");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.setStableBlock("skills", "short again");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.setStableBlock("skills", "short again");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.setStableBlock("digest", "a second block of another kind");
    ctx.appendUser("a turn after both blocks");
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));
  });

  it("holds after an eviction rebuild drops tool results and rewrites their owner", () => {
    const ctx = createLiveContext(seed(), ON, { agent: "lead" });
    for (let i = 0; i < 8; i++) {
      ctx.appendAssistantToolCalls("", [call(`c${i}`)]);
      ctx.appendToolMessage(`c${i}`, toolResult("t", 900));
    }
    expect(ctx.compact()).toBeDefined();
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));

    ctx.forceEvictOldest();
    expect(totalFrom(ctx)).toBe(expectedFrom(ctx));
  });
});

describe("volatile entries stay in one trailing run, so a cached prefix survives", () => {
  const roles = (ctx: ReturnType<typeof createLiveContext>): string[] =>
    ctx.messages.map((m) => m.role);

  it("keeps a runtime note last when ordinary turns arrive after it", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendRuntimeNote("tokens_remaining", "note v1");
    ctx.appendAssistantToolCalls("", [call("c1")]);
    ctx.appendToolMessage("c1", "result");

    expect(roles(ctx)).toEqual(["user", "assistant", "tool", "user"]);
    expect(contentToText(ctx.messages.at(-1)!.content)).toBe("note v1");
  });

  it("keeps the canonical block last, after both the note and the newest tool run", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendRuntimeNote("k", "note");
    ctx.setCanonicalState("state v1");
    ctx.appendAssistantToolCalls("", [call("c1")]);
    ctx.appendToolMessage("c1", "result");

    const tail = ctx.messages.slice(-2).map((m) => contentToText(m.content));
    expect(tail).toEqual(["note", "state v1"]);
  });

  it("puts a stable block ahead of the volatile run rather than behind it", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendRuntimeNote("k", "note");
    ctx.setStableBlock("state_block", "the spec");

    expect(ctx.messages.map((m) => contentToText(m.content))).toEqual([
      "seed task",
      "the spec",
      "note",
    ]);
  });

  it("never anchors a breakpoint at or after a volatile entry", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendRuntimeNote("k", "note");
    ctx.setCanonicalState("digest");
    ctx.appendAssistantToolCalls("", [call("c1")]);
    ctx.appendToolMessage("c1", "result");
    ctx.appendAssistantToolCalls("", [call("c2")]);
    ctx.appendToolMessage("c2", "result2");

    const { stable, prior } = ctx.cacheBreakpoints();
    const volatileFrom = ctx.messages.length - 2;
    expect(stable).toBeGreaterThanOrEqual(0);
    expect(stable).toBeLessThan(volatileFrom);
    expect(prior).toBeLessThan(stable);
  });

  it("keeps the prefix up to `stable` byte-identical across the next iteration", () => {
    const ctx = createLiveContext(seed(), DISABLED_COMPACTION, { agent: "lead" });
    ctx.appendRuntimeNote("k", "note v1");
    ctx.setCanonicalState("state v1");
    ctx.appendAssistantToolCalls("", [call("c1")]);
    ctx.appendToolMessage("c1", "result");

    const { stable } = ctx.cacheBreakpoints();
    const before = JSON.stringify(ctx.messages.slice(0, stable + 1));

    ctx.appendRuntimeNote("k", "note v2 is longer than v1 was");
    ctx.setCanonicalState("state v2");

    expect(JSON.stringify(ctx.messages.slice(0, stable + 1))).toBe(before);
  });
});
