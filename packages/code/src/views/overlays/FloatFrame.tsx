import type { JSX } from "solid-js";
import { createSignal, onMount, Show } from "solid-js";
import { useTerminalDimensions, useTimeline } from "@opentui/solid";
import { tokens } from "../../theme/tokens.ts";
import { borderChars } from "../../theme/glyphs.ts";
import { mixHex } from "../../theme/model.ts";
import { overlayBg, scrimColor } from "../../theme/surfaces.ts";
import {
  onSurfaceActivate,
  useOptionalSurfaceLifecycle,
} from "../../ui/patterns/surface-lifecycle.tsx";

const OPEN_MS = 170;

/** The z-index every {@link FloatFrame} (and its scrim) paints at, above the transcript. */
export const FLOAT_Z = 100;

const SIZES: Record<"sm" | "lg", { width: `${number}%`; maxWidth: number }> = {
  sm: { width: "85%", maxWidth: 80 },
  lg: { width: "85%", maxWidth: 100 },
};
const SM_MAX_HEIGHT = 10;

/** Rows a {@link FloatFrame} spends on its own chrome (title, footer, padding), for sizing scrollable content inside it. */
export const FLOAT_CHROME_ROWS = 5;

/** The maximum row budget for a {@link FloatFrame} card given the terminal's current height. */
export function floatMaxRows(terminalRows: number): number {
  return Math.floor(terminalRows * 0.8);
}

/**
 * A centered, animated overlay card with a title and footer, used as the
 * chrome behind pickers, filters and other modal content.
 *
 * @remarks
 * A full-bleed, absolutely-positioned scrim renders behind the card to dim
 * the transcript so the card reads as a raised layer rather than a cutout;
 * being absolute and full-bleed keeps it from affecting the centered card's
 * own layout, and the card paints above it.
 */
export function FloatFrame(props: {
  title: string;
  footer?: string;
  navigation?: JSX.Element;
  footerFg?: string;
  children: JSX.Element;
  size?: "sm" | "lg";
  width?: number | `${number}%`;
  maxWidth?: number;
  maxHeight?: number | `${number}%`;
}): JSX.Element {
  const dims = useTerminalDimensions();
  const lifecycle = useOptionalSurfaceLifecycle();
  const maxHeight = (): number | `${number}%` =>
    props.maxHeight ?? (props.size === "sm" ? SM_MAX_HEIGHT : floatMaxRows(dims().height));
  const [p, setP] = createSignal(0);
  const timeline = useTimeline({ duration: OPEN_MS, loop: false, autoplay: false });
  onMount(() => {
    timeline.add(
      { p: 0 },
      {
        p: 1,
        duration: OPEN_MS,
        ease: "outExpo",
        onUpdate: (a) => setP(a.progress),
      },
    );
    if (!lifecycle) timeline.restart();
  });
  if (lifecycle)
    onSurfaceActivate((activation) => {
      if (activation > 1) {
        timeline.pause();
        setP(1);
        return;
      }
      setP(0);
      timeline.restart();
      return () => timeline.pause();
    });
  const scrim = (): string => mixHex(tokens.bg, scrimColor(), p());
  const cardBg = (): string => mixHex(tokens.bg, overlayBg(), p());
  const edge = (): string => mixHex(tokens.muted, tokens.accent, p());

  return (
    <box
      visible={lifecycle?.active() ?? true}
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
      zIndex={FLOAT_Z}
    >
      <box
        position="absolute"
        left={0}
        right={0}
        top={0}
        bottom={0}
        backgroundColor={scrim()}
        zIndex={0}
      />
      <box
        flexDirection="column"
        backgroundColor={cardBg()}
        borderStyle="rounded"
        customBorderChars={borderChars()}
        borderColor={edge()}
        width={props.width ?? SIZES[props.size ?? "lg"].width}
        minWidth={40}
        maxWidth={props.maxWidth ?? SIZES[props.size ?? "lg"].maxWidth}
        maxHeight={maxHeight()}
        paddingLeft={1}
        paddingRight={1}
        zIndex={1}
      >
        <text fg={tokens.accent} height={1} flexShrink={0} wrapMode="none" truncate>
          <b>{props.title}</b>
        </text>
        <box flexDirection="column" paddingTop={1} flexGrow={1} minHeight={1}>
          {props.children}
        </box>
        <Show when={props.navigation || (props.footer?.length ?? 0) > 0}>
          <box height={1} flexShrink={0} flexDirection="row">
            <Show when={props.navigation}>
              <box flexGrow={1} minWidth={0}>
                {props.navigation}
              </box>
            </Show>
            <Show when={(props.footer?.length ?? 0) > 0}>
              <text flexShrink={0} fg={props.footerFg ?? tokens.muted} wrapMode="none" truncate>
                {props.footer}
              </text>
            </Show>
          </box>
        </Show>
      </box>
    </box>
  );
}
