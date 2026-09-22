import { setTimeout as delay } from "node:timers/promises";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

/** Recovery belongs to the positional writer; callers must not retry an entire append. */
export interface ProjectionRecoveryOptions {
  logger?: Logger;
  executionId?: string;
  hostGeneration?: string;
  wait?: (ms: number) => Promise<void>;
}

/** Repeat only a positional write of identical bytes or an idempotent synchronization syscall. */
export async function recoverProjectionIO<T>(
  operation: "write" | "sync_file" | "sync_directory",
  position: number,
  action: () => Promise<T>,
  options: ProjectionRecoveryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      const retry =
        code !== undefined && ["EINTR", "EAGAIN", "EBUSY", "ETIMEDOUT", "EIO"].includes(code);
      (options.logger ?? NOOP_LOGGER).warn(
        {
          event: "hosting.projection.io_recovery",
          execution_id: options.executionId,
          host_generation: options.hostGeneration,
          operation,
          offset: position,
          attempt,
          cause:
            code !== undefined &&
            [
              "EINTR",
              "EAGAIN",
              "EBUSY",
              "ETIMEDOUT",
              "EIO",
              "ENOSPC",
              "EACCES",
              "EEXIST",
              "EROFS",
              "EBADF",
            ].includes(code)
              ? code
              : "unclassified",
          state: retry && attempt < 3 ? "recovering" : "failed",
        },
        "hosted projection storage operation failed",
      );
      if (!retry || attempt >= 3) throw error;
      await (options.wait ?? delay)(
        Math.round(100 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)),
      );
    }
  }
}
