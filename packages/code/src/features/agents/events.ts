import { glyph } from "../../theme/glyphs.ts";
import { errorText } from "../../adapters/errors.ts";
import type { Scope } from "../../adapters/settings.ts";
import type { Notice } from "../../ui/notice.ts";

/** Structured events emitted by the Agents controller. */
export type AgentsEvent =
  | { type: "save_blocked"; message: string }
  | { type: "save_failed"; error: unknown }
  | { type: "saved"; name: string; scope: Scope; warning?: string }
  | { type: "forked"; source: string; name: string; scope: Scope }
  | { type: "fork_failed"; error: unknown }
  | { type: "already_exists"; name: string; scope: Scope }
  | { type: "create_failed"; error: unknown }
  | { type: "renamed"; oldName: string; newName: string }
  | { type: "rename_failed"; error: unknown }
  | { type: "delete_failed"; error: unknown }
  | { type: "deleted"; name: string; scope: Scope }
  | { type: "reset_to_shipped"; name: string; scope: Scope }
  | { type: "unchanged"; name: string };

/**
 * Presents an Agents controller event for the terminal notification surface.
 *
 * @param event - Structured controller event.
 * @returns Terminal text and semantic tone.
 */
export function presentAgentsEvent(event: AgentsEvent): Notice {
  switch (event.type) {
    case "save_blocked":
      return { message: `cannot save ${glyph("emDash")} ${event.message}`, tone: "error" };
    case "save_failed":
      return { message: `save failed: ${errorText(event.error)}`, tone: "error" };
    case "saved":
      return {
        message: event.warning ?? `saved agent '${event.name}' (${event.scope})`,
        tone: event.warning ? "warn" : "success",
      };
    case "forked":
      return {
        message: `forked '${event.source}' ${glyph("arrowRight")} '${event.name}' (${event.scope})`,
        tone: "success",
      };
    case "fork_failed":
      return { message: `fork failed: ${errorText(event.error)}`, tone: "error" };
    case "already_exists":
      return { message: `agent '${event.name}' already exists (${event.scope})`, tone: "warn" };
    case "create_failed":
      return { message: `create failed: ${errorText(event.error)}`, tone: "error" };
    case "renamed":
      return {
        message: `renamed '${event.oldName}' ${glyph("arrowRight")} '${event.newName}'`,
        tone: "success",
      };
    case "rename_failed":
      return { message: `rename failed: ${errorText(event.error)}`, tone: "error" };
    case "delete_failed":
      return { message: `delete failed: ${errorText(event.error)}`, tone: "error" };
    case "deleted":
      return { message: `deleted '${event.name}' (${event.scope})`, tone: "success" };
    case "reset_to_shipped":
      return {
        message: `'${event.name}' reset to the shipped default (${event.scope} customization removed)`,
        tone: "success",
      };
    case "unchanged":
      return {
        message: `'${event.name}' matches the shipped default ${glyph("emDash")} nothing written`,
        tone: "info",
      };
  }
}
