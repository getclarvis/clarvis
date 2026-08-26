import type { JSX } from "solid-js";
import { For } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { PickerRow } from "./PickerRow.tsx";

const ACTIVE_COL_WIDTH = glyphColWidth("radioOn");

/** One selectable option in a {@link ChoiceRows} list. */
export interface ChoiceRow<T extends string> {
  value: T;
  label: string;
  description: string;
  tone?: "normal" | "warn";
}

/**
 * Renders a list of {@link ChoiceRow}s as {@link PickerRow}s, marking the one
 * matching `props.selected()` with both the cursor and radio marker.
 *
 * @remarks A choice's visual cursor and submitted value must have one source
 * of truth. Callers derive `selected` from that value rather than keeping a
 * second highlight state that can drift from the radio marker.
 *
 * @remarks The label column is the only shrinkable cell. Callers size
 *   `labelWidth` from their longest label — an elicitation's options are
 *   model-authored and can be arbitrarily long — and a fixed cell that cannot
 *   shrink makes the row wider than its container, so the option text paints
 *   through the surrounding card's border. The marker column stays fixed; it is
 *   one glyph wide and compressing it would drop the active-choice dot.
 */
export function ChoiceRows<T extends string>(props: {
  choices: readonly ChoiceRow<T>[];
  selected: () => number;
  labelWidth: number;
  base?: string;
  onSelect?: (index: number) => void;
  onConfirm?: () => void;
}): JSX.Element {
  return (
    <For each={props.choices}>
      {(choice, index) => {
        const selected = (): boolean => index() === props.selected();
        return (
          <PickerRow
            selected={selected()}
            base={props.base}
            onSelect={props.onSelect && (() => props.onSelect!(index()))}
            onConfirm={props.onConfirm}
            cells={[
              {
                width: ACTIVE_COL_WIDTH,
                fg: selected() ? tokens.accent : tokens.muted,
                text: selected() ? glyph("radioOn") : glyph("radioOff"),
              },
              {
                width: props.labelWidth,
                shrink: true,
                fg: choice.tone === "warn" ? tokens.warn : selected() ? tokens.fg : tokens.muted,
                text: choice.label,
              },
              { grow: true, marginLeft: 2, fg: tokens.muted, text: choice.description },
            ]}
          />
        );
      }}
    </For>
  );
}
