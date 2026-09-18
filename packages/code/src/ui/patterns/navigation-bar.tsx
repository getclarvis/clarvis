import type { Accessor, JSX } from "solid-js";
import { createMemo, Show, For } from "solid-js";
import { KeymapProvider, useKeymapSelector } from "@opentui/keymap/solid";
import { useTerminalDimensions } from "@opentui/solid";
import type { Interaction } from "../../keys/interaction.ts";
import type { KeyboardEnvironment } from "../../keys/keyboard-profile.ts";
import { effectiveClientPlatform } from "../../keys/keyboard-profile.ts";
import { tokens } from "../../theme/tokens.ts";
import {
  footerText,
  footerLines,
  budgetFooterActions,
  projectCommandActions,
  type ActiveAction,
} from "./active-actions.ts";

/** Reactive action projection shared by footer and modal chrome. */
function useActiveActions(environment: Accessor<KeyboardEnvironment>): Accessor<ActiveAction[]> {
  const keys = useKeymapSelector((keymap) => keymap.getCommandEntries({ visibility: "reachable" }));
  return createMemo(() => projectCommandActions(keys(), effectiveClientPlatform(environment())));
}

/** Responsive footer projection; key and label always enter or leave as one complete segment. */
export function NavigationBar(props: {
  environment: Accessor<KeyboardEnvironment>;
  width: Accessor<number>;
  actionFilter?: (action: ActiveAction) => boolean;
  /** Project surface-local wording without rebuilding the owning key layer. */
  actionTransform?: (action: ActiveAction) => ActiveAction;
  active?: Accessor<boolean>;
  responsive?: boolean;
}): JSX.Element {
  const actions = useActiveActions(props.environment);
  const visible = createMemo(() => {
    const transformed = props.actionTransform
      ? actions().map((action) => props.actionTransform!(action))
      : actions();
    const filtered = props.actionFilter ? transformed.filter(props.actionFilter) : transformed;
    return props.responsive ? filtered : budgetFooterActions(filtered, props.width());
  });
  const lines = createMemo(() =>
    props.responsive
      ? footerLines(visible(), props.width())
      : [footerText(visible())].filter(Boolean),
  );
  return (
    <Show when={(props.active?.() ?? true) && lines().length > 0}>
      <box flexDirection="column" flexShrink={0} width={props.responsive ? "100%" : undefined}>
        <For each={lines()}>
          {(line) => (
            <text fg={tokens.muted} wrapMode="char">
              {line}
            </text>
          )}
        </For>
      </box>
    </Show>
  );
}

function NavigationBarForInteraction(props: {
  interaction: Interaction;
  actionFilter?: (action: ActiveAction) => boolean;
  actionTransform?: (action: ActiveAction) => ActiveAction;
}): JSX.Element {
  const dimensions = useTerminalDimensions();
  const fallback: KeyboardEnvironment = {
    transport: "local",
    runtimePlatform: "unknown",
    terminal: { name: "unknown" },
    protocol: "legacy",
    multiplexer: "unknown",
    modifiers: {
      ctrl: "unknown",
      shift: "unknown",
      meta: "unknown",
      super: "unknown",
      hyper: "unknown",
    },
    baseLayout: "unknown",
    profile: "portable",
  };
  return (
    <NavigationBar
      environment={props.interaction.keyboardEnvironment ?? (() => fallback)}
      width={() => dimensions().width}
      actionFilter={props.actionFilter}
      actionTransform={props.actionTransform}
    />
  );
}

/** Self-contained navigation projection for frames also mounted in focused renderer tests. */
export function InteractionNavigationBar(props: {
  interaction: Interaction;
  actionFilter?: (action: ActiveAction) => boolean;
  actionTransform?: (action: ActiveAction) => ActiveAction;
}): JSX.Element {
  if (
    typeof (props.interaction.keymap as Partial<Interaction["keymap"]>).getCommandEntries !==
      "function" ||
    typeof (props.interaction.keymap as Partial<Interaction["keymap"]>).getPendingSequence !==
      "function" ||
    typeof (props.interaction.keymap as Partial<Interaction["keymap"]>).on !== "function"
  )
    return null as never;
  return (
    <KeymapProvider keymap={props.interaction.keymap}>
      <NavigationBarForInteraction
        interaction={props.interaction}
        actionFilter={props.actionFilter}
        actionTransform={props.actionTransform}
      />
    </KeymapProvider>
  );
}
