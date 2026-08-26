import type { Accessor } from "solid-js";
import { createSignal, onCleanup } from "solid-js";
import type { NoticeTone } from "../ui/notice.ts";

/** The color/severity a transient hint message renders with. */
export type HintTone = NoticeTone;

/** A reactive, self-clearing hint line and the `notify` function that sets it. */
export interface HintState {
  hint: Accessor<{ text: string; tone: HintTone }>;
  notify: (message: string, tone?: HintTone) => void;
}

interface HintClock {
  after(callback: () => void, delayMs: number): () => void;
}

const systemHintClock: HintClock = {
  after(callback, delayMs) {
    const id = setTimeout(callback, delayMs);
    return () => clearTimeout(id);
  },
};

/**
 * Creates a {@link HintState}: `notify` replaces the current hint and, unless
 * the message is empty, clears it again after 4 seconds (each call resets the
 * timer).
 */
export function createHintState(clock: HintClock = systemHintClock): HintState {
  const [hint, setHint] = createSignal<{ text: string; tone: HintTone }>({
    text: "",
    tone: "info",
  });
  let cancelTimer: (() => void) | undefined;
  onCleanup(() => cancelTimer?.());
  return {
    hint,
    notify: (message, tone = "info") => {
      setHint({ text: message, tone });
      cancelTimer?.();
      cancelTimer = undefined;
      if (message) {
        cancelTimer = clock.after(() => {
          cancelTimer = undefined;
          setHint({ text: "", tone: "info" });
        }, 4000);
      }
    },
  };
}
