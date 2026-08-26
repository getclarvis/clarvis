import type { Accessor, JSX } from "solid-js";
import { createMemo, Index } from "solid-js";

/** A contiguous slice of `items` sized to fit a viewport, plus its hidden item counts. */
export interface RowWindow<T> {
  rows: T[];
  offset: number;
  above: number;
  below: number;
}

/**
 * Slices `items` down to at most `max` rows while keeping `index` visible.
 *
 * @remarks
 * Below three rows there is no room for both overflow indicators and content, so the window keeps
 * only the selected row and reports the remaining items on either side.
 */
export function windowRows<T>(items: readonly T[], index: number, max: number): RowWindow<T> {
  const n = items.length;
  if (max <= 0 || n === 0) return { rows: [], offset: 0, above: 0, below: 0 };
  const selected = Math.max(0, Math.min(n - 1, index));
  if (n <= max) return { rows: [...items], offset: 0, above: 0, below: 0 };
  if (max < 3)
    return {
      rows: [items[selected]!],
      offset: selected,
      above: selected,
      below: n - selected - 1,
    };
  const cap = max - 1;
  if (selected < cap) return { rows: items.slice(0, cap), offset: 0, above: 0, below: n - cap };
  const bottomOffset = n - cap;
  if (selected >= bottomOffset) {
    return {
      rows: items.slice(bottomOffset),
      offset: bottomOffset,
      above: bottomOffset,
      below: 0,
    };
  }
  const middleCap = max - 2;
  const offset = Math.min(Math.max(selected - Math.floor(middleCap / 2), 1), n - middleCap - 1);
  return {
    rows: items.slice(offset, offset + middleCap),
    offset,
    above: offset,
    below: n - offset - middleCap,
  };
}

/** A {@link RowWindow} with an optional group header parallel to each visible row. */
export interface GroupedRowWindow<T> extends RowWindow<T> {
  headers: (string | undefined)[];
}

function headersFor<T extends { group?: string }>(rows: readonly T[]): (string | undefined)[] {
  return rows.map((item, index) =>
    item.group && (index === 0 || item.group !== rows[index - 1]!.group) ? item.group : undefined,
  );
}

/**
 * Windows grouped rows while accounting for sticky group headers in the total line budget.
 *
 * @remarks The first visible item always receives its group header, including when the window
 * starts in the middle of a group.
 */
export function windowGroupedRows<T extends { group?: string }>(
  items: readonly T[],
  index: number,
  max: number,
): GroupedRowWindow<T> {
  let budget = max;
  let win = windowRows(items, index, budget);
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = headersFor(win.rows);
    const headerCount = headers.filter((header) => header !== undefined).length;
    const indicatorLines = (win.above > 0 ? 1 : 0) + (win.below > 0 ? 1 : 0);
    if (win.rows.length + headerCount + indicatorLines <= max) return { ...win, headers };
    budget = max - headerCount;
    win = windowRows(items, index, budget);
  }
  return { ...win, headers: headersFor(win.rows) };
}

/** The reactive state exposed for one retained row slot. */
export interface StableWindowSlot<T> {
  item: Accessor<T | undefined>;
  index: Accessor<number>;
  selected: Accessor<boolean>;
  visible: Accessor<boolean>;
  header: Accessor<string | undefined>;
  headerVisible: Accessor<boolean>;
}

/** The reactive state exposed for a retained overflow-indicator slot. */
export interface StableWindowOverflow {
  count: Accessor<number>;
  visible: Accessor<boolean>;
}

/**
 * Projects a scrolling collection into a fixed pool of retained row slots.
 *
 * @remarks
 * Consumers own row presentation while this pattern owns windowing, item identity and stable
 * Solid/OpenTUI slot lifetime. `slotCount` is captured at mount and must be the component's maximum
 * row count; changing terminal height changes visibility and content without mounting more rows.
 */
export function StableWindowedList<T>(props: {
  items: readonly T[];
  index: number;
  maxLines: number;
  slotCount: number;
  grouped?: boolean;
  above?: (state: StableWindowOverflow) => JSX.Element;
  row: (state: StableWindowSlot<T>) => JSX.Element;
  tail?: JSX.Element;
  below?: (state: StableWindowOverflow) => JSX.Element;
}): JSX.Element {
  const slots = Array.from(
    { length: Math.max(0, Math.trunc(props.slotCount)) },
    (_, index) => index,
  );
  const win = createMemo<GroupedRowWindow<T>>(() => {
    if (props.grouped)
      return windowGroupedRows(
        props.items as readonly (T & { group?: string })[],
        props.index,
        props.maxLines,
      );
    return { ...windowRows(props.items, props.index, props.maxLines), headers: [] };
  });
  const above = (): number => win().above;
  const below = (): number => win().below;

  return (
    <>
      {props.above?.({ count: above, visible: () => above() > 0 })}
      <Index each={slots}>
        {(_, localIndex) => {
          const item = (): T | undefined => win().rows[localIndex];
          const index = (): number => win().offset + localIndex;
          const header = (): string | undefined => win().headers[localIndex];
          return props.row({
            item,
            index,
            selected: () => item() !== undefined && index() === props.index,
            visible: () => item() !== undefined,
            header,
            headerVisible: () => header() !== undefined,
          });
        }}
      </Index>
      {props.tail}
      {props.below?.({ count: below, visible: () => below() > 0 })}
    </>
  );
}
