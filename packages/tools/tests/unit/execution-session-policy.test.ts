import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import {
  ExecutionSessionManager,
  type SessionChild,
  type SessionOwnership,
} from "#src/lib/execution-session.ts";
import { resolveConfig } from "#src/config.ts";
import { manualClock } from "../helpers/manual-clock.ts";
import { SessionWindow } from "#src/lib/session-window.ts";
import type { SessionLog } from "#src/lib/session-log.ts";
import { shellSession } from "#src/tools/shell-session.ts";
import { createShell } from "#src/tools/shell.ts";

function fakeChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref() {},
  });
  return child;
}

function rig(log?: SessionLog) {
  const time = manualClock();
  const running = new Set<number>();
  const stops: Array<{ pid: number; deadline: number }> = [];
  let confirms = true;
  const ownership: SessionOwnership = {
    isRunning: ({ pid }) => running.has(pid),
    async stop({ pid }, _logger, deadline) {
      stops.push({ pid, deadline });
      if (confirms) running.delete(pid);
      return confirms;
    },
  };
  const manager = new ExecutionSessionManager(undefined, {
    clock: time.clock,
    ownership,
    ...(log ? { createLog: () => log } : {}),
  });
  const config = resolveConfig({ workspaceRoot: process.cwd(), sessionManager: manager });
  let nextPid = 100;
  const launch = async (over: Record<string, unknown> = {}) => {
    const child = fakeChild(++nextPid);
    running.add(child.pid);
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command: "fake",
      cwd: process.cwd(),
      shell: { file: "sh", flavor: "posix" },
      spawnChild: () => child as SessionChild,
      ...over,
    });
    child.emit("spawn");
    return { child, session };
  };
  return {
    ...time,
    running,
    stops,
    manager,
    config,
    launch,
    setConfirmation: (value: boolean) => {
      confirms = value;
    },
  };
}

function controlledShell(r: ReturnType<typeof rig>) {
  let child: ReturnType<typeof fakeChild> | undefined;
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const shell = createShell({
    statDirectory: async () => {},
    spawn: () => {
      child = fakeChild(900);
      r.running.add(child.pid);
      markSpawned();
      return child as SessionChild;
    },
  });
  return { shell, spawned, child: () => child! };
}

test("deadline, output and drain use one clock without probing a real PID", async () => {
  const r = rig();
  const seen: string[] = [];
  const { child, session } = await r.launch({
    timeoutMs: 1000,
    onOutput: (s: string) => seen.push(s),
  });
  child.stdout.write("ready");
  expect(session.snapshot().phase).toBe("running");
  await r.advance(200);
  expect(seen).toEqual(["ready"]);
  await r.advance(799);
  expect(session.timedOut).toBe(false);
  await r.advance(1);
  expect(session.timedOut).toBe(true);
  expect(r.stops).toEqual([{ pid: child.pid, deadline: 2200 }]);
  child.emit("exit", null, "SIGTERM");
  await r.advance(100);
  expect((await session.completed).timedOut).toBe(true);
  expect(r.pending()).toBe(0);
});

test("early close cancels deadline and leaves a second session independent", async () => {
  const r = rig();
  const a = await r.launch({ timeoutMs: 500 });
  const b = await r.launch({ timeoutMs: 500 });
  a.child.exitCode = 0;
  r.running.delete(a.child.pid);
  a.child.emit("exit", 0, null);
  a.child.emit("close", 0, null);
  expect((await a.session.completed).timedOut).toBe(false);
  await r.advance(500);
  expect(a.session.timedOut).toBe(false);
  expect(b.session.timedOut).toBe(true);
  expect(r.stops.map((stop) => stop.pid)).toEqual([b.child.pid]);
  b.child.emit("close", null, "SIGTERM");
  await b.session.completed;
  expect(r.pending()).toBe(0);
});

test("manager close seals admission and stops every owned session", async () => {
  const r = rig();
  const a = await r.launch();
  const b = await r.launch();
  expect(await r.manager.close()).toBe(true);
  expect(r.stops).toEqual([
    { pid: a.child.pid, deadline: 1200 },
    { pid: b.child.pid, deadline: 1200 },
  ]);
  await expect(r.launch()).rejects.toMatchObject({ code: "aborted" });
});

test("manager close reports an unconfirmed tree instead of treating signalling as exit", async () => {
  const r = rig();
  const { child } = await r.launch();
  r.setConfirmation(false);
  expect(await r.manager.close()).toBe(false);
  expect(r.running.has(child.pid)).toBe(true);
  expect(r.stops).toEqual([{ pid: child.pid, deadline: 1200 }]);
});

test("controlled stream events join a split UTF-8 character and notify readiness", async () => {
  const r = rig();
  const { child, session } = await r.launch({ readyWhen: /é/ });
  const ready = session.waitReady(1000);
  child.stdout.write(Buffer.from([0xc3]));
  expect(session.ready).toBe(false);
  child.stdout.write(Buffer.from([0xa9]));
  expect(await ready).toBe(true);
  const page = session.readStreams(undefined, 1);
  expect(page.stdout).toMatchObject({ text: "é", nextOffset: 2 });
  child.emit("close", 0, null);
  await session.completed;
  expect(r.pending()).toBe(0);
});

test("readiness and activity waits end at their scheduled deadlines", async () => {
  const r = rig();
  const { child, session } = await r.launch({ readyWhen: /READY/ });
  const ready = session.waitReady(50);
  const change = session.waitForChange(undefined, 75);
  await r.advance(49);
  expect(r.pending()).toBe(2);
  await r.advance(1);
  expect(await ready).toBe(false);
  await r.advance(25);
  await change;
  expect(r.pending()).toBe(0);
  child.stdout.write("READY");
  expect(session.ready).toBe(true);
  child.emit("close", 0, null);
  await session.completed;
});

test("an asynchronous spawn error settles without touching the real process table", async () => {
  const r = rig();
  const { child, session } = await r.launch();
  child.emit("error", new Error("spawn refused"));
  await expect(session.completed).rejects.toMatchObject({ code: "io_error" });
  expect(r.pending()).toBe(0);
});

test("shell handler reports timeout from the manager clock without launching a command", async () => {
  const r = rig();
  const controlled = controlledShell(r);
  const pending = controlled.shell.handler({ command: "fake", timeout_ms: 1000 }, r.config);
  await controlled.spawned;
  controlled.child().emit("spawn");
  await r.advance(999);
  expect(r.stops).toEqual([]);
  await r.advance(1);
  controlled.child().emit("close", null, "SIGTERM");
  await expect(pending).rejects.toMatchObject({ code: "timeout" });
  expect(r.stops).toEqual([{ pid: 900, deadline: 2200 }]);
});

test("shell yield uses the same manager clock and retains the owned session", async () => {
  const r = rig();
  const controlled = controlledShell(r);
  const pending = controlled.shell.handler({ command: "fake", yield_time_ms: 50 }, r.config);
  await controlled.spawned;
  controlled.child().emit("spawn");
  for (let turn = 0; turn < 10 && r.pending() < 2; turn++) await Promise.resolve();
  expect(r.pending()).toBe(2);
  await r.advance(50);
  const output = await pending;
  expect(typeof output).toBe("string");
  expect(JSON.parse(output as string)).toMatchObject({ running: true });
  expect(r.manager.listSessions(r.config.sessionAgent)).toHaveLength(1);
  expect(await r.manager.close()).toBe(true);
});

test("keep_alive requires explicit yield and rejects permission deltas before spawn", async () => {
  const r = rig();
  const controlled = controlledShell(r);
  await expect(
    controlled.shell.handler({ command: "fake", keep_alive: true }, r.config),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    controlled.shell.handler(
      {
        command: "fake",
        keep_alive: true,
        yield_time_ms: 0,
        execution_permissions: { mode: "with_additional_permissions", network: "enabled" },
      },
      r.config,
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(r.running.size).toBe(0);
});

test("keep_alive rejects a Host launch without spawning a command", async () => {
  const r = rig();
  const controlled = controlledShell(r);
  await expect(
    controlled.shell.handler({ command: "fake", keep_alive: true, yield_time_ms: 0 }, r.config),
  ).rejects.toMatchObject({ code: "sandbox_unavailable" });
  expect(r.running.size).toBe(0);
});

for (const readyWhen of ["", " ", "\t \r\n"]) {
  test(`blank readiness ${JSON.stringify(readyWhen)} preserves the requested yield`, async () => {
    const r = rig();
    const controlled = controlledShell(r);
    let resolved = false;
    const pending = controlled.shell
      .handler({ command: "fake", yield_time_ms: 1000, ready_when: readyWhen }, r.config)
      .then((value) => {
        resolved = true;
        return value;
      });
    await controlled.spawned;
    controlled.child().emit("spawn");
    await r.advance(0);
    controlled.child().stdout.write("ordinary output");
    await r.advance(999);
    expect(resolved).toBe(false);
    await r.advance(1);
    expect(JSON.parse((await pending) as string)).toMatchObject({ running: true, ready: false });
    await r.manager.close();
  });
}

test("poll batches continuous and already pending output until its wait expires", async () => {
  const r = rig();
  const { child, session } = await r.launch();
  child.stdout.write("first\n");
  let resolved = false;
  const pending = shellSession
    .handler({ action: "poll", session_id: session.id }, r.config)
    .then((value) => {
      resolved = true;
      return value;
    });
  for (let i = 0; i < 9; i++) {
    child.stdout.write("progress\n");
    await r.advance(1000);
    expect(resolved).toBe(false);
  }
  await r.advance(1000);
  expect(JSON.parse((await pending) as string).stdout).toBe("first\n" + "progress\n".repeat(9));
  expect(r.pending()).toBe(0);
  await r.manager.close();
});

test("poll completion and cancellation wake promptly and remove timers", async () => {
  const r = rig();
  const { child, session } = await r.launch();
  const controller = new AbortController();
  const cancelled = session.waitForChange(undefined, 30000, controller.signal);
  controller.abort();
  await cancelled;
  expect(r.pending()).toBe(0);
  const completed = session.waitForChange(undefined, 30000);
  child.exitCode = 7;
  r.running.delete(child.pid);
  child.emit("close", 7, null);
  await completed;
  expect(r.pending()).toBe(0);
  expect(
    JSON.parse(
      (await shellSession.handler(
        { action: "status", session_id: session.id },
        r.config,
      )) as string,
    ),
  ).toMatchObject({ running: false, exit_code: 7 });
  await r.manager.close();
});

test("nonblank readiness preserves significant spaces and can yield before the timer", async () => {
  const r = rig();
  const controlled = controlledShell(r);
  let resolved = false;
  const pending = controlled.shell
    .handler({ command: "fake", yield_time_ms: 1000, ready_when: " READY " }, r.config)
    .then((value) => {
      resolved = true;
      return value;
    });
  await controlled.spawned;
  controlled.child().emit("spawn");
  await r.advance(0);
  controlled.child().stdout.write("READY");
  await r.advance(100);
  expect(resolved).toBe(false);
  controlled.child().stdout.write(" READY ");
  expect(JSON.parse((await pending) as string).ready).toBe(true);
  await r.manager.close();
});

test("failed log capture keeps recent output and unconfirmed cleanup retains the archive", async () => {
  let disposed = false;
  const log: SessionLog = {
    stdout: {
      totalBytes: 0,
      push: () => {
        throw new Error("disk full");
      },
      read: () => {
        throw new Error("unavailable");
      },
    },
    stderr: new SessionWindow(1024),
    stdoutPath: "test-stdout",
    stderrPath: "test-stderr",
    dispose: () => {
      disposed = true;
    },
  };
  const r = rig(log);
  const { child, session } = await r.launch({ retainOutput: true });
  child.stdout.write("recoverable tail");
  expect(session.readStreams(undefined, 100).stdout.text).toBe("recoverable tail");
  expect(session.outputInfo().log_truncated).toBe(true);
  r.setConfirmation(false);
  expect(await r.manager.close()).toBe(false);
  expect(disposed).toBe(false);
  r.setConfirmation(true);
  expect(await r.manager.close()).toBe(true);
  expect(disposed).toBe(true);
});

test("shell yield clears its wait when asynchronous launch fails", async () => {
  const r = rig();
  const controlled = controlledShell(r);
  const pending = controlled.shell.handler({ command: "fake", yield_time_ms: 1000 }, r.config);
  await controlled.spawned;
  await r.advance(0);
  controlled.child().emit("error", new Error("spawn failed"));
  await expect(pending).rejects.toMatchObject({ code: "io_error" });
  expect(r.pending()).toBe(0);
  await r.manager.close();
});
