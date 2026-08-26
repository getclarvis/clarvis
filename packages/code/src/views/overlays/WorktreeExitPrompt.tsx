import type { JSX } from "solid-js";
import { onCleanup, onMount } from "solid-js";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { Interaction } from "../../keys/interaction.ts";
import { uiCommand } from "../../keys/actions.ts";
import { LAYER } from "../../keys/keyspec.ts";
import { tokens } from "../../theme/tokens.ts";
import { InteractionNavigationBar } from "../../ui/patterns/navigation-bar.tsx";
import { FloatFrame } from "./FloatFrame.tsx";
import { useOptionalSurfaceLifecycle } from "../../ui/patterns/surface-lifecycle.tsx";

/** Confirm whether a clean Clarvis checkout should be removed during shutdown. */
export function WorktreeExitPrompt(props: {
  interaction: Interaction;
  name: string;
  branch: string;
  onRemove(): void;
  onKeep(): void;
  onCancel(): void;
}): JSX.Element {
  const actionIds = new Set(["worktree.exit.remove", "worktree.exit.keep", "worktree.exit.cancel"]);
  const lifecycle = useOptionalSurfaceLifecycle();
  const active = lifecycle?.active ?? (() => true);

  onMount(() => {
    const off = props.interaction.keymap.registerLayer({
      priority: LAYER.CONFIRM,
      enabled: reactiveMatcherFromSignal(active),
      commands: [
        uiCommand({
          id: "worktree.exit.remove",
          title: "Remove worktree checkout and exit",
          description: "Remove the clean checkout, keep its branch, and exit Clarvis",
          category: "mutation",
          surfaces: ["footer"],
          footerLabel: "remove",
          hintPriority: 100,
          hintGroup: "mutation",
          essential: true,
          run: () => props.onRemove(),
        }),
        uiCommand({
          id: "worktree.exit.keep",
          title: "Keep worktree checkout and exit",
          description: "Leave the checkout registered and exit Clarvis",
          category: "primary",
          surfaces: ["footer"],
          footerLabel: "keep",
          hintPriority: 95,
          hintGroup: "primary",
          essential: true,
          run: () => props.onKeep(),
        }),
        uiCommand({
          id: "worktree.exit.cancel",
          title: "Cancel exit",
          description: "Return to Clarvis without exiting",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "cancel",
          hintPriority: 90,
          hintGroup: "escape",
          essential: true,
          run: () => props.onCancel(),
        }),
      ],
      bindings: [
        { key: "y", cmd: "worktree.exit.remove" },
        { key: "n", cmd: "worktree.exit.keep" },
        { key: "escape", cmd: "worktree.exit.cancel" },
      ],
    });
    onCleanup(off);
  });

  return (
    <FloatFrame
      title="Clean worktree"
      size="sm"
      navigation={
        <InteractionNavigationBar
          interaction={props.interaction}
          actionFilter={(action) => actionIds.has(action.id)}
        />
      }
    >
      <box flexDirection="column">
        <text fg={tokens.fg}>Remove checkout '{props.name}' while exiting?</text>
        <text fg={tokens.muted}>Branch {props.branch} will be kept.</text>
      </box>
    </FloatFrame>
  );
}
