import { describe, expect, test } from "bun:test";
import {
  createHookRunner,
  HOOK_BLOCKING_EXIT_CODE,
  HOOK_PROTOCOL_VERSION,
  MAX_STDIN_BYTES,
} from "../../src/runner.ts";
import type { HookInvocation, HookLogger, HookSpec } from "../../src/types.ts";
import { FakeChild, fakeClock, fakeSpawn, tick, type SpawnCall } from "../helpers/fake-child.ts";

const POSIX_SHELL = { flavor: "posix", file: "sh" } as const;

function invocation(over: Partial<HookInvocation> = {}): HookInvocation {
  return {
    event: "pre_tool_use",
    externalEvent: "PreToolUse",
    data: { tool_name: "shell" },
    defaultTimeoutMs: 5_000,
    gate: true,
    ...over,
  };
}

function recorder(): {
  logger: HookLogger;
  warnings: Record<string, unknown>[];
  records: Record<string, unknown>[];
} {
  const warnings: Record<string, unknown>[] = [];
  const records: Record<string, unknown>[] = [];
  return {
    warnings,
    records,
    logger: {
      debug: (f) => records.push(f),
      info: (f) => records.push(f),
      warn: (f) => {
        warnings.push(f);
        records.push(f);
      },
      error: (f) => records.push(f),
    },
  };
}

interface Harness {
  runner: ReturnType<typeof createHookRunner>;
  child: FakeChild;
  calls: SpawnCall[];
  warnings: Record<string, unknown>[];
  records: Record<string, unknown>[];
}

function harness(over: { child?: FakeChild; baseEnv?: Record<string, string> } = {}): Harness {
  const child = over.child ?? new FakeChild();
  const calls: SpawnCall[] = [];
  const { logger, warnings, records } = recorder();
  const runner = createHookRunner({
    workspaceRoot: "/ws",
    baseEnv: over.baseEnv ?? { PATH: "/usr/bin" },
    logger,
    spawn: fakeSpawn(child, calls),
    resolveShell: () => POSIX_SHELL,
    ownProcessGroup: () => true,
    killTree: () => true,
  });
  return { runner, child, calls, warnings, records };
}

/** Drives one `run` to completion against a scripted child. */
async function runOnce(
  h: Harness,
  hook: HookSpec,
  inv: HookInvocation,
  script: (child: FakeChild) => void,
): ReturnType<Harness["runner"]["run"]> {
  const pending = h.runner.run(hook, inv);
  await tick();
  script(h.child);
  return pending;
}

describe("select", () => {
  const hooks: HookSpec[] = [
    { event: "pre_tool_use", command: "operator-1" },
    { event: "pre_tool_use", command: "scoped", match: { tool: "shell" } },
    { event: "post_tool_use", command: "other-event" },
    { event: "pre_tool_use", command: "plugin-1" },
  ];

  test("filters by event and preserves configuration order", () => {
    const { runner } = harness();
    const chosen = runner.select(
      hooks,
      invocation({ candidate: { tool: "shell", arguments: {} } }),
    );
    expect(chosen.map((h) => h.command)).toEqual(["operator-1", "scoped", "plugin-1"]);
  });

  test("a scoped hook drops out when the tool does not match", () => {
    const { runner } = harness();
    const chosen = runner.select(
      hooks,
      invocation({ candidate: { tool: "read_file", arguments: {} } }),
    );
    expect(chosen.map((h) => h.command)).toEqual(["operator-1", "plugin-1"]);
  });

  test("an unfiltered hook is selected at an event with no candidate", () => {
    const { runner } = harness();
    const chosen = runner.select(hooks, invocation({ event: "run_end", gate: false }));
    expect(chosen).toHaveLength(0);
    const observers: HookSpec[] = [{ event: "run_end", command: "notify" }];
    expect(runner.select(observers, invocation({ event: "run_end", gate: false }))).toHaveLength(1);
  });

  test("filters are compiled once per spec", () => {
    const { runner } = harness();
    const spec: HookSpec = { event: "pre_tool_use", command: "x", match: { tool: "shell" } };
    const inv = invocation({ candidate: { tool: "shell", arguments: {} } });
    expect(runner.select([spec], inv)).toHaveLength(1);
    expect(runner.select([spec], inv)).toHaveLength(1);
  });
});

describe("run", () => {
  test("parses a verdict from stdout", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.out('{"kind":"deny","message":"no"}');
      c.finish(0);
    });
    expect(result).toMatchObject({ ok: true, outcome: { kind: "deny", message: "no" } });
  });

  test("sends the protocol envelope on stdin", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "pre_tool_use", command: "x" },
      invocation({ data: { tool_name: "shell", tool_input: { command: "ls" } } }),
      (c) => {
        c.finish(0);
      },
    );
    const payload: unknown = JSON.parse(h.child.stdin?.written ?? "{}");
    expect(payload).toEqual({
      protocol: HOOK_PROTOCOL_VERSION,
      hook_event_name: "PreToolUse",
      cwd: "/ws",
      tool_name: "shell",
      tool_input: { command: "ls" },
    });
  });

  test("publishes no second copy of a field under a Clarvis name", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "pre_tool_use", command: "x" },
      invocation({ data: { tool_name: "shell", tool_input: { command: "ls" } } }),
      (c) => {
        c.finish(0);
      },
    );
    const payload = JSON.parse(h.child.stdin?.written ?? "{}") as Record<string, unknown>;
    for (const shim of ["event", "workspace_root", "data"]) {
      expect(payload).not.toHaveProperty(shim);
    }
  });

  test("names the event as the external dialect spells it, so a foreign hook matches", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "session_start", command: "x" },
      invocation({ event: "session_start", gate: false, externalEvent: "SessionStart", data: {} }),
      (c) => {
        c.finish(0);
      },
    );
    expect(JSON.parse(h.child.stdin?.written ?? "{}")).toMatchObject({
      hook_event_name: "SessionStart",
    });
  });

  test("falls back to our own event name when the dialect has no word for it", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "budget_exhausted", command: "x" },
      invocation({
        event: "budget_exhausted",
        gate: false,
        externalEvent: undefined,
        data: {},
      }),
      (c) => {
        c.finish(0);
      },
    );
    expect(JSON.parse(h.child.stdin?.written ?? "{}")).toMatchObject({
      hook_event_name: "budget_exhausted",
    });
  });

  test("omits tool fields at an event that has no pending call", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "run_start", command: "x" },
      invocation({ event: "run_start", gate: false, data: { mode: "lead" } }),
      (c) => {
        c.finish(0);
      },
    );
    const payload = JSON.parse(h.child.stdin?.written ?? "{}") as Record<string, unknown>;
    expect(payload).not.toHaveProperty("tool_name");
    expect(payload).not.toHaveProperty("tool_input");
  });

  test("omits session_id when the host supplies none", async () => {
    const h = harness();
    await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.finish(0);
    });
    expect(JSON.parse(h.child.stdin?.written ?? "{}")).not.toHaveProperty("session_id");
  });

  test("drops an oversized payload rather than the whole call", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "pre_tool_use", command: "x" },
      invocation({ data: { blob: "x".repeat(MAX_STDIN_BYTES + 10) } }),
      (c) => {
        c.finish(0);
      },
    );
    expect(JSON.parse(h.child.stdin?.written ?? "{}")).toEqual({
      protocol: HOOK_PROTOCOL_VERSION,
      hook_event_name: "PreToolUse",
      cwd: "/ws",
      payload_truncated: true,
    });
  });

  test("unserializable data degrades to a truncated payload", async () => {
    const h = harness();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await runOnce(
      h,
      { event: "pre_tool_use", command: "x" },
      invocation({ data: circular }),
      (c) => {
        c.finish(0);
      },
    );
    expect(JSON.parse(h.child.stdin?.written ?? "{}")).toMatchObject({ payload_truncated: true });
  });

  test("describes the fire point in the environment without leaking credentials", async () => {
    const h = harness({ baseEnv: { PATH: "/usr/bin" } });
    await runOnce(
      h,
      { event: "pre_tool_use", command: "x", timeout_ms: 1234 },
      invocation({ candidate: { tool: "shell", arguments: {} } }),
      (c) => {
        c.finish(0);
      },
    );
    expect(h.calls[0]?.options.env).toEqual({
      PATH: "/usr/bin",
      CLARVIS_HOOK_PROTOCOL: String(HOOK_PROTOCOL_VERSION),
      CLARVIS_HOOK_EVENT: "pre_tool_use",
      CLARVIS_HOOK_GATE: "1",
      CLARVIS_HOOK_TIMEOUT_MS: "1234",
      CLARVIS_WORKSPACE_ROOT: "/ws",
      CLARVIS_HOOK_TOOL: "shell",
    });
  });

  test("omits the tool variable where there is no tool", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "run_end", command: "x" },
      invocation({ event: "run_end", gate: false }),
      (c) => {
        c.finish(0);
      },
    );
    expect(h.calls[0]?.options.env.CLARVIS_HOOK_TOOL).toBeUndefined();
    expect(h.calls[0]?.options.env.CLARVIS_HOOK_GATE).toBe("0");
  });

  test("publishes a canonical full tool name beside its model-facing wire name", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "pre_tool_use", command: "x" },
      invocation({
        candidate: {
          tool: "remote_search",
          aliases: ["remote.search"],
          arguments: {},
        },
      }),
      (child) => child.finish(0),
    );
    expect(h.calls[0]?.options.env.CLARVIS_HOOK_TOOL).toBe("remote_search");
    expect(h.calls[0]?.options.env.CLARVIS_HOOK_TOOL_FULL_NAME).toBe("remote.search");
  });

  test("a spec timeout overrides the fire point's default", async () => {
    const h = harness();
    await runOnce(
      h,
      { event: "pre_tool_use", command: "x", timeout_ms: 250 },
      invocation({ defaultTimeoutMs: 9_000 }),
      (c) => {
        c.finish(0);
      },
    );
    expect(h.calls[0]?.options.env.CLARVIS_HOOK_TIMEOUT_MS).toBe("250");
  });

  test.each([1, 127])("exit code %d is exit_nonzero", async (code) => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.finish(code);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("exit_nonzero");
  });

  test("a signalled child is an exit failure carrying the signal", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.finish(null, "SIGSEGV");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("exit_nonzero");
      expect(result.failure.signal).toBe("SIGSEGV");
      expect(result.failure.message).toContain("SIGSEGV");
    }
  });

  test("a valid verdict on a non-zero exit is still a failure", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.out('{"kind":"pass"}');
      c.finish(3);
    });
    expect(result.ok).toBe(false);
  });

  test("exit code 2 at a gate denies, carrying stderr as the reason", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.err("destructive command blocked");
      c.finish(HOOK_BLOCKING_EXIT_CODE);
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toEqual({ kind: "deny", message: "destructive command blocked" });
    }
  });

  test("exit code 2 denies even when the hook explains nothing", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.finish(HOOK_BLOCKING_EXIT_CODE);
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome.kind).toBe("deny");
  });

  test("a replacement at a rewritable event is a rewrite outcome, logged as one", async () => {
    const h = harness();
    const result = await runOnce(
      h,
      { event: "pre_tool_use", command: "x" },
      invocation({ rewritable: true }),
      (c) => {
        c.out('{"kind":"rewrite","arguments":{"command":"safe"}}');
        c.finish(0);
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toEqual({ kind: "rewrite", arguments: { command: "safe" } });
    }
    expect(h.records.some((f) => f.event === "hooks.verdict" && f.kind === "rewrite")).toBe(true);
  });

  test("a replacement where nothing can act on it is bad output, not a silent pass", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.out('{"kind":"rewrite","arguments":{"command":"safe"}}');
      c.finish(0);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_output");
  });

  test("exit code 2 at an observer event stays an ordinary failure", async () => {
    const h = harness();
    const result = await runOnce(
      h,
      { event: "run_start", command: "x" },
      invocation({ event: "run_start", gate: false }),
      (c) => {
        c.err("noise");
        c.finish(HOOK_BLOCKING_EXIT_CODE);
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("exit_nonzero");
  });

  test("unparsable stdout is bad output", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.out("hello, not json");
      c.finish(0);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_output");
  });

  test("a context outcome at a gate is bad output", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.out('{"kind":"context","text":"hi"}');
      c.finish(0);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_output");
  });

  test("a context outcome is accepted where a verdict cannot block", async () => {
    const h = harness();
    const result = await runOnce(
      h,
      { event: "session_start", command: "x" },
      invocation({ event: "session_start", gate: false }),
      (c) => {
        c.out('{"kind":"context","text":"never edit dist/"}');
        c.finish(0);
      },
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "context", text: "never edit dist/" },
    });
  });

  test("a spawn failure is classified as such", async () => {
    const h = harness();
    const result = await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.fail("spawn sh EACCES");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("spawn_failed");
      expect(result.failure.message).toContain("EACCES");
    }
  });

  test("a timeout outranks the exit it produces", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const calls: SpawnCall[] = [];
    const runner = createHookRunner({
      workspaceRoot: "/ws",
      baseEnv: {},
      spawn: fakeSpawn(child, calls),
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => true,
      killTree: () => true,
      timers: clock.timers,
    });
    const pending = runner.run(
      { event: "pre_tool_use", command: "sleep 9" },
      invocation({ defaultTimeoutMs: 100 }),
    );
    await tick();
    clock.advance(100);
    child.finish(null, "SIGTERM");
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("timeout");
  });

  test("an abort outranks a timeout", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const controller = new AbortController();
    const runner = createHookRunner({
      workspaceRoot: "/ws",
      baseEnv: {},
      spawn: fakeSpawn(child),
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => true,
      killTree: () => true,
      timers: clock.timers,
    });
    const pending = runner.run(
      { event: "pre_tool_use", command: "sleep 9" },
      invocation({ defaultTimeoutMs: 100 }),
      controller.signal,
    );
    await tick();
    clock.advance(100);
    controller.abort();
    child.finish(null, "SIGKILL");
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("aborted");
  });

  test("a failure is logged with the command truncated and the payload absent", async () => {
    const h = harness();
    const command = "x".repeat(200);
    await runOnce(h, { event: "pre_tool_use", command }, invocation(), (c) => {
      c.err("boom");
      c.finish(9);
    });
    const warned = h.warnings[0];
    expect(warned?.err_kind).toBe("exit_nonzero");
    expect(warned?.exit_code).toBe(9);
    expect(warned?.stderr_tail).toBe("boom");
    expect(String(warned?.command)).toHaveLength(83);
    expect(JSON.stringify(warned)).not.toContain("protocol");
  });

  test("a successful hook logs nothing", async () => {
    const h = harness();
    await runOnce(h, { event: "pre_tool_use", command: "x" }, invocation(), (c) => {
      c.finish(0);
    });
    expect(h.warnings).toHaveLength(0);
  });
});

describe("resolve", () => {
  const gate = invocation();
  const observer = invocation({ event: "run_end", gate: false });

  test("a successful outcome passes straight through", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "pre_tool_use", command: "x" };
    expect(
      runner.resolve(
        { ok: true, hook, outcome: { kind: "deny", message: "no" }, durationMs: 1 },
        gate,
      ),
    ).toEqual({ kind: "deny", message: "no" });
  });

  test("a failure fails open by default", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "pre_tool_use", command: "x" };
    expect(
      runner.resolve(
        { ok: false, hook, failure: { kind: "timeout", message: "timed out" }, durationMs: 1 },
        gate,
      ),
    ).toEqual({ kind: "pass" });
  });

  test("on_failure deny blocks and explains itself", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "pre_tool_use", command: "x", on_failure: "deny" };
    const outcome = runner.resolve(
      {
        ok: false,
        hook,
        failure: { kind: "timeout", message: "the command timed out" },
        durationMs: 1,
      },
      gate,
    );
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") expect(outcome.message).toContain("the command timed out");
  });

  test("an observer event never denies, whatever on_failure says", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "run_end", command: "x", on_failure: "deny" };
    expect(
      runner.resolve(
        { ok: false, hook, failure: { kind: "exit_nonzero", message: "failed" }, durationMs: 1 },
        observer,
      ),
    ).toEqual({ kind: "pass" });
  });

  test("an observer event downgrades a hook that succeeded and asked to deny", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "run_end", command: "x", on_failure: "pass" };
    expect(
      runner.resolve(
        { ok: true, hook, outcome: { kind: "deny", message: "no" }, durationMs: 1 },
        observer,
      ),
    ).toEqual({ kind: "pass" });
  });

  test("an observer event still delivers the non-blocking outcomes it exists to hear", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "run_end", command: "x", on_failure: "pass" };
    expect(
      runner.resolve(
        { ok: true, hook, outcome: { kind: "advise", message: "fyi" }, durationMs: 1 },
        observer,
      ),
    ).toEqual({ kind: "advise", message: "fyi" });
    expect(
      runner.resolve(
        { ok: true, hook, outcome: { kind: "context", text: "state" }, durationMs: 1 },
        observer,
      ),
    ).toEqual({ kind: "context", text: "state" });
  });

  test("a gate still honours a hook that succeeded and asked to deny", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "pre_tool_use", command: "x", on_failure: "pass" };
    expect(
      runner.resolve(
        { ok: true, hook, outcome: { kind: "deny", message: "no" }, durationMs: 1 },
        gate,
      ),
    ).toEqual({ kind: "deny", message: "no" });
  });

  test("cancellation never denies, even for a fail-closed hook", () => {
    const { runner } = harness();
    const hook: HookSpec = { event: "pre_tool_use", command: "x", on_failure: "deny" };
    expect(
      runner.resolve(
        {
          ok: false,
          hook,
          failure: { kind: "aborted", message: "the run was cancelled" },
          durationMs: 1,
        },
        gate,
      ),
    ).toEqual({ kind: "pass" });
  });
});
