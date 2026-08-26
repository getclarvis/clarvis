import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { tone, type Tone } from "../theme/tone.ts";
import type { HintTone } from "./hint.ts";
import { spinnerChar } from "./spinner.ts";
import { FLOAT_Z } from "./overlays/FloatFrame.tsx";

/** "running" renders as spinner (accent) + text (muted) — the live run line. */
export type FooterStatusTone = HintTone | "running";

function hintTone(t: HintTone): Exclude<Tone, "running"> {
  switch (t) {
    case "success":
      return "ok";
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return "muted";
  }
}

/**
 * Overlay-safe notify surface. A floating dialog's full-bleed scrim paints over
 * the in-flow footer, so a notify raised with a picker open (a refused
 * shift+tab, "default agent set…") would land on a buried row. While any
 * overlay is mounted, App reroutes the hint here: a bottom-anchored row painted
 * above the float layer, in the same spot and tones as the footer's hint line.
 */
export function HintToast(props: { hint: () => { text: string; tone: HintTone } }): JSX.Element {
  const h = createMemo(() => props.hint());
  return (
    <Show when={h().text.length > 0}>
      <box
        position="absolute"
        left={0}
        right={0}
        bottom={0}
        height={1}
        paddingLeft={1}
        backgroundColor={tokens.bg}
        zIndex={FLOAT_Z + 1}
      >
        <text fg={tone(hintTone(h().tone)).fg} wrapMode="none" truncate>
          {h().text}
        </text>
      </box>
    </Show>
  );
}

/**
 * Contextual action bar and the canonical run strip. Detailed usage never owns a third row.
 *
 * @remarks
 * Hints carry arbitrary `notify()` text: the hint and status text truncate
 * instead of wrapping, because a wrapped second line would paint over the
 * usage row below.
 */
export function Footer(props: {
  hint: () => { text: string; tone: HintTone };
  status?: () => { text: string; tone: FooterStatusTone };
  runStrip?: () => string;
  /** Optional mouse route owned by the run strip, such as opening compact activity. */
  onRunStripMouseDown?: () => void;
  /** Keymap-derived action projection. */
  navigation?: JSX.Element;
  compact?: () => boolean;
}): JSX.Element {
  const h = createMemo(() => props.hint());
  const s = createMemo(() => props.status?.());
  const strip = createMemo(() => props.runStrip?.() ?? "");
  const running = createMemo(() => tone("running", spinnerChar()));
  return (
    <box
      flexShrink={0}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={tokens.bg}
      zIndex={1}
    >
      <box height={1} flexDirection="row">
        <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row">
          <Show
            when={h().text.length > 0}
            fallback={
              <Show when={!props.compact?.()}>
                <Show when={props.navigation}>{props.navigation}</Show>
              </Show>
            }
          >
            <text fg={tone(hintTone(h().tone)).fg} wrapMode="none" truncate>
              {h().text}
            </text>
          </Show>
        </box>
        <Show when={(s()?.text ?? "").length > 0}>
          <Show
            when={s()!.tone === "running"}
            fallback={
              <text fg={tone(hintTone(s()!.tone as HintTone)).fg} flexShrink={0} wrapMode="none">
                {s()!.text}
              </text>
            }
          >
            <text fg={running().fg} flexShrink={0} wrapMode="none">
              {running().glyph + " "}
            </text>
            <text fg={tokens.muted} flexShrink={1} minWidth={0} wrapMode="none" truncate>
              {s()!.text}
            </text>
          </Show>
        </Show>
        <Show when={strip().length > 0}>
          <box onMouseDown={() => props.onRunStripMouseDown?.()} flexShrink={1} minWidth={0}>
            <text fg={tokens.muted} flexShrink={1} minWidth={0} wrapMode="none" truncate>
              {"  " + strip()}
            </text>
          </box>
        </Show>
      </box>
    </box>
  );
}
