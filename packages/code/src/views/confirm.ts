import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { detachObserved } from "../core/tasks.ts";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { LAYER } from "../ui/patterns/level-keys.ts";
import { uiCommand } from "../keys/actions.ts";

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;

/** A two-step ("press again") confirmation gate armed against a specific `target`. */
export interface ArmedConfirm<T> {
  armed: Accessor<T | null>;
  message: Accessor<string | null>;
  arm: (target: T) => void;
  disarm: () => void;
}

/**
 * Builds an {@link ArmedConfirm}: `arm(target)` registers a keymap layer so
 * `y` calls `onYes(target)` and `n`/`escape` disarm; navigation keys are
 * swallowed (bound to a no-op) so a confirm prompt does not leak scroll/move
 * commands to whatever is behind it. Disarms automatically on unmount and,
 * if `watch` is given, whenever any watched accessor changes.
 *
 * @param opts.acceptLabel - footer verb for `y`, derived from the armed target;
 *   defaults to `"confirm"`.
 * @param opts.cancelLabel - footer verb for `n`/`escape`; defaults to
 *   `"cancel"`.
 * @remarks The two labels are read per `arm` rather than fixed at build time,
 *   which is what lets a caller name the sides of its own prompt
 *   ("uninstall"/"keep", "Overwrite"/"Keep current"). A generic
 *   `[y] confirm  [n] cancel` cannot say which side is the destructive one.
 *
 *   Both commands are `essential`, because since `ViewFrame` stopped printing a
 *   static `[y]/[n]` row this footer is the *only* place the pair appears, and a
 *   budget that can drop one of them leaves a prompt the user cannot decline.
 */
export function useArmedConfirm<T>(
  keymap: OpenTuiKeymap,
  opts: {
    message: (target: T) => string;
    onYes: (target: T) => void | Promise<void>;
    acceptLabel?: (target: T) => string | undefined;
    cancelLabel?: (target: T) => string | undefined;
    watch?: Accessor<unknown> | Accessor<unknown>[];
    priority?: number;
    active?: Accessor<boolean>;
  },
): ArmedConfirm<T> {
  const [armed, setArmed] = createSignal<T | null>(null);

  let off: (() => void) | undefined;
  const disarm = (): void => {
    off?.();
    off = undefined;
    setArmed(null);
  };
  onCleanup(disarm);

  if (opts.watch) {
    const deps = Array.isArray(opts.watch) ? opts.watch : [opts.watch];
    createEffect(on(deps, () => disarm(), { defer: true }));
  }

  const noop = (): void => {};
  createEffect(() => {
    const target = armed();
    const active = opts.active?.() ?? true;
    off?.();
    off = undefined;
    if (target === null || !active) return;
    const acceptLabel = opts.acceptLabel?.(target)?.trim() || "confirm";
    const cancelLabel = opts.cancelLabel?.(target)?.trim() || "cancel";
    off = keymap.registerLayer({
      priority: opts.priority ?? LAYER.CONFIRM,
      commands: [
        uiCommand({
          id: "confirm.accept",
          title: `Confirm: ${acceptLabel}`,
          description: `Confirm the pending action (${acceptLabel})`,
          category: "primary",
          surfaces: ["footer"],
          footerLabel: acceptLabel,
          hintPriority: 100,
          hintGroup: "primary",
          essential: true,
          run: () => {
            disarm();
            detachObserved("confirmed_action", () => opts.onYes(target));
          },
        }),
        uiCommand({
          id: "confirm.cancel",
          title: `Cancel: ${cancelLabel}`,
          description: `Leave the current item unchanged (${cancelLabel})`,
          category: "escape",
          surfaces: ["footer"],
          footerLabel: cancelLabel,
          hintPriority: 95,
          hintGroup: "escape",
          essential: true,
          run: disarm,
        }),
      ],
      bindings: [
        { key: "y", cmd: "confirm.accept" },
        { key: "n", cmd: "confirm.cancel" },
        { key: "escape", cmd: "confirm.cancel" },
        ...["up", "down", "k", "j", "pageup", "pagedown", "home", "end", "return"].map((key) => ({
          key,
          cmd: noop,
        })),
      ],
    });
  });

  function arm(target: T): void {
    if (armed() !== null) return;
    setArmed(() => target);
  }

  return {
    armed,
    message: () => {
      const target = armed();
      return target === null ? null : opts.message(target);
    },
    arm,
    disarm,
  };
}
