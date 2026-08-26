import { format } from "node:util";

/** How many bytes of deferred output the guard keeps before dropping the oldest. */
const MAX_DEFERRED_BYTES = 64 * 1024;

type StderrWrite = typeof process.stderr.write;

/**
 * The `console` methods that emit text, and so can reach the terminal.
 *
 * @remarks `console.log` and `console.info` write to stdout rather than stderr,
 *   and are guarded all the same: the renderer paints through
 *   `process.stdout.write` directly, never through `console`, so withholding
 *   these cannot suppress a frame.
 */
const CONSOLE_METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
  "table",
] as const satisfies readonly (keyof Console)[];

/**
 * Take the terminal away from everything except the renderer, for as long as
 * the canvas owns it.
 *
 * @returns a restore function: it puts the original writers back and flushes
 *   everything withheld, so nothing is lost — only deferred until the renderer
 *   has released the terminal.
 * @remarks `@clarvis/code` owns the terminal, and a stray write lands *inside*
 *   the frame: not appended below it, but interleaved mid-string, turning
 *   `Ask for an adjustment…` into `Ask for antadjustment…` and painting log
 *   JSON across the plan-approval gate. Only a forced repaint clears it.
 *
 *   Every package is already forbidden from writing there, and the one path
 *   that did — a component logger pinned above a silenced root — is fixed at
 *   its source in `@clarvis/kernel`'s `createComponentLoggers`. This closes the
 *   *class*: a dependency this package does not control, a pino default, or an
 *   uncaught rejection's own trace can each still reach the terminal, and none
 *   of them should be able to corrupt the canvas.
 *
 *   **Both `process.stderr.write` and `console.*` must be taken, because in Bun
 *   they are not the same path.** Patching `process.stderr.write` alone leaves
 *   `console.warn` writing straight to the terminal — measured directly: with
 *   the writer replaced, a `console.warn` and a `console.error` both still
 *   reached the terminal while only the direct `process.stderr.write` was
 *   captured. That gap is not hypothetical; `@opentui/core`'s own reconciler
 *   calls `console.warn("… being inserted, skipping insertBefore")` on a render
 *   race, and it was observed overwriting the composer placeholder mid-word and
 *   persisting for more than forty seconds, clearing only on an external
 *   terminal resize. `tests/unit/terminal-guard.test.ts` holds the rule.
 *
 *   Withholding rather than discarding is the point. A crash's stack trace is
 *   exactly what a user needs and it arrives on this descriptor, so the bytes
 *   are buffered — oldest dropped past {@link MAX_DEFERRED_BYTES} — and printed
 *   when the guard is lifted, after teardown has restored the scrollback.
 */
export function installTerminalGuard(): () => void {
  const original: StderrWrite = process.stderr.write.bind(process.stderr);
  const deferred: Buffer[] = [];
  let deferredBytes = 0;
  let active = true;

  const keep = (chunk: Buffer): void => {
    deferred.push(chunk);
    deferredBytes += chunk.byteLength;
    while (deferredBytes > MAX_DEFERRED_BYTES && deferred.length > 1) {
      deferredBytes -= deferred.shift()!.byteLength;
    }
  };

  const guarded = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const done = typeof encoding === "function" ? encoding : callback;
    keep(
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : Buffer.from(chunk),
    );
    done?.(null);
    return true;
  }) as StderrWrite;

  process.stderr.write = guarded;

  const restoreConsole = CONSOLE_METHODS.map((method) => {
    const previous = console[method] as (...args: unknown[]) => void;
    console[method] = ((...args: unknown[]): void => {
      keep(Buffer.from(`${format(...args)}\n`, "utf8"));
    }) as Console[typeof method];
    return (): void => {
      console[method] = previous as Console[typeof method];
    };
  });

  return (): void => {
    if (!active) return;
    active = false;
    process.stderr.write = original;
    for (const restore of restoreConsole) restore();
    if (deferred.length === 0) return;
    const pending = Buffer.concat(deferred);
    deferred.length = 0;
    deferredBytes = 0;
    try {
      original(pending);
    } catch {
      /* ignore */
    }
  };
}
