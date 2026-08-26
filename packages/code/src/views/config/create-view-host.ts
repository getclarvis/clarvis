import { createEffect, createRoot, createSignal, on, type Accessor } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { ConfirmRequest, Scope, ViewHost } from "../../keys/commands.ts";
import { useArmedConfirm, type ArmedConfirm } from "../confirm.ts";

/** Imperative controls the shell around a config view uses to drive it (save-on-close, escape, teardown). */
export interface ViewHostControls {
  /** Runs the view's registered save handler, if any, and awaits it. */
  runSave(): Promise<void>;
  /**
   * Whether the mounted view has called {@link ViewHost.bindScope}.
   *
   * @remarks The shell registers one `view.scope.toggle` command for every view
   *   it mounts, so this is what tells it whether toggling would do anything.
   *   A read-only screen (Sessions, Workflows, Marketplace, MCP, Doctor, Help,
   *   the diff viewer) never binds a scope, and advertising `[^t] scope` in its
   *   footer offered an action guaranteed to be a silent no-op.
   */
  scopeBound: Accessor<boolean>;
  /**
   * Handles an escape keypress: pops a level, confirms a discard, or closes the view.
   *
   * @remarks The dirty-checked close, and the only one any user-facing path may use: with unsaved
   * edits it asks "Discard unsaved changes?" and closes only on a yes.
   */
  escape(): void;
  /**
   * Tears down the view's internal reactive root and pending confirm/cancel state.
   *
   * @remarks The *forced* teardown: it settles any pending confirm as `false`, runs the cancel
   * handler and drops the save handler with **no dirty check**, so unsaved edits are discarded
   * silently. {@link ViewHostControls.escape} is the dirty-checked path; a caller that can fire
   * while the user is mid-edit must reach the view through that, never through here.
   */
  dispose(): void;
}

/** The pair a config view's caller receives from {@link createViewHost}. */
export interface ViewHostBundle {
  /** The `ViewHost` passed into the view's render function. */
  host: ViewHost;
  /** The imperative controls the caller drives the view with. */
  controls: ViewHostControls;
}

/**
 * Builds the {@link ViewHost} + {@link ViewHostControls} pair shared by every
 * config view: navigation depth/breadcrumbs, scope (global/workspace)
 * toggling with an unsaved-changes guard, dirty tracking, save/cancel
 * handler registration, and an armed (two-step) confirm prompt.
 */
export function createViewHost(opts: {
  interaction: Interaction;
  active?: Accessor<boolean>;
  close: () => void;
  back?: () => void;
  dispatch: (name: string) => void;
  initialScope?: Scope;
}): ViewHostBundle {
  const [depth, setDepth] = createSignal(0);
  const [crumbs, setCrumbs] = createSignal<string[]>([]);
  const [scope, setScope] = createSignal<Scope>(opts.initialScope ?? "global");
  const [dirty, setDirty] = createSignal(false);
  const active = opts.active ?? (() => true);
  const [scopeBound, setScopeBound] = createSignal(false);
  let saveHandler: (() => void | Promise<void>) | null = null;
  let saveInFlight: Promise<void> | null = null;
  let cancelHandler: (() => void) | null = null;
  let scopeMode: "reload" | "retarget" = "retarget";
  let scopeLoad: (() => void) | undefined;

  let confirmResolve: ((value: boolean) => void) | null = null;
  const settle = (value: boolean): void => {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve?.(value);
  };
  let armedConfirm!: ArmedConfirm<ConfirmRequest>;
  const disposeConfirm = createRoot((dispose) => {
    armedConfirm = useArmedConfirm<ConfirmRequest>(opts.interaction.keymap, {
      message: (o) => o.message,
      acceptLabel: (o) => o.confirmLabel,
      cancelLabel: (o) => o.cancelLabel,
      onYes: () => settle(true),
      active,
    });
    createEffect(
      on(
        armedConfirm.armed,
        (armed) => {
          if (armed === null) queueMicrotask(() => settle(false));
        },
        { defer: true },
      ),
    );
    return dispose;
  });

  const confirm = (o: ConfirmRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (armedConfirm.armed()) {
        resolve(false);
        return;
      }
      confirmResolve = resolve;
      armedConfirm.arm(o);
    });

  const host: ViewHost = {
    interaction: opts.interaction,
    active,
    close: opts.close,
    dispatch: opts.dispatch,
    level: {
      depth,
      push: (title) => {
        setCrumbs((c) => [...c, title]);
        setDepth((d) => d + 1);
      },
      pop: () => {
        if (depth() <= 0) return false;
        setCrumbs((c) => c.slice(0, -1));
        setDepth((d) => d - 1);
        return true;
      },
      retitle: (title) => {
        setCrumbs((c) => (c.length === 0 ? c : [...c.slice(0, -1), title]));
      },
    },
    breadcrumb: crumbs,
    scope,
    toggleScope: () => {
      const apply = (): void => {
        setScope((s) => (s === "global" ? "workspace" : "global"));
        scopeLoad?.();
      };
      if (scopeMode === "reload" && dirty()) {
        detachObserved("view_scope_confirm", () =>
          confirm({
            message:
              "Unsaved changes " + glyph("emDash") + " switching scope discards them. Switch?",
            danger: true,
          }).then((ok) => {
            if (ok) apply();
          }),
        );
        return;
      }
      apply();
    },
    bindScope: (o) => {
      scopeMode = o.mode;
      scopeLoad = o.load;
      setScopeBound(true);
    },
    dirty,
    markDirty: (v = true) => setDirty(v),
    onSave: (fn) => {
      saveHandler = fn;
    },
    onCancel: (fn) => {
      cancelHandler = fn;
    },
    confirm,
    pendingConfirm: armedConfirm.armed,
  };

  const runCancel = (): void => {
    const fn = cancelHandler;
    cancelHandler = null;
    fn?.();
  };

  const controls: ViewHostControls = {
    runSave() {
      if (saveInFlight) return saveInFlight;
      const handler = saveHandler;
      if (!handler) return Promise.resolve();
      let operation: Promise<void>;
      try {
        operation = Promise.resolve(handler());
      } catch (error) {
        operation = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      const tracked = operation.finally(() => {
        if (saveInFlight === tracked) saveInFlight = null;
      });
      saveInFlight = tracked;
      return tracked;
    },
    scopeBound,
    escape() {
      if (armedConfirm.armed()) return;
      if (host.level.pop()) return;
      if (dirty()) {
        detachObserved("view_close_confirm", () =>
          host.confirm({ message: "Discard unsaved changes?", danger: true }).then((ok) => {
            if (ok) {
              runCancel();
              (opts.back ?? opts.close)();
            }
          }),
        );
        return;
      }
      runCancel();
      (opts.back ?? opts.close)();
    },
    dispose() {
      disposeConfirm();
      settle(false);
      runCancel();
      saveHandler = null;
    },
  };

  return { host, controls };
}
