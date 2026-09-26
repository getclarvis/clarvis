import type { Accessor, JSX } from "solid-js";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { Interaction } from "../../keys/interaction.ts";
import { uiCommand } from "../../keys/actions.ts";
import { LAYER } from "../../keys/keyspec.ts";
import { tokens } from "../../theme/tokens.ts";
import { InteractionNavigationBar } from "../../ui/patterns/navigation-bar.tsx";
import { useTerminalSize } from "../../ui/patterns/terminal-size.tsx";
import { FloatFrame, floatContentWidth } from "./FloatFrame.tsx";

/** Show the exact denied action and rationale before a scoped new attempt is requested. */
export function DeniedActionPrompt(props: {
  interaction: Interaction;
  active: Accessor<boolean>;
  denials: Accessor<
    {
      callId: string;
      attempt: number;
      tool: string;
      arguments: Record<string, unknown>;
      reason: string;
    }[]
  >;
  onConfirm(denial: { callId: string; attempt: number }): void;
  onClose(): void;
}): JSX.Element {
  const dims = useTerminalSize();
  const [index, setIndex] = createSignal(0);
  const selected = () => props.denials()[Math.min(index(), props.denials().length - 1)];
  createEffect(() => {
    if (props.active()) setIndex(Math.max(0, props.denials().length - 1));
  });
  const actionIds = new Set([
    "denied.authorize",
    "denied.cancel",
    "denied.previous",
    "denied.next",
  ]);
  onMount(() => {
    const off = props.interaction.keymap.registerLayer({
      priority: LAYER.CONFIRM,
      enabled: reactiveMatcherFromSignal(props.active),
      commands: [
        uiCommand({
          id: "denied.authorize",
          title: "Authorize one new attempt",
          description: "Return this denied action to the agent for a new policy review",
          category: "mutation",
          surfaces: ["footer"],
          footerLabel: "authorize",
          hintPriority: 100,
          hintGroup: "mutation",
          essential: true,
          run: () => {
            const denial = selected();
            if (denial) props.onConfirm(denial);
          },
        }),
        uiCommand({
          id: "denied.previous",
          title: "Previous denial",
          description: "Select an older denied action",
          category: "navigation",
          surfaces: ["footer"],
          footerLabel: "previous",
          hintPriority: 70,
          run: () => {
            setIndex((value) => Math.max(0, value - 1));
          },
        }),
        uiCommand({
          id: "denied.next",
          title: "Next denial",
          description: "Select a newer denied action",
          category: "navigation",
          surfaces: ["footer"],
          footerLabel: "next",
          hintPriority: 69,
          run: () => {
            setIndex((value) => Math.min(props.denials().length - 1, value + 1));
          },
        }),
        uiCommand({
          id: "denied.cancel",
          title: "Cancel",
          description: "Close without authorizing",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "cancel",
          hintPriority: 90,
          hintGroup: "escape",
          essential: true,
          run: () => props.onClose(),
        }),
      ],
      bindings: [
        { key: "y", cmd: "denied.authorize" },
        { key: "up", cmd: "denied.previous" },
        { key: "down", cmd: "denied.next" },
        { key: "escape", cmd: "denied.cancel" },
      ],
    });
    onCleanup(off);
  });
  return (
    <FloatFrame
      title="Denied action"
      size="lg"
      navigation={
        <InteractionNavigationBar
          interaction={props.interaction}
          actionFilter={(action) => actionIds.has(action.id)}
          usableWidth={() => floatContentWidth(dims().width, "lg")}
        />
      }
    >
      <box flexDirection="column">
        <text
          fg={tokens.muted}
        >{`Recent denials: ${Math.min(index() + 1, props.denials().length)} of ${props.denials().length}`}</text>
        <text fg={tokens.fg}>Action: {selected()?.tool ?? "Unavailable"}</text>
        <text fg={tokens.fg}>Arguments: {JSON.stringify(selected()?.arguments ?? {})}</text>
        <text fg={tokens.muted}>Judge: {selected()?.reason ?? "Unavailable"}</text>
        <text fg={tokens.muted}>
          Authorizing asks the agent to propose one new attempt; rules and judge still review it.
        </text>
      </box>
    </FloatFrame>
  );
}
