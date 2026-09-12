/** One cancellable external-process request. */
export interface ProcessRunRequest {
  /** Executable name or path. */
  readonly command: string;
  /** Argument vector passed without shell parsing. */
  readonly args: readonly string[];
  /** Optional working directory. */
  readonly cwd?: string;
  /** Complete process environment. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Hard timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Combined UTF-8 output ceiling; exceeding it rejects and terminates the process. */
  readonly maxOutputBytes?: number;
  /** Host cancellation signal. */
  readonly signal?: AbortSignal;
}

/** Captured external-process result. */
export interface ProcessRunResult {
  /** Exit status, or `null` when terminated by a signal. */
  readonly exitCode: number | null;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
}

/** Asynchronous effect port for external process execution. */
export interface ProcessRunner {
  /**
   * Execute one process without a shell.
   *
   * @param request - executable, argv, environment, timeout, and cancellation.
   * @returns captured output and status.
   */
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}
