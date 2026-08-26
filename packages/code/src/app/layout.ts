import { createMemo, createSignal, type Accessor } from "solid-js";

/** Terminal-size band the shell renders against. */
export type LayoutMode = "wide" | "narrow" | "single" | "floor";

/** How the current secondary activity/detail surface is presented. */
export type SecondarySurfaceMode = "closed" | "split" | "drawer";

export const INSPECTOR_MIN_WIDTH = 32;
export const INSPECTOR_MAX_WIDTH = 56;
export const INSPECTOR_SPLIT_MIN_WIDTH = 100;

/**
 * Maps terminal dimensions to a {@link LayoutMode} breakpoint.
 *
 * @remarks
 * Breakpoints: below 24 columns or 6 rows is `"floor"` (too small to render
 * normally), below 72 columns is `"single"` (one column, no sidebar), below
 * 100 columns is `"narrow"`, otherwise `"wide"`.
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

/** Reactive layout state and controls for the shell's sidebar and drawer. */
export interface LayoutController {
  layoutMode: Accessor<LayoutMode>;
  drawerOpen: Accessor<boolean>;
  setDrawerOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sidebarVisible: Accessor<boolean>;
  secondaryMode: Accessor<SecondarySurfaceMode>;
  sidebarWidth: Accessor<number>;
  contentInset: Accessor<number>;
}

/**
 * Builds the reactive {@link LayoutController} that derives layout mode and
 * sidebar/drawer state from terminal dimensions and sidebar content.
 *
 * @param opts - Accessors for terminal dimensions and sidebar content presence.
 * @returns The layout controller.
 */
export function createLayoutController(opts: {
  dims: Accessor<{ w: number; h: number }>;
  hasSidebarContent: Accessor<boolean>;
}): LayoutController {
  const layoutMode = createMemo(() => {
    const { w, h } = opts.dims();
    return layoutModeFromDims(w, h);
  });
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const splitEligible = createMemo(() => opts.dims().w >= INSPECTOR_SPLIT_MIN_WIDTH);
  const secondaryMode = createMemo<SecondarySurfaceMode>(() => {
    if (!opts.hasSidebarContent()) return "closed";
    if (splitEligible()) return "split";
    return drawerOpen() ? "drawer" : "closed";
  });
  const sidebarVisible = createMemo(() => secondaryMode() === "split");
  const sidebarWidth = createMemo(() => {
    const viewport = Math.max(1, opts.dims().w);
    const preferred = Math.round(viewport * 0.32);
    const usefulWidth = Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, preferred));
    return Math.min(viewport, usefulWidth);
  });
  const contentInset = createMemo(() => (sidebarVisible() ? sidebarWidth() : 0));

  return {
    layoutMode,
    drawerOpen,
    setDrawerOpen,
    sidebarVisible,
    secondaryMode,
    sidebarWidth,
    contentInset,
  };
}
