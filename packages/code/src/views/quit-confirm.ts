import type { HintTone } from "./hint.ts";

/** The state {@link createQuitConfirm} checks to decide whether quitting needs confirmation. */
export interface QuitConfirmDeps {
  isDirtyView: () => boolean;
  isRunActive: () => boolean;
  isDraftNonEmpty: () => boolean;
  notify: (message: string, tone?: HintTone) => void;
  quit: () => void;
}

/** The quit gate returned by {@link createQuitConfirm}. */
export interface QuitConfirm {
  quit: (opts: { confirm: boolean }) => void;
  disarm: () => void;
}

const CONFIRM_WINDOW_MS = 1500;

/**
 * Builds a "press again to quit" gate.
 *
 * @remarks
 * `confirm: true` always arms the gate — the first call only notifies and
 * starts a {@link CONFIRM_WINDOW_MS} window, and quitting happens on a second
 * call inside that window. `confirm: false` is for a caller that has already
 * spent a keystroke on the decision (the double-tap `^C` path, and `/quit`,
 * where typing the command is itself explicit): it quits immediately from a
 * state where nothing is at stake.
 *
 * **The gate still arms whenever work would be lost**, whatever the flag says —
 * a dirty view or a live run. It used to check only the dirty view, and
 * `/quit` passes `confirm: false`, so typing it mid-run discarded a run in
 * flight with no prompt at all. The `(run active)` branch of the message below
 * could not fire, which is the tell: the gate described a state it never
 * reached.
 *
 * A non-empty *draft* is deliberately not in that set on this path. Running
 * `/quit` from the composer leaves the command itself sitting in the draft, so
 * counting it would make the slash command arm against its own text.
 */
export function createQuitConfirm(deps: QuitConfirmDeps): QuitConfirm {
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function disarm(): void {
    pending = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return {
    disarm,
    quit: ({ confirm }) => {
      const dirtyView = deps.isDirtyView();
      const atStake = dirtyView || deps.isRunActive();
      if ((confirm || atStake) && !pending) {
        pending = true;
        const why = dirtyView
          ? " (unsaved changes)"
          : deps.isRunActive()
            ? " (run active)"
            : deps.isDraftNonEmpty()
              ? " (draft unsaved)"
              : "";
        deps.notify(`press again to quit${why}`, "warn");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          pending = false;
          timer = undefined;
          deps.notify("");
        }, CONFIRM_WINDOW_MS);
        return;
      }
      deps.quit();
    },
  };
}
