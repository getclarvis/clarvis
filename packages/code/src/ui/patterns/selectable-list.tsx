import type { Accessor, JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { GlyphName } from "../../theme/glyphs.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { clampListIndex, followSelection } from "./list-navigation.ts";
import { EmptyHint, ErrorBanner, LoadingHint } from "../primitives/index.ts";

/**
 * Renders a scrollable, selection-following list of rows with error/loading/empty states, keeping
 * the selected row in view as `sel` changes.
 *
 * @param props.each - The items to render.
 * @param props.sel - The selected index, clamped against `each().length` before use.
 * @param props.idPrefix - Row id prefix; each row's id is `${idPrefix}${index}`, used to scroll it
 * into view.
 * @param props.row - Renders one item at its index.
 * @param props.empty - Renders the empty state; shown only once loading has finished and there is
 * no error.
 * @param props.loading - Whether the list is still loading; suppresses the empty state while true.
 * @param props.error - An error message to show instead of the list.
 * @param props.trailing - Extra content rendered after the list (e.g. an "add" row).
 * @param props.maxRows - Caps the scrollbox height, in rows.
 * @param props.contentRows - Override when rows are taller than one line (group headers etc.).
 * @returns The list, or its error/loading/empty fallback.
 */
export function SelectableList<T>(props: {
  each: () => readonly T[];
  sel: () => number;
  idPrefix: string;
  row: (item: T, index: Accessor<number>) => JSX.Element;
  empty?: () => { text: string; hint?: string; icon?: GlyphName };
  loading?: () => boolean;
  error?: () => string | null;
  trailing?: JSX.Element;
  maxRows?: number;
  /** Override when rows are taller than one line (group headers etc.). */
  contentRows?: () => number;
}): JSX.Element {
  let scrollEl: ScrollBoxRenderable | undefined;
  followSelection(
    () => scrollEl,
    props.idPrefix,
    () => clampListIndex(props.sel(), props.each().length),
  );
  const contentHeight = (): number =>
    Math.max(
      1,
      Math.min(
        props.contentRows?.() ?? props.each().length,
        props.maxRows ?? Number.POSITIVE_INFINITY,
      ),
    );
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
      <Show when={props.error?.()}>
        <ErrorBanner text={props.error!()!} />
      </Show>
      <Show when={props.each().length === 0 && !props.error?.() && (props.loading?.() ?? false)}>
        <LoadingHint />
      </Show>
      <Show when={props.each().length > 0}>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => (scrollEl = el)}
          maxHeight={contentHeight()}
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <For each={props.each()}>
            {(item, i) => (
              <box
                id={`${props.idPrefix}${i()}`}
                width="100%"
                flexShrink={0}
                flexDirection="column"
              >
                {props.row(item, i)}
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show
        when={
          props.each().length === 0 &&
          !props.error?.() &&
          !(props.loading?.() ?? false) &&
          props.empty
        }
      >
        <EmptyHint {...props.empty!()} />
      </Show>
      {props.trailing}
    </box>
  );
}
