import type { Accessor, JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import type { ViewHost } from "../../keys/commands.ts";
import { ViewFrame } from "./view-frame.tsx";
import { SurfaceBoundary } from "./surface-lifecycle.tsx";

interface EditorHost {
  editing: () => object | null;
  EditInput: () => JSX.Element;
  PickerInput?: () => JSX.Element;
}

/** One level in a {@link LevelHost}'s stack. */
export interface LevelView {
  title: string | (() => string);
  body: () => JSX.Element;
  when?: () => boolean;
  readOnly?: boolean;
}

/**
 * Renders whichever {@link LevelView} is active for the host's current depth (or a `when`-selected
 * level out of depth order), wrapped in a {@link ViewFrame}, plus an optional picker overlay.
 *
 * @param props.host - Drives the active depth, breadcrumb, scope and pending-confirm chrome.
 * @param props.levels - The level stack; the first level whose `when()` is true wins, else the one at
 * the current depth.
 * @param props.editor - Optional inline editor rendered inside the active level's frame while editing.
 * @param props.picker - Optional accessor for a picker overlay's spec, rendered outside the frame.
 * @param props.renderPicker - Renders the picker overlay for a non-null `picker` value.
 * @returns The active level's frame, plus the picker overlay when one is open.
 */
export function LevelHost<PickerSpec = never>(props: {
  host: ViewHost;
  levels: LevelView[];
  editor?: EditorHost;
  picker?: () => PickerSpec | null;
  renderPicker?: (spec: Accessor<PickerSpec | null>, active: Accessor<boolean>) => JSX.Element;
}): JSX.Element {
  const depth = (): number => props.host.level.depth();
  const active = createMemo<LevelView | undefined>(() =>
    props.levels.find((lv, i) => (lv.when ? lv.when() : i === depth())),
  );
  const title = (): string => {
    const t = active()?.title;
    return typeof t === "function" ? t() : (t ?? "");
  };
  const picker = (): PickerSpec | null => props.picker?.() ?? null;
  return (
    <>
      <Show when={active()}>
        <ViewFrame host={props.host} title={title()} readOnly={active()?.readOnly ?? false}>
          {active()?.body()}
          <Show when={props.editor?.editing()}>{props.editor!.EditInput()}</Show>
        </ViewFrame>
      </Show>
      {props.editor?.PickerInput?.()}
      <SurfaceBoundary
        active={() => props.host.active() && picker() !== null}
        retention="retain-one"
        placement="portal"
      >
        {(lifecycle) => props.renderPicker?.(picker, lifecycle.active)}
      </SurfaceBoundary>
    </>
  );
}
