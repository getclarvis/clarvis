import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { glyph } from "../theme/glyphs.ts";
import { tone, type Tone } from "../theme/tone.ts";
import type { HintTone } from "./hint.ts";
import { spinnerChar } from "./spinner.ts";
import { FLOAT_Z } from "./overlays/FloatFrame.tsx";

/** "running" renders as spinner (accent) + text (muted) — the live run line. */
export type FooterStatusTone = HintTone | "running";

/** Lead activity shown in the fixed row immediately above the composer. */
export type LeadActivityPhase = "ready" | "thinking" | "working" | "compacting";

function activityLabel(phase: LeadActivityPhase): string {
  return phase === "compacting" ? "compacting context" : phase;
}

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
        <text fg={tone(hintTone(h().tone)).fg} wrapMode="word">
          {h().text}
        </text>
      </box>
    </Show>
  );
}

/** Keeps transient Lead activity out of the scrollable transcript. */
export function LeadActivityLine(props: {
  phase: () => LeadActivityPhase;
  /** Conversation or run detail, retained while idle, beside the physical activity state. */
  detail?: () => string;
  /** Timed command prefix state, seated after live activity details in this same status band. */
  commandPrefixActive?: () => boolean;
}): JSX.Element {
  const running = createMemo(() => tone("running", spinnerChar()));
  return (
    <box
      id="lead-activity-line"
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={tokens.bg}
    >
      <Show when={props.phase() !== "ready"}>
        <text fg={running().fg} flexShrink={0} wrapMode="word" selectable={false}>
          {running().glyph + " "}
        </text>
        <text fg={tokens.muted} flexShrink={0} wrapMode="word" selectable={false}>
          {activityLabel(props.phase())}
        </text>
      </Show>
      <Show when={(props.detail?.() ?? "").length > 0}>
        <text
          fg={tokens.muted}
          flexShrink={1}
          minWidth={0}
          wrapMode="word"
          truncate
          selectable={false}
        >
          {`${props.phase() === "ready" ? "" : ` ${glyph("separator")} `}${props.detail?.() ?? ""}`}
        </text>
      </Show>
      <Show when={props.commandPrefixActive?.() === true}>
        <text
          fg={tokens.accent}
          flexShrink={0}
          marginLeft={props.phase() === "ready" && (props.detail?.() ?? "").length === 0 ? 0 : 2}
          wrapMode="none"
          selectable={false}
        >
          Ctrl+X active
        </text>
        <text fg={tokens.muted} flexShrink={0} wrapMode="none" selectable={false}>
          {` ${glyph("separator")} choose a key`}
        </text>
      </Show>
    </box>
  );
}

/**
 * Responsive action bar with independently wrapped status and run information.
 *
 */
export function Footer(props: {
  hint: () => { text: string; tone: HintTone };
  status?: () => { text: string; tone: FooterStatusTone };
  runStrip?: () => string;
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
      <box flexDirection="column" flexShrink={0}>
        <box flexShrink={0} minWidth={0} flexDirection="column">
          <Show
            when={h().text.length > 0}
            fallback={
              <Show when={!props.compact?.()}>
                <Show when={props.navigation}>{props.navigation}</Show>
              </Show>
            }
          >
            <text fg={tone(hintTone(h().tone)).fg} wrapMode="word">
              {h().text}
            </text>
          </Show>
        </box>
        <Show when={(s()?.text ?? "").length > 0}>
          <Show
            when={s()!.tone === "running"}
            fallback={
              <text fg={tone(hintTone(s()!.tone as HintTone)).fg} flexShrink={0} wrapMode="word">
                {s()!.text}
              </text>
            }
          >
            <text fg={running().fg} flexShrink={0} wrapMode="word">
              {running().glyph + " "}
              <span style={{ fg: tokens.muted }}>{s()!.text}</span>
            </text>
          </Show>
        </Show>
        <Show when={strip().length > 0}>
          <box flexShrink={1} minWidth={0}>
            <text fg={tokens.muted} flexShrink={1} minWidth={0} wrapMode="word">
              {strip()}
            </text>
          </box>
        </Show>
      </box>
    </box>
  );
}
