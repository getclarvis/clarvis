import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { settingSummary, type SettingPresentation } from "../presentation.ts";
import { SelectableRow } from "./selectable-row.tsx";

/** Configured/effective/source/applies row with explicit mutation affordance. */
export function SettingRow(props: {
  setting: SettingPresentation;
  selected?: boolean;
  expanded?: boolean;
  id?: string;
}): JSX.Element {
  const editable = (): boolean => props.setting.mutation !== "read-only";
  return (
    <box flexDirection="column" flexShrink={0}>
      <SelectableRow
        selected={editable() && (props.selected ?? false)}
        band={editable()}
        id={props.id}
      >
        <span style={{ fg: editable() ? tokens.fg : tokens.muted }}>{props.setting.label}</span>
        <span style={{ fg: tokens.muted }}>{`  ${settingSummary(props.setting)}`}</span>
        <Show when={editable() && props.selected}>
          <span style={{ fg: tokens.accent }}>{`  change ${props.setting.label}`}</span>
        </Show>
      </SelectableRow>
      <Show when={props.expanded}>
        <box flexDirection="column" paddingLeft={4}>
          <text fg={tokens.muted}>{`Configured here: ${props.setting.configured}`}</text>
          <text fg={tokens.muted}>{`Effective:       ${props.setting.effective}`}</text>
          <Show when={props.setting.pending !== undefined}>
            <text fg={tokens.warn}>{`Pending:         ${props.setting.pending}`}</text>
          </Show>
          <text fg={tokens.muted}>{`Source:          ${props.setting.source}`}</text>
          <text fg={tokens.muted}>{`Applies:         ${props.setting.applies}`}</text>
          <Show when={props.setting.readOnlyReason}>
            <text fg={tokens.muted}>{`Read-only — ${props.setting.readOnlyReason}`}</text>
          </Show>
        </box>
      </Show>
    </box>
  );
}
