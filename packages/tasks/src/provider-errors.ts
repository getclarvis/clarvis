import type { TaskDocument } from "./provider.ts";

export const TASK_PROVIDER_ERROR_CODES = [
  "task_not_found",
  "task_forbidden",
  "task_unsupported",
  "task_invalid_transition",
  "task_conflict",
  "task_already_claimed",
  "task_invalid_input",
  "task_provider_unavailable",
  "task_invalid_response",
  "task_outcome_unknown",
  "task_provider_mismatch",
  "task_not_configured",
  "task_writes_disabled",
  "task_cancelled",
] as const;

export type TaskProviderErrorCode = (typeof TASK_PROVIDER_ERROR_CODES)[number];

/** Stable task-domain failure, safe to map through protocol transports. */
export class TaskProviderError extends Error {
  readonly code: TaskProviderErrorCode;
  readonly currentRevision?: string;
  readonly currentTask?: TaskDocument;

  constructor(
    code: TaskProviderErrorCode,
    message: string,
    options: { currentRevision?: string; currentTask?: TaskDocument; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TaskProviderError";
    this.code = code;
    this.currentRevision = options.currentRevision;
    this.currentTask = options.currentTask;
  }
}

export function isTaskProviderError(error: unknown): error is TaskProviderError {
  return error instanceof TaskProviderError;
}
