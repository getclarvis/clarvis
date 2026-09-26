/** Versioned, bounded stdin/stdout protocol for a sandboxed file-tool worker. */
export const WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_FRAME_BYTES = 8 * 1024 * 1024;

export interface WorkerConfigDto {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly temporaryRoots: readonly string[];
  readonly readOnly: boolean;
  readonly maxOutputBytes: number;
  readonly maxShellOutputBytes: number;
  readonly maxFileBytes: number;
  readonly maxImageBytes: number;
  readonly maxTraversalEntries: number;
  readonly maxMutationBytes: number;
  readonly maxDiffInputBytes: number;
  readonly maxToolMetaBytes: number;
  readonly shellTimeoutMs: number;
  readonly shellTimeoutMaxMs: number;
  readonly maxSessions: number;
  readonly regexScanBudgetMs: number;
}

export interface WorkerCall {
  readonly version: typeof WORKER_PROTOCOL_VERSION;
  readonly type: "call";
  readonly id: number;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface WorkerResult {
  readonly version: typeof WORKER_PROTOCOL_VERSION;
  readonly type: "ready" | "result";
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { code: string; message: string; fields?: Record<string, unknown> };
}
