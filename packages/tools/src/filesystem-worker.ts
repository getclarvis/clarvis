import { randomUUID } from "node:crypto";
import { workspaceStatePathsFromRoot } from "@clarvis/paths";
import { dispatch } from "./core.ts";
import { resolveConfig, type AgentToolsOptions } from "./config.ts";
import { ToolError, parseToolError } from "./errors.ts";
import type { FileOp } from "./lib/atomic.ts";
import {
  mutationDigest,
  parseFilesystemParentMessage,
  readFilesystemFrames,
  writeFilesystemFrame,
  type FilesystemChildMessage,
  type FilesystemWireContext,
} from "./lib/filesystem-protocol.ts";

const MUTATIONS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "replace",
  "apply_patch",
  "copy",
  "move",
  "mkdir",
  "remove",
]);

interface PendingReview {
  readonly id: string;
  readonly digest: string;
  resolve(route: "worker" | "classified-host"): void;
  reject(error: Error): void;
}

/**
 * The only model-file executor in a native Sandbox. This entry is launched
 * beneath the same filesystem policy as shell and speaks only framed file ops.
 */
export async function runFilesystemWorker(): Promise<void> {
  let policyIdentity: string | undefined;
  let initialized = false;
  let closed = false;
  let writing = Promise.resolve();
  const controllers = new Map<string, AbortController>();
  const reviews = new Map<string, PendingReview>();
  const send = (message: FilesystemChildMessage): Promise<void> => {
    writing = writing.then(() => writeFilesystemFrame(process.stdout, message));
    return writing;
  };

  const reviewFor =
    (id: string, phase: (next: "review" | "commit") => void) =>
    async (operations: readonly FileOp[], commit: () => Promise<void>): Promise<void> => {
      if (policyIdentity === undefined || closed)
        throw new ToolError("aborted", "Filesystem service is closed");
      const batchId = randomUUID();
      const digest = mutationDigest(policyIdentity, id, operations);
      phase("review");
      const route = await new Promise<"worker" | "classified-host">((resolve, reject) => {
        reviews.set(batchId, { id, digest, resolve, reject });
        void send({ kind: "prepare", id, batchId, digest, operations }).catch((error: unknown) => {
          reviews.delete(batchId);
          reject(error instanceof Error ? error : new Error("Filesystem channel failed"));
        });
      });
      if (route === "worker") {
        phase("commit");
        await commit();
      }
    };

  const optionsFor = (
    context: FilesystemWireContext,
    id: string,
    phase: (next: "review" | "commit") => void,
  ): AgentToolsOptions => ({
    workspaceRoot: context.workspaceRoot,
    statePaths: workspaceStatePathsFromRoot(context.workspaceRoot, context.stateRoot),
    temporaryRoots: context.temporaryRoots,
    skillExecutionRoots: context.skillExecutionRoots,
    readOnly: context.readOnly,
    maxOutputBytes: context.maxOutputBytes,
    maxFileBytes: context.maxFileBytes,
    maxImageBytes: context.maxImageBytes,
    maxTraversalEntries: context.maxTraversalEntries,
    maxMutationBytes: context.maxMutationBytes,
    maxDiffInputBytes: context.maxDiffInputBytes,
    maxToolMetaBytes: context.maxToolMetaBytes,
    regexScanBudgetMs: context.regexScanBudgetMs,
    probeRipgrep: () => context.ripgrepAvailable,
    ...(context.configurationRoots === undefined
      ? {}
      : {
          configurationRoots: context.configurationRoots,
        }),
    ...(context.reviewMutation ? { reviewMutation: reviewFor(id, phase) } : {}),
  });

  try {
    for await (const raw of readFilesystemFrames(process.stdin)) {
      const message = parseFilesystemParentMessage(raw);
      if (message.kind === "init") {
        if (initialized) throw new Error("Filesystem service initialized more than once");
        initialized = true;
        policyIdentity = message.policyIdentity;
        await send({ kind: "ready", nonce: message.nonce, policyIdentity });
        continue;
      }
      if (!initialized) throw new Error("Filesystem service invoked before initialization");
      if (message.kind === "close") {
        closed = true;
        for (const controller of controllers.values()) controller.abort();
        for (const review of reviews.values())
          review.reject(new Error("Filesystem service closed"));
        reviews.clear();
        break;
      }
      if (closed) throw new Error("Filesystem service is closed");
      if (message.kind === "cancel") {
        controllers.get(message.id)?.abort();
        for (const [batchId, review] of reviews) {
          if (review.id !== message.id) continue;
          reviews.delete(batchId);
          review.reject(new ToolError("aborted", "Filesystem operation cancelled"));
        }
        continue;
      }
      if (message.kind === "commit" || message.kind === "reject") {
        const review = reviews.get(message.batchId);
        if (review === undefined || review.id !== message.id)
          throw new Error("Filesystem review receipt is unknown");
        reviews.delete(message.batchId);
        if (message.kind === "commit") {
          if (review.digest !== message.digest)
            throw new Error("Filesystem review receipt does not match the prepared batch");
          review.resolve(message.route);
        } else review.reject(new ToolError("denied", "Filesystem mutation was not approved"));
        continue;
      }
      if (controllers.has(message.id)) throw new Error("Filesystem request identity was reused");
      if (message.policyIdentity !== policyIdentity)
        throw new Error("Filesystem request policy differs from the initialized service");
      const controller = new AbortController();
      controllers.set(message.id, controller);
      void (async () => {
        let phase: "prepare" | "review" | "commit" | "execute" = MUTATIONS.has(message.operation)
          ? "prepare"
          : "execute";
        const failure = (error: ToolError | undefined): FilesystemChildMessage => ({
          kind: "failure",
          version: 1,
          id: message.id,
          code: error?.code ?? "internal",
          message:
            error !== undefined && error.message.length <= 1024
              ? error.message
              : "Filesystem service operation failed",
          phase,
          operation: message.operation,
          path_role:
            typeof error?.fields.path === "string" && error.fields.path === message.args.source
              ? "source"
              : typeof error?.fields.path === "string" &&
                  error.fields.path === message.args.destination
                ? "destination"
                : typeof message.args.path === "string" || typeof error?.fields.path === "string"
                  ? "target"
                  : "none",
          retryable: error?.code === "timeout",
          ...(error?.code === "commit_partial" && typeof error.fields.source_exists === "boolean"
            ? { source_exists: error.fields.source_exists }
            : {}),
          ...(error?.code === "commit_partial" &&
          typeof error.fields.destination_committed === "boolean"
            ? { destination_committed: error.fields.destination_committed }
            : {}),
        });
        try {
          const config = resolveConfig(
            optionsFor(message.context, message.id, (next) => {
              phase = next;
            }),
          );
          const result = await dispatch(message.operation, message.args, config, controller.signal);
          if (result.isError) {
            const part = result.content[0];
            await send(failure(parseToolError(part?.type === "text" ? part.text : undefined)));
          } else await send({ kind: "result", id: message.id, result });
        } catch (error) {
          await send(failure(error instanceof ToolError ? error : undefined));
        } finally {
          controllers.delete(message.id);
        }
      })().catch(() => {
        process.exitCode = 1;
        process.stdin.destroy();
      });
    }
  } finally {
    closed = true;
    for (const controller of controllers.values()) controller.abort();
    for (const review of reviews.values()) review.reject(new Error("Filesystem channel closed"));
    await writing.catch(() => undefined);
  }
}

if (import.meta.main) {
  await runFilesystemWorker().catch(() => {
    process.exitCode = 1;
  });
}
