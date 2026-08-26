import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { FieldEditor } from "./view-host.tsx";
import type { CatalogPickerSpec } from "./CatalogPicker.tsx";
import { configuredModelRows } from "./catalog-pick.ts";
import { glyph } from "../../theme/glyphs.ts";

/**
 * Builds a {@link CatalogPickerSpec} for picking a model from the configured providers.
 *
 * @param opts - Picker wiring: optional manual editor, settings adapter, current value, and
 * commit/close/onNoProviders callbacks.
 * @returns A spec for the catalog picker, or `null` when there are no configured providers.
 * @remarks
 * When no provider is configured, falls back to manual entry via `opts.fe.start` if a manual
 * editor was supplied, otherwise calls `opts.onNoProviders`; either way there is nothing to pick
 * from, so `null` is returned.
 */
export function modelPickerSpec(opts: {
  /** Manual-entry editor; hosts without one (the /model picker) omit it. */
  fe?: Pick<FieldEditor, "start">;
  settings: SettingsAdapter;
  current: string;
  commit: (value: string) => void;
  close: () => void;
  /** Called when no provider is configured and there is no manual editor to fall back to. */
  onNoProviders?: () => void;
  /** Restrict the offered models to those declaring this capability. */
  requireCapability?: string;
  /** Overrides the picker's title; use when the field is not "the model". */
  title?: string;
}): CatalogPickerSpec | null {
  const fe = opts.fe;
  const manual = fe
    ? (): void => fe.start("model (provider/modelId)", opts.current, (v) => opts.commit(v.trim()))
    : undefined;
  const providers = opts.settings.effective().providers ?? [];
  if (providers.length === 0) {
    if (manual) manual();
    else opts.onNoProviders?.();
    return null;
  }
  return {
    title: opts.title ?? "Pick a model " + glyph("emDash") + " configured providers",
    rows: () =>
      configuredModelRows(
        opts.settings.effective().providers ?? [],
        opts.current,
        opts.requireCapability,
      ),
    ...(manual
      ? {
          onManual: () => {
            opts.close();
            manual();
          },
        }
      : {}),
    onClose: opts.close,
    onPick: (id) => {
      opts.close();
      opts.commit(id);
    },
  };
}
