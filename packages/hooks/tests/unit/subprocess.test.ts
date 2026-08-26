import { describe, expect, test } from "bun:test";
import { shellArgs } from "@clarvis/tools/shell";
import {
  DEFAULT_KILL_GRACE_MS,
  ignoreRejection,
  runHookCommand,
  type SubprocessDeps,
  type SubprocessRequest,
} from "../../src/subprocess.ts";
import { FakeChild, fakeClock, fakeSpawn, tick, type SpawnCall } from "../helpers/fake-child.ts";

const POSIX_SHELL = { flavor: "posix", file: "sh" } as const;

function request(over: Partial<SubprocessRequest> = {}): SubprocessRequest {
  return {
    command: "true",
    cwd: "/ws",
    env: { PATH: "/usr/bin" },
    stdin: '{"protocol":1}',
    timeoutMs: 5_000,
    ...over,
  };
}

function seams(child: FakeChild, calls: SpawnCall[] = []): SubprocessDeps & { calls: SpawnCall[] } {
  return {
    calls,
    spawn: fakeSpawn(child, calls),
    resolveShell: () => POSIX_SHELL,
    ownProcessGroup: () => true,
    killTree: () => true,
  };
}

describe("runHookCommand", () => {
  test("captures stdout and stderr and reports the exit code", async () => {
    const child = new FakeChild();
    const pending = runHookCommand(request(), seams(child));
    await tick();
    child.out('{"kind":"pass"}');
    child.err("a warning");
    child.finish(0);
    const res = await pending;
    expect(res.stdout).toBe('{"kind":"pass"}');
    expect(res.stderr).toBe("a warning");
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.aborted).toBe(false);
    expect(res.spawnError).toBeUndefined();
  });

  test("runs in the workspace root, in its own process group, with the given env", async () => {
    const child = new FakeChild();
    const deps = seams(child);
    const pending = runHookCommand(request({ cwd: "/repo", env: { A: "1" } }), deps);
    await tick();
    child.finish(0);
    await pending;
    expect(deps.calls[0]?.file).toBe("sh");
    expect(deps.calls[0]?.args).toEqual(["-c", "true"]);
    expect(deps.calls[0]?.options.cwd).toBe("/repo");
    expect(deps.calls[0]?.options.env).toEqual({ A: "1" });
    expect(deps.calls[0]?.options.detached).toBe(true);
    expect(deps.calls[0]?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  test("never passes detached on a platform without process groups", async () => {
    const child = new FakeChild();
    const deps = { ...seams(child), ownProcessGroup: () => false };
    const pending = runHookCommand(request(), deps);
    await tick();
    child.finish(0);
    await pending;
    expect(deps.calls[0]?.options.detached).toBe(false);
  });

  test("uses the host's own shell dialect, including the Windows encoded form", async () => {
    const child = new FakeChild();
    const calls: SpawnCall[] = [];
    const pending = runHookCommand(request({ command: "echo hi" }), {
      spawn: fakeSpawn(child, calls),
      resolveShell: () => ({ flavor: "powershell", file: "pwsh.exe" }),
      shellArgs,
      ownProcessGroup: () => false,
    });
    await tick();
    child.finish(0);
    await pending;
    expect(calls[0]?.file).toBe("pwsh.exe");
    expect(calls[0]?.args.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    const encoded = calls[0]?.args[3] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain("echo hi");
  });

  test("writes the payload to stdin and closes it", async () => {
    const child = new FakeChild();
    const pending = runHookCommand(request({ stdin: "PAYLOAD" }), seams(child));
    await tick();
    child.finish(0);
    await pending;
    expect(child.stdin?.written).toBe("PAYLOAD");
  });

  test("a hook that never reads stdin does not take the host down", async () => {
    const child = new FakeChild();
    if (child.stdin !== null) child.stdin.epipe = true;
    const pending = runHookCommand(request(), seams(child));
    await tick();
    child.finish(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });

  test("tolerates a child with no stdin at all", async () => {
    const child = new FakeChild();
    child.stdin = null;
    const pending = runHookCommand(request(), seams(child));
    await tick();
    child.finish(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });

  test("truncation sticks past the boundary chunk", async () => {
    const child = new FakeChild();
    const pending = runHookCommand(request({ maxStdoutBytes: 8 }), seams(child));
    await tick();
    child.out("12345");
    child.out("67890");
    child.out("ignored entirely");
    child.finish(0);
    const res = await pending;
    expect(res.stdout).toBe("12345678");
    expect(res.stdoutTruncated).toBe(true);
  });

  test("stderr has its own cap", async () => {
    const child = new FakeChild();
    const pending = runHookCommand(request({ maxStderrBytes: 4 }), seams(child));
    await tick();
    child.err("abcdefgh");
    child.finish(0);
    const res = await pending;
    expect(res.stderr).toBe("abcd");
  });

  test("exit then close settles only after both process events", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const pending = runHookCommand(request(), { ...seams(child), timers: clock.timers });
    await tick();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    child.exitOnly(0);
    await tick();
    expect(settled).toBe(false);
    child.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(clock.pending()).toBe(0);
  });

  test("close then exit settles only after both process events", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const pending = runHookCommand(request(), { ...seams(child), timers: clock.timers });
    await tick();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    child.closeOnly(0);
    await tick();
    expect(settled).toBe(false);
    child.emit("exit", 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(clock.pending()).toBe(0);
  });

  test("exit without close settles after the drain window", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const pending = runHookCommand(request(), { ...seams(child), timers: clock.timers });
    await tick();
    child.out("late");
    child.exitOnly(3);
    clock.advance(100);
    const res = await pending;
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("late");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  test("close without exit settles after the drain window", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const pending = runHookCommand(request(), { ...seams(child), timers: clock.timers });
    await tick();
    child.closeOnly(4);
    clock.advance(100);
    const res = await pending;
    expect(res.exitCode).toBe(4);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  test("a timeout escalates SIGTERM to SIGKILL over the grace period", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const killed: [number, NodeJS.Signals][] = [];
    const pending = runHookCommand(request({ timeoutMs: 1_000 }), {
      ...seams(child),
      timers: clock.timers,
      killTree: (pid, signal) => {
        killed.push([pid, signal]);
        return true;
      },
    });
    await tick();

    clock.advance(999);
    expect(killed).toEqual([]);

    clock.advance(1);
    expect(killed).toEqual([[4242, "SIGTERM"]]);

    clock.advance(DEFAULT_KILL_GRACE_MS);
    expect(killed).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);

    child.finish(null, "SIGKILL");
    const res = await pending;
    expect(res.timedOut).toBe(true);
    expect(res.signal).toBe("SIGKILL");
  });

  test("falls back to killing the lone process when the tree walk fails", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const pending = runHookCommand(request({ timeoutMs: 10 }), {
      ...seams(child),
      timers: clock.timers,
      killTree: () => false,
    });
    await tick();
    clock.advance(10);
    expect(child.kills).toEqual(["SIGTERM"]);
    child.finish(null, "SIGTERM");
    await pending;
  });

  test("kills directly when the child has no pid", async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const clock = fakeClock();
    const pending = runHookCommand(request({ timeoutMs: 10 }), {
      ...seams(child),
      timers: clock.timers,
    });
    await tick();
    clock.advance(10);
    expect(child.kills).toEqual(["SIGTERM"]);
    child.finish(null, "SIGTERM");
    await pending;
  });

  test("an already-aborted signal short-circuits before anything is spawned", async () => {
    const child = new FakeChild();
    const deps = seams(child);
    const controller = new AbortController();
    controller.abort();
    const res = await runHookCommand(request({ signal: controller.signal }), deps);
    expect(res.aborted).toBe(true);
    expect(deps.calls).toHaveLength(0);
  });

  test("aborting mid-flight kills the child and reports the abort", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const controller = new AbortController();
    const pending = runHookCommand(request({ signal: controller.signal }), {
      ...seams(child),
      timers: clock.timers,
    });
    await tick();
    controller.abort();
    child.finish(null, "SIGTERM");
    const res = await pending;
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
  });

  test("a spawn that throws is reported, not raised", async () => {
    const res = await runHookCommand(request(), {
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => false,
      spawn: () => {
        throw new Error("EACCES");
      },
    });
    expect(res.spawnError).toBe("EACCES");
    expect(res.exitCode).toBeNull();
  });

  test("a spawn that throws a non-Error is still reported", async () => {
    const res = await runHookCommand(request(), {
      resolveShell: () => POSIX_SHELL,
      ownProcessGroup: () => false,
      spawn: () => {
        throw "not an error object";
      },
    });
    expect(res.spawnError).toBe("not an error object");
  });

  test("an error event is reported as a spawn failure", async () => {
    const child = new FakeChild();
    const pending = runHookCommand(request(), seams(child));
    await tick();
    child.fail("spawn sh ENOENT");
    const res = await pending;
    expect(res.spawnError).toBe("spawn sh ENOENT");
  });

  test("settling happens once and unrefs the child", async () => {
    const child = new FakeChild();
    const pending = runHookCommand(request(), seams(child));
    await tick();
    child.finish(0);
    child.finish(1);
    const res = await pending;
    expect(res.exitCode).toBe(0);
    expect(child.unrefs).toBe(1);
  });

  test("measures its own duration through the injected clock", async () => {
    const child = new FakeChild();
    let clockValue = 1_000;
    const pending = runHookCommand(request(), { ...seams(child), now: () => clockValue });
    await tick();
    clockValue = 1_250;
    child.finish(0);
    const res = await pending;
    expect(res.durationMs).toBe(250);
  });

  test("a timeout beyond the platform's timer ceiling is clamped rather than firing at once", async () => {
    const child = new FakeChild();
    const clock = fakeClock();
    const pending = runHookCommand(request({ timeoutMs: Number.MAX_SAFE_INTEGER }), {
      ...seams(child),
      timers: clock.timers,
    });
    await tick();
    clock.advance(2_147_483_646);
    expect(child.kills).toEqual([]);
    child.finish(0);
    await expect(pending).resolves.toMatchObject({ timedOut: false });
  });
});

describe("ignoreRejection", () => {
  test("absorbs a rejection instead of letting it go unhandled", async () => {
    // Every detached promise in the module ends here, so this is the one place
    // the sink itself can be held to its contract: it must swallow, and it must
    // not turn a rejection into a throw at the call site.
    expect(() => {
      ignoreRejection(Promise.reject(new Error("the reader was already torn down")));
    }).not.toThrow();
    await tick();
  });

  test("is transparent to a promise that settles normally", async () => {
    expect(() => {
      ignoreRejection(Promise.resolve("fine"));
    }).not.toThrow();
    await tick();
  });
});
