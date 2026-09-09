import type { HintTone } from "./hint.ts";

/** The state {@link createQuitConfirm} checks to decide whether quitting needs confirmation. */
export interface QuitConfirmDeps {
  isDirtyView: () => boolean;
  /** True when quitting would abandon or cancel the current run, excluding hosted continue policy. */
  isRunAtRisk: () => boolean;
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
 * The gate also arms whenever work would be lost: a dirty view or a run that
 * will be cancelled on exit. A hosted run with confirmed continuation is not
 * at risk merely because it is active. This gate never changes host policy
 * or grants tool consent; the caller supplies the current risk projection.
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
      const runAtRisk = deps.isRunAtRisk();
      const atStake = dirtyView || runAtRisk;
      if ((confirm || atStake) && !pending) {
        pending = true;
        const why = dirtyView
          ? " (unsaved changes)"
          : runAtRisk
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
