import { glyph } from "../../theme/glyphs.ts";
import { errorText } from "../../adapters/errors.ts";
import type { FieldIssue } from "../../adapters/settings.ts";
import type { KeySource } from "../../adapters/provider-secrets.ts";
import type { Notice } from "../../ui/notice.ts";

/** Structured events emitted by the Providers controller. */
export type ProvidersEvent =
  | { type: "key_staged"; envVar: string }
  | { type: "source_staged"; envVar: string; source: KeySource; meaning: string }
  | { type: "model_added"; id: string; contextWindow: number }
  | { type: "validation_failed"; issue: FieldIssue }
  | { type: "key_save_failed"; envVar: string; error: unknown }
  | { type: "source_save_failed"; envVar: string; error: unknown }
  | { type: "saved"; scope: string; reconnecting: boolean };

/**
 * Presents a Providers controller event for the terminal notification surface.
 *
 * @param event - Structured controller event.
 * @returns Terminal text and semantic tone.
 */
export function presentProvidersEvent(event: ProvidersEvent): Notice {
  switch (event.type) {
    case "key_staged":
      return {
        message: `key staged for ${event.envVar} ${glyph("emDash")} save to reconnect`,
      };
    case "source_staged":
      return {
        message:
          `key source for ${event.envVar}: ${event.source} ${glyph("emDash")} ` +
          `${event.meaning} (saves on ^s)`,
      };
    case "model_added":
      return {
        message: `added ${event.id} ${glyph("emDash")} ctx ${event.contextWindow}`,
      };
    case "validation_failed":
      return {
        message: `cannot save ${glyph("emDash")} ${event.issue.message}`,
        tone: "error",
      };
    case "key_save_failed":
      return {
        message: `key save failed for ${event.envVar}: ${errorText(event.error)}`,
        tone: "error",
      };
    case "source_save_failed":
      return {
        message: `source save failed for ${event.envVar}: ${errorText(event.error)}`,
        tone: "error",
      };
    case "saved":
      return {
        message:
          `saved ${event.scope} providers` +
          (event.reconnecting ? ` ${glyph("emDash")} reconnecting backend` : ""),
        tone: "success",
      };
  }
}
