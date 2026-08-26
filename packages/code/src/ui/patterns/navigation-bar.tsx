import type { Accessor, JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { KeymapProvider, useKeymapSelector } from "@opentui/keymap/solid";
import { useTerminalDimensions } from "@opentui/solid";
import type { Interaction } from "../../keys/interaction.ts";
import type { KeyboardEnvironment } from "../../keys/keyboard-profile.ts";
import { effectiveClientPlatform } from "../../keys/keyboard-profile.ts";
import { tokens } from "../../theme/tokens.ts";
import {
  actionSegment,
  budgetFooterActions,
  projectActiveActions,
  type ActiveAction,
} from "./active-actions.ts";

/** Reactive action projection shared by footer and modal chrome. */
function useActiveActions(environment: Accessor<KeyboardEnvironment>): Accessor<ActiveAction[]> {
  const keys = useKeymapSelector((keymap) =>
    keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }),
  );
  return createMemo(() => projectActiveActions(keys(), effectiveClientPlatform(environment())));
}

/** Responsive footer projection; key and label always enter or leave as one complete segment. */
export function NavigationBar(props: {
  environment: Accessor<KeyboardEnvironment>;
  width: Accessor<number>;
  actionFilter?: (action: ActiveAction) => boolean;
  active?: Accessor<boolean>;
}): JSX.Element {
  const actions = useActiveActions(props.environment);
  const visible = createMemo(() =>
    budgetFooterActions(
      props.actionFilter ? actions().filter(props.actionFilter) : actions(),
      props.width(),
    ),
  );
  const text = createMemo(() => visible().map(actionSegment).join("  "));
  return (
    <Show when={(props.active?.() ?? true) && text().length > 0}>
      <text fg={tokens.muted} wrapMode="none">
        {text()}
      </text>
    </Show>
  );
}

function NavigationBarForInteraction(props: {
  interaction: Interaction;
  actionFilter?: (action: ActiveAction) => boolean;
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
    />
  );
}

/** Self-contained navigation projection for frames also mounted in focused renderer tests. */
export function InteractionNavigationBar(props: {
  interaction: Interaction;
  actionFilter?: (action: ActiveAction) => boolean;
}): JSX.Element {
  if (
    typeof (props.interaction.keymap as Partial<Interaction["keymap"]>).getActiveKeys !== "function"
  )
    return null as never;
  return (
    <KeymapProvider keymap={props.interaction.keymap}>
      <NavigationBarForInteraction
        interaction={props.interaction}
        actionFilter={props.actionFilter}
      />
    </KeymapProvider>
  );
}
