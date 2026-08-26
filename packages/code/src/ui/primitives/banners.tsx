import type { JSX } from "solid-js";
import { For } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { tone } from "../../theme/tone.ts";

/** Renders an error message with the error tone, plus optional indented detail lines. */
export function ErrorBanner(props: { text: string; detail?: string[] }): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text flexShrink={0} fg={tone("error").fg}>
        {tone("error").glyph + " " + props.text}
      </text>
      <For each={props.detail ?? []}>
        {(line) => (
          <text flexShrink={0} fg={tokens.muted}>
            {"  " + line}
          </text>
        )}
      </For>
    </box>
  );
}
