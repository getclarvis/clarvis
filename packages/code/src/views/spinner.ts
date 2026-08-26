import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { asciiMode } from "../theme/glyphs.ts";

/** Unicode spinner animation frames, cycled by the shared clock in {@link useSpinnerClock}. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** ASCII fallback spinner frames, used when {@link charForFrame}'s `ascii` mode is on. */
export const SPINNER_ASCII = ["-", "\\", "|", "/"] as const;

const THINKING_FRAMES = ["...", ".. ", ".  ", ".  ", ".. ", "..."] as const;

const TICK_MS = 200;
const FRAME_CAP = 1_000_000;

const [frame, setFrame] = createSignal(0);

interface SpinnerClock {
  every(callback: () => void, intervalMs: number): () => void;
}

const systemSpinnerClock: SpinnerClock = {
  every(callback, intervalMs) {
    const id = setInterval(callback, intervalMs);
    return () => clearInterval(id);
  },
};

function spinnerFrame(): number {
  return frame();
}

/** The glyph for animation `index`, wrapped into range; picks {@link SPINNER_ASCII} when `ascii`. */
export function charForFrame(index: number, ascii = asciiMode()): string {
  const frames = ascii ? SPINNER_ASCII : SPINNER_FRAMES;
  return frames[((index % frames.length) + frames.length) % frames.length]!;
}

/** The current shared spinner glyph, reactive to {@link useSpinnerClock}'s tick. */
export function spinnerChar(): string {
  return charForFrame(frame());
}

/** The current (or given) "thinking…" ellipsis animation frame. */
export function thinkingDots(index = frame()): string {
  return THINKING_FRAMES[
    ((index % THINKING_FRAMES.length) + THINKING_FRAMES.length) % THINKING_FRAMES.length
  ]!;
}

/**
 * `Date.now()`, read through the shared spinner signal so callers recompute
 * on every tick without depending on `Date.now()` directly (which Solid
 * cannot track).
 */
export function tickNow(): number {
  return (spinnerFrame(), Date.now());
}

export { formatElapsed } from "../core/format-elapsed.ts";

/**
 * Drives the shared spinner frame signal on a {@link TICK_MS} interval while
 * `active()` is true, tearing the interval down on cleanup or when `active`
 * goes false. One clock is shared process-wide, so every spinner/tick-now
 * consumer advances in lockstep.
 */
export function useSpinnerClock(
  active: Accessor<boolean>,
  clock: SpinnerClock = systemSpinnerClock,
): void {
  createEffect(() => {
    if (!active()) return;
    const cancel = clock.every(() => setFrame((f) => (f + 1) % FRAME_CAP), TICK_MS);
    onCleanup(cancel);
  });
}
