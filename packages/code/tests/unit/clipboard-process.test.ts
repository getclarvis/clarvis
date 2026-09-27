import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, mock, test } from "bun:test";
import { runClipboardProcess, type ClipboardChild } from "#src/adapters/clipboard-process.ts";

type FakeChild = ClipboardChild &
  EventEmitter & {
    signals: NodeJS.Signals[];
  };

function fakeChild(closeOnSignal?: NodeJS.Signals): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: [] as NodeJS.Signals[],
  });
  Object.defineProperty(child, "pid", { value: 4321, configurable: true });
  child.kill = mock((signal: NodeJS.Signals = "SIGTERM") => {
    child.signals.push(signal);
    if (signal === closeOnSignal) queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  return child;
}

function manualTimers() {
  let now = 0;
  let id = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const handle = ++id;
        tasks.set(handle, { at: now + ms, fn });
        return { handle };
      },
      clearTimeout(handle: { handle: number }) {
        tasks.delete(handle.handle);
      },
    },
    advance(ms: number) {
      now += ms;
      while (true) {
        const due = [...tasks].find(([, task]) => task.at <= now);
        if (due === undefined) break;
        tasks.delete(due[0]);
        due[1].fn();
      }
    },
    pending: () => tasks.size,
  };
}

test("a hung clipboard helper receives TERM at timeout and KILL after grace", async () => {
  const child = fakeChild("SIGKILL");
  const spawn = mock(() => child);
  const time = manualTimers();

  const pending = runClipboardProcess(
    { command: "hung-clipboard", args: [], timeoutMs: 10 },
    {
      spawn,
      killTree: () => false,
      ownProcessGroup: () => false,
      killGraceMs: 5,
      timers: time.timers,
    },
  );
  time.advance(9);
  expect(child.signals).toEqual([]);
  time.advance(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  time.advance(5);
  const result = await pending;
  expect(result.timedOut).toBe(true);
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(time.pending()).toBe(0);
});

test("abort terminates an in-flight helper and reports cancellation", async () => {
  const child = fakeChild("SIGTERM");
  const controller = new AbortController();
  const pending = runClipboardProcess(
    { command: "clipboard", args: [], signal: controller.signal },
    {
      spawn: () => child,
      killTree: () => false,
      ownProcessGroup: () => false,
      killGraceMs: 5,
    },
  );
  controller.abort("shutdown");
  const result = await pending;
  expect(result.cancelled).toBe(true);
  expect(child.signals).toEqual(["SIGTERM"]);
});

test("oversized binary output is capped and terminates the helper", async () => {
  const child = fakeChild("SIGTERM");
  const pending = runClipboardProcess(
    { command: "clipboard", args: [], maxStdoutBytes: 8 },
    {
      spawn: () => child,
      killTree: () => false,
      ownProcessGroup: () => false,
      killGraceMs: 5,
    },
  );
  (child.stdout as PassThrough).write(Buffer.alloc(12, 1));
  const result = await pending;
  expect(result.outputExceeded).toBe(true);
  expect(result.stdout).toHaveLength(8);
  expect(child.signals).toEqual(["SIGTERM"]);
});

test("stdin and binary stdout round-trip without string conversion", async () => {
  const child = fakeChild();
  const stdin: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer) => stdin.push(chunk));
  const pending = runClipboardProcess(
    { command: "clipboard", args: ["--png"], stdin: "olá" },
    { spawn: () => child, ownProcessGroup: () => false },
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  (child.stdout as PassThrough).write(png);
  child.emit("close", 0, null);
  const result = await pending;
  expect(Buffer.concat(stdin).toString("utf8")).toBe("olá");
  expect(result.stdout).toEqual(png);
  expect(result.exitCode).toBe(0);
});

test("a synchronous spawn failure is returned as a normalized process error", async () => {
  const result = await runClipboardProcess(
    { command: "missing-clipboard", args: [] },
    {
      spawn: () => {
        throw "spawn refused";
      },
      ownProcessGroup: () => false,
    },
  );
  expect(result).toMatchObject({
    exitCode: null,
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    error: new Error("spawn refused"),
  });
  expect(result.stdout).toHaveLength(0);
});

test("stderr is bounded and a child error settles the helper", async () => {
  const child = fakeChild();
  const pending = runClipboardProcess(
    { command: "clipboard", args: [] },
    { spawn: () => child, ownProcessGroup: () => false },
  );
  (child.stderr as PassThrough).emit("data", "failure detail");
  child.emit("error", new Error("helper failed"));
  const result = await pending;
  expect(result.stderr).toBe("failure detail");
  expect(result.error?.message).toBe("helper failed");
  expect(result.exitCode).toBeNull();
});
