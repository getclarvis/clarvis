import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { glyph } from "../theme/glyphs.ts";
import type { Interaction } from "../keys/interaction.ts";
import { InteractionNavigationBar } from "../ui/patterns/navigation-bar.tsx";

/**
 * A full-page overlay chrome: title/subtitle row, keymap-derived navigation and content.
 *
 * @remarks The title row owns its own cell (opaque + `zIndex={1}`); the content region below it
 * clips its overflow (`overflow="hidden"`), matching {@link import("../ui/patterns/view-frame.tsx").ViewFrame}'s
 * structurally identical region, so an over-tall or absolutely-positioned child can never composite
 * over the title row above it.
 */
export function PageFrame(props: {
  title: string;
  subtitle?: string;
  interaction: Interaction;
  children: JSX.Element;
}): JSX.Element {
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      backgroundColor={tokens.bg}
      paddingLeft={1}
      paddingTop={1}
    >
      <box height={1} flexShrink={0} backgroundColor={tokens.bg} zIndex={1}>
        <text height={1} wrapMode="none" truncate>
          <span style={{ fg: tokens.accent }}>
            <b>{props.title}</b>
          </span>
          <Show when={props.subtitle}>
            <span style={{ fg: tokens.muted }}>
              {" " + glyph("separator") + " " + props.subtitle}
            </span>
          </Show>
        </text>
      </box>
      <box
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        paddingTop={1}
      >
        {props.children}
      </box>
      <box flexShrink={0} backgroundColor={tokens.bg} zIndex={1}>
        <InteractionNavigationBar interaction={props.interaction} />
      </box>
    </box>
  );
}
