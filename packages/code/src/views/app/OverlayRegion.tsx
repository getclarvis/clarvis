import { For, lazy, Suspense, untrack, type Accessor, type JSX } from "solid-js";
import type { PlansService } from "@clarvis/protocol";
import type { ActivityStore } from "../../adapters/activity-store.ts";
import type { TranscriptToolNode } from "../../adapters/store.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { MountedView, OverlayHost } from "../overlay-host.ts";
import { diagnosticCount } from "../../core/diagnostic-events.ts";
import { SurfaceBoundary, SurfaceOverlay } from "../../ui/patterns/surface-lifecycle.tsx";

const DiffViewer = lazy(async () => {
  const module = await import("../overlays/DiffViewer.tsx");
  return { default: module.DiffViewer };
});

const PlanOverlay = lazy(async () => {
  const module = await import("../overlays/PlanOverlay.tsx");
  return { default: module.PlanOverlay };
});

function renderMountedView(frame: MountedView): JSX.Element {
  // A view factory creates its own reactive owner and effects. Do not let the
  // surrounding `<For>` mapper subscribe to signals the factory reads during
  // construction, or any async state update will execute the factory again,
  // remounting the page and restarting its I/O in an unbounded feedback loop.
  return untrack(() => {
    diagnosticCount("overlay.view.factory", undefined, "overlay.view.factory");
    return frame.factory(frame.host);
  });
}

/** Props for the application overlay switch. */
export interface OverlayRegionProps {
  host: OverlayHost;
  fallback: JSX.Element;
  interaction: Interaction;
  diffNode: Accessor<TranscriptToolNode | null>;
  activity: ActivityStore;
  /** Absent until a backend supplies the current-plan document reader. */
  plans?: Pick<PlansService, "read">;
}

/** Whether the persistent shell owns paint and interaction for the current overlay state. */
export function overlayFallbackActive(host: OverlayHost): boolean {
  return (
    host.overlay() !== "diff" &&
    host.overlay() !== "plan" &&
    (host.overlay() !== "view" || host.views().length === 0)
  );
}

/**
 * Renders the overlay kinds that own the whole region — `view`, `diff` and
 * `plan` — or the main shell fallback.
 *
 * @remarks A picker kind such as `agentPicker` is deliberately not here. A
 *   picker paints as an absolutely positioned `FloatFrame` card over its own
 *   dimming scrim, mounted by `App` as a sibling of this region, and the
 *   transcript has to keep rendering behind it — so it reaches this switch as
 *   the fallback rather than as a full-region branch. Anything else unrecognized
 *   falls back the same way, which keeps an unknown kind from blanking the screen.
 */
export function OverlayRegion(props: OverlayRegionProps): JSX.Element {
  const fallbackActive = (): boolean => overlayFallbackActive(props.host);

  return (
    <>
      <box
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        opacity={fallbackActive() ? 1 : 0}
        zIndex={fallbackActive() ? 0 : -1}
        onMouse={(event) => {
          if (fallbackActive()) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {props.fallback}
      </box>
      <For each={props.host.views()}>
        {(frame) => (
          <SurfaceBoundary
            active={() => props.host.overlay() === "view" && frame.host.active()}
            retention="retain-one"
          >
            {() => <SurfaceOverlay>{renderMountedView(frame)}</SurfaceOverlay>}
          </SurfaceBoundary>
        )}
      </For>
      <SurfaceBoundary active={() => props.host.overlay() === "diff"} retention="retain-one">
        {(lifecycle) => (
          <SurfaceOverlay>
            <Suspense fallback={<text>Loading diff…</text>}>
              <DiffViewer
                interaction={props.interaction}
                node={props.diffNode}
                active={lifecycle.active}
              />
            </Suspense>
          </SurfaceOverlay>
        )}
      </SurfaceBoundary>
      <SurfaceBoundary active={() => props.host.overlay() === "plan"} retention="retain-one">
        {(lifecycle) => (
          <SurfaceOverlay>
            <Suspense fallback={<text>Loading plan…</text>}>
              <PlanOverlay
                interaction={props.interaction}
                plan={() => props.activity.plan}
                plans={props.plans}
                active={lifecycle.active}
                onClose={() => props.host.dismissTop()}
              />
            </Suspense>
          </SurfaceOverlay>
        )}
      </SurfaceBoundary>
    </>
  );
}
