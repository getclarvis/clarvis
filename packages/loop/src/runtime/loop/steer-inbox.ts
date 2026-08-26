/**
 * A buffering wrapper over the run's {@link SteerSource}, so a steer's *arrival*
 * can be observed without consuming it.
 *
 * @remarks A `SteerSource` is pull-only by contract — `drain()`, with no arrival
 * signal — and the kernel's queue behind it is the same. That is fine while the
 * only reader is the loop itself, but it makes an interruptible idle impossible:
 * anything that wants to wake on a steer has to pull, and pulling swallows the
 * message the loop was about to deliver at the next iteration.
 *
 * The inbox splits the two: `probe()` pulls into a local buffer and reports
 * whether anything is there, `take()` hands the buffer to the loop's own drain.
 * A message is therefore delivered exactly once, through the existing path that
 * records `user_steering` and resets the progress tracker — polling never
 * short-circuits it.
 */
import { sanitizeErrorMessage } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { SteerMessage, SteerSource } from "@clarvis/capability";

/** A pull-once, observe-many view of a {@link SteerSource}. */
export interface SteerInbox {
  /** Pull anything pending into the buffer, then hand it over and clear it. */
  take(): SteerMessage[];
  /** Pull into the buffer without consuming; true when anything is buffered. */
  probe(): boolean;
  /** Close the underlying source. */
  close(): void;
}

/**
 * Wrap a {@link SteerSource} in a {@link SteerInbox}.
 *
 * @param source - the run's steer channel.
 * @param logger - optional; a throwing `drain()` is logged and treated as empty,
 *   preserving the loop's existing tolerance for a misbehaving source.
 */
export function createSteerInbox(source: SteerSource, logger?: Logger): SteerInbox {
  let buffered: SteerMessage[] = [];

  const pull = (): void => {
    try {
      const pending = source.drain();
      if (pending.length > 0) buffered.push(...pending);
    } catch (err) {
      logger?.warn(
        {
          event: "steer.drain_failed",
          err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "steer source drain threw; treating as empty",
      );
    }
  };

  return {
    take(): SteerMessage[] {
      pull();
      const out = buffered;
      buffered = [];
      return out;
    },
    probe(): boolean {
      pull();
      return buffered.length > 0;
    },
    close(): void {
      source.close?.();
    },
  };
}
