import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  sessionSupervisorPath,
  SupervisorChild,
  type SupervisorProcess,
  verifySessionSupervisorSource,
  runSessionSupervisor,
  encodeSupervisorInit,
} from "#src/execution/session-supervisor.ts";

interface RawFrame {
  version: number;
  type: string;
  data?: string;
  message?: string;
  status?: string;
  exit_code?: number | null;
  signal?: string | null;
}

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  }
});

function inProcessSupervisor(source: string, releaseOnExit = true, failOutput = false) {
  const input = new PassThrough();
  const frames: RawFrame[] = [];
  let stderr = "";
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const done = runSessionSupervisor({
    input,
    output: {
      write(text) {
        const frame = JSON.parse(text) as RawFrame;
        if (failOutput && frame.type === "stdout") throw new Error("controller output failed");
        frames.push(frame);
        if (frame.type === "status" && frame.status === "exited") {
          markExited();
          if (releaseOnExit) input.end();
        }
      },
      flush() {},
    },
    error: {
      write: (text) => {
        stderr += text;
      },
      flush() {},
    },
    spawn(file, args, options) {
      const child = spawn(file, args, options) as ChildProcessWithoutNullStreams;
      children.push(child);
      return child;
    },
  });
  input.write(
    encodeSupervisorInit({
      version: 1,
      type: "init",
      file: process.execPath,
      args: ["-e", source],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    }),
  );
  return { done, input, frames, exited, stderr: () => stderr };
}

test("supervisor transport drains framed output before final status and accepts an early lease close", async () => {
  const run = inProcessSupervisor(
    "process.stdout.write('x'.repeat(100000)); process.stderr.write('diagnostic');",
  );
  expect(await run.done).toBe(0);
  const outputs = run.frames.filter((frame) => frame.type === "stdout");
  expect(outputs.map((frame) => Buffer.from(frame.data!, "base64").toString()).join("")).toBe(
    "x".repeat(100000),
  );
  expect(run.frames.at(-1)).toMatchObject({ type: "status", status: "exited", exit_code: 0 });
  expect(run.stderr()).toBe("");
  const early = inProcessSupervisor("process.stdout.write('done');", false);
  early.input.end();
  expect(await early.done).toBe(0);
});

test("supervisor transport reports command failure and signal status without retaining the lease", async () => {
  const failed = inProcessSupervisor("process.exit(7)", false);
  expect(await failed.done).toBe(7);
  expect(failed.input.destroyed).toBe(true);
  expect(failed.frames.at(-1)).toMatchObject({ type: "status", status: "exited", exit_code: 7 });
  if (process.platform !== "win32") {
    const signalled = inProcessSupervisor("process.kill(process.pid, 'SIGTERM')", false);
    expect(await signalled.done).toBe(143);
    expect(signalled.frames.at(-1)).toMatchObject({ signal: "SIGTERM" });
  }
});

test("supervisor transport retains a successful command until its controller closes the lease", async () => {
  const run = inProcessSupervisor("process.stdout.write('READY')", false);
  let settled = false;
  void run.done.then(() => {
    settled = true;
  });
  await run.exited;
  for (let turn = 0; turn < 20 && run.input.listenerCount("close") === 0; turn++)
    await Promise.resolve();
  expect(run.input.listenerCount("close")).toBeGreaterThan(0);
  expect(settled).toBe(false);
  run.input.end();
  expect(await run.done).toBe(0);
  expect(run.input.listenerCount("close")).toBe(0);
});

test("supervisor transport rejects invalid bootstrap before spawning", async () => {
  for (const frame of ["not-json\n", "{}\n", "x".repeat(512 * 1024 + 1), ""]) {
    const input = new PassThrough();
    let diagnostic = "";
    let spawned = false;
    const done = runSessionSupervisor({
      input,
      output: { write() {}, flush() {} },
      error: {
        write(text) {
          diagnostic += text;
        },
        flush() {},
      },
      spawn() {
        spawned = true;
        throw new Error("must not spawn");
      },
    });
    input.end(frame);
    expect(await done).toBe(64);
    expect(spawned).toBe(false);
    expect(diagnostic).toContain("supervisor");
  }
});

test("supervisor transport reports refused spawn and protocol writer failures", async () => {
  for (const failWrite of [false, true]) {
    const input = new PassThrough();
    const frames: RawFrame[] = [];
    let diagnostic = "";
    const done = runSessionSupervisor({
      input,
      output: {
        write(text) {
          if (failWrite) throw new Error("controller pipe closed");
          frames.push(JSON.parse(text));
        },
        flush() {},
      },
      error: {
        write(text) {
          diagnostic += text;
        },
        flush() {},
      },
      spawn() {
        throw new Error("spawn refused");
      },
    });
    input.write(
      encodeSupervisorInit({
        version: 1,
        type: "init",
        file: "test",
        args: [],
        cwd: "test",
        env: {},
      }),
    );
    expect(await done).toBe(failWrite ? 64 : 1);
    if (failWrite) expect(diagnostic).toContain("controller pipe closed");
    else expect(frames.at(-1)).toMatchObject({ type: "error", message: "command spawn failed" });
    input.destroy();
  }
});

test("supervisor asset verification accepts the manifest and rejects source tampering", () => {
  verifySessionSupervisorSource();
  const root = mkdtempSync(join(tmpdir(), "clarvis-supervisor-asset-"));
  const source = join(root, "src", "execution", "session-supervisor.ts");
  const assets = join(root, "assets");
  try {
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(assets);
    const bytes = readFileSync(sessionSupervisorPath());
    writeFileSync(source, bytes);
    writeFileSync(
      join(assets, "worker.manifest.json"),
      JSON.stringify({
        format: 1,
        protocol: 1,
        os: process.platform,
        architecture: process.arch,
        assets: {
          "session-supervisor.ts": {
            path: "session-supervisor.ts",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      }),
    );
    verifySessionSupervisorSource(source);
    writeFileSync(source, "tampered");
    expect(() => verifySessionSupervisorSource(source)).toThrow("hash mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function helper(): {
  child: ChildProcessWithoutNullStreams;
  frames: RawFrame[];
  waitFor(predicate: (frame: RawFrame) => boolean): Promise<RawFrame>;
} {
  const child = spawn(process.execPath, [sessionSupervisorPath()], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const frames: RawFrame[] = [];
  const waiters: { predicate: (frame: RawFrame) => boolean; resolve: (frame: RawFrame) => void }[] =
    [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)) as RawFrame;
      buffer = buffer.slice(newline + 1);
      frames.push(frame);
      for (let index = waiters.length - 1; index >= 0; index--) {
        if (waiters[index]!.predicate(frame)) {
          waiters[index]!.resolve(frame);
          waiters.splice(index, 1);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  return {
    child,
    frames,
    waitFor(predicate) {
      const found = frames.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

function sendInit(child: ChildProcessWithoutNullStreams, file: string, args: string[]): void {
  child.stdin.write(
    `${JSON.stringify({
      version: 1,
      type: "init",
      file: process.execPath,
      args,
      cwd: process.cwd(),
      env: { ...process.env },
    })}\n`,
  );
}

test("supervisor frames command output separately from status, including output that resembles control", async () => {
  const running = helper();
  sendInit(running.child, process.execPath, [
    "-e",
    "process.stdout.write('payload'); process.stderr.write('warning')",
  ]);
  await running.waitFor((frame) => frame.type === "status" && frame.status === "exited");
  const stdout = running.frames
    .filter((frame) => frame.type === "stdout")
    .map((frame) => Buffer.from(frame.data!, "base64").toString("utf8"))
    .join("");
  const stderr = running.frames
    .filter((frame) => frame.type === "stderr")
    .map((frame) => Buffer.from(frame.data!, "base64").toString("utf8"))
    .join("");
  expect(stdout).toBe("payload");
  expect(stderr).toBe("warning");
  running.child.stdin.end();
  await new Promise<void>((resolve) => running.child.once("close", () => resolve()));

  const imitation = helper();
  const fakeStatus = JSON.stringify({ version: 1, type: "status", status: "exited" });
  sendInit(imitation.child, process.execPath, [
    "-e",
    `process.stdout.write(${JSON.stringify(fakeStatus)})`,
  ]);
  await imitation.waitFor((frame) => frame.type === "status" && frame.status === "exited");
  expect(
    imitation.frames
      .filter((frame) => frame.type === "stdout")
      .map((frame) => Buffer.from(frame.data!, "base64").toString("utf8"))
      .join(""),
  ).toBe(fakeStatus);
  imitation.child.stdin.end();
  await new Promise<void>((resolve) => imitation.child.once("close", () => resolve()));
});

test("supervisor does not retain failed initializers and rejects EOF or malformed bootstrap", async () => {
  const failed = helper();
  sendInit(failed.child, process.execPath, ["-e", "process.exit(7)"]);
  const failedExit = await new Promise<{ code: number | null }>((resolve) =>
    failed.child.once("close", (code) => resolve({ code })),
  );
  expect(failedExit.code).toBe(7);
  expect(failed.frames).toContainEqual(
    expect.objectContaining({ type: "status", status: "exited", exit_code: 7 }),
  );

  const malformed = helper();
  malformed.child.stdin.write("not-json\n");
  const malformedExit = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    malformed.child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    malformed.child.once("close", (code) => resolve({ code, stderr }));
  });
  expect(malformedExit.code).toBe(64);
  expect(malformedExit.stderr).toContain("invalid");

  const eof = helper();
  eof.child.stdin.end();
  expect(await new Promise<number | null>((resolve) => eof.child.once("close", resolve))).toBe(64);
});

test("manager rejects invalid supervisor framing instead of treating it as output", async () => {
  const raw = spawn(process.execPath, ["-e", "process.stdout.write('invalid\\n')"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(raw);
  const adapted = new SupervisorChild(raw as unknown as SupervisorProcess);
  const error = await new Promise<Error>((resolve) => adapted.once("error", resolve));
  expect(error.message).toContain("framing");
});

test("supervisor transport handles asynchronous spawn failure", async () => {
  const input = new PassThrough();
  const frames: RawFrame[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
  const done = runSessionSupervisor({
    input,
    output: {
      write(text) {
        frames.push(JSON.parse(text));
      },
      flush() {},
    },
    error: { write() {}, flush() {} },
    spawn() {
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
        child.stdout.end();
        child.stderr.end();
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  input.write(
    encodeSupervisorInit({
      version: 1,
      type: "init",
      file: "test",
      args: [],
      cwd: "test",
      env: {},
    }),
  );
  expect(await done).toBe(1);
  expect(frames).toContainEqual({ version: 1, type: "error", message: "command spawn failed" });
  expect(input.destroyed).toBe(true);
});

test("supervisor transport terminates the initializer when protocol output fails", async () => {
  const run = inProcessSupervisor(
    "process.stdout.write('payload'); setInterval(() => {}, 1000)",
    false,
    true,
  );
  expect(await run.done).toBe(64);
  expect(run.stderr()).toContain("controller output failed");
  expect(run.input.destroyed).toBe(true);
});
