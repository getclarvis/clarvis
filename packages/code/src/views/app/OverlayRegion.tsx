import { For, lazy, Show, Suspense, untrack, type Accessor, type JSX } from "solid-js";
import type { PlansService } from "@clarvis/protocol";
import type { ActivityStore } from "../../adapters/activity-store.ts";
import type { TranscriptToolNode } from "../../adapters/store.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { MountedView, OverlayHost } from "../overlay-host.ts";
import type { HintTone } from "../hint.ts";
import { diagnosticCount } from "../../core/diagnostic-events.ts";
import { SurfaceBoundary, SurfaceRegion } from "../../ui/patterns/surface-lifecycle.tsx";

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
  /**
   * Absent until a backend supplies one; {@link PlanOverlay} declares the same
   * prop optional and opens on its task list rather than its history when it is
   * missing, so requiring it here only made this component stricter than the one
   * it forwards to.
   */
  plans?: PlansService;
  notify: (message: string, tone?: HintTone) => void;
  planOrigin?: "direct" | "history";
}

/**
 * Renders the overlay kinds that own the whole region — `view`, `diff` and
 * `plan` — or the main shell fallback.
 *
 * @remarks A picker kind such as `agentPicker` is deliberately not here. A
 *   picker paints as an absolutely positioned `FloatFrame` card over its own
 *   dimming scrim, mounted by `App` as a sibling of this region, and the
 *   transcript has to keep rendering behind it — so it reaches this switch as
 *   the fallback rather than as a `Match`. Anything else unrecognized falls back
 *   the same way, which is what keeps an unknown kind from blanking the screen.
 */
export function OverlayRegion(props: OverlayRegionProps): JSX.Element {
  return (
    <>
      <Show when={props.host.overlay() !== "view" || props.host.views().length === 0}>
        <box
          visible={props.host.overlay() !== "diff" && props.host.overlay() !== "plan"}
          flexGrow={1}
          flexDirection="column"
        >
          {props.fallback}
        </box>
      </Show>
      <For each={props.host.views()}>
        {(frame) => (
          <SurfaceBoundary
            active={() => props.host.overlay() === "view" && frame.host.active()}
            retention="retain-one"
          >
            {() => <SurfaceRegion>{renderMountedView(frame)}</SurfaceRegion>}
          </SurfaceBoundary>
        )}
      </For>
      <SurfaceBoundary active={() => props.host.overlay() === "diff"} retention="retain-one">
        {(lifecycle) => (
          <SurfaceRegion>
            <Suspense fallback={<text>Loading diff…</text>}>
              <DiffViewer
                interaction={props.interaction}
                node={props.diffNode}
                active={lifecycle.active}
              />
            </Suspense>
          </SurfaceRegion>
        )}
      </SurfaceBoundary>
      <SurfaceBoundary active={() => props.host.overlay() === "plan"} retention="retain-one">
        {(lifecycle) => (
          <SurfaceRegion>
            <Suspense fallback={<text>Loading plans…</text>}>
              <PlanOverlay
                interaction={props.interaction}
                plan={() => props.activity.plan}
                plans={props.plans}
                notify={props.notify}
                origin={props.planOrigin}
                active={lifecycle.active}
                onClose={() => props.host.dismissTop()}
              />
            </Suspense>
          </SurfaceRegion>
        )}
      </SurfaceBoundary>
    </>
  );
}
