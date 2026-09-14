import type { testRender } from "@opentui/solid";

type Rendered = Awaited<ReturnType<typeof testRender>>;

/** Drain one known reactive/event-loop turn and paint it immediately. */
export async function flush(t: Rendered): Promise<string> {
  await Bun.sleep(0);
  await t.renderOnce();
  return t.captureCharFrame();
}

/** Wait for an observable frame predicate with a diagnostic fuse. */
export async function until(
  t: Rendered,
  predicate: (frame: string) => boolean,
  label: string,
  maxIters = 120,
): Promise<string> {
  let frame = t.captureCharFrame();
  for (let attempt = 0; attempt < maxIters; attempt += 1) {
    if (predicate(frame)) return frame;
    frame = await flush(t);
  }
  throw new Error(
    `render until ${label} timed out after ${String(maxIters)} turns.\nLast frame:\n${frame}`,
  );
}

/**
 * Render frames until `needle` appears, then return the frame containing it.
 *
 * OpenTUI coalesces frames, so a capture taken right after a keypress catches a
 * stale one; polling is the only reliable way to observe the result of an
 * interaction. Giving up **throws** rather than returning the last frame: a wait
 * that silently expires turns every `await captureUntil(...)` with no follow-up
 * assertion into a sleep, and a renamed label stops being caught by anything.
 *
 * @param t - the `testRender` handle to drive.
 * @param needle - substring expected to appear in the rendered frame.
 * @param maxIters - render attempts before giving up. Each attempt yields one
 *   event-loop turn and renders explicitly; no wall-clock delay is used.
 * @returns the first frame containing `needle`.
 * @throws if `needle` never appears; the message carries the frame so the
 *   failure shows what *was* on screen.
 */
export async function captureUntil(t: Rendered, needle: string, maxIters = 120): Promise<string> {
  return until(t, (frame) => frame.includes(needle), JSON.stringify(needle), maxIters);
}
