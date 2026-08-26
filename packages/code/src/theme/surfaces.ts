/**
 * Derived surface colors: every tint in this module is a fraction of an existing
 * theme token mixed into another, never a literal color.
 *
 * @remarks The mixing amounts are ordered by the *strength of the signal* each
 * surface carries, and it is the ordering that is designed rather than any
 * single number. Reading up the scale: a selected row and a focused element sit
 * at the lightest tint that survives a low-contrast terminal palette (0.16); the
 * user's own band is a step above it (0.18) so it reads as belonging to the
 * conversation rather than as a selection; a scrollbar track is above that
 * (0.22) because it must be findable without being read; a diff gutter is
 * stronger again (0.28) since it marks a specific line rather than a region; a
 * scrollbar thumb is the strongest tint (0.35) as the one element the eye is
 * meant to track; and the divider rule and the modal scrim are past tinting
 * altogether (0.55, 0.5) because they separate rather than decorate.
 *
 * They are deliberately expressed against `tokens` so a theme change moves every
 * surface with it. A literal color here would be the one thing a user's palette
 * could not reach.
 */
import { tokens } from "./tokens.ts";
import { mixHex } from "./model.ts";

/** Background color for a modal's dimming scrim behind it. */
export function scrimColor(): string {
  return mixHex(tokens.bg, "#000000", 0.5);
}

/** Background color for an elevated overlay surface (popups, cards). */
export function overlayBg(): string {
  return tokens.bgElev;
}

/** Background tint for a selected row, over `base` (defaults to the app background). */
export function selectionBg(base: string = tokens.bg): string {
  return mixHex(base, tokens.accent, 0.16);
}

/** Background tint for the currently focused element. */
export function focusBg(): string {
  return mixHex(tokens.bg, tokens.accent, 0.16);
}

/** Background tint for the band behind the user's own transcript entries. */
export function userBandBg(): string {
  return mixHex(tokens.bg, tokens.accent, 0.18);
}

/** Color for a thin divider rule between sections. */
export function ruleColor(): string {
  return mixHex(tokens.bg, tokens.muted, 0.55);
}

/** Extra right-hand gutter width (in columns) reserved for a scrollbar next to a table. */
export const SCROLLBOX_TABLE_GUTTER = 2;

/** Track/thumb colors for a themed scrollbar, over `base` (defaults to the app background). */
export function scrollbarOptions(base: string = tokens.bg): {
  trackOptions: { backgroundColor: string; foregroundColor: string };
} {
  return {
    trackOptions: {
      backgroundColor: mixHex(base, tokens.muted, 0.22),
      foregroundColor: mixHex(tokens.muted, tokens.accent, 0.35),
    },
  };
}
