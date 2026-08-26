import type { Accessor, JSX } from "solid-js";
import { Index, Show } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { BrandWordmark } from "./brand.tsx";
import type { HeaderPlan } from "./header-projection.ts";

/** Props for {@link HeaderRows}. */
export interface HeaderRowsProps {
  plan: Accessor<HeaderPlan>;
}

/**
 * Renders the app header's workspace, active identity, run configuration and host-state zones.
 */
export function HeaderRows(props: HeaderRowsProps): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0}>
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        paddingLeft={1}
        backgroundColor={tokens.bg}
        zIndex={1}
      >
        <BrandWordmark />
        <text
          fg={props.plan().workspace.color}
          flexShrink={1}
          minWidth={0}
          truncate
          wrapMode="none"
        >
          {props.plan().workspace.text}
        </text>
        <Show when={props.plan().identity}>
          <text
            fg={props.plan().identity!.color}
            flexShrink={1}
            minWidth={0}
            truncate
            wrapMode="none"
          >
            {props.plan().identity!.text}
          </text>
        </Show>
        <Index each={props.plan().status}>
          {(chip) => (
            <text fg={chip().color} flexShrink={0} wrapMode="none">
              {chip().text}
            </text>
          )}
        </Index>
        <box flexGrow={1} minWidth={0} />
        <Show when={props.plan().exception}>
          <text fg={props.plan().exception!.color} flexShrink={0} wrapMode="none">
            {props.plan().exception!.text}
          </text>
        </Show>
        <Show when={props.plan().urgent}>
          <text fg={props.plan().urgent!.color} flexShrink={0} wrapMode="none">
            {props.plan().urgent!.text}
          </text>
        </Show>
      </box>
    </box>
  );
}
