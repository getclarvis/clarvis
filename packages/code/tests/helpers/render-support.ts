import type { testRender } from "@opentui/solid";

type Rendered = Awaited<ReturnType<typeof testRender>>;

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
 * @param maxIters - render attempts before giving up (8ms apart).
 * @returns the first frame containing `needle`.
 * @throws if `needle` never appears; the message carries the frame so the
 *   failure shows what *was* on screen.
 */
export async function captureUntil(t: Rendered, needle: string, maxIters = 120): Promise<string> {
  let out = t.captureCharFrame();
  for (let i = 0; i < maxIters && !out.includes(needle); i++) {
    await new Promise((r) => setTimeout(r, 8));
    await t.renderOnce();
    out = t.captureCharFrame();
  }
  if (!out.includes(needle))
    throw new Error(
      `captureUntil: ${JSON.stringify(needle)} never rendered after ${maxIters} frames.\n` +
        `Last frame:\n${out}`,
    );
  return out;
}
