import type { JSX } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { borderChars, glyph } from "../../theme/glyphs.ts";
import { ruleColor } from "../../theme/surfaces.ts";

/**
 * A non-interactive section divider for the `/` command popup, rendered above
 * the first row of each command group.
 *
 * @remarks
 * Deliberately takes only `label` — no `onSelect`/`onConfirm`/mouse handler
 * exists on this component's props, so it cannot be wired up like a
 * `PickerRow` by accident. Structurally the same rule-with-label divider
 * `DoctorView` already uses (lead-in glyphs, a label, a rule extending to the
 * edge), styled distinctly: the label carries `tokens.accent2` and the rule
 * `ruleColor()`, rather than `DoctorView`'s single `tokens.muted` for both.
 */
export function CommandGroupHeader(props: { label: string }): JSX.Element {
  return (
    <box flexDirection="row" flexShrink={0} height={1}>
      <text fg={ruleColor()} flexShrink={0}>
        {glyph("horizontal") + glyph("horizontal") + " "}
      </text>
      <text fg={tokens.accent2} flexShrink={1} minWidth={0} wrapMode="none" truncate>
        {props.label}
      </text>
      <text fg={ruleColor()} flexShrink={0}>
        {" "}
      </text>
      <box
        flexGrow={1}
        flexShrink={1}
        height={1}
        border={["top"]}
        borderStyle="single"
        customBorderChars={borderChars()}
        borderColor={ruleColor()}
      />
    </box>
  );
}
