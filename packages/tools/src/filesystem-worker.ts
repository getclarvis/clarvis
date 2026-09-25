import { workspaceStatePathsFromRoot } from "@clarvis/paths";
import { dispatch } from "./core.ts";
import { resolveConfig, type AgentToolsOptions } from "./config.ts";
import { ToolError, parseToolError } from "./errors.ts";
import {
  parseFilesystemParentMessage,
  readFilesystemFrames,
  writeFilesystemFrame,
  type FilesystemChildMessage,
  type FilesystemWireContext,
} from "./lib/filesystem-protocol.ts";

/**
 * The only model-file executor in a native Sandbox. This entry is launched
 * beneath the same filesystem policy as shell and speaks only framed file ops.
 */
export async function runFilesystemWorker(): Promise<void> {
  let policyIdentity: string | undefined;
  let initialized = false;
  let writing = Promise.resolve();
  const controllers = new Map<string, AbortController>();
  const send = (message: FilesystemChildMessage): Promise<void> => {
    writing = writing.then(() => writeFilesystemFrame(process.stdout, message));
    return writing;
  };

  const optionsFor = (context: FilesystemWireContext): AgentToolsOptions => ({
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
        for (const controller of controllers.values()) controller.abort();
        break;
      }
      if (message.kind === "cancel") {
        controllers.get(message.id)?.abort();
        continue;
      }
      if (controllers.has(message.id)) throw new Error("Filesystem request identity was reused");
      if (message.policyIdentity !== policyIdentity)
        throw new Error("Filesystem request policy differs from the initialized service");
      const controller = new AbortController();
      controllers.set(message.id, controller);
      void (async () => {
        const phase = "execute" as const;
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
          const config = resolveConfig(optionsFor(message.context));
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
    for (const controller of controllers.values()) controller.abort();
    await writing.catch(() => undefined);
  }
}

if (import.meta.main) {
  await runFilesystemWorker().catch(() => {
    process.exitCode = 1;
  });
}
