/** One deadline shared by every review attempt. */
export function reviewDeadline(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; remaining(): number; close(): void } {
  const controller = new AbortController();
  const expires = Date.now() + timeoutMs;
  const onAbort = (): void => controller.abort(external?.reason);
  external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("judge deadline exceeded")), timeoutMs);
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, expires - Date.now()),
    close() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}
