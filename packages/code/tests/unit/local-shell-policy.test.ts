import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import {
  runLocalBash,
  type LocalBashDependencies,
  type LocalShellChild,
} from "#src/adapters/local-shell.ts";

function rig() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: [] as NodeJS.Signals[],
    kill(signal: NodeJS.Signals) {
      this.signals.push(signal);
      return true;
    },
  });
  const invocations: Array<{ file: string; args: string[]; detached: boolean }> = [];
  const deps: LocalBashDependencies = {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = ++nextId;
        tasks.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(handle) {
        tasks.delete(handle as number);
      },
    },
    resolveShell: () => ({ file: "sh", flavor: "posix" }),
    ownProcessGroup: () => false,
    killTree: () => false,
    spawn: ((file: string, args: string[], options: { detached?: boolean }) => {
      invocations.push({ file, args, detached: options.detached ?? false });
      return child as LocalShellChild;
    }) as LocalBashDependencies["spawn"],
  };
  const advance = (ms: number) => {
    const end = now + ms;
    while (true) {
      const first = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (first === undefined || first[1].at > end) break;
      now = first[1].at;
      tasks.delete(first[0]);
      first[1].fn();
    }
    now = end;
  };
  return { child, deps, advance, pending: () => tasks.size, invocations };
}

test("local shell keeps Bash and times out without a physical child", async () => {
  const r = rig();
  const pending = runLocalBash("[[ x == x ]]", { cwd: "/virtual", timeoutMs: 100 }, r.deps);
  expect(r.invocations[0]).toMatchObject({ file: "bash", detached: false });
  r.advance(99);
  expect(r.child.signals).toEqual([]);
  r.advance(1);
  expect(r.child.signals).toEqual(["SIGTERM"]);
  r.advance(1500);
  expect(r.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  r.child.emit("close", null, "SIGKILL");
  expect(await pending).toMatchObject({ timedOut: true, durationMs: 1600 });
  expect(r.pending()).toBe(0);
});

test("exit waits for pipe close or the unchanged drain deadline", async () => {
  const r = rig();
  const pending = runLocalBash("printf x", { cwd: "/virtual" }, r.deps);
  r.child.stdout.write(Buffer.from("\u001b[31m é\u001b[0m"));
  r.child.stderr.write(Buffer.from("warning"));
  r.child.emit("exit", 4, null);
  r.advance(999);
  expect(r.pending()).toBe(2);
  r.advance(1);
  expect(await pending).toMatchObject({ exitCode: 4, stdout: " é", stderr: "warning" });
  expect(r.pending()).toBe(0);
});

test("close before timeout cancels escalation and preserves bounded output", async () => {
  const r = rig();
  const pending = runLocalBash("output", { cwd: "/virtual", maxBytes: 2 }, r.deps);
  r.child.stdout.write(Buffer.from("abc"));
  r.child.emit("close", 0, null);
  expect(await pending).toMatchObject({ stdout: "ab", stdoutTruncated: true, timedOut: false });
  r.advance(200000);
  expect(r.child.signals).toEqual([]);
  expect(r.pending()).toBe(0);
});

test("abort requests termination once and reports cancellation", async () => {
  const r = rig();
  const controller = new AbortController();
  const pending = runLocalBash("long task", { cwd: "/virtual", signal: controller.signal }, r.deps);
  controller.abort();
  expect(r.child.signals).toEqual(["SIGTERM"]);
  r.child.emit("close", null, "SIGTERM");
  expect(await pending).toMatchObject({ cancelled: true, timedOut: false });
  r.advance(200000);
  expect(r.child.signals).toEqual(["SIGTERM"]);
  expect(r.pending()).toBe(0);
});

test("asynchronous spawn error settles through the owned scheduler", async () => {
  const r = rig();
  const pending = runLocalBash("missing", { cwd: "/virtual" }, r.deps);
  r.child.emit("error", new Error("spawn refused"));
  r.advance(0);
  expect(await pending).toMatchObject({ exitCode: null, stderr: "spawn refused" });
  expect(r.pending()).toBe(0);
});
