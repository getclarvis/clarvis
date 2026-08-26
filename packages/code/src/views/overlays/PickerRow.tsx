import type { JSX } from "solid-js";
import { Index } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { overlayBg, selectionBg } from "../../theme/surfaces.ts";

const CHEVRON_COL_WIDTH = glyphColWidth("chevronRight");

/**
 * One column of a {@link PickerRow}: either static `text` or a custom
 * `render`, sized either by a fixed `width` or by `grow`.
 */
export interface PickerCell {
  text?: string;
  render?: () => JSX.Element;
  fg?: string;
  width?: number;
  grow?: boolean;
  marginLeft?: number;
  /**
   * Whether this fixed-`width` cell may be compressed when the row does not fit.
   *
   * @remarks Opt-in, because a marker column sized to one glyph must keep its
   *   glyph. Set it on any cell whose `width` is derived from data rather than
   *   hardcoded: a fixed cell is laid out with `flexShrink: 0`, so a width taken
   *   from the longest item makes the row wider than its container and the text
   *   paints straight through the surrounding border instead of being clipped by
   *   it. Every cell already sets `truncate`, so shrinking degrades to an
   *   ellipsis rather than to overflow.
   */
  shrink?: boolean;
}

/**
 * A single selectable row in a picker list: a leading chevron indicator
 * followed by fixed- or grow-width {@link PickerCell}s, highlighted when
 * `selected` and clickable via mouse-down.
 */
export function PickerRow(props: {
  selected: boolean;
  visible?: boolean;
  id?: string;
  base?: string;
  cells: PickerCell[];
  onSelect?: () => void;
  onConfirm?: () => void;
}): JSX.Element {
  return (
    <box
      visible={props.visible ?? true}
      flexDirection="row"
      width="100%"
      height={1}
      flexShrink={0}
      id={props.id}
      backgroundColor={props.selected ? selectionBg(props.base ?? overlayBg()) : undefined}
      onMouseDown={() => {
        props.onSelect?.();
        props.onConfirm?.();
      }}
    >
      <text
        width={CHEVRON_COL_WIDTH}
        flexShrink={0}
        wrapMode="none"
        truncate
        fg={props.selected ? tokens.accent : tokens.muted}
      >
        {props.selected ? glyph("chevronRight") : " "}
      </text>
      <Index each={props.cells}>
        {(cell) => (
          <text
            width={cell().grow ? undefined : cell().width}
            flexGrow={cell().grow ? 1 : 0}
            flexShrink={cell().grow === true || cell().shrink === true ? 1 : 0}
            marginLeft={cell().marginLeft ?? 1}
            wrapMode="none"
            truncate
            fg={cell().fg ?? tokens.muted}
          >
            {cell().render?.() ?? cell().text ?? ""}
          </text>
        )}
      </Index>
    </box>
  );
}
