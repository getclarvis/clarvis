import type { KeyEvent, Renderable } from "@opentui/core";
import type { Command, Keymap } from "@opentui/keymap";

/** Surfaces that may project one named action. */
export type ActionSurface = "footer" | "full-help" | "internal";

/** Stable ordering groups shared by the footer and full Help screen. */
export type ActionHintGroup = "primary" | "navigation" | "mutation" | "escape";

/** Product-facing action declaration compiled into one OpenTUI command. */
export interface UiActionSpec {
  id: string;
  title: string;
  description: string;
  category: string;
  run(): void | Promise<void>;
  surfaces: readonly ActionSurface[];
  footerLabel?: string;
  hintPriority?: number;
  hintGroup?: ActionHintGroup;
  essential?: boolean;
  enabled?: () => boolean;
}

type OpenTuiCommand = Command<Renderable, KeyEvent>;
type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;

function expectString(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

/** Registers Clarvis projection fields once on a keymap and returns their disposer. */
export function registerUiActionFields(keymap: OpenTuiKeymap): () => void {
  const offCommands = keymap.registerCommandFields({
    uiTitle(value, ctx) {
      ctx.attr("uiTitle", expectString("uiTitle", value));
    },
    uiDescription(value, ctx) {
      ctx.attr("uiDescription", expectString("uiDescription", value));
    },
    uiCategory(value, ctx) {
      ctx.attr("uiCategory", expectString("uiCategory", value));
    },
    uiSurfaces(value, ctx) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new Error("uiSurfaces must be an array of strings");
      ctx.attr("uiSurfaces", [...value]);
    },
    footerLabel(value, ctx) {
      ctx.attr("footerLabel", expectString("footerLabel", value));
    },
    hintPriority(value, ctx) {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error("hintPriority must be a finite number");
      ctx.attr("hintPriority", value);
    },
    hintGroup(value, ctx) {
      ctx.attr("hintGroup", expectString("hintGroup", value));
    },
    essential(value, ctx) {
      if (typeof value !== "boolean") throw new Error("essential must be a boolean");
      ctx.attr("essential", value);
    },
  });
  return () => offCommands();
}

/** Turns one semantic action declaration into the command the keymap dispatches and describes. */
export function uiCommand(spec: UiActionSpec): OpenTuiCommand {
  return {
    name: spec.id,
    title: spec.title,
    desc: spec.description,
    category: spec.category,
    uiTitle: spec.title,
    uiDescription: spec.description,
    uiCategory: spec.category,
    uiSurfaces: [...spec.surfaces],
    ...(spec.footerLabel ? { footerLabel: spec.footerLabel } : {}),
    ...(spec.hintPriority === undefined ? {} : { hintPriority: spec.hintPriority }),
    ...(spec.hintGroup ? { hintGroup: spec.hintGroup } : {}),
    ...(spec.essential === undefined ? {} : { essential: spec.essential }),
    ...(spec.enabled ? { enabled: spec.enabled } : {}),
    run: () => spec.run(),
  };
}
