import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { ViewHost } from "../../keys/commands.ts";

interface EditingState {
  editing: Accessor<object | null>;
}

/**
 * Registers a level's key layer once per structural spec and gates it while the
 * level is inactive, editing, confirming, or explicitly suspended.
 *
 * @param opts.register - Installs the level's key layer with its reactive gate and returns its own unregister function.
 * @param opts.editor - Optional editing-state accessor; a non-null value suppresses registration.
 * @param opts.host - Optional host whose pending confirm suppresses registration while active.
 * @param opts.suspend - Optional extra predicate that suppresses registration when true.
 * @remarks Signals read while building the structural spec still replace the layer. Lifecycle-only
 *   changes update the supplied gate without allocating another layer registration.
 */
export function bindLevelKeys(opts: {
  register: (enabled: Accessor<boolean>) => (() => void) | undefined;
  editor?: EditingState;
  host?: Pick<ViewHost, "active" | "pendingConfirm">;
  suspend?: () => boolean;
}): void {
  let off: (() => void) | undefined;
  const enabled = (): boolean =>
    (opts.editor?.editing() ?? null) === null &&
    (opts.host?.pendingConfirm() ?? null) === null &&
    (opts.host?.active() ?? true) &&
    !(opts.suspend?.() ?? false);
  createEffect(() => {
    off?.();
    off = opts.register(enabled);
  });
  onCleanup(() => off?.());
}
