import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tone } from "../../theme/tone.ts";
import { SelectableRow } from "./selectable-row.tsx";

/** The fixed column width labels are padded to across field, status and detail rows. */
export const LABEL_WIDTH = 15;

/** Structural field issue — matches config PanelIssue without importing features. */
export interface FieldIssueBadge {
  level: "error" | "warn";
  message: string;
}

/**
 * Renders a labeled config field row: label, required marker, value, an optional enum affordance
 * or trailing note, and an issue line beneath when the field has a {@link FieldIssueBadge}.
 */
export function FieldRow(props: {
  label: string;
  value: string;
  /** "enum" marks a pick-a-value field: the caretDown affordance is appended. */
  kind?: "enum";
  selected?: boolean;
  required?: boolean;
  issue?: FieldIssueBadge;
  note?: string;
  noteFg?: string;
  id?: string;
}): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0}>
      <SelectableRow selected={props.selected ?? false} id={props.id}>
        <span style={{ fg: tokens.muted }}>{props.label.padEnd(LABEL_WIDTH)}</span>
        <span style={{ fg: tokens.warn }}>{props.required ? "*" : " "}</span>
        <span style={{ fg: tokens.fg }}>{props.value}</span>
        <Show when={props.kind === "enum"}>
          <span style={{ fg: tokens.muted }}>{"  " + glyph("caretDown")}</span>
        </Show>
        <Show when={props.note}>
          <span style={{ fg: props.noteFg ?? tokens.muted }}>{"   " + props.note}</span>
        </Show>
      </SelectableRow>
      <Show when={props.issue}>
        <text flexShrink={0}>
          <span>{"  "}</span>
          <span style={{ fg: tone(props.issue!.level).fg }}>
            {tone(props.issue!.level).glyph + " " + props.issue!.message}
          </span>
        </text>
      </Show>
    </box>
  );
}

/** A {@link FieldRow} specialized for a boolean value, rendered as `"on"`/`"off"`. */
export function ToggleRow(props: {
  label: string;
  value: boolean;
  selected?: boolean;
  issue?: FieldIssueBadge;
  note?: string;
  noteFg?: string;
  id?: string;
}): JSX.Element {
  return (
    <FieldRow
      label={props.label}
      value={props.value ? "on" : "off"}
      selected={props.selected}
      issue={props.issue}
      note={props.note}
      noteFg={props.noteFg}
      id={props.id}
    />
  );
}
