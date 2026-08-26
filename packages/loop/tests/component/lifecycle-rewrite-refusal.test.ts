import { describe, expect, it } from "../bun-test.ts";
import {
  loadEnv,
  type GateVerdict,
  type LifecycleHook,
  type Logger,
  type PreFinalizeContext,
} from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger } from "../../src/runtime/budget/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import {
  buildPreFinalizeGate,
  runVerdictHooks,
  UNSUPPORTED_REWRITE_MESSAGE,
} from "../../src/runtime/loop/lifecycle-hooks.ts";
import {
  prepareSpawn,
  runPreparedSubagent,
  type DelegateTaskContext,
} from "../../src/runtime/subagents/delegate-task.ts";
import type { ResolvedSubagentProfile } from "../../src/runtime/subagents/subagent-profiles.ts";
import { MockLLM } from "../helpers/fixtures.ts";

const env = loadEnv({});
const SPAWN_ARGS = { title: "worker", task: "do the thing", profile: "coder" };

/**
 * A `rewrite` verdict at a gate whose signature refuses one.
 *
 * The cast is the point of these tests. `LifecycleHook.preDelegateTask` and
 * `preFinalize` are typed `GateVerdict`, so a typed author cannot write this —
 * but the only production producer, `@clarvis/hooks`'s `compileWorkspaceHooks`,
 * assembles its gate methods into an untyped bag and casts the whole object to
 * `LifecycleHook` on the way out, so the narrowed signature never rules on what
 * it actually returns. Anything reaching the engine through that cast is what
 * these tests stand in for.
 */
function unsupportedRewrite(args: unknown, message?: string): GateVerdict {
  return {
    kind: "rewrite",
    arguments: args,
    ...(message === undefined ? {} : { message }),
  } as unknown as GateVerdict;
}

function profile(name: string): ResolvedSubagentProfile {
  return {
    name,
    model: "model",
    modelRef: "anthropic:model",
    provider: "anthropic",
    tools: [],
    contextWindowTokens: 200_000,
    stagnationThreshold: 3,
    callTimeoutMs: 60_000,
    reasoningSummary: "off",
    maxRetries: 0,
    maxRetryAfterMs: 0,
    compaction: DISABLED_COMPACTION,
    stream: true,
  };
}

function context(
  llm: MockLLM,
  hooks: LifecycleHook[],
): DelegateTaskContext & { trace: ReturnType<typeof createTrace> } {
  return {
    env,
    opened: [],
    profiles: new Map([
      ["coder", profile("coder")],
      ["explorer", profile("explorer")],
    ]),
    iterationLimitDefault: 5,
    llm,
    ledger: createTokenLedger(1_000_000),
    trace: createTrace(),
    subagentAggByModel: new Map(),
    hooks,
  };
}

function collectingLogger(sink: { event: unknown }[]): Logger {
  const noop = (): void => {};
  const record = (fields: Record<string, unknown>): void => {
    sink.push({ event: fields.event });
  };
  return {
    debug: noop,
    info: noop,
    warn: record,
    error: noop,
    child: () => collectingLogger(sink),
  } as unknown as Logger;
}

describe("a preDelegateTask rewrite is refused, never silently dropped", () => {
  it("denies the spawn and names the channel that does replace a delegation's brief", async () => {
    const ctx = context(new MockLLM({ script: [{ text: "should never run" }] }), [
      {
        preDelegateTask: async () =>
          unsupportedRewrite({ title: "w", task: "a different brief", profile: "explorer" }),
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.text).toContain("delegate_task DENIED by a workspace hook");
    expect(prepared.text).toContain(UNSUPPORTED_REWRITE_MESSAGE);
    expect(prepared.text).toContain("pre-tool-use");
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(false);
  });

  it("does not run the sub-agent the hook believed it had redirected", async () => {
    const llm = new MockLLM({ script: [{ text: "should never run" }] });
    const ctx = context(llm, [
      {
        preDelegateTask: async () =>
          unsupportedRewrite({ title: "w", task: "a different brief", profile: "explorer" }),
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared.ok).toBe(false);
    expect(llm.calls.length).toBe(0);
  });

  it("records the refusal on the diagnostic channel", async () => {
    const seen: { event: unknown }[] = [];
    const ctx = context(new MockLLM({ script: [] }), [
      { preDelegateTask: async () => unsupportedRewrite({ profile: "explorer" }) },
    ]);
    ctx.logger = collectingLogger(seen);

    await prepareSpawn(SPAWN_ARGS, ctx);

    expect(seen.map((s) => s.event)).toContain("hook.rewrite_unsupported");
  });

  it("refuses before a later hook can pass the spawn, as a denial does", async () => {
    let laterRan = false;
    const ctx = context(new MockLLM({ script: [] }), [
      { preDelegateTask: async () => unsupportedRewrite({ profile: "explorer" }) },
      {
        preDelegateTask: async () => {
          laterRan = true;
          return { kind: "pass" };
        },
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared.ok).toBe(false);
    expect(laterRan).toBe(false);
  });

  it("still spawns for every verdict a preDelegateTask hook may legitimately return", async () => {
    const ctx = context(new MockLLM({ script: [{ text: "done" }] }), [
      { preDelegateTask: async () => ({ kind: "advise", message: "prefer a narrow brief" }) },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.adviseMessages).toEqual(["prefer a narrow brief"]);

    const result = await runPreparedSubagent(prepared.prepared, ctx);
    expect(result.text).toContain("done");
    expect(result.text).toContain("[advisor] prefer a narrow brief");
  });
});

describe("a preFinalize rewrite is refused, never silently dropped", () => {
  function gate(hooks: LifecycleHook[], notes: string[]): ReturnType<typeof buildPreFinalizeGate> {
    return buildPreFinalizeGate({
      hooks,
      agent: "lead",
      appendNote: (note) => notes.push(note),
    });
  }

  it("nudges instead of accepting the finalize the hook thought it had rewritten", async () => {
    const notes: string[] = [];
    const outcome = await gate(
      [{ preFinalize: async () => unsupportedRewrite({ text: "a different answer" }) }],
      notes,
    ).check({ mode: "text", text: "hi" });

    expect(outcome.kind).toBe("nudge");
    if (outcome.kind !== "nudge") return;
    expect(outcome.note).toContain(UNSUPPORTED_REWRITE_MESSAGE);
    expect(notes).toEqual([]);
  });

  it("still passes a finalize its hooks merely advise on", async () => {
    const notes: string[] = [];
    const outcome = await gate(
      [{ preFinalize: async () => ({ kind: "advise", message: "cite the file" }) }],
      notes,
    ).check({ mode: "text", text: "hi" });

    expect(outcome.kind).toBe("pass");
    expect(notes).toEqual(["[advisor] cite the file"]);
  });

  it("hands the hook the finalize attempt it is ruling on", async () => {
    const seen: PreFinalizeContext[] = [];
    await gate(
      [
        {
          preFinalize: async (c) => {
            seen.push(c);
            return { kind: "pass" };
          },
        },
      ],
      [],
    ).check({ mode: "text", text: "hi" });

    expect(seen).toEqual([{ agent: "lead", mode: "text", text: "hi" }]);
  });
});

describe("runVerdictHooks still honours a rewrite where the caller replaces the action", () => {
  const rewritingHook = (): LifecycleHook => ({
    beforeToolUse: async () => ({
      kind: "rewrite",
      arguments: { command: "safe" },
      message: "added --dry-run",
    }),
  });

  it("reports the replacement when opts.rewritable is left unset", async () => {
    const sweep = await runVerdictHooks(
      [rewritingHook()],
      (h, rewritten) =>
        h.beforeToolUse
          ? () => h.beforeToolUse!({ tool: "shell", arguments: rewritten ?? {} })
          : undefined,
      { onThrow: "deny", onThrowWarn: "beforeToolUse threw" },
    );

    expect(sweep.denied).toBeNull();
    expect(sweep.rewritten).toEqual({ arguments: { command: "safe" } });
    expect(sweep.advise).toEqual(["added --dry-run"]);
  });

  it("refuses the very same verdict once the caller declares nothing to rewrite", async () => {
    const sweep = await runVerdictHooks(
      [rewritingHook()],
      (h) =>
        h.beforeToolUse ? () => h.beforeToolUse!({ tool: "shell", arguments: {} }) : undefined,
      { onThrow: "deny", onThrowWarn: "beforeToolUse threw", rewritable: false },
    );

    expect(sweep.rewritten).toBeUndefined();
    expect(sweep.denied).toEqual({ message: UNSUPPORTED_REWRITE_MESSAGE, fromThrow: true });
  });

  it("skips the hook rather than denying where the fire point fails open", async () => {
    const sweep = await runVerdictHooks(
      [rewritingHook(), { beforeToolUse: async () => ({ kind: "advise", message: "still here" }) }],
      (h) =>
        h.beforeToolUse ? () => h.beforeToolUse!({ tool: "shell", arguments: {} }) : undefined,
      { onThrow: "ignore", onThrowWarn: "beforeToolUse threw", rewritable: false },
    );

    expect(sweep.denied).toBeNull();
    expect(sweep.rewritten).toBeUndefined();
    expect(sweep.advise).toEqual(["still here"]);
  });
});
