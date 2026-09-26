import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isIsolationSetupError,
  ToolIsolationSetupError,
  type ToolIsolationPolicy,
  type ToolIsolationBackend,
} from "./isolation-port.ts";
import { ToolError, ERROR_CODES, type ErrorCode } from "../errors.ts";
import type { RuntimeConfig } from "../config.ts";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "../lib/log.ts";
import { stopOwnedProcess } from "../lib/process-owner.ts";
import type { ToolResult } from "../tools/content.ts";
import type { ToolExecutionPort } from "./port.ts";
import { resultDiagnostic } from "./diagnostics.ts";
import { canonicalTarget } from "./canonical-target.ts";
import {
  MAX_WORKER_FRAME_BYTES,
  WORKER_PROTOCOL_VERSION,
  type WorkerConfigDto,
  type WorkerResult,
} from "./worker-protocol.ts";

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
/** Installation root needed by a host-issued sandbox policy. */
export const sandboxWorkerRoot = resolve(dirname(DEFAULT_WORKER_PATH), "../..");

function sandboxResult(
  result: string | ToolResult,
  toolName: string,
  backend: "bubblewrap" | "seatbelt",
  policyId: string,
): ToolResult {
  const structured = typeof result === "string" ? { content: result } : result;
  return {
    ...structured,
    meta: {
      ...structured.meta,
      execution_mode: "sandbox",
      execution_backend: backend,
      policy_id: policyId,
      execution_started: true,
      execution_diagnostic: resultDiagnostic(result, toolName, "sandbox", backend, policyId),
    },
  };
}

function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

/** Classify only OS permission failures that also match an explicit policy boundary. */
function policyDenied(
  error: unknown,
  policy: ToolIsolationPolicy,
  backend: ToolIsolationBackend["name"],
): ToolError | undefined {
  if (!(error instanceof ToolError) || error.code !== "io_error") return undefined;
  if (!["EACCES", "EPERM", "EROFS"].includes(String(error.fields.errno_code))) return undefined;
  const path = error.fields.path;
  if (typeof path !== "string") return undefined;
  const target = canonicalTarget(
    isAbsolute(path) ? resolve(path) : resolve(policy.workspaceRoot, path),
  );
  if (!target) return undefined;
  const explicitDeny = policy.denies.some((deny) => {
    const canonicalDeny = canonicalTarget(deny);
    return canonicalDeny !== undefined && within(target, canonicalDeny);
  });
  const readonlyWorkspace =
    policy.workspaceAccess === "read-only" &&
    within(target, policy.workspaceRoot) &&
    (error.fields.errno_code === "EROFS" ||
      (backend === "seatbelt" && error.fields.errno_code === "EPERM"));
  if (!explicitDeny && !readonlyWorkspace) return undefined;
  return new ToolError("sandbox_denied", "Native policy denied filesystem access", {
    ...error.fields,
    execution_mode: "sandbox",
    execution_backend: backend,
    execution_started: true,
    policy_id: policy.id,
  });
}

function verifyWorkerSource(workerPath: string): void {
  const manifestPath = resolve(dirname(workerPath), "../..", "assets", "worker.manifest.json");
  if (!existsSync(workerPath) || !existsSync(manifestPath)) {
    throw new ToolIsolationSetupError("sandbox_unavailable", "Tool worker source unavailable");
  }
  let manifest: {
    format?: number;
    protocol?: number;
    os?: string;
    architecture?: string;
    executables?: string[];
    assets?: Record<string, { path: string; sha256: string }>;
  };
  try {
    const encoded = readFileSync(manifestPath);
    if (encoded.byteLength > 16 * 1024) throw new Error("manifest too large");
    manifest = JSON.parse(encoded.toString("utf8")) as typeof manifest;
    if (typeof manifest !== "object" || manifest === null || !lstatSync(manifestPath).isFile()) {
      throw new Error("manifest is not a regular object file");
    }
  } catch {
    throw new ToolIsolationSetupError("sandbox_setup_failed", "Tool worker manifest is invalid");
  }
  const asset = manifest.assets?.["worker.ts"];
  if (
    manifest.format !== 1 ||
    manifest.protocol !== WORKER_PROTOCOL_VERSION ||
    manifest.os !== process.platform ||
    manifest.architecture !== process.arch ||
    JSON.stringify(manifest.executables) !== JSON.stringify(["bun", "worker.ts"]) ||
    basename(workerPath) !== "worker.ts" ||
    !asset ||
    asset.path !== "worker.ts" ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  ) {
    throw new ToolIsolationSetupError(
      "sandbox_setup_failed",
      "Tool worker manifest is incompatible",
    );
  }
  let actual: string;
  try {
    if (!lstatSync(workerPath).isFile()) throw new Error("worker is not a regular file");
    actual = createHash("sha256").update(readFileSync(workerPath)).digest("hex");
  } catch {
    throw new ToolIsolationSetupError(
      "sandbox_setup_failed",
      "Tool worker source cannot be verified",
    );
  }
  if (actual !== asset.sha256) {
    throw new ToolIsolationSetupError("sandbox_setup_failed", "Tool worker source hash mismatch");
  }
}

function dto(config: RuntimeConfig, scratchRoot: string): WorkerConfigDto {
  return {
    workspaceRoot: config.workspaceRoot,
    stateRoot: scratchRoot,
    temporaryRoots: config.temporaryRoots,
    readOnly: config.readOnly,
    maxOutputBytes: config.maxOutputBytes,
    maxShellOutputBytes: config.maxShellOutputBytes,
    maxFileBytes: config.maxFileBytes,
    maxImageBytes: config.maxImageBytes,
    maxTraversalEntries: config.maxTraversalEntries,
    maxMutationBytes: config.maxMutationBytes,
    maxDiffInputBytes: config.maxDiffInputBytes,
    maxToolMetaBytes: config.maxToolMetaBytes,
    shellTimeoutMs: config.shellTimeoutMs,
    shellTimeoutMaxMs: config.shellTimeoutMaxMs,
    maxSessions: config.maxSessions,
    regexScanBudgetMs: config.regexScanBudgetMs,
  };
}

/** One worker per policy/run; complete file handlers execute behind one native boundary. */
export class SandboxToolExecutor implements ToolExecutionPort {
  private worker: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pending:
    | {
        id: number;
        resolve: (value: string | ToolResult) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private ready: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private nextId = 1;
  private closed = false;
  private abortPending = false;
  private stopPromise: Promise<boolean> | undefined;
  private workerLogger: ToolsLogger = NOOP_TOOLS_LOGGER;

  constructor(
    private readonly policy: ToolIsolationPolicy,
    private readonly backend: ToolIsolationBackend,
    private readonly scratchRoot: string,
    private readonly workerPath = DEFAULT_WORKER_PATH,
    private readonly bunPath = process.execPath,
  ) {
    if (policy.mode !== "sandbox") throw new ToolError("invalid_input", "Sandbox mode required");
    if (!policy.temporaryWriteRoots.some((root) => within(scratchRoot, root))) {
      throw new ToolError(
        "invalid_input",
        "Worker scratch must be inside a writable temporary root",
      );
    }
  }

  private checkInstallation(): void {
    verifyWorkerSource(this.workerPath);
    let workerPath: string;
    let bunPath: string;
    try {
      workerPath = realpathSync(this.workerPath);
      bunPath = realpathSync(this.bunPath);
    } catch {
      throw new ToolIsolationSetupError(
        "sandbox_setup_failed",
        "Worker or Bun path is not canonical",
      );
    }
    const policy = this.policy;
    if (!policy.installationRoots.some((root) => within(workerPath, root))) {
      throw new ToolIsolationSetupError(
        "sandbox_setup_failed",
        "Worker source is not mounted read-only",
      );
    }
    if (
      !policy.installationRoots.some((root) => within(bunPath, root)) &&
      !within(bunPath, "/usr")
    ) {
      throw new ToolIsolationSetupError(
        "sandbox_setup_failed",
        "Bun executable is not mounted read-only",
      );
    }
  }

  async execute(
    tool: Parameters<ToolExecutionPort["execute"]>[0],
    args: Record<string, unknown>,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<ToolExecutionPort["execute"]>>> {
    if (config.executionPolicy !== this.policy || config.sandboxBackend !== this.backend) {
      throw new ToolError("invalid_input", "Tool execution policy does not match the worker");
    }
    if (tool.name === "shell_session") {
      return tool.handler(args, config, signal);
    }
    if (tool.name === "shell") {
      return sandboxResult(
        await tool.handler(args, config, signal),
        tool.name,
        this.backend.name,
        this.policy.id,
      );
    }
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (this.closed) throw new ToolError("aborted", "Tool worker is closed");
      if (signal?.aborted) throw new ToolError("aborted", "Tool call aborted");
      await this.ensureStarted(config);
      const worker = this.worker;
      if (!worker) {
        throw new ToolIsolationSetupError(
          "sandbox_setup_failed",
          "Tool worker stopped before admission",
        );
      }
      const id = this.nextId++;
      const frame = JSON.stringify({
        version: WORKER_PROTOCOL_VERSION,
        type: "call",
        id,
        name: tool.name,
        args,
      });
      if (Buffer.byteLength(frame, "utf8") > MAX_WORKER_FRAME_BYTES) {
        throw new ToolError("too_large", "Worker request exceeds protocol limit");
      }
      const result = await new Promise<string | ToolResult>((resolve, reject) => {
        const settledResolve = (value: string | ToolResult) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const settledReject = (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        };
        this.pending = { id, resolve: settledResolve, reject: settledReject };
        const onAbort = () => {
          this.closed = true;
          this.abortPending = true;
          this.stopWorker();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.stdin.write(`${frame}\n`, (error) => {
          if (error) this.stopWorker();
        });
      });
      return sandboxResult(result, tool.name, this.backend.name, this.policy.id);
    } catch (error) {
      if (this.stopPromise) {
        if (!(await this.stopPromise)) {
          throw new ToolError("outcome_unknown", "Worker tree termination was not confirmed", {
            execution_mode: "sandbox",
            execution_backend: this.backend.name,
            policy_id: this.policy.id,
            execution_started: true,
          });
        }
        this.stopPromise = undefined;
      }
      const denied = policyDenied(error, this.policy, this.backend.name);
      if (denied) throw denied;
      throw error;
    } finally {
      try {
        await this.stopPromise;
      } finally {
        release();
      }
    }
  }

  private async ensureStarted(config: RuntimeConfig): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start(config).catch((error: unknown) => {
      this.startPromise = undefined;
      if (isIsolationSetupError(error)) {
        throw new ToolIsolationSetupError(error.code, error.message, {
          backend: this.backend.name,
          policyId: this.policy.id,
        });
      }
      throw error;
    });
    return this.startPromise;
  }

  private async start(config: RuntimeConfig): Promise<void> {
    this.checkInstallation();
    this.workerLogger = config.logger;
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.policy.homeRoot,
      TMPDIR: this.scratchRoot,
      CLARVIS_HOME: this.policy.globalRoot,
    };
    const spec = this.backend.prepare(this.policy, {
      file: this.bunPath,
      args: [this.workerPath],
      cwd: this.policy.workspaceRoot,
      env,
    });
    const child = spawn(spec.file, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.worker = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_WORKER_FRAME_BYTES) {
        this.stopWorker();
        return;
      }
      let separator = buffer.indexOf("\n");
      while (separator >= 0) {
        const line = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 1);
        this.onFrame(line);
        separator = buffer.indexOf("\n");
      }
    });
    child.stderr.resume();
    child.on("error", () => this.onWorkerExit(child));
    child.on("exit", () => this.onWorkerExit(child));
    const init = JSON.stringify({
      version: WORKER_PROTOCOL_VERSION,
      type: "init",
      config: dto(config, this.scratchRoot),
    });
    if (Buffer.byteLength(init, "utf8") > MAX_WORKER_FRAME_BYTES) {
      this.stopWorker();
      throw new ToolIsolationSetupError(
        "sandbox_setup_failed",
        "Worker configuration exceeds protocol limit",
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
      const timer = setTimeout(() => {
        this.stopWorker();
        reject(new ToolIsolationSetupError("sandbox_setup_failed", "Worker did not become ready"));
      }, 5000);
      const settle = (callback: () => void) => () => {
        clearTimeout(timer);
        callback();
      };
      this.ready = { resolve: settle(resolve), reject: (error) => settle(() => reject(error))() };
      child.stdin.write(`${init}\n`, (error) => {
        if (error)
          this.ready?.reject(
            new ToolIsolationSetupError("sandbox_setup_failed", "Worker initialization failed"),
          );
      });
    });
  }

  private onFrame(line: string): void {
    let frame: WorkerResult;
    try {
      frame = JSON.parse(line) as WorkerResult;
    } catch {
      this.stopWorker();
      return;
    }
    if (frame.version !== WORKER_PROTOCOL_VERSION) {
      this.stopWorker();
      return;
    }
    if (frame.type === "ready" && this.ready) {
      const ready = this.ready;
      this.ready = undefined;
      ready.resolve();
      return;
    }
    if (frame.type !== "result" || !this.pending || frame.id !== this.pending.id) {
      this.stopWorker();
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    if (frame.error) {
      const code = ERROR_CODES.includes(frame.error.code as ErrorCode)
        ? (frame.error.code as ErrorCode)
        : "internal";
      pending.reject(
        new ToolError(code, frame.error.message, {
          ...frame.error.fields,
          execution_mode: "sandbox",
          execution_backend: this.backend.name,
          policy_id: this.policy.id,
          execution_started: code !== "invalid_input",
        }),
      );
    } else {
      if (
        typeof frame.result !== "string" &&
        (typeof frame.result !== "object" || frame.result === null)
      ) {
        this.stopWorker();
        pending.reject(new ToolError("io_error", "Malformed tool worker result"));
        return;
      }
      pending.resolve(frame.result as string | ToolResult);
    }
  }

  private onWorkerExit(child: ChildProcessWithoutNullStreams): void {
    if (this.worker !== child) return;
    this.stopWorker();
    this.worker = undefined;
    this.ready?.reject(
      new ToolIsolationSetupError("sandbox_setup_failed", "Tool worker exited before ready"),
    );
    this.ready = undefined;
    this.pending?.reject(
      this.abortPending
        ? new ToolError("aborted", "Tool call aborted", {
            execution_mode: "sandbox",
            execution_backend: this.backend.name,
            policy_id: this.policy.id,
            execution_started: true,
          })
        : new ToolError("outcome_unknown", "Tool worker stopped with outcome unknown", {
            execution_mode: "sandbox",
            execution_backend: this.backend.name,
            policy_id: this.policy.id,
            execution_started: true,
          }),
    );
    this.pending = undefined;
    this.abortPending = false;
    this.startPromise = undefined;
  }

  private stopWorker(): void {
    const child = this.worker;
    if (!child) return;
    if (this.stopPromise) return;
    if (child.pid !== undefined && process.platform !== "win32") {
      this.stopPromise = stopOwnedProcess({ pid: child.pid, child }, this.workerLogger);
      return;
    }
    child.kill("SIGKILL");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.worker?.stdin.end();
    this.stopWorker();
    await this.queue;
    if (this.stopPromise && !(await this.stopPromise)) {
      throw new ToolError("io_error", "Tool worker tree termination was not confirmed");
    }
  }
}
