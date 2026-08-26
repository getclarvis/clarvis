/**
 * Compatibility barrel for the config view toolkit.
 * Implementations live in ui/primitives, ui/patterns, create-view-host, and field-editor.
 */

import type { JSX } from "solid-js";
import type { ViewHost } from "../../keys/commands.ts";
import { LevelHost as UiLevelHost, type LevelView } from "../../ui/patterns/level-host.tsx";
import { CatalogPicker, type CatalogPickerSpec } from "./CatalogPicker.tsx";
import type { FieldEditor } from "./field-editor.tsx";

export { createViewHost, type ViewHostBundle, type ViewHostControls } from "./create-view-host.ts";

export {
  createFieldEditor,
  type FieldEditState,
  type FieldEditor,
  type PickItem,
} from "./field-editor.tsx";

export {
  SourceBadge,
  SelectableRow,
  EmptyHint,
  LoadingHint,
  ErrorBanner,
  FieldRow,
  ToggleRow,
  SectionHeader,
  StatusRow,
  SettingRow,
  DetailLines,
  Dash,
  type DetailRow,
} from "../../ui/primitives/index.ts";

export { bindLevelKeys, SelectableList, ViewFrame } from "../../ui/patterns/index.ts";

export type { LevelView };

/**
 * Configuration-level host that binds the generic UI pattern to the catalog picker.
 *
 * @param props - Level, editor, and picker state for a configuration panel.
 * @returns The active level and optional picker overlay.
 */
export function LevelHost(props: {
  host: ViewHost;
  levels: LevelView[];
  editor?: FieldEditor;
  picker?: () => CatalogPickerSpec | null;
}): JSX.Element {
  return (
    <UiLevelHost
      {...props}
      renderPicker={(picker, active) => (
        <CatalogPicker keymap={props.host.interaction.keymap} active={active} spec={picker} />
      )}
    />
  );
}
