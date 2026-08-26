/** Cancel a timeout that has not fired yet. */
export type CancelTimeout = () => void;

/** Narrow timeout port used by async state machines in deterministic tests. */
export type ScheduleTimeout = (callback: () => void, delayMs: number) => CancelTimeout;

/** Production scheduler backed by the host timer API. */
export const scheduleSystemTimeout: ScheduleTimeout = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};
