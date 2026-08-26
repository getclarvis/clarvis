/**
 * Running one hook command: spawn, feed stdin, bound the output, bound the
 * clock, and kill the whole tree when it overruns.
 *
 * @remarks
 * The shape follows the two prototypes already in this repository - the `shell`
 * tool's settle discipline and `@clarvis/code`'s local-shell escalation - with
 * one difference that neither could have exercised: **a hook reads stdin**. Both
 * of those spawn with `stdio[0] = "ignore"`, so neither meets the case where the
 * child exits without reading, the write end breaks, and an unhandled `EPIPE` on
 * a stream with no `error` listener takes the host process down. That listener
 * is registered before the write, and there is a test that would fail without
 * it.
 *
 * Captured stderr is kept verbatim rather than ANSI-stripped. It is only ever
 * logged, never shown to the model, so the strip would buy nothing - and the
 * pattern that performs it has to embed raw escape bytes in the source, which
 * this repository forbids.
 */
import {
  killTree as defaultKillTree,
  ownProcessGroup as defaultOwnProcessGroup,
  resolveShell as defaultResolveShell,
  shellArgs as defaultShellArgs,
  type ShellSpec,
} from "@clarvis/tools/shell";
import { NOOP_HOOK_LOGGER, type HookLogger } from "./types.ts";

/** Grace between `SIGTERM` and `SIGKILL` when a hook overruns. */
export const DEFAULT_KILL_GRACE_MS = 1_500;
/** Cap on captured stdout; beyond it the output cannot be a valid verdict anyway. */
export const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
/** Cap on captured stderr, which is only ever logged. */
export const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;

/**
 * How long to keep reading after `exit` before giving up on `close`.
 *
 * @remarks
 * 100ms, matching the `shell` tool, rather than the 1s `@clarvis/code` uses for
 * a user-typed command. A tool-scoped hook runs on every tool call, so a full
 * second of drain per call would be the dominant cost of having hooks at all.
 */
const EXIT_DRAIN_MS = 100;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The child's stdout/stderr, narrowed to what this module uses. */
export interface HookReadable {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  destroy(): unknown;
}

/** The child's stdin, narrowed to what this module uses. */
export interface HookWritable {
  on(event: "error" | "close", listener: (err?: Error) => void): unknown;
  end(data: string, encoding: BufferEncoding): unknown;
}

/** A spawned child, narrowed so a test double is a plain object. */
export interface HookChildProcess {
  readonly pid?: number | undefined;
  readonly stdin: HookWritable | null;
  readonly stdout: HookReadable | null;
  readonly stderr: HookReadable | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): unknown;
}

/** The spawn options this module fixes; nothing else is configurable. */
export interface HookSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly detached: boolean;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  /** Payload supplied at spawn time on Bun, whose child-process stdin drops writes. */
  readonly input: string;
}

/** Injectable `spawn`. */
export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: HookSpawnOptions,
) => HookChildProcess;

/**
 * Injectable timers.
 *
 * @remarks
 * An explicit object rather than a fake-timer global patch. Bun's
 * `useFakeTimers` replaces the global `setTimeout`, which makes any test that
 * also touches a real subprocess order-dependent; this seam is local, so
 * "deadline fires, child ignores SIGTERM, grace elapses, SIGKILL is sent" is
 * assertable in the same file as a real spawn and without a real 1.5s wait.
 */
export interface TimerDeps {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: TimerDeps = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Test seams for {@link runHookCommand}; every one defaults to the real thing. */
export interface SubprocessDeps {
  /**
   * Where this module reports what it spawned and what it had to kill.
   *
   * @remarks Not a signature change: `runHookCommand(req, deps)` already takes
   *   a deps bag, so a host that has a logger threads it through the same
   *   object the runner already builds.
   */
  logger?: HookLogger;
  spawn?: SpawnFn;
  killTree?: (pid: number, signal: NodeJS.Signals) => boolean;
  ownProcessGroup?: () => boolean;
  resolveShell?: () => ShellSpec;
  shellArgs?: (shell: ShellSpec, command: string) => string[];
  timers?: TimerDeps;
  now?: () => number;
}

/** One command to run. */
export interface SubprocessRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Written to the child's stdin, which is then closed. */
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly killGraceMs?: number | undefined;
  readonly maxStdoutBytes?: number | undefined;
  readonly maxStderrBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * Context the caller knows and this module cannot derive, carried for the
   * diagnostic records only.
   *
   * @remarks Never reaches the child. It exists so a spawn record can name the
   *   hook event without this module having to know that hook events exist.
   */
  readonly diagnostics?: {
    readonly hookEvent: string;
    readonly dataTruncated: boolean;
  };
}

/** Everything observed about one command. */
export interface SubprocessResult {
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Set when the shell itself could not be started. */
  readonly spawnError: string | undefined;
  readonly durationMs: number;
}

interface Collector {
  push(chunk: Buffer): void;
  text(): string;
  truncated(): boolean;
}

/**
 * Accumulates up to `maxBytes`; once the cap is hit the excess of that chunk is
 * dropped and every later push is a no-op, so `truncated()` sticks for the rest
 * of the stream rather than marking only the boundary chunk.
 */
function collector(maxBytes: number): Collector {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

/** The one rejection sink every fire-and-forget promise in this module ends with. */
const absorb = (): void => undefined;

/**
 * Start `promise` for its effect alone, absorbing any rejection.
 *
 * @remarks An unhandled rejection is not a failure mode a hook subsystem should
 * be able to raise, and `no-floating-promises` requires a rejection handler on
 * every detached promise regardless. Routing all of them through one named sink
 * means there is a single such handler in the module rather than one per call
 * site — each of which would be a callback nothing could be shown to invoke.
 */
export function ignoreRejection(promise: Promise<unknown>): void {
  promise.catch(absorb);
}

interface BunReadableState {
  readonly readable: HookReadable;
  readonly drained: Promise<void>;
}

/**
 * Adapt one Bun stream to the listener shape {@link runHookCommand} consumes.
 *
 * @remarks The read loop swallows its own failure in a `catch` *block* rather
 * than a trailing `.catch(...)` callback, because the two are not equivalent
 * here: `destroy` cancels the reader while a `read()` is very likely pending,
 * which rejects that read, and a block keeps the handling on the same path the
 * loop already takes. `drained` therefore never rejects, which is what lets its
 * consumer await it without a rejection arm of its own.
 */
function bunReadable(stream: ReadableStream<Uint8Array>): BunReadableState {
  const reader = stream.getReader();
  const listeners: Array<(chunk: Buffer) => void> = [];
  const drained = (async () => {
    try {
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        const chunk = Buffer.from(read.value);
        for (const listener of listeners) listener(chunk);
      }
    } catch {
      /* the stream ended abnormally, or was cancelled under the pending read */
    }
  })();
  return {
    drained,
    readable: {
      on(_event, listener) {
        listeners.push(listener);
      },
      destroy() {
        ignoreRejection(reader.cancel());
      },
    },
  };
}

function bunSpawn(
  file: string,
  args: readonly string[],
  options: HookSpawnOptions,
): HookChildProcess {
  const process = Bun.spawn([file, ...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdin: new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = bunReadable(process.stdout);
  const stderr = bunReadable(process.stderr);
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  ignoreRejection(
    process.exited.then((code) => {
      const signal = process.signalCode ?? null;
      for (const listener of exitListeners) listener(code, signal);
      ignoreRejection(
        Promise.all([stdout.drained, stderr.drained]).then(() => {
          for (const listener of closeListeners) listener(code, signal);
        }),
      );
    }),
  );

  /**
   * Register a listener, honouring `exit` and `close` only.
   *
   * @remarks `error` is part of {@link HookChildProcess} because a test double
   * emits it, but it cannot fire here: Bun reports a spawn failure by throwing
   * from `Bun.spawn`, which {@link runHookCommand} already catches into
   * `spawnError`, and `process.exited` never rejects. Wiring listeners it could
   * never call would be an arm no input can reach.
   */
  function on(event: "error", listener: (error: Error) => void): unknown;
  function on(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  function on(
    event: "error" | "exit" | "close",
    listener:
      ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): unknown {
    if (event === "exit") {
      exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    } else if (event === "close") {
      closeListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    }
    return undefined;
  }

  return {
    pid: process.pid,
    stdin: null,
    stdout: stdout.readable,
    stderr: stderr.readable,
    on,
    kill(signal) {
      process.kill(signal);
      return true;
    },
    unref() {
      process.unref();
    },
  };
}

/**
 * The production spawn.
 *
 * @remarks Bun is the only runtime this workspace supports, so there is no
 * `node:child_process` fallback behind a `typeof Bun` test: that branch could
 * never be taken, and an arm no input can reach is one no test can hold to
 * account. {@link SubprocessDeps.spawn} remains the seam for a double.
 */
const defaultSpawn: SpawnFn = (file, args, options) => bunSpawn(file, args, options);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs one hook command to completion.
 *
 * @param req - the command and its bounds.
 * @param deps - test seams.
 * @returns what happened. **Never rejects**: a spawn failure, a timeout and an
 *   abort are all ordinary fields, because the caller's contract is to turn any
 *   outcome into a verdict rather than to handle an exception at a fire point.
 * @remarks
 * `detached` comes from `ownProcessGroup()` and is never passed unconditionally.
 * On POSIX it makes the child a group leader, which is the only reason
 * `killTree` can reap a hook's grandchildren; on Windows it would mean
 * `DETACHED_PROCESS`, denying the child a console and producing a silent
 * do-nothing spawn. There is no platform branch here: `killTree` runs
 * `taskkill /T /F` on Windows, where signals do not exist and the escalation
 * step is therefore a no-op.
 *
 * The shell is the one the host's own tools resolve to - `sh` on POSIX, pwsh
 * with an encoded command on Windows - so a hook command behaves exactly like a
 * `shell` tool command on the same machine.
 *
 * An already-aborted signal short-circuits before the spawn: at teardown there
 * is nothing to learn from starting a process only to kill it.
 */
export function runHookCommand(
  req: SubprocessRequest,
  deps: SubprocessDeps = {},
): Promise<SubprocessResult> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const kill = deps.killTree ?? defaultKillTree;
  const inOwnGroup = deps.ownProcessGroup ?? defaultOwnProcessGroup;
  const resolve = deps.resolveShell ?? defaultResolveShell;
  const toArgs = deps.shellArgs ?? defaultShellArgs;
  const timers = deps.timers ?? REAL_TIMERS;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? NOOP_HOOK_LOGGER;
  const hookEvent = req.diagnostics?.hookEvent ?? "unknown";

  const startedAt = now();
  const bare = (over: Partial<SubprocessResult>): SubprocessResult => ({
    stdout: "",
    stdoutTruncated: false,
    stderr: "",
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    spawnError: undefined,
    durationMs: now() - startedAt,
    ...over,
  });

  if (req.signal?.aborted === true) return Promise.resolve(bare({ aborted: true }));

  return new Promise<SubprocessResult>((settleOuter) => {
    const shell = resolve();
    const detached = inOwnGroup();
    logger.debug(
      {
        event: "hooks.spawn",
        hook_event: hookEvent,
        shell_file: shell.file,
        detached,
        timeout_ms: req.timeoutMs,
        stdin_bytes: Buffer.byteLength(req.stdin, "utf8"),
        data_truncated: req.diagnostics?.dataTruncated ?? false,
      },
      "a workspace hook command is being spawned; its verdict gates the pending call",
    );
    let child: HookChildProcess;
    try {
      child = spawnFn(shell.file, toArgs(shell, req.command), {
        cwd: req.cwd,
        env: req.env,
        detached,
        stdio: ["pipe", "pipe", "pipe"],
        input: req.stdin,
      });
    } catch (e) {
      settleOuter(bare({ spawnError: errorMessage(e) }));
      return;
    }

    const out = collector(req.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES);
    const err = collector(req.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES);
    child.stdout?.on("data", (c) => {
      out.push(c);
    });
    child.stderr?.on("data", (c) => {
      err.push(c);
    });

    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    let killHandle: unknown;
    let drainHandle: unknown;
    let treeKilled = false;
    let escalatedToSigkill = false;
    let exitResult: readonly [number | null, NodeJS.Signals | null] | undefined;
    let closeResult: readonly [number | null, NodeJS.Signals | null] | undefined;
    let stdinDone = child.stdin === null;
    let processSettleScheduled = false;

    const killAll = (sig: NodeJS.Signals): void => {
      if (child.pid !== undefined && kill(child.pid, sig)) {
        treeKilled = true;
        return;
      }
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const startKill = (): void => {
      killAll("SIGTERM");
      killHandle ??= timers.setTimeout(() => {
        escalatedToSigkill = true;
        killAll("SIGKILL");
      }, req.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };

    const timeoutHandle = timers.setTimeout(
      () => {
        timedOut = true;
        startKill();
      },
      Math.min(req.timeoutMs, MAX_TIMER_DELAY_MS),
    );

    const onAbort = (): void => {
      aborted = true;
      startKill();
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeoutHandle);
      if (killHandle !== undefined) timers.clearTimeout(killHandle);
      if (drainHandle !== undefined) timers.clearTimeout(drainHandle);
      req.signal?.removeEventListener("abort", onAbort);
      child.unref();
      if (timedOut) {
        logger.warn(
          {
            event: "hooks.timeout_kill",
            hook_event: hookEvent,
            timeout_ms: req.timeoutMs,
            escalated_to_sigkill: escalatedToSigkill,
            tree_killed: treeKilled,
          },
          "a workspace hook overran its deadline and its process tree was killed; the hook's verdict is a timeout failure",
        );
      }
      settleOuter({
        stdout: out.text(),
        stdoutTruncated: out.truncated(),
        stderr: err.text(),
        exitCode: code,
        signal,
        timedOut,
        aborted,
        spawnError,
        durationMs: now() - startedAt,
      });
    };

    child.on("error", (e) => {
      spawnError = e.message;
      settle(null, null);
    });
    const finishAfterProcessEvents = (): void => {
      if (exitResult !== undefined && closeResult !== undefined && stdinDone) {
        if (processSettleScheduled) return;
        processSettleScheduled = true;
        if (drainHandle !== undefined) timers.clearTimeout(drainHandle);
        const result = exitResult;
        setImmediate(() => {
          settle(result[0], result[1]);
        });
        return;
      }
      if (exitResult === undefined && closeResult === undefined) return;
      drainHandle ??= timers.setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        const result = exitResult ?? closeResult ?? [null, null];
        settle(result[0], result[1]);
      }, EXIT_DRAIN_MS);
    };
    child.on("exit", (code, signal) => {
      exitResult = [code, signal];
      finishAfterProcessEvents();
    });
    child.on("close", (code, signal) => {
      closeResult = [code, signal];
      finishAfterProcessEvents();
    });

    const stdin = child.stdin;
    if (stdin !== null) {
      stdin.on("error", () => {
        /* a hook that never reads stdin breaks the pipe; that is not a failure */
        stdinDone = true;
        finishAfterProcessEvents();
      });
      stdin.on("close", () => {
        stdinDone = true;
        finishAfterProcessEvents();
      });
      stdin.end(req.stdin, "utf8");
    }
  });
}
