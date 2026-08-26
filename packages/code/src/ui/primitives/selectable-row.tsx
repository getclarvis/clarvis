import type { JSX } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { selectionBg } from "../../theme/surfaces.ts";

/**
 * Renders a one-line row with a leading selection chevron and, when selected, a highlighted
 * background band.
 *
 * @param props.selected - Whether this row is the current selection.
 * @param props.id - Optional element id, used e.g. to scroll the row into view.
 * @param props.base - The background color the selection highlight is computed against; defaults
 * to `tokens.bg`.
 * @param props.band - Set false to suppress the highlighted background while still selected.
 * @param props.visible - Hides a retained row slot without disposing its OpenTUI subtree.
 * @param props.children - The row's content, rendered after the selection chevron.
 */
export function SelectableRow(props: {
  selected: boolean;
  id?: string;
  base?: string;
  band?: boolean;
  visible?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <box
      visible={props.visible ?? true}
      id={props.id}
      width="100%"
      height={1}
      flexShrink={0}
      backgroundColor={
        props.selected && (props.band ?? true) ? selectionBg(props.base ?? tokens.bg) : undefined
      }
    >
      <text flexShrink={0} wrapMode="none" truncate>
        <span style={{ fg: props.selected ? tokens.accent : tokens.muted }}>
          {props.selected ? glyph("chevronRight") + " " : "  "}
        </span>
        {props.children}
      </text>
    </box>
  );
}
