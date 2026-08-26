import type { BoxRenderable } from "@opentui/core";
import { Portal } from "@opentui/solid";
import type { Accessor, JSX } from "solid-js";
import {
  createContext,
  createEffect,
  createMemo,
  on,
  onCleanup,
  Show,
  untrack,
  useContext,
} from "solid-js";

/** Whether a closed surface disposes its Solid/OpenTUI tree or keeps one bounded instance. */
export type SurfaceRetention = "dispose-on-close" | "retain-one";

/** Reactive ownership shared by a surface host and every component mounted below it. */
export interface SurfaceLifecycle {
  /** True only while this surface owns visible interaction. */
  active: Accessor<boolean>;
  /** True while the Solid/OpenTUI subtree is instantiated. */
  mounted: Accessor<boolean>;
  /** Increments on every inactive-to-active transition, including the first mount. */
  activation: Accessor<number>;
  /** Explicit close policy chosen by the host. */
  retention: SurfaceRetention;
}

const SurfaceLifecycleContext = createContext<SurfaceLifecycle>();

type SurfaceBoundaryProps =
  | {
      active: Accessor<boolean>;
      retention: SurfaceRetention;
      placement?: "region";
      children: (lifecycle: SurfaceLifecycle) => JSX.Element;
    }
  | {
      active: Accessor<boolean>;
      retention: "retain-one";
      placement: "portal";
      children: (lifecycle: SurfaceLifecycle) => JSX.Element;
    };

/** Returns the nearest surface lifecycle, when the component also supports standalone rendering. */
export function useOptionalSurfaceLifecycle(): SurfaceLifecycle | undefined {
  return useContext(SurfaceLifecycleContext);
}

/** Returns the nearest surface lifecycle and fails when a lifecycle-owned component escaped its host. */
export function useSurfaceLifecycle(): SurfaceLifecycle {
  const lifecycle = useOptionalSurfaceLifecycle();
  if (!lifecycle) throw new Error("surface lifecycle is unavailable outside SurfaceBoundary");
  return lifecycle;
}

/**
 * Owns lazy first mount and the explicit disposal/retention policy for one interactive surface.
 *
 * @remarks A retained boundary keeps exactly one subtree after its first activation. Components
 *   below it must consume {@link SurfaceLifecycle.active} to disable their visual and non-visual
 *   behavior while hidden. Portal placement requires `retain-one`: mutating OpenTUI's Portal host
 *   while a conditional descendant is being recursively disposed leaves orphaned lifecycle-pass
 *   renderables.
 */
export function SurfaceBoundary(props: SurfaceBoundaryProps): JSX.Element {
  const initiallyActive = untrack(props.active);
  let everMounted = initiallyActive;
  let observedActive = initiallyActive;
  const activation = createMemo(
    (previous: number): number => {
      const active = props.active();
      const next = active && !observedActive ? previous + 1 : previous;
      observedActive = active;
      return next;
    },
    initiallyActive ? 1 : 0,
  );
  const mounted = (): boolean => {
    const active = props.active();
    activation();
    if (active) everMounted = true;
    return props.retention === "retain-one" ? everMounted : active;
  };
  const lifecycle: SurfaceLifecycle = {
    active: props.active,
    mounted,
    activation,
    retention: props.retention,
  };

  return (
    <SurfaceLifecycleContext.Provider value={lifecycle}>
      {props.placement === "portal" ? (
        <SurfacePortal visible={props.active}>
          <Show when={mounted()}>{props.children(lifecycle)}</Show>
        </SurfacePortal>
      ) : (
        <Show when={mounted()}>{props.children(lifecycle)}</Show>
      )}
    </SurfaceLifecycleContext.Provider>
  );
}

/** Runs one effect for each activation and disposes that effect on deactivation or unmount. */
export function onSurfaceActivate(effect: (activation: number) => void | (() => void)): void {
  const lifecycle = useSurfaceLifecycle();
  createEffect(
    on(lifecycle.active, (active) => {
      if (!active) return;
      const dispose = effect(lifecycle.activation());
      if (dispose) onCleanup(dispose);
    }),
  );
}

/** Runs once when an active surface deactivates or is disposed while still active. */
export function onSurfaceDeactivate(effect: () => void): void {
  const lifecycle = useSurfaceLifecycle();
  let wasActive = untrack(lifecycle.active);
  createEffect(
    on(
      lifecycle.active,
      (active) => {
        if (wasActive && !active) effect();
        wasActive = active;
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    if (wasActive) effect();
    wasActive = false;
  });
}

/** Minimal focus contract shared by OpenTUI inputs and other focusable renderables. */
export interface SurfaceFocusTarget {
  focus(): void;
  blur(): void;
}

/** Focuses one target on activation and always releases it on deactivation. */
export function useSurfaceFocus(target: Accessor<SurfaceFocusTarget | undefined>): void {
  onSurfaceActivate(() => {
    target()?.focus();
    return () => target()?.blur();
  });
}

/** Captures activation identity so async completions can reject stale or hidden results. */
export function useSurfaceActivationGuard(): {
  capture(): () => boolean;
  activation: Accessor<number>;
} {
  const lifecycle = useSurfaceLifecycle();
  return {
    activation: lifecycle.activation,
    capture: () => {
      const activation = lifecycle.activation();
      return () => lifecycle.active() && lifecycle.activation() === activation;
    },
  };
}

/** Full-region host that removes an inactive retained page from Yoga layout and native painting. */
export function SurfaceRegion(props: { children: JSX.Element }): JSX.Element {
  const lifecycle = useSurfaceLifecycle();
  return (
    <box
      visible={lifecycle.active()}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      minHeight={0}
      overflow="hidden"
    >
      {props.children}
    </box>
  );
}

/** Full-bleed host for a retained in-region drawer or other non-portal overlay. */
export function SurfaceOverlay(props: { children: JSX.Element }): JSX.Element {
  const lifecycle = useSurfaceLifecycle();
  return (
    <box visible={lifecycle.active()} position="absolute" left={0} right={0} top={0} bottom={0}>
      {props.children}
    </box>
  );
}

/**
 * Moves floating content to the renderer root so page clipping cannot crop modal paint or hit tests.
 *
 * @remarks OpenTUI's Portal supplies an internal host box. The ref makes that host full-bleed before
 *   its absolutely positioned child is laid out.
 */
export function SurfacePortal(props: {
  children: JSX.Element;
  zIndex?: number;
  visible?: Accessor<boolean>;
}): JSX.Element {
  let portalHost: BoxRenderable | undefined;
  const applyVisibility = (visible: boolean): void => {
    if (!portalHost) return;
    portalHost.zIndex = props.zIndex ?? 0;
    portalHost.visible = visible;
  };
  const configureHost = (value: object): void => {
    const host = value as BoxRenderable;
    portalHost = host;
    host.position = "absolute";
    host.left = 0;
    host.width = "100%";
    host.top = 0;
    host.height = "100%";
    host.overflow = "hidden";
    applyVisibility(props.visible?.() ?? true);
  };
  createEffect(() => {
    applyVisibility(props.visible?.() ?? true);
  });
  return <Portal ref={configureHost}>{props.children}</Portal>;
}
