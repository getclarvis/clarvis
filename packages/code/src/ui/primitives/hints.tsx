import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph, type GlyphName } from "../../theme/glyphs.ts";
import { tone } from "../../theme/tone.ts";

/** Renders an empty-state message with an optional leading icon and a muted hint line below it. */
export function EmptyHint(props: { text: string; hint?: string; icon?: GlyphName }): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text flexShrink={0}>
        <Show when={props.icon}>
          <span style={{ fg: tokens.muted }}>{glyph(props.icon!) + " "}</span>
        </Show>
        <span style={{ fg: tokens.muted }}>{props.text}</span>
      </text>
      <Show when={props.hint}>
        <text fg={tokens.muted} flexShrink={0}>
          {(props.icon ? "   " : "") + props.hint}
        </text>
      </Show>
    </box>
  );
}

/** Renders a pending-tone loading message with a trailing ellipsis glyph. */
export function LoadingHint(props: { text?: string }): JSX.Element {
  return (
    <text flexShrink={0} fg={tokens.muted}>
      {tone("pending").glyph + " " + (props.text ?? "loading") + glyph("ellipsis")}
    </text>
  );
}
