import type { JSX } from "solid-js";
import { children, createSignal, onMount, Show } from "solid-js";
import { useTimeline } from "@opentui/solid";
import { tokens } from "../../theme/tokens.ts";
import { borderChars } from "../../theme/glyphs.ts";
import { mixHex } from "../../theme/model.ts";
import { overlayBg, scrimColor } from "../../theme/surfaces.ts";
import { useTerminalSize } from "../../ui/patterns/terminal-size.tsx";
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

/** The narrowest a card is allowed to collapse to while the viewport still has room. */
const FLOAT_MIN_WIDTH = 40;

/**
 * Cells a card spends on its border and padding, excluded from its content.
 *
 * @remarks Every band inside a card owes this to the projection: the card's own
 *   footer is not the terminal's full row, and a band admitted by the terminal
 *   width paints past the card's edge.
 */
const FLOAT_CARD_INSET = 4;

/**
 * The resolved outer width of a card.
 *
 * @param terminalWidth - the viewport width in cells.
 * @param size - the card's declared size.
 * @returns the width the card really paints at.
 * @remarks The floor is capped by the viewport: a 24-column terminal granted the
 *   unconditional 40-cell floor a card wider than the screen, which the layout
 *   then clipped on both sides. The floor exists so a card is readable on a
 *   normal terminal, not to exceed the one it is drawn on.
 */
function floatCardWidth(terminalWidth: number, size: "sm" | "lg" = "lg"): number {
  const viewport = Math.max(1, Math.floor(terminalWidth));
  const preferred = Math.floor(viewport * 0.85);
  return Math.max(Math.min(FLOAT_MIN_WIDTH, viewport), Math.min(preferred, SIZES[size].maxWidth));
}

/** Cells a card can really give its own body or footer, after border and padding. */
export function floatContentWidth(terminalWidth: number, size: "sm" | "lg" = "lg"): number {
  return Math.max(0, floatCardWidth(terminalWidth, size) - FLOAT_CARD_INSET);
}

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
  const dims = useTerminalSize();
  /** Resolve the JSX-valued getter once so footer probes cannot mount duplicate navigation trees. */
  const navigation = children(() => props.navigation);
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
        width={props.width ?? floatCardWidth(dims().width, props.size ?? "lg")}
        minWidth={Math.min(FLOAT_MIN_WIDTH, dims().width)}
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
        <Show when={navigation() || (props.footer?.length ?? 0) > 0}>
          <box flexShrink={0} flexDirection="row">
            <Show when={navigation()}>
              <box flexGrow={1} minWidth={0}>
                {navigation()}
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
