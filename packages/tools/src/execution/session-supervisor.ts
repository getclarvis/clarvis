import { constants as osConstants } from "node:os";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { SessionChild } from "../lib/execution-session.ts";

export const SESSION_SUPERVISOR_PROTOCOL_VERSION = 1;
export const MAX_SESSION_SUPERVISOR_FRAME_BYTES = 64 * 1024;
const MAX_SESSION_SUPERVISOR_INIT_BYTES = 512 * 1024;
const MAX_SESSION_SUPERVISOR_OUTPUT_BYTES = 32 * 1024;

export type SupervisorProcess = ChildProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

export type SupervisorCommandStatus = "starting" | "running" | "exited";

export interface SupervisorLaunchInit {
  readonly version: typeof SESSION_SUPERVISOR_PROTOCOL_VERSION;
  readonly type: "init";
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface SupervisorState {
  status: SupervisorCommandStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

type SupervisorFrame =
  | { readonly version: number; readonly type: "stdout" | "stderr"; readonly data: string }
  | {
      readonly version: number;
      readonly type: "status";
      readonly status: SupervisorCommandStatus;
      readonly exit_code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly version: number; readonly type: "error"; readonly message: string };

const SUPERVISOR_PATH = fileURLToPath(new URL("./session-supervisor.ts", import.meta.url));

/** Return the source file launched inside the retained Sandbox boundary. */
export function sessionSupervisorPath(): string {
  return SUPERVISOR_PATH;
}

/** Verify the installed supervisor against the tools asset manifest before launch. */
export function verifySessionSupervisorSource(path = SUPERVISOR_PATH): void {
  const manifestPath = resolve(dirname(path), "../..", "assets", "worker.manifest.json");
  if (!existsSync(path) || !existsSync(manifestPath))
    throw new Error("supervisor asset unavailable");
  let manifest: {
    format?: number;
    protocol?: number;
    os?: string;
    architecture?: string;
    assets?: Record<string, { path: string; sha256: string }>;
  };
  try {
    const encoded = readFileSync(manifestPath);
    if (encoded.byteLength > 16 * 1024) throw new Error("manifest too large");
    manifest = JSON.parse(encoded.toString("utf8")) as typeof manifest;
    if (!lstatSync(manifestPath).isFile() || typeof manifest !== "object" || manifest === null) {
      throw new Error("manifest is not an object file");
    }
  } catch {
    throw new Error("supervisor manifest is invalid");
  }
  const asset = manifest.assets?.["session-supervisor.ts"];
  if (
    manifest.format !== 1 ||
    manifest.protocol !== 1 ||
    manifest.os !== process.platform ||
    manifest.architecture !== process.arch ||
    basename(path) !== "session-supervisor.ts" ||
    !asset ||
    asset.path !== "session-supervisor.ts" ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  ) {
    throw new Error("supervisor manifest is incompatible");
  }
  let actual: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error("supervisor is not a regular file");
    actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    throw new Error("supervisor source cannot be verified");
  }
  if (actual !== asset.sha256) throw new Error("supervisor source hash mismatch");
}

/** Encode the one bootstrap frame sent before the manager keeps stdin open. */
export function encodeSupervisorInit(init: SupervisorLaunchInit): string {
  const frame = JSON.stringify(init);
  if (Buffer.byteLength(frame, "utf8") > MAX_SESSION_SUPERVISOR_INIT_BYTES) {
    throw new Error("supervisor initialization exceeds protocol limit");
  }
  return `${frame}\n`;
}

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && value in osConstants.signals;
}

function decodePayload(data: unknown): Buffer | undefined {
  if (typeof data !== "string" || data.length > MAX_SESSION_SUPERVISOR_FRAME_BYTES)
    return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    return undefined;
  const decoded = Buffer.from(data, "base64");
  return decoded.toString("base64") === data ? decoded : undefined;
}

function validStatus(frame: Record<string, unknown>): frame is {
  version: number;
  type: "status";
  status: SupervisorCommandStatus;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
} {
  return (
    frame.version === SESSION_SUPERVISOR_PROTOCOL_VERSION &&
    frame.type === "status" &&
    (frame.status === "starting" || frame.status === "running" || frame.status === "exited") &&
    (frame.exit_code === null || Number.isSafeInteger(frame.exit_code)) &&
    (frame.signal === null || isSignal(frame.signal))
  );
}

function validFrame(value: unknown): value is SupervisorFrame {
  if (typeof value !== "object" || value === null || !("version" in value) || !("type" in value)) {
    return false;
  }
  const frame = value as Record<string, unknown>;
  if (frame.version !== SESSION_SUPERVISOR_PROTOCOL_VERSION) return false;
  if (frame.type === "stdout" || frame.type === "stderr")
    return decodePayload(frame.data) !== undefined;
  if (frame.type === "error")
    return typeof frame.message === "string" && frame.message.length <= 1024;
  return validStatus(frame);
}

/** A protocol-decoding child that exposes only command payload streams to LiveSession. */
export class SupervisorChild extends EventEmitter implements SessionChild {
  readonly pid: number | undefined;
  readonly stdout = new PassThrough({ highWaterMark: MAX_SESSION_SUPERVISOR_OUTPUT_BYTES * 2 });
  readonly stderr = new PassThrough({ highWaterMark: MAX_SESSION_SUPERVISOR_OUTPUT_BYTES * 2 });
  readonly commandState: SupervisorState = { status: "starting", exitCode: null, signal: null };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private protocolBuffer = "";
  private protocolFailed = false;

  constructor(private readonly child: SupervisorProcess) {
    super();
    this.pid = child.pid;
    child.stdout.on("data", (chunk: Buffer | string) => this.onProtocolData(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!this.stderr.write(chunk)) child.stderr.pause();
    });
    this.stderr.on("drain", () => child.stderr.resume());
    child.once("spawn", () => this.emit("spawn"));
    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit("exit", code, signal);
    });
    child.on("close", (code, signal) => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", code, signal);
    });
  }

  sendInit(init: SupervisorLaunchInit): void {
    const frame = encodeSupervisorInit(init);
    this.child.stdin.write(frame, (error) => {
      if (error) this.failProtocol("supervisor initialization failed");
    });
  }

  unref(): void {
    this.child.unref();
  }

  private onProtocolData(chunk: Buffer | string): void {
    if (this.protocolFailed) return;
    this.protocolBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = this.protocolBuffer.indexOf("\n");
    if (
      newline < 0 &&
      Buffer.byteLength(this.protocolBuffer, "utf8") > MAX_SESSION_SUPERVISOR_FRAME_BYTES
    ) {
      this.failProtocol("supervisor frame exceeds protocol limit");
      return;
    }
    while (newline >= 0) {
      const line = this.protocolBuffer.slice(0, newline);
      this.protocolBuffer = this.protocolBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_SESSION_SUPERVISOR_FRAME_BYTES) {
        this.failProtocol("supervisor frame exceeds protocol limit");
        return;
      }
      if (!line) {
        this.failProtocol("supervisor emitted an empty frame");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failProtocol("supervisor emitted invalid framing");
        return;
      }
      if (!validFrame(parsed)) {
        this.failProtocol("supervisor emitted an invalid frame");
        return;
      }
      this.accept(parsed);
      if (this.protocolFailed) return;
      newline = this.protocolBuffer.indexOf("\n");
      if (
        newline < 0 &&
        Buffer.byteLength(this.protocolBuffer, "utf8") > MAX_SESSION_SUPERVISOR_FRAME_BYTES
      ) {
        this.failProtocol("supervisor frame exceeds protocol limit");
        return;
      }
    }
  }

  private accept(frame: SupervisorFrame): void {
    if (frame.type === "stdout" || frame.type === "stderr") {
      const payload = decodePayload(frame.data);
      if (!payload) return this.failProtocol("supervisor emitted invalid output payload");
      const stream = frame.type === "stdout" ? this.stdout : this.stderr;
      if (!stream.write(payload)) {
        this.child.stdout.pause();
        stream.once("drain", () => this.child.stdout.resume());
      }
      return;
    }
    if (frame.type === "status") {
      this.commandState.status = frame.status;
      this.commandState.exitCode = frame.exit_code;
      this.commandState.signal = frame.signal;
      return;
    }
    if (frame.type === "error") {
      this.stderr.write(`${frame.message}\n`);
      this.failProtocol("supervisor reported a bootstrap failure");
    } else {
      this.failProtocol("supervisor emitted an unknown frame");
    }
  }

  private failProtocol(message: string): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    queueMicrotask(() => this.emit("error", new Error(message)));
    this.child.kill("SIGKILL");
  }
}

function frame(type: "stdout" | "stderr", data: Buffer): string {
  return JSON.stringify({
    version: SESSION_SUPERVISOR_PROTOCOL_VERSION,
    type,
    data: data.toString("base64"),
  });
}

function status(state: SupervisorState): string {
  return JSON.stringify({
    version: SESSION_SUPERVISOR_PROTOCOL_VERSION,
    type: "status",
    status: state.status,
    exit_code: state.exitCode,
    signal: state.signal,
  });
}

/** Serialized protocol transport supplied by the supervisor entrypoint. */
export interface SupervisorWriter {
  write(text: string): unknown;
  flush(): unknown;
}

/** Explicit supervisor effects, also usable by in-process protocol qualification. */
export interface SupervisorRuntime {
  input: Readable;
  output: SupervisorWriter;
  error: SupervisorWriter;
  spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

async function writeFrame(encoded: string, writer: SupervisorWriter): Promise<void> {
  if (Buffer.byteLength(encoded, "utf8") > MAX_SESSION_SUPERVISOR_FRAME_BYTES) {
    throw new Error("supervisor output frame exceeds protocol limit");
  }
  await writer.write(`${encoded}\n`);
  await writer.flush();
}

function queueWriter(writer: SupervisorWriter): (encoded: string) => Promise<void> {
  let tail = Promise.resolve();
  return (encoded) => {
    const current = tail.then(() => writeFrame(encoded, writer));
    tail = current.catch(() => undefined);
    return current;
  };
}

async function streamOutput(
  stream: Readable,
  type: "stdout" | "stderr",
  send: (encoded: string) => Promise<void>,
): Promise<void> {
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    for (let offset = 0; offset < bytes.length; offset += MAX_SESSION_SUPERVISOR_OUTPUT_BYTES) {
      await send(frame(type, bytes.subarray(offset, offset + MAX_SESSION_SUPERVISOR_OUTPUT_BYTES)));
    }
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0);
}

async function readInit(input: Readable): Promise<SupervisorLaunchInit> {
  return new Promise((resolveInit, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_SESSION_SUPERVISOR_INIT_BYTES) {
        reject(new Error("supervisor initialization exceeds protocol limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      input.off("data", onData);
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        reject(new Error("supervisor initialization is invalid"));
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== SESSION_SUPERVISOR_PROTOCOL_VERSION ||
        (parsed as { type?: unknown }).type !== "init" ||
        typeof (parsed as { file?: unknown }).file !== "string" ||
        !Array.isArray((parsed as { args?: unknown }).args) ||
        !(parsed as { args: unknown[] }).args.every((arg) => typeof arg === "string") ||
        typeof (parsed as { cwd?: unknown }).cwd !== "string" ||
        typeof (parsed as { env?: unknown }).env !== "object" ||
        (parsed as { env?: unknown }).env === null
      ) {
        reject(new Error("supervisor initialization is malformed"));
        return;
      }
      resolveInit(parsed as SupervisorLaunchInit);
    };
    input.on("data", onData);
    input.once("end", () => reject(new Error("supervisor lease closed before initialization")));
    input.resume();
  });
}

async function waitForLease(input: Readable): Promise<void> {
  if (input.destroyed || input.readableEnded) return;
  await new Promise<void>((resolveLease) => {
    const done = () => {
      input.off("end", done);
      input.off("close", done);
      resolveLease();
    };
    input.once("end", done);
    input.once("close", done);
  });
}

async function runSupervisor(
  init: SupervisorLaunchInit,
  runtime: SupervisorRuntime,
): Promise<number> {
  const send = queueWriter(runtime.output);
  const state: SupervisorState = { status: "starting", exitCode: null, signal: null };
  await send(status(state));
  let child: SupervisorProcess;
  try {
    child = (runtime.spawn ?? spawn)(init.file, [...init.args], {
      cwd: init.cwd,
      env: { ...init.env },
      stdio: ["ignore", "pipe", "pipe"],
    }) as SupervisorProcess;
  } catch {
    await send(
      JSON.stringify({
        version: SESSION_SUPERVISOR_PROTOCOL_VERSION,
        type: "error",
        message: "command spawn failed",
      }),
    );
    return 1;
  }
  const stdoutDone = streamOutput(child.stdout, "stdout", send);
  const stderrDone = streamOutput(child.stderr, "stderr", send);
  let commandError = false;
  const closed = new Promise<void>((resolveChild) => {
    child.once("spawn", () => {
      state.status = "running";
      void send(status(state)).catch(() => undefined);
    });
    child.once("close", (code, signal) => {
      state.status = "exited";
      state.exitCode = code;
      state.signal = signal;
      resolveChild();
    });
    child.once("error", () => {
      commandError = true;
      state.status = "exited";
      state.exitCode = 1;
      resolveChild();
    });
  });
  try {
    await Promise.all([closed, stdoutDone, stderrDone]);
  } catch (error) {
    child.kill("SIGKILL");
    runtime.input.destroy();
    throw error;
  }
  if (commandError) {
    await send(
      JSON.stringify({
        version: SESSION_SUPERVISOR_PROTOCOL_VERSION,
        type: "error",
        message: "command spawn failed",
      }),
    );
  }
  await send(status(state));
  if (state.exitCode !== 0 || state.signal !== null) {
    runtime.input.destroy();
    return state.exitCode ?? signalExitCode(state.signal);
  }
  await waitForLease(runtime.input);
  return 0;
}

/** Run one bootstrap/command/lease exchange without mutating the caller's process. */
export async function runSessionSupervisor(runtime: SupervisorRuntime): Promise<number> {
  try {
    return await runSupervisor(await readInit(runtime.input), runtime);
  } catch (error) {
    await runtime.error.write(
      `${error instanceof Error ? error.message : "supervisor bootstrap failed"}\n`,
    );
    await runtime.error.flush();
    runtime.input.destroy();
    return 64;
  }
}

if (import.meta.main)
  void runSessionSupervisor({
    input: process.stdin,
    output: Bun.stdout.writer(),
    error: Bun.stderr.writer(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 64;
      process.stdin.destroy();
    },
  );
