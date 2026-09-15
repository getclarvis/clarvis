/**
 * The small, slow tier: real shells, real pipes, real signals.
 *
 * The unit suites drive every branch through a scripted child, which is what
 * makes them fast and exhaustive - but a double cannot prove that stdin is
 * actually wired, that a 200KiB write into a 64KiB pipe buffer does not
 * deadlock, or that a hook's grandchild dies with it. Those are exactly the
 * failures that would reach an operator, so they are asserted against the real
 * thing here.
 *
 * `posixShell` guards the file because every command below is POSIX shell
 * syntax and every kill assertion is POSIX signal semantics. The Windows shell
 * path is covered where it can be: `subprocess.test.ts` asserts the pwsh
 * `-EncodedCommand` argv from any host.
 */
import { describe, expect, test } from "bun:test";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createHookRunner,
  filterHookEnv,
  MAX_STDIN_BYTES,
  type HookInvocation,
  type HookRunner,
} from "@clarvis/hooks";
import { tempRoot } from "../helpers/temp-root.ts";

const posixShell = process.platform !== "win32";

interface RealHookFixture {
  workspace: string;
  runner: HookRunner;
  temp: Awaited<ReturnType<typeof tempRoot>>;
}

function isolatedTest(
  name: string,
  body: (fixture: RealHookFixture) => void | Promise<void>,
): void {
  test(name, async () => {
    const temp = await tempRoot("clarvis-hooks-");
    const fixture = {
      workspace: temp.root,
      temp,
      runner: createHookRunner({
        workspaceRoot: temp.root,
        baseEnv: { PATH: process.env.PATH ?? "" },
      }),
    };
    try {
      await body(fixture);
    } finally {
      await temp.cleanup();
      expect(temp.pending()).toEqual([]);
    }
  });
}

function gate(over: Partial<HookInvocation> = {}): HookInvocation {
  return {
    event: "pre_tool_use",
    externalEvent: "PreToolUse",
    data: { tool: "shell" },
    defaultTimeoutMs: 10_000,
    gate: true,
    ...over,
  };
}

/** Polls until `pid` is gone, so the assertion is not racing the kernel's reaping. */
async function waitGone(pid: number, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
}

/** Waits on an observable child-side milestone instead of a timing guess. */
async function waitForText(path: string, expected?: string, budgetMs = 5_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const actual = await readFile(path, "utf8");
      if (actual.length > 0 && (expected === undefined || actual === expected)) return actual;
    } catch {
      // The child has not created the marker yet.
    }
    if (Date.now() > deadline) throw new Error(`child did not write ${path}`);
    await Bun.sleep(25);
  }
}

describe.skipIf(!posixShell)("a hook command against a real shell", () => {
  isolatedTest("a deny reaches the caller with its message intact", async ({ runner }) => {
    const result = await runner.run(
      { event: "pre_tool_use", command: `echo '{"kind":"deny","message":"dist/ is generated"}'` },
      gate(),
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "deny", message: "dist/ is generated" },
    });
  });

  isolatedTest("a silent hook passes", async ({ runner }) => {
    const result = await runner.run({ event: "pre_tool_use", command: "true" }, gate());
    expect(result).toMatchObject({ ok: true, outcome: { kind: "pass" } });
  });

  isolatedTest("the payload really arrives on stdin", async ({ runner, workspace }) => {
    const target = join(workspace, "stdin.json");
    const result = await runner.run(
      { event: "pre_tool_use", command: `cat > '${target}'` },
      gate({ data: { tool_name: "shell", tool_input: { command: "ls -la" } } }),
    );
    expect(result.ok).toBe(true);
    const received: unknown = JSON.parse(await readFile(target, "utf8"));
    expect(received).toEqual({
      protocol: 1,
      hook_event_name: "PreToolUse",
      cwd: workspace,
      tool_name: "shell",
      tool_input: { command: "ls -la" },
    });
  });

  isolatedTest(
    "a hook that never reads a large payload neither crashes nor deadlocks",
    async ({ runner }) => {
      const big = "x".repeat(200 * 1024);
      expect(Buffer.byteLength(JSON.stringify({ blob: big }), "utf8")).toBeLessThan(
        MAX_STDIN_BYTES,
      );
      const result = await runner.run(
        { event: "pre_tool_use", command: "exit 0" },
        gate({ data: { blob: big } }),
      );
      expect(result).toMatchObject({ ok: true, outcome: { kind: "pass" } });
    },
  );

  isolatedTest("the command runs in the workspace root", async ({ runner, workspace }) => {
    // `pwd` reports the physical path, and on macOS the temp dir reached via
    // /var is a symlink to /private/var — compare what the child can actually see.
    const physical = await realpath(workspace);
    const result = await runner.run(
      { event: "pre_tool_use", command: `test "$(pwd)" = '${physical}'` },
      gate(),
    );
    expect(result.ok).toBe(true);
  });

  isolatedTest(
    "the environment describes the fire point and withholds credentials",
    async ({ workspace }) => {
      const target = join(workspace, "env.txt");
      const scoped = createHookRunner({
        workspaceRoot: workspace,
        baseEnv: filterHookEnv(
          {
            PATH: process.env.PATH,
            ANTHROPIC_API_KEY: "sk-shape-rule",
            MY_COMPANY_LLM: "sk-named-by-config",
          },
          { denyExact: ["MY_COMPANY_LLM"] },
        ).env,
      });
      await scoped.run(
        {
          event: "pre_tool_use",
          command: `printf '%s|%s|%s|%s' "$CLARVIS_HOOK_EVENT" "$CLARVIS_HOOK_TOOL" "$ANTHROPIC_API_KEY" "$MY_COMPANY_LLM" > '${target}'`,
        },
        gate({ candidate: { tool: "shell", arguments: {} } }),
      );
      expect(await readFile(target, "utf8")).toBe("pre_tool_use|shell||");
    },
  );

  isolatedTest(
    "a command that does not exist is a non-zero exit, not a spawn failure",
    async ({ runner }) => {
      const result = await runner.run(
        { event: "pre_tool_use", command: "definitely-not-a-binary-xyz" },
        gate(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe("exit_nonzero");
        expect(result.failure.exitCode).toBe(127);
      }
    },
  );

  isolatedTest("stdout that is not a verdict is reported as bad output", async ({ runner }) => {
    const hook = { event: "pre_tool_use", command: "printf hello" } as const;
    const result = await runner.run(hook, gate());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_output");
  });

  isolatedTest("oversized stdout is truncated and never parsed", async ({ runner }) => {
    const result = await runner.run(
      { event: "pre_tool_use", command: `head -c 100000 /dev/zero | tr '\\0' a` },
      gate(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("bad_output");
      expect(result.failure.message).toContain("capture limit");
    }
  });

  isolatedTest(
    "stderr is captured for the log and never confused with the verdict",
    async ({ runner }) => {
      const result = await runner.run(
        {
          event: "pre_tool_use",
          command: `echo noise 1>&2; echo '{"kind":"advise","message":"ok"}'`,
        },
        gate(),
      );
      expect(result).toMatchObject({ ok: true, outcome: { kind: "advise", message: "ok" } });
    },
  );

  isolatedTest("a hook that overruns is killed and reported as a timeout", async ({ runner }) => {
    const hook = {
      event: "pre_tool_use",
      command: "sleep 30",
      timeout_ms: 150,
    } as const;
    const result = await runner.run(hook, gate());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("timeout");
  });

  isolatedTest("a hook's grandchild dies with it", async ({ runner, workspace, temp }) => {
    const pidFile = join(workspace, "grandchild.pid");
    const controller = new AbortController();
    const pending = runner.run(
      {
        event: "pre_tool_use",
        command: `sleep 30 & echo $! > '${pidFile}'; sleep 30`,
        timeout_ms: 10_000,
      },
      gate(),
      controller.signal,
    );
    const unregister = temp.register("grandchild hook run", async () => {
      controller.abort();
      await pending;
    });
    const pid = Number.parseInt((await waitForText(pidFile)).trim(), 10);
    controller.abort();
    const result = await pending;
    unregister();
    expect(result.ok).toBe(false);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitGone(pid)).toBe(true);
  });

  isolatedTest(
    "an abort mid-flight kills the child and reports cancellation",
    async ({ runner, workspace, temp }) => {
      const controller = new AbortController();
      const started = join(workspace, "abort.started");
      const pending = runner.run(
        { event: "pre_tool_use", command: `printf ready > '${started}'; sleep 30` },
        gate(),
        controller.signal,
      );
      const unregister = temp.register("aborted hook run", async () => {
        controller.abort();
        await pending;
      });
      await waitForText(started, "ready");
      controller.abort();
      const result = await pending;
      unregister();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe("aborted");
    },
  );
});
