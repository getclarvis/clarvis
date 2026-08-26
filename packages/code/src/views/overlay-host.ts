import type { Accessor } from "solid-js";
import { createRoot, createSignal } from "solid-js";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { Interaction, OverlayKind } from "../keys/interaction.ts";
import type { CommandUi, ViewFactory, ViewHost, ViewRoute } from "../keys/commands.ts";
import { createViewHost, type ViewHostControls } from "./config/view-host.tsx";
import { LAYER } from "../ui/patterns/level-keys.ts";
import { errorText } from "../adapters/errors.ts";
import type { HintTone } from "./hint.ts";
import { uiCommand } from "../keys/actions.ts";
import { diagnosticCount, diagnosticEvent } from "../core/diagnostic-events.ts";

/** One mounted page in the config-view navigation stack. */
export interface MountedView {
  name: string;
  factory: ViewFactory;
  host: ViewHost;
}

interface ActiveMountedView extends MountedView {
  setActive(value: boolean): void;
  controls: ViewHostControls;
  dispose(): void;
}

/** The host callbacks {@link createOverlayHost} needs to drive overlays and route commands. */
export interface OverlayHostDeps {
  interaction: () => Interaction;
  runCommand: (name: string) => void;
  focusInput: () => void;
  notify: (message: string, tone?: HintTone) => void;
  /**
   * Whether a shell-owned transient overlay is on screen.
   *
   * @remarks These overlays are owned by the shell rather than by this host, so
   *   without being told about them {@link OverlayHost.openPicker}'s
   *   "close the current overlay first" guard cannot see them: `shift+tab`,
   *   `ctrl+p` / `alt+p` and the transcript's plan route could otherwise mount a picker underneath
   *   a live transient and push a second overlay context, leaving the keymap's
   *   `overlay` stack out of step with the screen — so `overlay==none` bindings
   *   stayed dead after everything had been closed.
   */
  transientOpen?: () => boolean;
}

/** Tracks which overlay (if any) is mounted and mediates opening/dismissing it. */
export interface OverlayHost {
  overlay: Accessor<OverlayKind>;
  /** The complete mounted view stack, oldest page first. */
  views: Accessor<readonly MountedView[]>;
  /** The visible top page, retained as a convenience for screen labels and tests. */
  view: Accessor<MountedView | null>;
  /** Whether any mounted page has staged changes. */
  viewDirty(): boolean;
  /**
   * Mount a picker overlay.
   *
   * @param onClose - run once when this picker closes, however it closes.
   * @remarks The hook exists so a picker opened *from* a config view can put the
   *   user back on it. A picker cannot mount over a view, so the Workflows hub
   *   closes itself before opening the agent picker — and one Escape then landed
   *   on the root screen, two semantic levels from where the user was
   *   (invariant 5).
   */
  openPicker(kind: OverlayKind, onClose?: () => void): boolean;
  /** Dismisses the complete top-level overlay. A view overlay disposes its whole page stack. */
  dismissTop(): boolean;
  /** Background-safe dismissal that refuses to discard a dirty page anywhere in the stack. */
  dismissTopUnlessDirty(opts: { reason: string }): boolean;
  /** Suspend/resume the mounted view's key layers without unmounting its draft. */
  setInteractionBlocked(blocked: boolean): void;
  setRecheck(fn: () => void): void;
  /** Dispose mounted view frames and release the overlay keymap context. */
  dispose(): void;
  ui: CommandUi;
}

/**
 * Builds the overlay host. Config destinations form a real mounted page stack:
 * opening a child deactivates (but does not unmount) its parent, and Escape on
 * the child pops only that frame. Pickers/diff/plan remain single overlays.
 */
export function createOverlayHost(deps: OverlayHostDeps): OverlayHost {
  const [overlay, setOverlay] = createSignal<OverlayKind>("none");
  const [viewFrames, setViewFrames] = createSignal<ActiveMountedView[]>([]);
  let recheck: () => void = () => {};
  let pickerReturn: (() => void) | undefined;
  let disposed = false;
  let interactionBlocked = false;

  const view = (): MountedView | null => viewFrames().at(-1) ?? null;

  function finishOverlayClose(refocus = true): void {
    if (overlay() === "none") return;
    setOverlay("none");
    deps.interaction().popOverlayContext();
    const back = pickerReturn;
    pickerReturn = undefined;
    if (refocus) deps.focusInput();
    back?.();
  }

  function disposeFrame(frame: ActiveMountedView): void {
    diagnosticCount("view.disposed", { name: frame.name }, `view.disposed.${frame.name}`);
    frame.dispose();
  }

  function closeViewStack(): void {
    const mounted = viewFrames();
    setViewFrames([]);
    for (const frame of [...mounted].reverse()) disposeFrame(frame);
  }

  function popView(frame: ActiveMountedView): void {
    const mounted = viewFrames();
    if (mounted.at(-1) !== frame) return;
    const rest = mounted.slice(0, -1);
    disposeFrame(frame);
    setViewFrames(rest);
    const parent = rest.at(-1);
    if (parent) {
      recheck();
      parent.setActive(!interactionBlocked);
      return;
    }
    finishOverlayClose();
  }

  function dismissTop(): boolean {
    if (disposed || overlay() === "none") return false;
    if (overlay() === "view") closeViewStack();
    finishOverlayClose();
    return true;
  }

  function dismissTopUnlessDirty(opts: { reason: string }): boolean {
    if (disposed || overlay() === "none") return false;
    if (viewFrames().some((frame) => frame.host.dirty())) {
      deps.notify(opts.reason, "warn");
      return false;
    }
    return dismissTop();
  }

  function mountView(route: ViewRoute, initiallyActive: boolean): ActiveMountedView {
    diagnosticCount(
      "view.mounted",
      { name: route.name, initiallyActive },
      `view.mounted.${route.name}`,
    );
    const interaction = deps.interaction();
    const [active, setActive] = createSignal(initiallyActive);
    let goBack = (): void => {};
    const { host, controls } = createViewHost({
      interaction,
      active,
      close: () => goBack(),
      back: () => goBack(),
      dispatch: (name) => deps.runCommand(name),
      initialScope: route.scope,
    });

    const disposeKeys = createRoot((dispose) => {
      const enabled = reactiveMatcherFromSignal(active);
      const offKeys = interaction.keymap.registerLayer({
        enabled,
        priority: LAYER.LIST,
        commands: [
          uiCommand({
            id: "view.save",
            title: "Save changes",
            description: "Save staged changes to disk",
            category: "mutation",
            surfaces: ["footer"],
            footerLabel: "save",
            hintPriority: 70,
            hintGroup: "mutation",
            enabled: () => host.dirty() && !host.pendingConfirm(),
            run: () =>
              controls
                .runSave()
                .catch((error: unknown) =>
                  deps.notify(`save failed: ${errorText(error)}`, "error"),
                ),
          }),
          uiCommand({
            id: "view.scope.toggle",
            title: "Toggle scope",
            description: "Switch between global and workspace configuration",
            category: "navigation",
            surfaces: ["footer"],
            footerLabel: "scope",
            hintPriority: 35,
            hintGroup: "navigation",
            enabled: () => controls.scopeBound() && !host.pendingConfirm(),
            run: () => host.toggleScope(),
          }),
          uiCommand({
            id: "view.escape",
            title: "Back or close",
            description: "Move up one level, then return to the previous page",
            category: "escape",
            surfaces: ["footer"],
            footerLabel: "back / close",
            hintPriority: 100,
            hintGroup: "escape",
            essential: true,
            run: () => controls.escape(),
          }),
        ],
        bindings: [
          { key: "ctrl+s", cmd: "view.save" },
          { key: "ctrl+t", cmd: "view.scope.toggle" },
        ],
      });
      const offEsc = interaction.keymap.registerLayer({
        enabled,
        priority: LAYER.OVERLAY,
        bindings: [{ key: "escape", cmd: "view.escape" }],
      });
      return () => {
        try {
          offKeys();
        } finally {
          try {
            offEsc();
          } finally {
            dispose();
          }
        }
      };
    });

    let frameDisposed = false;
    const frame: ActiveMountedView = {
      name: route.name,
      factory: route.factory,
      host,
      setActive,
      controls,
      dispose: () => {
        if (frameDisposed) return;
        frameDisposed = true;
        try {
          disposeKeys();
        } finally {
          controls.dispose();
        }
      },
    };
    goBack = () => popView(frame);
    return frame;
  }

  const ui: CommandUi = {
    openView: (name, factory, opts) => {
      if (disposed) return;
      deps.notify("");
      if (overlay() !== "none" && overlay() !== "view") {
        deps.notify("close the current overlay first", "warn");
        return;
      }

      const current = viewFrames().at(-1);
      if (current?.name === name) return;

      diagnosticEvent("view.opened", {
        name,
        parent: opts?.parent?.name,
        stackDepth: viewFrames().length + 1,
      });

      if (overlay() === "view") {
        current?.setActive(false);
        setViewFrames((frames) => [
          ...frames,
          mountView(
            { name, factory, ...(opts?.scope ? { scope: opts.scope } : {}) },
            !interactionBlocked,
          ),
        ]);
        return;
      }

      const mounted: ActiveMountedView[] = [];
      if (opts?.parent && opts.parent.name !== name) mounted.push(mountView(opts.parent, false));
      mounted.push(
        mountView(
          { name, factory, ...(opts?.scope ? { scope: opts.scope } : {}) },
          !interactionBlocked,
        ),
      );
      setViewFrames(mounted);
      setOverlay("view");
      deps.interaction().pushOverlayContext("view");
    },
    dismiss: () => dismissTop(),
    commandFailed: (name, error) => {
      if (!disposed) deps.notify(`${name} failed: ${errorText(error)}`, "error");
    },
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (overlay() === "view") closeViewStack();
    finishOverlayClose(false);
    recheck = () => {};
  }

  return {
    overlay,
    views: viewFrames,
    view,
    viewDirty: () => viewFrames().some((frame) => frame.host.dirty()),
    openPicker: (kind, onClose) => {
      if (disposed) return false;
      if (overlay() !== "none" || deps.transientOpen?.() === true) {
        deps.notify("close the current overlay first", "warn");
        return false;
      }
      pickerReturn = onClose;
      setOverlay(kind);
      deps.interaction().pushOverlayContext(kind);
      return true;
    },
    dismissTop,
    dismissTopUnlessDirty,
    setInteractionBlocked: (blocked) => {
      if (disposed || interactionBlocked === blocked) return;
      interactionBlocked = blocked;
      viewFrames().at(-1)?.setActive(!blocked);
    },
    setRecheck: (fn) => {
      if (!disposed) recheck = fn;
    },
    dispose,
    ui,
  };
}
