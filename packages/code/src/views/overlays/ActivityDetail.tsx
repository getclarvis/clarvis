import type { Accessor, JSX } from "solid-js";
import { onCleanup, onMount, Show } from "solid-js";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { Interaction } from "../../keys/interaction.ts";
import { uiCommand } from "../../keys/actions.ts";
import { LAYER } from "../../keys/keyspec.ts";
import { tokens } from "../../theme/tokens.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { InteractionNavigationBar } from "../../ui/patterns/navigation-bar.tsx";
import { Prose } from "../Prose.tsx";
import type { ActivityDetail as ActivityDetailValue } from "../activity-detail.ts";
import { FloatFrame } from "./FloatFrame.tsx";
import { useOptionalSurfaceLifecycle } from "../../ui/patterns/surface-lifecycle.tsx";

const EMPTY_DETAIL: ActivityDetailValue = { title: "Activity detail", content: "" };

/** Markdown reader for a delegation brief, sub-agent answer, or terminal plan-task result. */
export function ActivityDetail(props: {
  interaction: Interaction;
  detail: Accessor<ActivityDetailValue | null>;
  onClose(): void;
}): JSX.Element {
  const lifecycle = useOptionalSurfaceLifecycle();
  const active = lifecycle?.active ?? (() => true);
  const detail = (): ActivityDetailValue => props.detail() ?? EMPTY_DETAIL;
  onMount(() => {
    const off = props.interaction.keymap.registerLayer({
      priority: LAYER.MODAL,
      enabled: reactiveMatcherFromSignal(active),
      commands: [
        uiCommand({
          id: "activity.detail.close",
          title: "Close activity detail",
          description: "Return to the transcript",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "close",
          hintPriority: 100,
          hintGroup: "escape",
          essential: true,
          run: () => props.onClose(),
        }),
      ],
      bindings: [{ key: "escape", cmd: "activity.detail.close" }],
    });
    onCleanup(off);
  });

  return (
    <FloatFrame
      title={detail().title}
      navigation={
        <InteractionNavigationBar
          interaction={props.interaction}
          actionFilter={(action) => action.id === "activity.detail.close"}
        />
      }
    >
      <box flexDirection="column" flexGrow={1} minHeight={1} overflow="hidden">
        <Show when={detail().eyebrow}>
          <text fg={tokens.muted} height={1} flexShrink={0} wrapMode="none" truncate>
            {detail().eyebrow}
          </text>
        </Show>
        <scrollbox flexGrow={1} minHeight={1} verticalScrollbarOptions={scrollbarOptions()}>
          <Prose content={detail().content} block />
        </scrollbox>
      </box>
    </FloatFrame>
  );
}
