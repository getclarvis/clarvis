import { describe, it, expect } from "bun:test";
import type { HookInvocation, HookResult, HookRunner, HookSpec } from "../../src/index.ts";
import {
  buildSeedBlock,
  compileWorkspaceHooks,
  createHooksCapability,
  createWorkspaceHooksCapability,
  HOOKS_SEED_MARKER,
  runUserPromptExpansionHooks,
} from "../../src/capability.ts";
import type { HookConfig } from "@clarvis/capability";
import {
  createCapabilityServices,
  HOOKS_CAPABILITY_NAME,
  MCP_HOOK_TOOL_PORT,
} from "@clarvis/capability";
import type { LifecycleHook } from "@clarvis/capability";
import { CONFIG, context } from "../helpers/capability.ts";

const LEAD_SCOPE = { agent: "lead", entry: true, grants: [] } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Recorded {
  hook: HookSpec;
  inv: HookInvocation;
}

/**
 * A runner that answers from a scripted table. The real one is exhaustively
 * covered in `@clarvis/hooks`; what matters here is the translation.
 */
function fakeRunner(
  answer: (
    hook: HookSpec,
    inv: HookInvocation,
  ) => HookResult["ok"] extends never ? never : HookResult,
  recorded: Recorded[] = [],
): HookRunner {
  return {
    select: (hooks, inv) => hooks.filter((h) => h.event === inv.event),
    run: async (hook, inv) => {
      recorded.push({ hook, inv });
      return answer(hook, inv);
    },
    resolve: (result) => (result.ok ? result.outcome : { kind: "pass" }),
  };
}

function passing(recorded: Recorded[] = []): HookRunner {
  return fakeRunner(
    (hook) => ({ ok: true, hook, outcome: { kind: "pass" }, durationMs: 1 }),
    recorded,
  );
}

describe("compileWorkspaceHooks", () => {
  it("returns undefined when nothing gate- or observer-shaped is configured", () => {
    expect(compileWorkspaceHooks([], passing())).toBeUndefined();
    expect(compileWorkspaceHooks([CONFIG({ event: "session_start" })], passing())).toBeUndefined();
    expect(
      compileWorkspaceHooks([CONFIG({ event: "user_prompt_expansion" })], passing()),
    ).toBeUndefined();
  });

  it("defines only the methods that have a spec", () => {
    const compiled = compileWorkspaceHooks([CONFIG({ event: "pre_tool_use" })], passing());
    expect(Object.keys(compiled ?? {})).toEqual(["beforeToolUse"]);
  });

  it("leaves preFinalize undefined for a workspace with only tool hooks", () => {
    const compiled = compileWorkspaceHooks(
      [CONFIG({ event: "pre_tool_use" }), CONFIG({ event: "post_tool_use" })],
      passing(),
    );
    expect(compiled?.preFinalize).toBeUndefined();
    expect(compiled?.beforeToolUse).toBeDefined();
    expect(compiled?.afterToolUse).toBeDefined();
  });

  it("maps every event to its method", () => {
    const events: HookConfig["event"][] = [
      "pre_tool_use",
      "post_tool_use",
      "pre_finalize",
      "pre_delegate_task",
      "run_start",
      "run_end",
      "post_compact",
      "subagent_start",
      "subagent_complete",
      "pre_compact",
      "model_call_error",
      "budget_exhausted",
      "user_steer",
    ];
    const compiled = compileWorkspaceHooks(
      events.map((event) => CONFIG({ event })),
      passing(),
    );
    expect(Object.keys(compiled ?? {}).sort()).toEqual(
      [
        "beforeToolUse",
        "afterToolUse",
        "preFinalize",
        "preDelegateTask",
        "onRunStart",
        "onRunEnd",
        "onPostCompact",
        "onSubagentStart",
        "onSubagentComplete",
        "onPreCompact",
        "onModelCallError",
        "onBudgetExhausted",
        "onUserSteer",
      ].sort(),
    );
  });

  it("labels the fire point with the name the external dialect uses", async () => {
    const recorded: Recorded[] = [];
    const compiled = compileWorkspaceHooks(
      [CONFIG({ event: "pre_tool_use" })],
      fakeRunner(
        (hook) => ({ ok: true, hook, outcome: { kind: "pass" }, durationMs: 1 }),
        recorded,
      ),
    );
    await compiled?.beforeToolUse?.({ tool: "shell", arguments: {} });
    expect(recorded[0]?.inv.externalEvent).toBe("PreToolUse");
  });

  it("passes when every hook passes", async () => {
    const compiled = compileWorkspaceHooks([CONFIG({ event: "pre_tool_use" })], passing());
    const verdict = await compiled?.beforeToolUse?.({ tool: "shell", arguments: {} });
    expect(verdict).toEqual({ kind: "pass" });
  });

  describe("a rewrite verdict", () => {
    /** A runner whose every hook replaces the arguments with its own command name. */
    const replacing = (recorded: Recorded[], message?: string): HookRunner =>
      fakeRunner(
        (hook) => ({
          ok: true,
          hook,
          durationMs: 1,
          outcome: {
            kind: "rewrite",
            arguments: { step: hook.command },
            ...(message === undefined ? {} : { message }),
          },
        }),
        recorded,
      );

    it("threads the replacement forward so the last writer wins", async () => {
      const recorded: Recorded[] = [];
      const compiled = compileWorkspaceHooks(
        [
          CONFIG({ event: "pre_tool_use", command: "one" }),
          CONFIG({ event: "pre_tool_use", command: "two" }),
        ],
        replacing(recorded),
      );
      const verdict = await compiled?.beforeToolUse?.({
        tool: "shell",
        arguments: { step: "model" },
      });
      expect(verdict).toEqual({ kind: "rewrite", arguments: { step: "two" } });
      expect(recorded.map((r) => r.inv.candidate?.arguments)).toEqual([
        { step: "model" },
        { step: "one" },
      ]);
    });

    it("carries any message offered alongside the replacement", async () => {
      const compiled = compileWorkspaceHooks(
        [CONFIG({ event: "pre_tool_use", command: "one" })],
        replacing([], "added --dry-run"),
      );
      const verdict = await compiled?.beforeToolUse?.({ tool: "shell", arguments: {} });
      expect(verdict).toEqual({
        kind: "rewrite",
        arguments: { step: "one" },
        message: "added --dry-run",
      });
    });
  });

  describe("pre_compact contributes rather than observes", () => {
    const context = { agent: "lead" as const, estimatedTokens: 10 };

    /** A runner whose `pre_compact` hooks each answer with their own command as context text. */
    const contributing = (): HookRunner =>
      fakeRunner((hook) => ({
        ok: true,
        hook,
        outcome: { kind: "context", text: `from ${hook.command}` },
        durationMs: 1,
      }));

    it("returns one contribution per hook, in configured order", async () => {
      const compiled = compileWorkspaceHooks(
        [
          CONFIG({ event: "pre_compact", command: "operator" }),
          CONFIG({ event: "pre_compact", command: "plugin" }),
        ],
        contributing(),
      );
      expect(await compiled?.onPreCompact?.(context)).toEqual([
        { source: "hook", text: "from operator" },
        { source: "hook", text: "from plugin" },
      ]);
    });

    it("contributes nothing when the hook merely passes", async () => {
      const compiled = compileWorkspaceHooks([CONFIG({ event: "pre_compact" })], passing());
      const offered = await compiled?.onPreCompact?.(context);
      expect(offered).toEqual([]);
    });

    it("contributes nothing when the hook fails, and never throws", async () => {
      const compiled = compileWorkspaceHooks(
        [CONFIG({ event: "pre_compact" })],
        fakeRunner((hook) => ({
          ok: false,
          hook,
          failure: { kind: "exit_nonzero", message: "exited 1", exitCode: 1 },
          durationMs: 1,
        })),
      );
      const offered = await compiled?.onPreCompact?.(context);
      expect(offered).toEqual([]);
    });
  });

  it("short-circuits on the first deny, so an operator judges first", async () => {
    const recorded: Recorded[] = [];
    const runner = fakeRunner(
      (hook) =>
        hook.command === "operator"
          ? {
              ok: true,
              hook,
              outcome: { kind: "deny", message: "operator says no" },
              durationMs: 1,
            }
          : { ok: true, hook, outcome: { kind: "pass" }, durationMs: 1 },
      recorded,
    );
    const compiled = compileWorkspaceHooks(
      [
        CONFIG({ event: "pre_tool_use", command: "operator" }),
        CONFIG({ event: "pre_tool_use", command: "plugin" }),
      ],
      runner,
    );
    const verdict = await compiled?.beforeToolUse?.({ tool: "shell", arguments: {} });
    expect(verdict).toEqual({ kind: "deny", message: "operator says no" });
    expect(recorded.map((r) => r.hook.command)).toEqual(["operator"]);
  });

  it("joins multiple advisories into the single message a verdict carries", async () => {
    const runner = fakeRunner((hook) => ({
      ok: true,
      hook,
      outcome: { kind: "advise", message: `from ${hook.command}` },
      durationMs: 1,
    }));
    const compiled = compileWorkspaceHooks(
      [
        CONFIG({ event: "pre_tool_use", command: "a" }),
        CONFIG({ event: "pre_tool_use", command: "b" }),
      ],
      runner,
    );
    expect(await compiled?.beforeToolUse?.({ tool: "shell", arguments: {} })).toEqual({
      kind: "advise",
      message: "from a\nfrom b",
    });
  });

  it("an observer returns nothing and runs its hooks concurrently", async () => {
    const started: string[] = [];
    let release = (): void => undefined;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const runner: HookRunner = {
      select: (hooks, inv) => hooks.filter((h) => h.event === inv.event),
      run: async (hook) => {
        started.push(hook.command);
        await barrier;
        return { ok: true, hook, outcome: { kind: "pass" }, durationMs: 1 };
      },
      resolve: () => ({ kind: "pass" }),
    };
    const compiled = compileWorkspaceHooks(
      [CONFIG({ event: "run_end", command: "a" }), CONFIG({ event: "run_end", command: "b" })],
      runner,
    );
    const pending = compiled?.onRunEnd?.({ status: "completed", iterationsUsed: 1, elapsedMs: 5 });
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    release();
    await expect(pending).resolves.toBeUndefined();
  });

  it("a gate method never throws, whatever the runner reports", async () => {
    const runner = fakeRunner((hook) => ({
      ok: false,
      hook,
      failure: { kind: "timeout", message: "timed out" },
      durationMs: 1,
    }));
    const compiled = compileWorkspaceHooks([CONFIG({ event: "pre_finalize" })], runner);
    await expect(
      compiled?.preFinalize?.({ agent: "lead", mode: "text", text: "done" }),
    ).resolves.toEqual({ kind: "pass" });
  });
});

describe("the payload a hook receives", () => {
  async function payloadFor(
    event: HookConfig["event"],
    call: (hook: LifecycleHook) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    const recorded: Recorded[] = [];
    const compiled = compileWorkspaceHooks([CONFIG({ event })], passing(recorded));
    if (compiled === undefined) throw new Error(`missing lifecycle hook for ${event}`);
    await call(compiled);
    const data = recorded[0]?.inv.data;
    if (!isRecord(data)) throw new Error(`missing payload for ${event}`);
    return data;
  }

  it("names its fields in snake_case, as every operator-facing surface does", async () => {
    const data = await payloadFor("user_steer", async (h) =>
      h.onUserSteer?.({ agent: "lead", iteration: 3, message: "stop", subagentInstanceId: "sa-1" }),
    );
    expect(data).toEqual({
      agent: "lead",
      subagent_instance_id: "sa-1",
      iteration: 3,
      message: "stop",
      id: undefined,
    });
  });

  it("projects every remaining event onto snake_case fields", async () => {
    expect(
      await payloadFor("pre_delegate_task", async (h) =>
        h.preDelegateTask?.({ title: "T", task: "body", profile: "coder", taskId: "t1" }),
      ),
    ).toEqual({ title: "T", task: "body", profile: "coder", task_id: "t1" });

    expect(
      await payloadFor("run_start", async (h) =>
        h.onRunStart?.({ mode: "solo", entry: "coder", leadModel: "m1", subagentModel: "m2" }),
      ),
    ).toEqual({ mode: "solo", entry: "coder", lead_model: "m1", subagent_model: "m2" });

    expect(
      await payloadFor("run_end", async (h) =>
        h.onRunEnd?.({
          status: "completed",
          errorCode: undefined,
          iterationsUsed: 4,
          elapsedMs: 90,
        }),
      ),
    ).toEqual({ status: "completed", error_code: undefined, iterations_used: 4, elapsed_ms: 90 });

    expect(
      await payloadFor("post_compact", async (h) =>
        h.onPostCompact?.({
          agent: "subagent",
          subagentInstanceId: "sa-1",
          operation: "summarization",
          freedChars: 120,
          keptChars: 80,
        }),
      ),
    ).toEqual({
      agent: "subagent",
      subagent_instance_id: "sa-1",
      operation: "summarization",
      freed_chars: 120,
      kept_chars: 80,
    });

    expect(
      await payloadFor("subagent_start", async (h) =>
        h.onSubagentStart?.({
          subagentInstanceId: "sa-2",
          profile: "reviewer",
          model: "provider:model",
          task: "inspect",
        }),
      ),
    ).toEqual({
      subagent_instance_id: "sa-2",
      profile: "reviewer",
      model: "provider:model",
      task: "inspect",
    });

    expect(
      await payloadFor("subagent_complete", async (h) =>
        h.onSubagentComplete?.({ subagentInstanceId: "sa-2", status: "completed", result: "ok" }),
      ),
    ).toEqual({ subagent_instance_id: "sa-2", status: "completed", result: "ok" });

    expect(
      await payloadFor("pre_compact", async (h) =>
        h.onPreCompact?.({ agent: "lead", estimatedTokens: 120_000 }),
      ),
    ).toEqual({ agent: "lead", subagent_instance_id: undefined, estimated_tokens: 120_000 });

    expect(
      await payloadFor("model_call_error", async (h) =>
        h.onModelCallError?.({ agent: "lead", iteration: 2, model: "m1", message: "429" }),
      ),
    ).toEqual({
      agent: "lead",
      subagent_instance_id: undefined,
      iteration: 2,
      model: "m1",
      message: "429",
    });

    expect(
      await payloadFor("budget_exhausted", async (h) =>
        h.onBudgetExhausted?.({
          agent: "lead",
          reason: "exhausted",
          tokensUsed: 10,
          iterationsUsed: 3,
        }),
      ),
    ).toEqual({ agent: "lead", reason: "exhausted", tokens_used: 10, iterations_used: 3 });
  });

  it("an unserializable argument is replaced rather than allowed to throw", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const data = await payloadFor("pre_tool_use", async (h) =>
      h.beforeToolUse?.({ tool: "shell", arguments: circular }),
    );
    expect(data.tool_input).toEqual({ truncated: true });
  });

  it("adds the external skill alias to load_skill without changing the candidate", async () => {
    const recorded: Recorded[] = [];
    const compiled = compileWorkspaceHooks([CONFIG({ event: "post_tool_use" })], passing(recorded));
    await compiled?.afterToolUse?.({
      tool: "load_skill",
      arguments: { name: "ui-guidelines" },
      result: { text: "loaded", progress: false },
    });
    expect(recorded[0]?.inv.data).toMatchObject({
      tool_name: "Skill",
      tool_input: { name: "ui-guidelines", skill: "ui-guidelines" },
    });
    expect(recorded[0]?.inv.candidate).toEqual({
      tool: "load_skill",
      arguments: { name: "ui-guidelines" },
    });
  });

  it("emits external built-in and MCP tool names while matching their Clarvis identities", async () => {
    const shell = await payloadFor("pre_tool_use", async (hook) =>
      hook.beforeToolUse?.({ tool: "shell", arguments: { command: "pwd" } }),
    );
    const remote = await payloadFor("pre_tool_use", async (hook) =>
      hook.beforeToolUse?.({
        tool: "remote_search",
        toolFullName: "remote.search",
        arguments: { query: "docs" },
      }),
    );
    expect(shell.tool_name).toBe("Bash");
    expect(remote.tool_name).toBe("mcp__remote__search");

    const pluginRemote = await payloadFor("pre_tool_use", async (hook) =>
      hook.beforeToolUse?.({
        tool: "quality_docs_search",
        toolFullName: "quality-kit:docs.search",
        arguments: { query: "example" },
      }),
    );
    expect(pluginRemote.tool_name).toBe("mcp__docs__search");
  });

  it("a submit-mode finalize carries its validated value", async () => {
    const data = await payloadFor("pre_finalize", async (h) =>
      h.preFinalize?.({
        agent: "subagent",
        subagentInstanceId: "sa-3",
        mode: "submit",
        value: { ok: 1 },
      }),
    );
    expect(data).toEqual({
      agent: "subagent",
      subagent_instance_id: "sa-3",
      mode: "submit",
      text: undefined,
      value: { ok: 1 },
    });
  });

  it("a checkpoint finalize carries its stage handoff separately from the final value", async () => {
    const checkpoint = { summary: "Stage prepared", next_step: "Verify" };
    const data = await payloadFor("pre_finalize", async (h) =>
      h.preFinalize?.({ agent: "lead", mode: "checkpoint", checkpoint }),
    );
    expect(data).toEqual({
      agent: "lead",
      subagent_instance_id: undefined,
      mode: "checkpoint",
      checkpoint,
      text: undefined,
      value: undefined,
    });
  });

  it("drops image data and sends a count instead", async () => {
    const data = await payloadFor("post_tool_use", async (h) =>
      h.afterToolUse?.({
        tool: "screenshot",
        arguments: {},
        result: {
          text: "captured",
          progress: true,
          images: [
            { data: "a".repeat(1024), mediaType: "image/png" },
            { data: "b".repeat(1024), mediaType: "image/png" },
          ],
        },
      }),
    );
    const result = data.tool_response;
    if (!isRecord(result)) throw new Error("missing projected tool result");
    expect(result.image_count).toBe(2);
    expect(JSON.stringify(data)).not.toContain("aaaa");
  });

  it("clamps free text and oversized structured arguments", async () => {
    const data = await payloadFor("pre_tool_use", async (h) =>
      h.beforeToolUse?.({ tool: "shell", arguments: { blob: "x".repeat(50_000) } }),
    );
    expect(data.tool_input).toEqual({ truncated: true, bytes: expect.any(Number) });

    const finalize = await payloadFor("pre_finalize", async (h) =>
      h.preFinalize?.({ agent: "lead", mode: "text", text: "y".repeat(20_000) }),
    );
    expect(String(finalize.text)).toHaveLength(8_000);
  });

  it("carries a tool candidate only for the tool events", async () => {
    const recorded: Recorded[] = [];
    const compiled = compileWorkspaceHooks(
      [CONFIG({ event: "pre_tool_use" }), CONFIG({ event: "pre_finalize" })],
      passing(recorded),
    );
    await compiled?.beforeToolUse?.({ tool: "shell", arguments: { command: "ls" } });
    await compiled?.preFinalize?.({ agent: "lead", mode: "text", text: "done" });
    expect(recorded[0]?.inv.candidate).toEqual({ tool: "shell", arguments: { command: "ls" } });
    expect(recorded[1]?.inv.candidate).toBeUndefined();
  });

  it("carries a canonical MCP alias without replacing the model-facing wire name", async () => {
    const recorded: Recorded[] = [];
    const compiled = compileWorkspaceHooks([CONFIG({ event: "pre_tool_use" })], passing(recorded));
    await compiled?.beforeToolUse?.({
      tool: "remote_search",
      toolFullName: "remote.search",
      arguments: { query: "docs" },
    });
    expect(recorded[0]?.inv.candidate).toEqual({
      tool: "remote_search",
      aliases: ["remote.search"],
      arguments: { query: "docs" },
    });
  });

  it("marks gates as gates and observers as not", async () => {
    const recorded: Recorded[] = [];
    const compiled = compileWorkspaceHooks(
      [CONFIG({ event: "pre_tool_use" }), CONFIG({ event: "run_start" })],
      passing(recorded),
    );
    await compiled?.beforeToolUse?.({ tool: "shell", arguments: {} });
    await compiled?.onRunStart?.({ mode: "solo", entry: "coder" });
    expect(recorded[0]?.inv.gate).toBe(true);
    expect(recorded[1]?.inv.gate).toBe(false);
  });

  it("gives the tool events the short default budget and the rare gates the long one", async () => {
    const recorded: Recorded[] = [];
    const compiled = compileWorkspaceHooks(
      [
        CONFIG({ event: "pre_tool_use" }),
        CONFIG({ event: "pre_finalize" }),
        CONFIG({ event: "run_end" }),
        CONFIG({ event: "run_start" }),
      ],
      passing(recorded),
    );
    await compiled?.beforeToolUse?.({ tool: "shell", arguments: {} });
    await compiled?.preFinalize?.({ agent: "lead", mode: "text" });
    await compiled?.onRunEnd?.({ status: "completed", iterationsUsed: 1, elapsedMs: 1 });
    await compiled?.onRunStart?.({ mode: "solo", entry: "coder" });
    expect(recorded.map((r) => r.inv.defaultTimeoutMs)).toEqual([5_000, 30_000, 2_000, 5_000]);
  });
});

describe("createWorkspaceHooksCapability", () => {
  it("always declares its seed marker, so a stale block is stripped even when off", () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => undefined,
      environment: {},
    });
    expect(capability.seedMarker).toBe(HOOKS_SEED_MARKER);
  });

  it("does not activate for a run with no hooks configured", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => undefined,
      environment: {},
    });
    expect(await capability.forRun(context())).toBeNull();
  });

  it("re-reads the configuration on every run", async () => {
    let configured: HookConfig[] = [];
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => configured,
      environment: {},
    });
    expect(await capability.forRun(context())).toBeNull();
    configured = [CONFIG({ event: "pre_tool_use" })];
    expect(await capability.forRun(context())).not.toBeNull();
  });

  it("contributes exactly one lifecycle hook and no per-agent surface", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [CONFIG({ event: "pre_tool_use" })],
      environment: {},
    });
    const activation = await capability.forRun(context());
    expect(activation?.lifecycle).toHaveLength(1);
    expect(activation?.forAgent(LEAD_SCOPE)).toBeNull();
  });

  it("omits lifecycle entirely for a hooks block that is context-only", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [CONFIG({ event: "session_start" })],
      environment: {},
    });
    const activation = await capability.forRun(context());
    expect(activation?.lifecycle).toBeUndefined();
  });

  it("omits lifecycle for a prompt-expansion-only block", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [CONFIG({ event: "user_prompt_expansion" })],
      environment: {},
    });
    const activation = await capability.forRun(context());
    expect(activation?.lifecycle).toBeUndefined();
  });

  it("fires user prompt expansion once with the external command payload", async () => {
    const recorded: Recorded[] = [];
    await runUserPromptExpansionHooks(
      [CONFIG({ event: "user_prompt_expansion" })],
      passing(recorded),
      { commandName: "design:ui-guidelines" },
      undefined,
      undefined,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.inv).toMatchObject({
      event: "user_prompt_expansion",
      externalEvent: "UserPromptExpansion",
      data: { command_name: "design:ui-guidelines" },
      gate: false,
    });
  });

  it("does not fire user prompt expansion without a skill command", async () => {
    const recorded: Recorded[] = [];
    await runUserPromptExpansionHooks(
      [CONFIG({ event: "user_prompt_expansion" })],
      passing(recorded),
      undefined,
      undefined,
      undefined,
    );
    expect(recorded).toEqual([]);
  });

  it("swallows and reports a prompt expansion runner that rejects", async () => {
    const warnings: unknown[] = [];
    const exploding: HookRunner = {
      select: (hooks, inv) => hooks.filter((hook) => hook.event === inv.event),
      run: () => Promise.reject(new Error("the prompt observer vanished")),
      resolve: () => ({ kind: "pass" }),
    };
    const logger = {
      warn: (fields: unknown) => {
        warnings.push(fields);
      },
    } as unknown as Parameters<typeof runUserPromptExpansionHooks>[4];

    await runUserPromptExpansionHooks(
      [CONFIG({ event: "user_prompt_expansion" })],
      exploding,
      { commandName: "design:ui-guidelines" },
      undefined,
      logger,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      hook_event: "user_prompt_expansion",
      err: expect.any(Error),
    });
  });

  it("swallows a throwing context hook rather than failing the run", async () => {
    // `seedBlock` throwing fails the run, and a hook whose job is only to offer
    // context must never be able to do that. The runner this package builds
    // catches a spawn failure into `spawnError` instead of raising, so the
    // guard is only demonstrable against a runner that genuinely throws.
    const warnings: unknown[] = [];
    const exploding: HookRunner = {
      select: (hooks, inv) => hooks.filter((h) => h.event === inv.event),
      run: () => Promise.reject(new Error("the hook process vanished")),
      resolve: () => ({ kind: "pass" }),
    };
    const logger = {
      warn: (fields: unknown) => {
        warnings.push(fields);
      },
    } as unknown as Parameters<typeof buildSeedBlock>[3];

    const block = await buildSeedBlock(
      [CONFIG({ event: "session_start" })],
      exploding,
      undefined,
      logger,
    );

    expect(block).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("assembles one marked block from every context hook that contributed", async () => {
    const block = await buildSeedBlock(
      [CONFIG({ event: "session_start", command: "seed" })],
      fakeRunner((hook) => ({
        ok: true,
        hook,
        outcome: { kind: "context", text: "from the seed hook" },
        durationMs: 1,
      })),
      undefined,
      undefined,
    );

    expect(block).toContain("from the seed hook");
  });

  it("contributes no seed block when no context hook is configured", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [CONFIG({ event: "pre_tool_use" })],
      environment: {},
    });
    const activation = await capability.forRun(context());
    expect(await activation?.seedBlock?.()).toBeUndefined();
  });

  it("routes direct MCP hooks through the run-scoped tool port", async () => {
    const calls: unknown[][] = [];
    const services = createCapabilityServices();
    services.provide(MCP_HOOK_TOOL_PORT, {
      call: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    });
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [
        CONFIG({
          event: "run_start",
          type: "mcp_tool",
          command: "",
          server: "alerts",
          tool: "notify",
          input: { mode: "${mode}" },
        }),
      ],
      environment: {},
    });
    const activation = await capability.forRun(context({ services }));
    await activation?.lifecycle?.[0]?.onRunStart?.({ mode: "solo", entry: "lead" });

    expect(calls[0]?.slice(0, 3)).toEqual(["alerts", "notify", { mode: "solo" }]);
  });

  it("keeps a direct MCP hook non-blocking when the run has no MCP tool port", async () => {
    const capability = createWorkspaceHooksCapability({
      resolveHooks: () => [
        CONFIG({
          event: "pre_tool_use",
          type: "mcp_tool",
          command: "",
          server: "review",
          tool: "inspect",
        }),
      ],
      environment: {},
    });
    const activation = await capability.forRun(context());
    await expect(
      activation?.lifecycle?.[0]?.beforeToolUse?.({ tool: "shell", arguments: {} }),
    ).resolves.toEqual({ kind: "pass" });
  });
});

describe("createHooksCapability", () => {
  const hook = (): LifecycleHook => ({ beforeToolUse: () => Promise.resolve({ kind: "pass" }) });

  it("does not activate for an empty hook set", async () => {
    expect(await createHooksCapability([]).forRun(context())).toBeNull();
  });

  it("carries the supplied hooks and contributes no per-agent surface", async () => {
    const hooks = [hook(), hook()];
    const activation = await createHooksCapability(hooks).forRun(context());

    expect(activation?.lifecycle).toBe(hooks);
    expect(activation?.forAgent(LEAD_SCOPE)).toBeNull();
  });

  it("defaults to the registry name and accepts an override", async () => {
    expect(createHooksCapability([hook()]).name).toBe(HOOKS_CAPABILITY_NAME);
    const named = createHooksCapability([hook()], "extra-hooks");
    expect(named.name).toBe("extra-hooks");
    expect((await named.forRun(context()))?.name).toBe("extra-hooks");
  });
});
