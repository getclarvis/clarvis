import { describe, expect, test } from "bun:test";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { createHookRunner } from "../../src/runner.ts";
import { runHookCommand } from "../../src/subprocess.ts";
import { NOOP_HOOK_LOGGER, type HookInvocation, type HookLogger } from "../../src/types.ts";
import { FakeChild, fakeClock, fakeSpawn, tick, type SpawnCall } from "../helpers/fake-child.ts";

const POSIX_SHELL = { flavor: "posix", file: "sh" } as const;

function invocation(over: Partial<HookInvocation> = {}): HookInvocation {
  return {
    event: "pre_tool_use",
    data: { tool: "shell" },
    defaultTimeoutMs: 5_000,
    gate: true,
    ...over,
  };
}

function recorder(): { logger: HookLogger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const push = (fields: Record<string, unknown>): void => {
    records.push(fields);
  };
  return { records, logger: { debug: push, info: push, warn: push, error: push } };
}

function eventsOf(records: Record<string, unknown>[], name: string): Record<string, unknown>[] {
  return records.filter((r) => r.event === name);
}

describe("hooks.selected", () => {
  test("counts what fired, what was configured for the event, and what can never fire", () => {
    const { logger, records } = recorder();
    const runner = createHookRunner({ workspaceRoot: "/ws", baseEnv: {}, logger });
    const hooks = [
      { event: "pre_tool_use", command: "a" },
      { event: "pre_tool_use", command: "b", match: { tool: "read_file" } },
      { event: "pre_tool_use", command: "c", match: { args: { path: "[" } } },
      { event: "post_tool_use", command: "d" },
    ] as const;

    const chosen = runner.select(
      [...hooks],
      invocation({ candidate: { tool: "shell", arguments: {} } }),
    );

    expect(chosen.map((h) => h.command)).toEqual(["a"]);
    expect(eventsOf(records, "hooks.selected")).toEqual([
      {
        event: "hooks.selected",
        hook_event: "pre_tool_use",
        matched: 1,
        total: 3,
        broken_patterns: 1,
      },
    ]);
  });
});

describe("hooks.verdict", () => {
  async function verdictFor(stdout: string): Promise<Record<string, unknown>[]> {
    const child = new FakeChild();
    const calls: SpawnCall[] = [];
    const { logger, records } = recorder();
    const runner = createHookRunner({
      workspaceRoot: "/ws",
      baseEnv: {},
      logger,
      spawn: fakeSpawn(child, calls),
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => true,
      killTree: () => true,
    });
    const hook = { event: "pre_tool_use", command: "check" } as const;
    runner.select([hook], invocation());
    const pending = runner.run(hook, invocation());
    await tick();
    child.out(stdout);
    child.finish(0);
    await pending;
    return eventsOf(records, "hooks.verdict");
  }

  test("a deny is info, and names the hook's position in the firing order", async () => {
    const [record] = await verdictFor(JSON.stringify({ decision: "deny", message: "no" }));
    expect(record).toMatchObject({
      event: "hooks.verdict",
      hook_event: "pre_tool_use",
      kind: "deny",
      hook_index: 0,
    });
    expect(typeof record?.duration_ms).toBe("number");
  });

  test("any other verdict is debug", async () => {
    const [record] = await verdictFor("");
    expect(record).toMatchObject({ kind: "pass", hook_index: 0 });
  });

  test("a hook run without a preceding select reports no position rather than a wrong one", async () => {
    const child = new FakeChild();
    const { logger, records } = recorder();
    const runner = createHookRunner({
      workspaceRoot: "/ws",
      baseEnv: {},
      logger,
      spawn: fakeSpawn(child, []),
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => true,
      killTree: () => true,
    });
    const pending = runner.run({ event: "pre_tool_use", command: "x" }, invocation());
    await tick();
    child.finish(0);
    await pending;
    expect(eventsOf(records, "hooks.verdict")[0]).toMatchObject({ hook_index: -1 });
  });
});

describe("hooks.spawn", () => {
  test("records the spawn posture and the stdin size, never the command", async () => {
    const child = new FakeChild();
    const { logger, records } = recorder();
    const runner = createHookRunner({
      workspaceRoot: "/ws",
      baseEnv: {},
      logger,
      spawn: fakeSpawn(child, []),
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => true,
      killTree: () => true,
    });
    const pending = runner.run(
      { event: "pre_tool_use", command: "secret --token=abc" },
      invocation(),
    );
    await tick();
    child.finish(0);
    await pending;

    const [record] = eventsOf(records, "hooks.spawn");
    expect(record).toMatchObject({
      event: "hooks.spawn",
      hook_event: "pre_tool_use",
      shell_file: "sh",
      detached: true,
      timeout_ms: 5_000,
      data_truncated: false,
    });
    expect(record?.stdin_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toContain("abc");
  });

  test("an oversized payload is reported as truncated", async () => {
    const child = new FakeChild();
    const { logger, records } = recorder();
    const runner = createHookRunner({
      workspaceRoot: "/ws",
      baseEnv: {},
      logger,
      spawn: fakeSpawn(child, []),
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => true,
      killTree: () => true,
    });
    const pending = runner.run(
      { event: "pre_tool_use", command: "x" },
      invocation({ data: { blob: "x".repeat(400_000) } }),
    );
    await tick();
    child.finish(0);
    await pending;
    expect(eventsOf(records, "hooks.spawn")[0]).toMatchObject({ data_truncated: true });
  });

  test("a direct subprocess caller that names no event reports an unknown one", async () => {
    const child = new FakeChild();
    const { logger, records } = recorder();
    const pending = runHookCommand(
      { command: "x", cwd: "/ws", env: {}, stdin: "", timeoutMs: 1_000 },
      {
        logger,
        spawn: fakeSpawn(child, []),
        resolveShell: () => POSIX_SHELL,
        ownProcessGroup: () => false,
        killTree: () => true,
      },
    );
    await tick();
    child.finish(0);
    await pending;
    expect(eventsOf(records, "hooks.spawn")[0]).toMatchObject({
      hook_event: "unknown",
      detached: false,
      stdin_bytes: 0,
      data_truncated: false,
    });
  });
});

describe("hooks.timeout_kill", () => {
  test("reports the escalation and whether the tree was reached", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const { logger, records } = recorder();
    const pending = runHookCommand(
      { command: "sleep", cwd: "/ws", env: {}, stdin: "", timeoutMs: 10, killGraceMs: 5 },
      {
        logger,
        spawn: fakeSpawn(child, []),
        resolveShell: () => POSIX_SHELL,
        ownProcessGroup: () => true,
        killTree: () => true,
        timers: clock.timers,
      },
    );
    await tick();
    clock.advance(10);
    clock.advance(5);
    child.finish(null, "SIGKILL");
    await pending;

    expect(eventsOf(records, "hooks.timeout_kill")).toEqual([
      {
        event: "hooks.timeout_kill",
        hook_event: "unknown",
        timeout_ms: 10,
        escalated_to_sigkill: true,
        tree_killed: true,
      },
    ]);
  });

  test("a command that exits on its own reports nothing", async () => {
    const child = new FakeChild();
    const { logger, records } = recorder();
    const pending = runHookCommand(
      { command: "x", cwd: "/ws", env: {}, stdin: "", timeoutMs: 1_000 },
      {
        logger,
        spawn: fakeSpawn(child, []),
        resolveShell: () => POSIX_SHELL,
        ownProcessGroup: () => true,
        killTree: () => true,
      },
    );
    await tick();
    child.finish(0);
    await pending;
    expect(eventsOf(records, "hooks.timeout_kill")).toEqual([]);
  });
});

describe("the logger contract", () => {
  test("the capability port's Logger satisfies HookLogger", () => {
    const port: Logger = NOOP_LOGGER;
    const asHook: HookLogger = port;
    expect(() => asHook.debug({ event: "x" }, "m")).not.toThrow();
  });

  test("the no-op logger discards every level", () => {
    expect(NOOP_HOOK_LOGGER.debug({}, "m")).toBeUndefined();
    expect(NOOP_HOOK_LOGGER.info({}, "m")).toBeUndefined();
    expect(NOOP_HOOK_LOGGER.warn({}, "m")).toBeUndefined();
    expect(NOOP_HOOK_LOGGER.error({}, "m")).toBeUndefined();
  });

  test("a runner given no logger still runs", async () => {
    const child = new FakeChild();
    const runner = createHookRunner({
      workspaceRoot: "/ws",
      baseEnv: {},
      spawn: fakeSpawn(child, []),
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => true,
      killTree: () => true,
    });
    const pending = runner.run({ event: "pre_tool_use", command: "x" }, invocation());
    await tick();
    child.finish(0);
    expect((await pending).ok).toBe(true);
  });
});
