import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  encodeSupervisorInit,
  SupervisorChild,
  type SupervisorProcess,
} from "#src/execution/session-supervisor.ts";

function transport() {
  const killed: string[] = [];
  const raw = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill(signal: string) {
      killed.push(signal);
    },
    unref() {},
  });
  const child = new SupervisorChild(raw as unknown as SupervisorProcess);
  const errors: Error[] = [];
  child.on("error", (error) => errors.push(error));
  const send = (frame: unknown) => raw.stdout.emit("data", `${JSON.stringify(frame)}\n`);
  return { raw, child, errors, killed, send };
}

test("supervisor decoder separates output, status and backpressure from its controller protocol", () => {
  const t = transport();
  const payload = Buffer.alloc(40000, "x").toString("base64");
  t.send({ version: 1, type: "stdout", data: payload });
  t.send({ version: 1, type: "stdout", data: payload });
  t.send({ version: 1, type: "stdout", data: payload });
  expect(t.raw.stdout.isPaused()).toBe(true);
  t.child.stdout.emit("drain");
  expect(t.raw.stdout.isPaused()).toBe(false);
  t.raw.stderr.emit("data", Buffer.alloc(80000));
  expect(t.raw.stderr.isPaused()).toBe(true);
  t.child.stderr.emit("drain");
  expect(t.raw.stderr.isPaused()).toBe(false);
  t.send({ version: 1, type: "status", status: "exited", exit_code: 3, signal: null });
  expect(t.child.commandState).toEqual({ status: "exited", exitCode: 3, signal: null });
  t.send({ version: 1, type: "status", status: "exited", exit_code: null, signal: "SIGTERM" });
  expect(t.child.commandState.signal).toBe("SIGTERM");
  t.raw.emit("exit", 3, null);
  t.raw.emit("close", 3, null);
  t.child.unref();
  t.raw.emit("error", new Error("launch error"));
  expect(t.errors[0]?.message).toBe("launch error");
  expect(t.child.exitCode).toBe(3);
  expect(t.killed).toEqual([]);
});

test("supervisor decoder rejects malformed, oversized and untrusted control frames", async () => {
  for (const frame of [
    "\n",
    "x".repeat(65537),
    `${"x".repeat(65537)}\n`,
    "not-json\n",
    JSON.stringify({ version: 2, type: "status" }) + "\n",
    JSON.stringify({ version: 1, type: "stdout", data: "not-base64" }) + "\n",
    JSON.stringify({ version: 1, type: "error", message: "bootstrap failure" }) + "\n",
  ]) {
    const t = transport();
    t.raw.stdout.emit("data", Buffer.from(frame));
    await Promise.resolve();
    expect(t.errors).toHaveLength(1);
    expect(t.killed).toEqual(["SIGKILL"]);
    t.raw.stdout.emit("data", "ignored\n");
    expect(t.killed).toHaveLength(1);
  }
});

test("supervisor initialization enforces its byte bound and failed delivery closes the boundary", async () => {
  const init = {
    version: 1 as const,
    type: "init" as const,
    file: "sh",
    args: [],
    cwd: "/",
    env: {},
  };
  expect(() => encodeSupervisorInit({ ...init, file: "x".repeat(512 * 1024) })).toThrow(
    "protocol limit",
  );
  const t = transport();
  t.raw.stdin.write = ((_text: string, callback: (error: Error) => void) => {
    callback(new Error("closed pipe"));
    return false;
  }) as typeof t.raw.stdin.write;
  t.child.sendInit(init);
  await Promise.resolve();
  expect(t.errors[0]?.message).toContain("initialization failed");
  expect(t.killed).toEqual(["SIGKILL"]);
});
