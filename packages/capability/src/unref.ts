/**
 * Best-effort `unref()` on a timer so it does not keep the process alive.
 *
 * @param timer - a timer handle (or anything); a missing `unref` method is a
 *   no-op, so this is safe across runtimes where the handle shape differs.
 */
export function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}
