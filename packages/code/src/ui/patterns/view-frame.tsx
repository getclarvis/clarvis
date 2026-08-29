import type { Accessor, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tone } from "../../theme/tone.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { ScopeBadge } from "../primitives/index.ts";
import { InteractionNavigationBar } from "./navigation-bar.tsx";
import type { ActiveAction } from "./active-actions.ts";

/** One compact, reactive status pinned to the right edge of a view footer. */
export interface ViewFrameStatus {
  text: string;
  fg?: string;
  glyph?: string;
  glyphFg?: string;
}

/**
 * Renders one level's chrome: title/breadcrumb/scope, body and keymap-derived navigation.
 *
 * @param props.host - Drives the breadcrumb, scope, dirty flag and pending-confirm state.
 * @param props.title - The title shown at the top of the frame.
 * @param props.readOnly - When true, shows "read-only" instead of the scope badge. Reserve it
 * for a level that genuinely cannot be changed from here; a level that mutates but binds no
 * scope wants {@link ViewFrame | props.unscoped} instead.
 * @param props.unscoped - When true, shows no badge at all: the level binds no global/workspace
 * scope, but it is not read-only either.
 * @param props.children - The level's body content.
 * @returns The framed level.
 * @remarks The title and footer rows own their own cells (opaque + `zIndex={1}`); the content area
 * between them clips its overflow (`overflow="hidden"`), so an over-tall body can never composite
 * over either. A pending confirm prompt asks rather than reports: its glyph stays a warning glyph
 * in both flavours, and only the severity color (danger vs. warn) comes from {@link tone}.
 */
export function ViewFrame(props: {
  host: ViewHost;
  title: string;
  readOnly?: boolean;
  unscoped?: boolean;
  mode?: "monitor" | "read-only";
  readOnlyReason?: string;
  purpose?: string;
  mutationContract?: string;
  actionFilter?: (action: ActiveAction) => boolean;
  footerStatus?: () => ViewFrameStatus | undefined;
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
        <text height={1} selectable={false}>
          <span style={{ fg: tokens.accent }}>
            <b>{props.title}</b>
          </span>
          <Show when={props.host.breadcrumb().length > 0}>
            <span style={{ fg: tokens.muted }}>
              {" " +
                glyph("chevronRight") +
                " " +
                props.host.breadcrumb().join(" " + glyph("chevronRight") + " ")}
            </span>
          </Show>
          <Show when={props.unscoped !== true}>
            <Show
              when={!props.readOnly && props.mode !== "read-only" && props.mode !== "monitor"}
              fallback={
                <span style={{ fg: tokens.muted }}>
                  {props.mode === "monitor"
                    ? "   Monitor"
                    : `   Read-only${props.readOnlyReason ? ` — ${props.readOnlyReason}` : ""}`}
                </span>
              }
            >
              <span style={{ fg: tokens.muted }}>{"   scope " + glyph("chevronRight") + " "}</span>
              <ScopeBadge scope={props.host.scope()} />
              <Show when={props.host.dirty()}>
                <span style={{ fg: tokens.warn }}>{"  ~ Unsaved"}</span>
              </Show>
            </Show>
          </Show>
        </text>
      </box>
      <Show when={props.purpose || props.mutationContract}>
        <text fg={tokens.muted} flexShrink={0} selectable={false}>
          {[props.purpose, props.mutationContract].filter(Boolean).join(` ${glyph("separator")} `)}
        </text>
      </Show>
      <box
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        paddingTop={1}
        paddingBottom={1}
      >
        {props.children}
      </box>
      <box flexShrink={0} flexDirection="column" backgroundColor={tokens.bg} zIndex={1}>
        <Show when={props.host.pendingConfirm()}>
          <text fg={tone(props.host.pendingConfirm()!.danger ? "error" : "warn").fg}>
            {glyph("warning") + " " + props.host.pendingConfirm()!.message}
          </text>
          <For each={props.host.pendingConfirm()!.detail ?? []}>
            {(line) => <text fg={tokens.muted}>{"  " + line}</text>}
          </For>
        </Show>
        <box height={1} flexDirection="row">
          <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <InteractionNavigationBar
              interaction={props.host.interaction}
              actionFilter={(action) =>
                action.id !== "run.cancel" && (props.actionFilter?.(action) ?? true)
              }
            />
          </box>
          <Show when={props.footerStatus?.()}>
            {(status: Accessor<ViewFrameStatus>) => (
              <text flexShrink={0} wrapMode="none">
                <Show when={status().glyph}>
                  <span style={{ fg: status().glyphFg ?? status().fg ?? tokens.muted }}>
                    {status().glyph + " "}
                  </span>
                </Show>
                <span style={{ fg: status().fg ?? tokens.muted }}>{status().text}</span>
              </text>
            )}
          </Show>
        </box>
      </box>
    </box>
  );
}
