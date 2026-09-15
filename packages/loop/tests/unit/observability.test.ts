import { describe, expect, it } from "../bun-test.ts";
import type { AgentCapability, LLMCallResult, LLMProvider } from "@clarvis/capability";
import { NOOP_LOGGER, ProviderError } from "@clarvis/capability";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import { runGates } from "../../src/runtime/loop/loop-contract.ts";
import { createToolArgValidator } from "../../src/runtime/tools/tool-arg-validator.ts";
import {
  createCachePrefixWatch,
  recordIterationMetrics,
} from "../../src/runtime/loop/iteration-metrics.ts";
import { createCompactionReachWatch } from "../../src/runtime/loop/compaction-reach.ts";
import { attemptCompaction } from "../../src/runtime/context/llm-compaction.ts";
import { collectCompactionContributions } from "../../src/runtime/loop/lifecycle-hooks.ts";
import {
  createLiveContext,
  DISABLED_COMPACTION,
  type CompactionConfig,
} from "../../src/runtime/context/index.ts";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { createTrace } from "@clarvis/trace";
import { MockLLM } from "../helpers/fixtures.ts";
import { recordingLogger, type LogRecord, type RecordingLogger } from "../helpers/logging.ts";

describe("tool.args_validation_failed_open", () => {
  const OK_SCHEMA = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };

  it("names the tool and the arm, once per schema, when a schema will not compile", () => {
    const logger = recordingLogger();
    const validator = createToolArgValidator(logger);
    const broken = { type: "object", properties: { x: { type: 7 } } } as Record<string, unknown>;

    expect(validator.validate(broken, { x: 1 }, "grep")).toBeNull();
    expect(validator.validate(broken, { x: 2 }, "grep")).toBeNull();

    const records = logger.of("tool.args_validation_failed_open");
    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toMatchObject({ tool: "grep", reason: "compile_error" });
    expect(typeof records[0]?.fields.cause).toBe("string");
  });

  it("names the async arm and omits `tool` when the caller could not supply one", () => {
    const logger = recordingLogger();
    const validator = createToolArgValidator(logger);
    const asyncSchema = { $async: true, ...OK_SCHEMA } as Record<string, unknown>;

    expect(validator.validate(asyncSchema, { x: "ok" })).toBeNull();

    const [record] = logger.of("tool.args_validation_failed_open");
    expect(record?.fields).toMatchObject({ reason: "async" });
    expect(record?.fields.tool).toBeUndefined();
  });

  it("names the non-boolean arm when a compiled validator answers with neither true nor false", () => {
    const logger = recordingLogger();
    const validator = createToolArgValidator(logger);
    const schema = { ...OK_SCHEMA } as Record<string, unknown>;
    expect(validator.validate(schema, { x: "ok" }, "read_file")).toBeNull();

    const lying = { type: "object", properties: { y: { type: "string" } } } as Record<
      string,
      unknown
    >;
    const inner = createToolArgValidator(logger);
    expect(inner.validate(lying, { y: "ok" })).toBeNull();

    expect(logger.of("tool.args_validation_failed_open")).toHaveLength(0);
  });

  it("names the throwing arm when validation itself blows up", () => {
    const logger = recordingLogger();
    const validator = createToolArgValidator(logger);
    const hostile = {
      type: "object",
      get properties(): never {
        throw new Error("schema getter exploded");
      },
    } as unknown as Record<string, unknown>;

    expect(validator.validate(hostile, {}, "shell")).toBeNull();

    const [record] = logger.of("tool.args_validation_failed_open");
    expect(record?.fields).toMatchObject({ tool: "shell", reason: "validator_threw" });
  });

  it("accepts no logger at all", () => {
    const validator = createToolArgValidator();
    const broken = { type: "object", properties: { x: { type: 7 } } } as Record<string, unknown>;
    expect(validator.validate(broken, { x: 1 }, "grep")).toBeNull();
  });
});

describe("iteration.cache", () => {
  const usage = (input: number, cached: number) => ({
    input_tokens: input,
    output_tokens: 1,
    cached_tokens: cached,
    cache_write_tokens: 0,
  });

  const record =
    (logger: RecordingLogger, cacheWatch: ReturnType<typeof createCachePrefixWatch>) =>
    (iteration: number, input: number, cached: number): void => {
      recordIterationMetrics({
        llmResult: { text: "", usage: usage(input, cached) } as LLMCallResult,
        ledger: createTokenLedger(1_000_000),
        usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
        trace: createTrace(),
        agent: "lead",
        iteration,
        iterStart: 0,
        model: "m",
        logger,
        cacheWatch,
      });
    };

  const warnings = (logger: RecordingLogger): LogRecord[] =>
    logger.of("iteration.cache").filter((line) => line.level === "warn");

  it("writes the four numbers the trace already computed, at debug", () => {
    const logger = recordingLogger();
    record(logger, createCachePrefixWatch())(1, 100, 90);

    const [line] = logger.of("iteration.cache");
    expect(line?.level).toBe("debug");
    expect(line?.fields).toMatchObject({
      iteration: 1,
      input_tokens: 100,
      cached_tokens: 90,
      ratio: 0.9,
    });
  });

  it("warns when the provider serves a shorter prefix than it already served", () => {
    const logger = recordingLogger();
    const write = record(logger, createCachePrefixWatch());
    write(1, 100_000, 95_000);
    write(2, 130_000, 2_000);

    const warned = warnings(logger);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({ iteration: 2, cached_tokens: 2_000 });
    expect(warned[0]?.message).toContain("cache reuse");
  });

  it("stays quiet when one large tool result collapses the ratio with the prefix intact", () => {
    const logger = recordingLogger();
    const write = record(logger, createCachePrefixWatch());
    write(1, 5_000, 4_000);
    write(2, 30_000, 5_000);

    expect(warnings(logger)).toHaveLength(0);
    expect(logger.of("iteration.cache")).toHaveLength(2);
  });

  it("stays quiet for a provider that never serves a cached prefix at all", () => {
    const logger = recordingLogger();
    const write = record(logger, createCachePrefixWatch());
    write(1, 5_000, 0);
    write(2, 40_000, 0);
    write(3, 90_000, 0);

    expect(warnings(logger)).toHaveLength(0);
  });

  it("tolerates the block rounding a provider reports its cache reads in", () => {
    const logger = recordingLogger();
    const write = record(logger, createCachePrefixWatch());
    write(1, 100_000, 90_000);
    write(2, 110_000, 89_000);

    expect(warnings(logger)).toHaveLength(0);
  });

  it("reports one line per break, and still catches a later one", () => {
    const logger = recordingLogger();
    const write = record(logger, createCachePrefixWatch());
    write(1, 100_000, 90_000);
    write(2, 130_000, 1_000);
    write(3, 140_000, 1_100);
    write(4, 150_000, 60_000);
    write(5, 160_000, 500);

    expect(warnings(logger).map((line) => line.fields.iteration)).toEqual([2, 5]);
  });

  it("keeps reporting a real break after a false positive spent a warning", () => {
    const watch = createCachePrefixWatch();
    expect(watch.observe(50_000)).toBe(false);
    expect(watch.observe(0)).toBe(true);
    expect(watch.observe(50_000)).toBe(false);
    expect(watch.observe(0)).toBe(true);
  });

  it("allocates nothing at a level that discards it, unless the break forces the line out", () => {
    const quiet = recordingLogger("info");
    const write = record(quiet, createCachePrefixWatch());
    write(1, 100_000, 90_000);
    expect(quiet.records).toHaveLength(0);
    write(2, 110_000, 1_000);
    expect(quiet.of("iteration.cache")).toHaveLength(1);
  });

  it("defaults to no logger and no watch", () => {
    expect(() =>
      record(recordingLogger("silent"), createCachePrefixWatch())(1, 0, 0),
    ).not.toThrow();
    recordIterationMetrics({
      llmResult: { text: "", usage: usage(10, 1) } as LLMCallResult,
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      trace: createTrace(),
      agent: "subagent",
      iteration: 1,
      iterStart: 0,
      model: "m",
    });
  });

  it("never escalates the very first iteration, which has nothing to fall from", () => {
    const watch = createCachePrefixWatch();
    expect(watch.observe(0)).toBe(false);
    expect(watch.observe(0)).toBe(false);
  });
});

describe("compaction.summarizer_failed", () => {
  const ON: CompactionConfig = {
    enabled: true,
    windowTokens: 1000,
    fraction: 0.8,
    targetFraction: 0.5,
    maxResultChars: 1_000_000,
    preserveRecentTokens: 0,
  };

  const overBudget = (logger: RecordingLogger) => {
    const ctx = createLiveContext([{ role: "user", content: "seed task" }], ON, {
      agent: "lead",
      logger,
    });
    ctx.appendAssistantToolCalls("", [{ id: "c0", name: "t", arguments: {} }]);
    ctx.appendToolMessage("c0", `R0: ${"x".repeat(4000)}`);
    return ctx;
  };

  const args = (ctx: ReturnType<typeof createLiveContext>, llm: LLMProvider, logger: unknown) => ({
    ctx,
    compactionPrompt: "Summarize.",
    llm,
    model: "m",
    provider: "anthropic",
    windowTokens: ON.windowTokens,
    ledger: createTokenLedger(1_000_000),
    usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    logger: logger as RecordingLogger,
  });

  const throwing: LLMProvider = {
    call: () => Promise.reject(new Error("provider boom")),
  };

  it("reports the billed summary the scheduled path throws away before it evicts", async () => {
    const logger = recordingLogger();
    const outcome = await attemptCompaction({
      ...args(overBudget(logger), throwing, logger),
      mode: "scheduled",
      fallbackOnFailure: true,
    });

    expect(outcome.kind).toBe("applied");
    const [line] = logger.of("compaction.summarizer_failed");
    expect(line?.level).toBe("warn");
    expect(line?.fields).toMatchObject({
      mode: "scheduled",
      reason: "summarization_failed",
      fell_back: true,
    });
    expect(line?.fields.cause).toBe("provider boom");
    expect(line?.message).toContain("evicted instead");
  });

  it("reports the same failure on the user-requested path, where nothing falls back", async () => {
    const logger = recordingLogger();
    const outcome = await attemptCompaction({
      ...args(overBudget(logger), throwing, logger),
      mode: "forced",
      fallbackOnFailure: false,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "summarization_failed" });
    const [line] = logger.of("compaction.summarizer_failed");
    expect(line?.fields).toMatchObject({ mode: "forced", fell_back: false });
    expect(line?.message).toContain("compaction is skipped");
  });

  it("reports a summary that was produced, billed, and too large to adopt", async () => {
    const logger = recordingLogger();
    const bloated: LLMProvider = {
      call: () =>
        Promise.resolve({
          text: "S".repeat(9000),
          usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 },
        }),
    };
    await attemptCompaction({
      ...args(overBudget(logger), bloated, logger),
      mode: "scheduled",
      fallbackOnFailure: true,
    });

    const [line] = logger.of("compaction.summarizer_failed");
    expect(line?.fields).toMatchObject({ reason: "summary_not_effective" });
    expect(line?.fields.cause).toBeUndefined();
  });

  it("says nothing when the summary is adopted", async () => {
    const logger = recordingLogger();
    const good: LLMProvider = {
      call: () =>
        Promise.resolve({
          text: "tiny",
          usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 },
        }),
    };
    const outcome = await attemptCompaction({
      ...args(overBudget(logger), good, logger),
      mode: "scheduled",
      fallbackOnFailure: true,
    });

    expect(outcome.kind).toBe("applied");
    expect(logger.of("compaction.summarizer_failed")).toHaveLength(0);
  });
});

describe("runGates names the gate that ruled", () => {
  it("returns the ordinal of the first non-pass gate", async () => {
    const pass = { check: () => Promise.resolve({ kind: "pass" as const }) };
    const nudge = { check: () => Promise.resolve({ kind: "nudge" as const, note: "again" }) };

    expect(await runGates([pass, pass, nudge], { mode: "text", text: "hi" })).toEqual({
      outcome: { kind: "nudge", note: "again" },
      gate: 2,
    });
  });

  it("returns -1 when every gate allows the attempt", async () => {
    const pass = { check: () => Promise.resolve({ kind: "pass" as const }) };
    expect(await runGates([pass], { mode: "text", text: "hi" })).toEqual({
      outcome: { kind: "pass" },
      gate: -1,
    });
  });
});

function agentInput(
  llm: MockLLM,
  opts: {
    logger?: RecordingLogger;
    compaction?: CompactionConfig;
    agentCapabilities?: AgentCapability[];
    forceToolOnNudge?: boolean;
  } = {},
): RunAgentInput {
  return {
    agent: "subagent",
    subagentInstanceId: "w1",
    messages: [{ role: "user", content: "go" }],
    target: { llm, model: "m", provider: "anthropic", capabilities: new Set(["tool_calling"]) },
    budget: {
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(4),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace: createTrace() },
    compaction: opts.compaction ?? DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    mcpProgress: (r) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: 6,
    noProgressMessage: (streak) => `no progress for ${streak}`,
    emptyResponseAgent: "LLM",
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.agentCapabilities !== undefined ? { agentCapabilities: opts.agentCapabilities } : {}),
    ...(opts.forceToolOnNudge !== undefined ? { forceToolOnNudge: opts.forceToolOnNudge } : {}),
  };
}

describe("compaction.unreachable", () => {
  const withWindow = (declared: number, enabled = true): CompactionConfig => ({
    enabled,
    windowTokens: declared,
    fraction: 0.8,
    targetFraction: 0.5,
    maxResultChars: 1_000_000,
    preserveRecentTokens: 0,
  });

  it("says nothing until the provider actually refuses a prompt", () => {
    const logger = recordingLogger();
    createCompactionReachWatch(withWindow(1_048_576), logger);
    expect(logger.of("compaction.unreachable")).toHaveLength(0);
  });

  it("names the declared window when a refusal lands below compaction's trigger", () => {
    const logger = recordingLogger();
    const watch = createCompactionReachWatch(withWindow(1_048_576), logger);
    watch.observeOverflow(190_000);

    const [line] = logger.of("compaction.unreachable");
    expect(line?.level).toBe("warn");
    expect(line?.fields).toMatchObject({
      declared_window_tokens: 1_048_576,
      high_water_tokens: 838_860,
      observed_tokens: 190_000,
    });
    expect(line?.message).toContain("wider than the model's real one");
  });

  it("reports one refusal per agent loop, however many arrive", () => {
    const logger = recordingLogger();
    const watch = createCompactionReachWatch(withWindow(1_048_576), logger);
    watch.observeOverflow(190_000);
    watch.observeOverflow(150_000);
    expect(logger.of("compaction.unreachable")).toHaveLength(1);
  });

  it("stays quiet for a refusal above the trigger, which proves nothing about the window", () => {
    const logger = recordingLogger();
    createCompactionReachWatch(withWindow(200_000), logger).observeOverflow(180_000);
    expect(logger.of("compaction.unreachable")).toHaveLength(0);
  });

  it("stays quiet for a correctly declared window larger than Clarvis's default", () => {
    const logger = recordingLogger();
    createCompactionReachWatch(withWindow(200_000), logger);
    expect(logger.of("compaction.unreachable")).toHaveLength(0);
  });

  it("stays quiet when compaction is off, and needs no logger at all", () => {
    const logger = recordingLogger();
    createCompactionReachWatch(withWindow(1_048_576, false), logger).observeOverflow(10);
    expect(logger.of("compaction.unreachable")).toHaveLength(0);
    expect(() =>
      createCompactionReachWatch(withWindow(1_048_576)).observeOverflow(10),
    ).not.toThrow();
  });

  it("reaches the log through a real run whose provider rejects the prompt", async () => {
    const logger = recordingLogger();
    const overflow = new ProviderError("prompt is too long", { kind: "context_overflow" });
    await expect(
      runAgent(
        agentInput(new MockLLM({ script: [{ throw: overflow }] }), {
          logger,
          compaction: withWindow(1_048_576),
        }),
      ),
    ).rejects.toThrow(/context does not fit/);

    const [line] = logger.of("compaction.unreachable");
    expect(line?.fields).toMatchObject({ agent: "subagent", subagent_instance_id: "w1" });
  });
});

describe("gate.nudged", () => {
  const nudgingCapability = (): AgentCapability => ({
    attach: () => ({
      advertised: false,
      gates: [{ check: () => Promise.resolve({ kind: "nudge" as const, note: "keep going" }) }],
    }),
  });

  it("names the gate, the mode, the count and whether a tool is forced next", async () => {
    const logger = recordingLogger();
    await runAgent(
      agentInput(
        new MockLLM({
          script: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }],
        }),
        {
          logger,
          agentCapabilities: [nudgingCapability()],
          forceToolOnNudge: true,
        },
      ),
    );

    const nudges = logger.of("gate.nudged");
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(nudges[0]?.level).toBe("debug");
    expect(nudges[0]?.fields).toMatchObject({
      gate: 0,
      mode: "text",
      force_tool_next: true,
      nudge_count: 1,
      agent: "subagent",
    });
    expect(logger.of("gate.force_tool_applied").length).toBeGreaterThanOrEqual(1);
  });

  it("reports force_tool_next false when the agent does not force after a nudge", async () => {
    const logger = recordingLogger();
    await runAgent(
      agentInput(
        new MockLLM({
          script: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }],
        }),
        {
          logger,
          agentCapabilities: [nudgingCapability()],
        },
      ),
    );

    expect(logger.of("gate.nudged")[0]?.fields.force_tool_next).toBe(false);
    expect(logger.of("gate.force_tool_applied")).toHaveLength(0);
  });

  it("allocates no bindings when the level discards them, and none at all with no logger", async () => {
    const quiet = recordingLogger("warn");
    await runAgent(
      agentInput(
        new MockLLM({
          script: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }],
        }),
        {
          logger: quiet,
          agentCapabilities: [nudgingCapability()],
          forceToolOnNudge: true,
        },
      ),
    );
    expect(quiet.of("gate.nudged")).toHaveLength(0);
    expect(quiet.of("gate.force_tool_applied")).toHaveLength(0);

    const res = await runAgent(
      agentInput(
        new MockLLM({
          script: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }],
        }),
        {
          agentCapabilities: [nudgingCapability()],
          forceToolOnNudge: true,
        },
      ),
    );
    expect(res.status).toBeDefined();
  });
});

describe("hook.pre_compact_failed", () => {
  it("names the hook event and keeps the compaction going", async () => {
    const logger = recordingLogger();
    const offered = await collectCompactionContributions(
      [
        {
          onPreCompact: (): Promise<never> => {
            throw new Error("pre-compact boom");
          },
        },
        {
          onPreCompact: () =>
            Promise.resolve([{ source: "hook" as const, text: "keep the mapping" }]),
        },
      ],
      { agent: "lead", estimatedTokens: 10 },
      logger,
    );

    expect(offered).toEqual([{ source: "hook", text: "keep the mapping" }]);
    const [line] = logger.of("hook.pre_compact_failed");
    expect(line?.level).toBe("warn");
    expect(line?.fields).toMatchObject({ hook_event: "onPreCompact", err: "pre-compact boom" });
  });
});

describe("the no-op logger is the silent default", () => {
  it("discards everything and derives itself", () => {
    expect(NOOP_LOGGER.child?.({ a: 1 })).toBe(NOOP_LOGGER);
  });
});
