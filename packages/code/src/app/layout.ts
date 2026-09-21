import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

/** Terminal-size band the shell renders against. */
export type LayoutMode = "wide" | "narrow" | "single" | "floor";

/**
 * How the current secondary activity/detail surface is presented.
 *
 * @remarks `"full"` is the compact band's explicit presentation: the activity
 *   sections take the whole content region instead of opening beside the
 *   transcript.
 */
export type SecondarySurfaceMode = "closed" | "split" | "drawer" | "full";

/** Why the secondary surface is open; the compact band treats the two origins differently. */
export type SecondaryOrigin = "automatic" | "explicit";

export const INSPECTOR_MIN_WIDTH = 32;
export const INSPECTOR_MAX_WIDTH = 56;
export const INSPECTOR_SPLIT_MIN_WIDTH = 100;

/**
 * Maps terminal dimensions to a {@link LayoutMode} breakpoint.
 *
 * @remarks
 * Breakpoints: below 24 columns or 6 rows is `"floor"` (too small to render
 * normally), below 72 columns is `"single"` (one column: the compact band, which
 * summarises activity instead of opening a surface), below 100 columns is
 * `"narrow"`, otherwise `"wide"`.
 */
/** The smallest terminal the shell renders in: below either, it shows the floor screen. */
export const FLOOR_MIN_COLUMNS = 24;
/** @see {@link FLOOR_MIN_COLUMNS} */
export const FLOOR_MIN_ROWS = 6;

function layoutModeFromDims(w: number, h: number): LayoutMode {
  if (w < FLOOR_MIN_COLUMNS || h < FLOOR_MIN_ROWS) return "floor";
  if (w < 72) return "single";
  if (w < 100) return "narrow";
  return "wide";
}

/** Reactive layout state and controls for the shell's sidebar, drawer and compact activity panel. */
export interface LayoutController {
  layoutMode: Accessor<LayoutMode>;
  /** Whether the terminal is in the compact band where activity is summarised, not opened. */
  compact: Accessor<boolean>;
  secondaryOpen: Accessor<boolean>;
  /** Which intent opened the current surface, or `null` while it is closed. */
  secondaryOrigin: Accessor<SecondaryOrigin | null>;
  openSecondary: (origin: SecondaryOrigin) => void;
  closeSecondary: () => void;
  sidebarVisible: Accessor<boolean>;
  secondaryMode: Accessor<SecondarySurfaceMode>;
  sidebarWidth: Accessor<number>;
  contentInset: Accessor<number>;
}

/**
 * Builds the reactive {@link LayoutController} that derives layout mode and
 * presents available secondary content only after an explicit user intent or one of the bounded
 * run-scoped first-Plan, first-workflow-leader, or first-delegation intents supplied by the
 * application shell.
 *
 * @param opts - Accessors for terminal dimensions and secondary content presence, plus the
 *   compact-collapse notification.
 * @returns The layout controller.
 *
 * @remarks The compact band never keeps an automatically opened surface open. An automatic
 *   intent that arrives there belongs to the activity summary, and a width that shrinks into the
 *   band collapses the surface the intent had opened, so a later widening cannot surprise the
 *   reader with a panel they never asked for. An explicit intent survives the same shrink and is
 *   presented at full width.
 *   `onCompactCollapse` reports that collapse; the shell owns which section the reader was
 *   looking at, so it can restore it on the next explicit open.
 */
export function createLayoutController(opts: {
  dims: Accessor<{ w: number; h: number }>;
  hasSidebarContent: Accessor<boolean>;
  onCompactCollapse?: () => void;
}): LayoutController {
  const layoutMode = createMemo(() => {
    const { w, h } = opts.dims();
    return layoutModeFromDims(w, h);
  });
  const compact = createMemo(() => layoutMode() === "single");
  const [secondaryOpen, setSecondaryOpen] = createSignal(false);
  const [secondaryOrigin, setSecondaryOrigin] = createSignal<SecondaryOrigin | null>(null);
  const openSecondary: LayoutController["openSecondary"] = (origin) => {
    if (!opts.hasSidebarContent()) return;
    setSecondaryOrigin(origin);
    setSecondaryOpen(true);
  };
  const closeSecondary = (): void => {
    setSecondaryOpen(false);
    setSecondaryOrigin(null);
  };
  const splitEligible = createMemo(() => opts.dims().w >= INSPECTOR_SPLIT_MIN_WIDTH);
  const secondaryMode = createMemo<SecondarySurfaceMode>(() => {
    if (!secondaryOpen()) return "closed";
    if (splitEligible()) return "split";
    return compact() ? "full" : "drawer";
  });
  const sidebarVisible = createMemo(() => secondaryMode() === "split");
  const sidebarWidth = createMemo(() => {
    const viewport = Math.max(1, opts.dims().w);
    const preferred = Math.round(viewport * 0.32);
    const usefulWidth = Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, preferred));
    return Math.min(viewport, usefulWidth);
  });
  const contentInset = createMemo(() => (sidebarVisible() ? sidebarWidth() : 0));

  createEffect(() => {
    if (!compact() || !secondaryOpen() || secondaryOrigin() !== "automatic") return;
    closeSecondary();
    opts.onCompactCollapse?.();
  });

  return {
    layoutMode,
    compact,
    secondaryOpen,
    secondaryOrigin,
    openSecondary,
    closeSecondary,
    sidebarVisible,
    secondaryMode,
    sidebarWidth,
    contentInset,
  };
}
