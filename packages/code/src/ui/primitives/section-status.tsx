import type { JSX } from "solid-js";
import { For } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { LABEL_WIDTH } from "./field-row.tsx";

/** Renders a section divider label with a leading rule glyph, in the accent2 color. */
export function SectionHeader(props: { label: string }): JSX.Element {
  return (
    <text flexShrink={0} fg={tokens.accent2} paddingTop={1}>
      {glyph("horizontal") + glyph("horizontal") + " " + props.label}
    </text>
  );
}

/** Renders a label/value status line, the label padded to {@link LABEL_WIDTH} in muted color. */
export function StatusRow(props: { label: string; text: string; fg?: string }): JSX.Element {
  return (
    <text flexShrink={0}>
      <span style={{ fg: tokens.muted }}>{"  " + props.label.padEnd(LABEL_WIDTH) + " "}</span>
      <span style={{ fg: props.fg ?? tokens.fg }}>{props.text}</span>
    </text>
  );
}

/** One colored line rendered by {@link DetailLines}. */
export interface DetailRow {
  text: string;
  fg: string;
}

/**
 * Renders a list of {@link DetailRow} lines, each optionally indented to align under a
 * {@link LABEL_WIDTH}-padded label.
 */
export function DetailLines(props: { rows: readonly DetailRow[]; indent?: boolean }): JSX.Element {
  return (
    <For each={props.rows}>
      {(row) => (
        <text flexShrink={0} fg={row.fg}>
          {(props.indent ? " ".repeat(LABEL_WIDTH + 3) : "") + row.text}
        </text>
      )}
    </For>
  );
}

/** Renders a muted em-dash placeholder for an absent value. */
export function Dash(): JSX.Element {
  return <text fg={tokens.muted}>{glyph("emDash")}</text>;
}
