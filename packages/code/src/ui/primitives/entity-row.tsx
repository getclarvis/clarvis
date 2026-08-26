import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { lifecycleLabel, type EntitySummary } from "../presentation.ts";
import { SelectableRow } from "./selectable-row.tsx";

/** Shared identity-first row for agents, workflows, plans, providers and pickers. */
export function EntityRow(props: {
  entity: EntitySummary;
  selected?: boolean;
  action?: string;
}): JSX.Element {
  const identity = (): string => (props.entity.id ? `${props.entity.id}  ` : "");
  const badges = (): string =>
    [props.entity.current ? "current" : "", props.entity.default ? "default" : ""]
      .filter(Boolean)
      .join(", ");
  return (
    <box flexDirection="column" flexShrink={0}>
      <SelectableRow selected={props.selected ?? false}>
        <span style={{ fg: tokens.accent2 }}>{identity()}</span>
        <span style={{ fg: tokens.fg }}>{props.entity.title}</span>
        <Show when={props.entity.state}>
          <span style={{ fg: tokens.muted }}>{`  ${lifecycleLabel(props.entity.state!)}`}</span>
        </Show>
        <Show when={badges()}>
          <span style={{ fg: tokens.accent }}>{`  ${badges()}`}</span>
        </Show>
        <Show when={props.action && props.selected}>
          <span style={{ fg: tokens.muted }}>{`  ${props.action}`}</span>
        </Show>
      </SelectableRow>
      <Show when={props.entity.description || props.entity.metadata?.length}>
        <text fg={tokens.muted} wrapMode="word" selectable={false} paddingLeft={4}>
          {[props.entity.description, ...(props.entity.metadata ?? [])].filter(Boolean).join(" · ")}
        </text>
      </Show>
      <Show when={props.entity.readOnlyReason}>
        <text fg={tokens.muted} paddingLeft={4} selectable={false}>
          {`Read-only — ${props.entity.readOnlyReason}`}
        </text>
      </Show>
    </box>
  );
}
