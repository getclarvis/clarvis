/**
 * Terminal attention cues: desktop notifications (OSC, terminal-mediated) and
 * the terminal tab title, so a run that blocks on approval or settles while
 * the user is in another window actually reaches them. Every call is guarded
 * by the renderer's detected capabilities — headless/test renderers no-op.
 */

/** The slice of CliRenderer this helper drives, structural so tests can fake it. */
export interface AttentionRenderer {
  readonly capabilities: { notifications?: boolean; focus_tracking?: boolean } | null;
  triggerNotification(message: string, title?: string): boolean;
  setTerminalTitle(title: string): void;
  on(event: "focus" | "blur", listener: () => void): unknown;
}

export type AttentionState = "running" | "waiting for approval" | null;

export interface Attention {
  /** Ask the terminal for a desktop notification; no-op without the capability. */
  notify(message: string, title?: string): void;
  /** Mirror the app state in the terminal title (`clarvis — <state>`). */
  setTitle(state: AttentionState): void;
  /** Whether a settle notification adds signal: the terminal reported blur, or
   * it cannot report focus at all — then the terminal decides presentation. */
  away(): boolean;
}

const BASE_TITLE = "clarvis";

/**
 * Builds an {@link Attention} driven by the renderer's capabilities and
 * focus/blur events.
 *
 * @param renderer - The renderer slice to observe and drive.
 * @returns The attention controller.
 */
export function createAttention(renderer: AttentionRenderer): Attention {
  let focused = true;
  renderer.on("focus", () => {
    focused = true;
  });
  renderer.on("blur", () => {
    focused = false;
  });
  return {
    notify(message, title = BASE_TITLE) {
      if (renderer.capabilities?.notifications !== true) return;
      renderer.triggerNotification(message, title);
    },
    setTitle(state) {
      if (!renderer.capabilities) return;
      renderer.setTerminalTitle(state ? `${BASE_TITLE} — ${state}` : BASE_TITLE);
    },
    away() {
      if (renderer.capabilities?.focus_tracking === true) return !focused;
      return true;
    },
  };
}
