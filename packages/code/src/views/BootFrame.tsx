import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { tokens } from "../theme/tokens.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import { ruleColor } from "../theme/surfaces.ts";
import { SPLASH_WORDMARK } from "./brand.tsx";
import { spinnerChar, useSpinnerClock } from "./spinner.ts";

/** Branded parser-free shell shown while the interactive foundation is loading. */
export function BootFrame(): JSX.Element {
  const dims = useTerminalDimensions();
  useSpinnerClock(() => true);
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      backgroundColor={tokens.bg}
      flexDirection="column"
    >
      <box flexDirection="column" flexShrink={0} height={dims().height >= 8 ? 2 : 1}>
        <box height={1} flexDirection="row" paddingLeft={1} flexShrink={0}>
          <text flexShrink={0} wrapMode="none">
            <b>
              <span style={{ fg: tokens.accent }}>{"/"}</span>
              <span style={{ fg: tokens.fg }}>{" Clarvis"}</span>
            </b>
          </text>
          <text fg={tokens.muted} flexShrink={1} minWidth={0} wrapMode="none" truncate>
            {` ${glyph("separator")} code ${glyph("separator")} starting`}
          </text>
        </box>
        <Show when={dims().height >= 8}>
          <text fg={ruleColor()} wrapMode="none" truncate>
            {glyph("horizontal").repeat(Math.max(1, dims().width))}
          </text>
        </Show>
      </box>

      <box
        flexGrow={1}
        minHeight={0}
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
      >
        <Show when={dims().height >= 8}>
          <text wrapMode="none">
            <b>
              <span style={{ fg: tokens.accent }}>{"/"}</span>
              <span style={{ fg: tokens.fg }}>{SPLASH_WORDMARK}</span>
            </b>
          </text>
        </Show>
        <text fg={tokens.muted} wrapMode="none" truncate>
          <span style={{ fg: tokens.accent }}>{spinnerChar() + " "}</span>
          {`loading workspace${glyph("ellipsis")}`}
        </text>
      </box>

      <box
        height={3}
        flexShrink={0}
        marginLeft={1}
        marginRight={1}
        marginBottom={1}
        paddingLeft={1}
        paddingRight={1}
        border
        borderStyle="rounded"
        customBorderChars={borderChars()}
        borderColor={tokens.muted}
        alignItems="center"
      >
        <text fg={tokens.muted} flexShrink={1} minWidth={0} wrapMode="none" truncate>
          {`Preparing composer${glyph("ellipsis")}`}
        </text>
      </box>
    </box>
  );
}
