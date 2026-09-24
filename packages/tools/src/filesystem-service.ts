import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationTarget } from "@clarvis/paths";
import { isFileOperation, type AgentFilesystem, type FilesystemCall } from "./agent-filesystem.ts";
import type { FileOp } from "./lib/atomic.ts";
import type { RuntimeConfig } from "./config.ts";
import type { DispatchResult } from "./core.ts";
import { ToolError } from "./errors.ts";
import {
  mutationDigest,
  parseFilesystemChildMessage,
  readFilesystemFrames,
  writeFilesystemFrame,
  type FilesystemChildMessage,
  type FilesystemParentMessage,
  type FilesystemWireContext,
} from "./lib/filesystem-protocol.ts";
import { stopOwnedProcess } from "./lib/process-owner.ts";
import { ownProcessGroup } from "./lib/process.ts";
import { probeSandbox, sandboxCommand, type SandboxProbe } from "./sandbox.ts";

interface PendingCall {
  readonly config: RuntimeConfig;
  readonly resolve: (result: DispatchResult) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
  readonly fuse: ReturnType<typeof setTimeout>;
  review?: Promise<void>;
  reviewFailure?: Error;
  commit?: { resolve(): void; reject(error: Error): void };
  committed?: boolean;
}

const BOOT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 10 * 60_000;

function workerEntry(): string {
  const source = fileURLToPath(new URL("./filesystem-worker.ts", import.meta.url));
  if (existsSync(source)) return source;
  const built = fileURLToPath(new URL("./filesystem-worker.js", import.meta.url));
  if (existsSync(built)) return built;
  throw new ToolError("io_error", "Native filesystem service artifact is missing");
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function contextOf(config: RuntimeConfig): FilesystemWireContext {
  return {
    workspaceRoot: config.workspaceRoot,
    stateRoot: config.statePaths.root,
    temporaryRoots: config.temporaryRoots,
    skillExecutionRoots: config.skillExecutionRoots,
    ...(config.configurationRoots === undefined
      ? {}
      : { configurationRoots: config.configurationRoots }),
    readOnly: config.readOnly,
    reviewMutation: config.reviewMutation !== undefined,
    ripgrepAvailable: config.ripgrepAvailable,
    maxOutputBytes: config.maxOutputBytes,
    maxFileBytes: config.maxFileBytes,
    maxImageBytes: config.maxImageBytes,
    maxTraversalEntries: config.maxTraversalEntries,
    maxMutationBytes: config.maxMutationBytes,
    maxDiffInputBytes: config.maxDiffInputBytes,
    maxToolMetaBytes: config.maxToolMetaBytes,
    regexScanBudgetMs: config.regexScanBudgetMs,
  };
}

function mutationRoute(
  operations: readonly FileOp[],
  config: RuntimeConfig,
): "worker" | "classified-host" {
  const roots = config.configurationRoots;
  if (roots === undefined || config.reviewMutation?.commitClassified === undefined) return "worker";
  const paths = operations.flatMap((operation) => [
    operation.path,
    ...(operation.from === undefined ? [] : [operation.from]),
  ]);
  const classified = paths.map((path) => configurationTarget(roots, path));
  if (classified.some((target) => target?.kind === "private"))
    throw new ToolError("denied", "Private configuration cannot be changed by file tools");
  if (classified.every((target) => target === undefined)) return "worker";
  if (
    classified.some(
      (target, index) =>
        target === undefined &&
        (!within(config.workspaceRoot, paths[index]!) ||
          config.filesystemPolicy.workspaceAccess === "read-only" ||
          config.filesystemPolicy.protectedRoots.some((root) => within(root, paths[index]!))),
    )
  )
    throw new ToolError("denied", "A configuration batch includes an unadmitted target");
  if (
    config.filesystemPolicy.workspaceAccess === "read-only" &&
    classified.some((target) => target?.root.startsWith("workspace_"))
  )
    throw new ToolError("denied", "The workspace is read-only under this Sandbox policy");
  return "classified-host";
}

function within(root: string, target: string): boolean {
  if (!isAbsolute(target)) return false;
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** One physical child shared by every file call in a run's native Sandbox. */
export class SandboxAgentFilesystem implements AgentFilesystem {
  private child: ChildProcess | undefined;
  private boot: Promise<void> | undefined;
  private ready: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private readonly nonce = randomBytes(16).toString("hex");
  private writing = Promise.resolve();
  private closed = false;
  private failed: Error | undefined;

  constructor(
    private readonly owner: RuntimeConfig,
    private readonly probe: () => SandboxProbe = probeSandbox,
    private readonly callTimeoutMs = CALL_TIMEOUT_MS,
  ) {
    if (owner.filesystemPolicy.placement !== "sandbox")
      throw new ToolError("invalid_input", "Filesystem service requires native Sandbox placement");
  }

  private rejectPending(error: Error): void {
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.fuse);
      if (call.signal !== undefined && call.abort !== undefined)
        call.signal.removeEventListener("abort", call.abort);
      call.commit?.reject(error);
      call.reject(error);
    }
  }

  private fail(error: Error): void {
    if (this.failed !== undefined) return;
    this.failed = error;
    this.ready?.reject(error);
    this.ready = undefined;
    this.rejectPending(error);
    const child = this.child;
    if (child?.pid !== undefined) {
      child.stdin?.destroy();
      void stopOwnedProcess({ pid: child.pid, child }, this.owner.logger, Date.now() + 1_200).catch(
        () => undefined,
      );
    }
    this.owner.logger.warn(
      { event: "tools.filesystem_service_failed", cause: error.name },
      "native filesystem service failed closed",
    );
  }

  private send(message: FilesystemParentMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.failed || this.closed)
      return Promise.reject(
        this.failed ?? new ToolError("aborted", "Filesystem service is closed"),
      );
    this.writing = this.writing.then(() => writeFilesystemFrame(stdin, message));
    return this.writing.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error("Filesystem channel write failed");
      this.fail(failure);
      throw failure;
    });
  }

  private async read(): Promise<void> {
    const stdout = this.child?.stdout;
    if (!stdout) throw new Error("Filesystem service has no response pipe");
    for await (const raw of readFilesystemFrames(stdout)) {
      const message = parseFilesystemChildMessage(raw);
      this.handle(message);
    }
    if (!this.closed) throw new Error("Filesystem service channel closed");
  }

  private handle(message: FilesystemChildMessage): void {
    if (message.kind === "ready") {
      if (
        this.ready === undefined ||
        message.nonce !== this.nonce ||
        message.policyIdentity !== this.owner.filesystemPolicy.identity
      )
        throw new Error("Filesystem service policy handshake failed");
      this.ready.resolve();
      this.ready = undefined;
      return;
    }
    const call = this.pending.get(message.id);
    if (!call) throw new Error("Filesystem service returned an unknown request");
    if (message.kind === "prepare") {
      this.prepare(message, call);
      return;
    }
    if (message.kind === "failure") {
      if (call.review !== undefined)
        void call.review.then(
          () =>
            this.settle(
              message.id,
              call.reviewFailure ??
                new ToolError("io_error", "Filesystem service operation failed"),
            ),
          (error: unknown) =>
            this.settle(
              message.id,
              error instanceof Error ? error : new Error("Filesystem review failed"),
            ),
        );
      else
        this.settle(message.id, new ToolError("io_error", "Filesystem service operation failed"));
      return;
    }
    if (call.commit !== undefined) {
      if (message.result.isError)
        call.commit.reject(new ToolError("io_error", "Filesystem mutation commit failed"));
      else call.commit.resolve();
    }
    if (call.review !== undefined) {
      void call.review.then(
        () => this.settle(message.id, call.reviewFailure, message.result),
        (error: unknown) =>
          this.settle(
            message.id,
            error instanceof Error ? error : new Error("Filesystem review failed"),
          ),
      );
    } else this.settle(message.id, undefined, message.result);
  }

  private prepare(
    message: Extract<FilesystemChildMessage, { kind: "prepare" }>,
    call: PendingCall,
  ): void {
    if (
      call.review !== undefined ||
      message.digest !==
        mutationDigest(this.owner.filesystemPolicy.identity, message.id, message.operations)
    )
      throw new Error("Filesystem service prepared a divergent mutation");
    const reviewer = call.config.reviewMutation;
    if (!reviewer) throw new Error("Filesystem service requested unavailable host review");
    let route: "worker" | "classified-host";
    try {
      route = mutationRoute(message.operations, call.config);
    } catch (error) {
      call.review = Promise.reject(
        error instanceof Error ? error : new Error("Filesystem mutation route failed"),
      );
      void call.review.catch(() => undefined);
      void this.send({ kind: "reject", id: message.id, batchId: message.batchId }).catch(
        () => undefined,
      );
      return;
    }
    call.review = reviewer(message.operations, async () => {
      if (this.closed || this.failed)
        throw new ToolError("aborted", "Filesystem service is unavailable");
      if (call.signal?.aborted) throw new ToolError("aborted", "Filesystem call was cancelled");
      if (call.committed) throw new Error("Filesystem mutation receipt was reused");
      if (route === "classified-host")
        await reviewer.commitClassified!(message.operations, call.config.filesystemPolicy);
      call.committed = true;
      const committed = new Promise<void>((resolve, reject) => {
        call.commit = { resolve, reject };
      });
      await this.send({
        kind: "commit",
        id: message.id,
        batchId: message.batchId,
        digest: message.digest,
        route,
      });
      await committed;
    });
    void call.review.then(
      () => {
        if (!call.committed) {
          call.reviewFailure = new ToolError(
            "denied",
            "Filesystem mutation was not committed by review",
          );
          void this.send({ kind: "reject", id: message.id, batchId: message.batchId }).catch(
            () => undefined,
          );
        }
      },
      () => {
        if (!call.committed)
          void this.send({ kind: "reject", id: message.id, batchId: message.batchId }).catch(
            () => undefined,
          );
      },
    );
  }

  private settle(id: string, error?: Error, result?: DispatchResult): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.fuse);
    if (call.signal !== undefined && call.abort !== undefined)
      call.signal.removeEventListener("abort", call.abort);
    if (error) call.reject(error);
    else if (result) call.resolve(result);
    else call.reject(new Error("Filesystem service omitted its result"));
  }

  private async start(): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.closed) throw new ToolError("aborted", "Filesystem service is closed");
    const spec = sandboxCommand({
      command: `exec ${quoted(process.execPath)} ${quoted(workerEntry())}`,
      cwd: this.owner.workspaceRoot,
      workspaceRoot: this.owner.workspaceRoot,
      filesystemPolicy: this.owner.filesystemPolicy,
      secretEnvNames: this.owner.secretEnvNames,
      probe: this.probe,
    });
    const child = spawn(spec.file, spec.args, {
      ...spec.options,
      stdio: ["pipe", "pipe", "pipe"],
      detached: ownProcessGroup(),
    });
    this.child = child;
    child.stderr?.resume();
    child.on("error", () => this.fail(new Error("Filesystem service process failed")));
    child.on("exit", () => {
      if (!this.closed) this.fail(new Error("Filesystem service process exited"));
    });
    void this.read().catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error("Filesystem response channel failed"));
    });
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    void ready.catch(() => undefined);
    const fuse = setTimeout(
      () => this.fail(new Error("Filesystem service boot timed out")),
      BOOT_TIMEOUT_MS,
    );
    try {
      await this.send({
        kind: "init",
        nonce: this.nonce,
        policyIdentity: this.owner.filesystemPolicy.identity,
      });
      await ready;
    } finally {
      clearTimeout(fuse);
    }
  }

  async execute(
    call: FilesystemCall,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    if (!isFileOperation(call.operation))
      throw new ToolError("invalid_input", "Unknown filesystem operation");
    if (this.closed || this.failed)
      throw this.failed ?? new ToolError("aborted", "Filesystem service is closed");
    if (config.filesystemPolicy.identity !== this.owner.filesystemPolicy.identity)
      throw new ToolError("denied", "Filesystem policy changed within the run");
    this.boot ??= this.start().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error("Filesystem service boot failed");
      this.fail(failure);
      throw failure;
    });
    await this.boot;
    if (signal?.aborted) throw new ToolError("aborted", "Filesystem call was cancelled");
    const id = randomBytes(16).toString("hex");
    return new Promise<DispatchResult>((resolve, reject) => {
      const abort = () => {
        this.fail(new ToolError("aborted", "Filesystem call was cancelled"));
      };
      const fuse = setTimeout(() => {
        this.fail(new Error("Filesystem service operation timed out"));
      }, this.callTimeoutMs);
      this.pending.set(id, { config, resolve, reject, signal, abort, fuse });
      signal?.addEventListener("abort", abort, { once: true });
      void this.send({
        kind: "invoke",
        id,
        operation: call.operation,
        args: call.args,
        context: contextOf(config),
      }).catch((error: unknown) => {
        this.settle(id, error instanceof Error ? error : new Error("Filesystem channel failed"));
      });
    });
  }

  /** Close admission and confirm the worker's complete process tree exited. */
  async close(deadline: number): Promise<boolean> {
    this.closed = true;
    const ended = new ToolError("aborted", "Filesystem run ended");
    this.ready?.reject(ended);
    this.ready = undefined;
    this.rejectPending(ended);
    const child = this.child;
    if (!child || child.pid === undefined) return true;
    child.stdin?.destroy();
    const confirmed = await stopOwnedProcess(
      { pid: child.pid, child },
      this.owner.logger,
      deadline,
    );
    if (!confirmed) this.fail(new Error("Filesystem service termination was not confirmed"));
    return confirmed;
  }
}
