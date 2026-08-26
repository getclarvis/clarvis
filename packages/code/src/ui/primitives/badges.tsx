import type { JSX } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { Scope } from "../../keys/commands.ts";

/** Renders a config {@link Scope} label in the accent color used for scope chrome. */
export function ScopeBadge(props: { scope: Scope }): JSX.Element {
  return <span style={{ fg: tokens.accent2 }}>{props.scope}</span>;
}

/**
 * Renders a superscript badge marking where a config value came from.
 *
 * @param props.origin - `"global"`/`"workspace"` render a superscript G/W; `"shadow"` renders a
 * shadowed-override glyph (`W'G`) in the warn color; any other string renders as-is.
 */
export function SourceBadge(props: {
  origin: "global" | "workspace" | "shadow" | (string & {});
}): JSX.Element {
  const label = (): string =>
    props.origin === "shadow"
      ? glyph("superscriptW") + glyph("prime") + glyph("superscriptG")
      : props.origin === "workspace"
        ? glyph("superscriptW")
        : props.origin === "global"
          ? glyph("superscriptG")
          : props.origin;
  return (
    <span style={{ fg: props.origin === "shadow" ? tokens.warn : tokens.muted }}>{label()}</span>
  );
}
