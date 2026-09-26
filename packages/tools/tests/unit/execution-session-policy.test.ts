import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import {
  ExecutionSessionManager,
  type SessionChild,
  type SessionOwnership,
} from "../../src/lib/execution-session.ts";
import { resolveConfig } from "../../src/config.ts";
import { manualClock } from "../helpers/manual-clock.ts";
import { createShell } from "../../src/tools/shell.ts";

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

function rig() {
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
  const manager = new ExecutionSessionManager(undefined, { clock: time.clock, ownership });
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
