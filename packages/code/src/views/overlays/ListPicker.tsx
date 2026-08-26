import type { Accessor, JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { InputRenderable, KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useTerminalDimensions } from "@opentui/solid";
import { glyph, type GlyphName } from "../../theme/glyphs.ts";
import { fuzzyFilter } from "../../core/fuzzy.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import {
  LAYER,
  registerLevel,
  verb,
  type LevelSpec,
  type PanelVerbName,
  type VerbSpec,
} from "../../ui/patterns/level-keys.ts";
import { tokens } from "../../theme/tokens.ts";
import { EmptyHint } from "../../ui/primitives/hints.tsx";
import { windowRows } from "../../ui/patterns/windowed-list.tsx";
import { FLOAT_CHROME_ROWS, floatMaxRows, FloatFrame } from "./FloatFrame.tsx";
import { InteractionNavigationBar } from "../../ui/patterns/navigation-bar.tsx";
import type { Interaction } from "../../keys/interaction.ts";
import { FilterField } from "./FilterField.tsx";
import { PickerRow, type PickerCell } from "./PickerRow.tsx";

const PREVIEW_ROWS = 3;

/**
 * An extra key-bound action available on the currently-selected item in a
 * {@link ListPicker}: either a shared {@link PanelVerbName} (for consistent
 * cross-panel labeling) or a one-off `key`/`label` pair.
 */
export type ListPickerVerb<T> =
  | { verb: PanelVerbName; run: (item: T) => void; when?: () => boolean }
  | { key: string; label: string; run: (item: T) => void; when?: () => boolean };

/**
 * A generic filterable, scrollable, keyboard-navigable list picker rendered
 * inside a {@link FloatFrame}, parameterized over the item type `T`.
 *
 * @remarks
 * Selection tracking, fuzzy filtering, scroll-follow and the registered key
 * level are all owned here, so callers only supply how an item renders
 * (`cells`), matches a filter term (`filter.haystack`) and is confirmed
 * (`onConfirm`).
 */
export function ListPicker<T>(props: {
  keymap: Keymap<Renderable, KeyEvent>;
  title: string;
  items: () => T[];
  cells: (item: T, selected: () => boolean) => PickerCell[];
  onConfirm: (item: T) => void;
  confirmLabel?: string | ((item: T | undefined) => string);
  onClose?: () => void;
  escLabel?: string;
  verbs?: ListPickerVerb<T>[];
  filter?: { haystack: (item: T) => string; onInput?: (el: InputRenderable) => void };
  empty?: (term: string) => { text: string; hint?: string; icon?: GlyphName };
  onSelect?: (item: T | undefined, index: number) => void;
  footer?: () => string | undefined;
  footerExtra?: string;
  footerFg?: string;
  size?: "sm" | "lg";
  base?: string;
  idPrefix?: string;
  initialIndex?: number;
  priority?: number;
  guards?: string[];
  preview?: (item: T) => JSX.Element;
  /** Suppresses this picker's layer and input focus while its parent page is hidden in a stack. */
  active?: Accessor<boolean>;
  /** Resets transient filter and selection state when a retained host receives a new picker spec. */
  resetKey?: Accessor<unknown>;
}): JSX.Element {
  const [term, setTerm] = createSignal("");
  const [sel, setSel] = createSignal(props.initialIndex ?? 0);
  const idPrefix = props.idPrefix ?? "pick-";

  const rows = createMemo<T[]>(() => {
    const f = props.filter;
    const t = term().trim();
    return f && t !== "" ? fuzzyFilter(props.items(), t, f.haystack) : props.items();
  });
  const clamp = (i: number): number => clampListIndex(i, rows().length);
  createEffect(on(term, () => setSel(0), { defer: true }));
  if (props.resetKey)
    createEffect(
      on(
        props.resetKey,
        () => {
          setTerm("");
          setSel(props.initialIndex ?? 0);
        },
        { defer: true },
      ),
    );
  createEffect(() => props.onSelect?.(rows()[clamp(sel())], clamp(sel())));

  function confirm(): void {
    const item = rows()[clamp(sel())];
    if (item !== undefined) props.onConfirm(item);
  }

  const toVerbSpec = (v: ListPickerVerb<T>): VerbSpec => {
    const run = (): void => {
      const item = rows()[clamp(sel())];
      if (item !== undefined) v.run(item);
    };
    if ("verb" in v) return verb(v.verb, run, v.when);
    const spec: VerbSpec = { key: v.key, label: v.label, run };
    if (v.when) spec.when = v.when;
    return spec;
  };

  const spec = (): LevelSpec => {
    const level: LevelSpec = {
      nav: {
        count: () => rows().length,
        index: sel,
        setIndex: (i) => setSel(clamp(i)),
        lettersNav: !props.filter,
        showArrows: true,
        activate: {
          label:
            typeof props.confirmLabel === "function"
              ? props.confirmLabel(rows()[clamp(sel())])
              : (props.confirmLabel ?? "select"),
          run: confirm,
        },
      },
      verbs: (props.verbs ?? []).map(toVerbSpec),
      escape: { label: props.escLabel ?? "cancel" },
      ...(props.active ? { enabled: props.active } : {}),
    };
    if (props.onClose) level.escape!.run = props.onClose;
    if (props.guards) level.guards = props.guards;
    return level;
  };

  const dims = useTerminalDimensions();
  const contentRows = (): number => {
    if (rows().length > 0) return rows().length;
    return (props.empty?.(term()) ?? { text: "" }).hint !== undefined ? 2 : 1;
  };
  /** Rows left for the list once the card's chrome, filter and preview are paid for. */
  const rowBudget = (reservePreview: boolean): number =>
    floatMaxRows(dims().height) -
    FLOAT_CHROME_ROWS -
    (props.filter ? 2 : 0) -
    (reservePreview ? PREVIEW_ROWS : 0);
  /**
   * Whether the preview pane still leaves the list a row to stand on.
   *
   * @remarks The preview is supplementary; the rows, the filter and the footer
   *   are not. It is a `flexShrink={0}` fixed-height box, so at a reduced height
   *   it could not yield — and the list's own floor demanded three rows whether
   *   or not they fitted. Between them the card overflowed its `maxHeight`: at
   *   100x13 the description row painted *into* the bottom border and the
   *   footnote spilled outside the box entirely.
   */
  const previewFits = (): boolean => props.preview !== undefined && rowBudget(true) >= 1;
  const maxVisibleRows = (): number => Math.max(1, rowBudget(previewFits()));
  const scrollHeight = (): number =>
    Math.min(contentRows(), maxVisibleRows()) + (props.filter ? 1 : 0);
  /**
   * The slice of rows actually mounted, plus how many sit off either end.
   *
   * @remarks The list is **windowed** rather than scrolled: only the rows that
   *   fit are mounted, and `above`/`below` carry the overflow the scrollbar used
   *   to. Every mounted row costs roughly 10 KiB of native memory that is not
   *   returned when the overlay closes (see
   *   `specs/known-issues.md#every-floatframe-overlay-leaks-native-memory-per-rendered-row`),
   *   so a picker that mounted ~102 rows to show ~12 leaked an order of
   *   magnitude more than it needed to, every time it was opened.
   *
   *   The trade is the scroll box's mouse wheel, which a windowed list has
   *   nothing to scroll. Rows stay clickable, the keyboard path is unchanged,
   *   and this is the same shape `AutocompletePopup` already uses.
   */
  const win = createMemo(() => windowRows(rows(), clamp(sel()), maxVisibleRows()));
  /**
   * Whether the overflow indicators fit beside a row.
   *
   * @remarks `windowRows` guarantees `rows + indicators <= max` only from
   *   `max >= 3`. Below that it returns the selected row and reports the rest
   *   as overflow on *both* sides, so a budget of 1 or 2 still mounts three
   *   lines. `rowBudget(false)` is 2 at 12 terminal rows and 1 at 11 - well
   *   above the 6-row floor - so a filtered picker painted past the card there,
   *   the same symptom the preview budget above exists to prevent. The selected
   *   row is what the user needs at that height; the counts are what goes.
   */
  const showOverflow = (): boolean => maxVisibleRows() >= 3;

  /**
   * Move the selection by a wheel notch, so a windowed list keeps the scroll
   * box's mouse parity instead of trading it away.
   */
  const onWheel = (event: { scroll?: { direction: string; delta: number } }): void => {
    const scroll = event.scroll;
    if (!scroll) return;
    const step = Math.max(1, Math.trunc(scroll.delta)) * (scroll.direction === "up" ? -1 : 1);
    if (scroll.direction !== "up" && scroll.direction !== "down") return;
    setSel((current) => clamp(current + step));
  };

  let off: (() => void) | undefined;
  onMount(() => {
    off = registerLevel(props.keymap, spec(), props.priority ?? LAYER.OVERLAY);
  });
  onCleanup(() => off?.());

  const footer = (): string =>
    [props.footer?.(), props.footerExtra].filter((value): value is string => !!value).join("  ");

  return (
    <FloatFrame
      title={props.title}
      footer={footer()}
      navigation={
        typeof props.keymap.getActiveKeys === "function" ? (
          <InteractionNavigationBar
            interaction={{ keymap: props.keymap } as Interaction}
            actionFilter={(action) =>
              action.id.startsWith("ui.list.") || action.id.startsWith("ui.level.")
            }
          />
        ) : undefined
      }
      footerFg={props.footerFg}
      size={props.size ?? "lg"}
    >
      <Show when={props.filter}>
        <FilterField onTerm={setTerm} onInput={props.filter?.onInput} active={props.active} />
      </Show>
      <box
        flexDirection="column"
        height={scrollHeight()}
        flexShrink={1}
        overflow="hidden"
        paddingTop={props.filter ? 1 : 0}
        onMouseScroll={onWheel}
      >
        <Show when={showOverflow() && win().above > 0}>
          <text fg={tokens.muted} height={1} flexShrink={0} selectable={false}>
            {`  ${glyph("arrowUp")} ${win().above} more`}
          </text>
        </Show>
        <Index each={win().rows}>
          {(item, i) => {
            const at = (): number => win().offset + i;
            return (
              <PickerRow
                selected={at() === clamp(sel())}
                id={`${idPrefix}${at()}`}
                base={props.base}
                cells={props.cells(item(), () => at() === clamp(sel()))}
                onSelect={() => setSel(at())}
                onConfirm={confirm}
              />
            );
          }}
        </Index>
        <Show when={showOverflow() && win().below > 0}>
          <text fg={tokens.muted} height={1} flexShrink={0} selectable={false}>
            {`  ${glyph("arrowDown")} ${win().below} more`}
          </text>
        </Show>
        <Show when={rows().length === 0}>
          <EmptyHint {...(props.empty?.(term()) ?? { text: "no matches" })} />
        </Show>
      </box>
      <Show when={previewFits() && rows()[clamp(sel())]}>
        {(item: Accessor<T>) => (
          <box
            flexDirection="column"
            flexShrink={0}
            paddingTop={1}
            height={PREVIEW_ROWS}
            overflow="hidden"
          >
            {props.preview!(item())}
          </box>
        )}
      </Show>
    </FloatFrame>
  );
}
