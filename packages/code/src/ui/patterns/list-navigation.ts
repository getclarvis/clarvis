import { createEffect, untrack } from "solid-js";
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Binding, Command, Keymap, ReactiveMatcher } from "@opentui/keymap";
import { LAYER } from "../../keys/keyspec.ts";
import { uiCommand } from "../../keys/actions.ts";

type OpenTuiBinding = Binding<Renderable, KeyEvent>;
type OpenTuiCommand = Command<Renderable, KeyEvent>;

const sentenceCase = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

/**
 * Clamps a list index into `[0, count - 1]`, collapsing to `0` for an empty list.
 *
 * @param index - The candidate index.
 * @param count - The number of items in the list.
 * @returns The clamped index.
 */
export function clampListIndex(index: number, count: number): number {
  return count <= 0 ? 0 : Math.max(0, Math.min(count - 1, index));
}

/** Options for {@link registerListNav}. */
export interface ListNavOptions {
  count: () => number;
  index: () => number;
  setIndex: (index: number) => void;
  /**
   * The list's primary action.
   *
   * @remarks Advertised only while there is a row to act on. An empty list used
   *   to offer `[↵]` in its footer and do nothing on Enter — the Tasks hub with
   *   no provider configured is the case the QA pass caught, and it is invariant
   *   8 ("no silent no-op is advertised"). `when` narrows it further for a list
   *   whose rows are not all actionable.
   *
   *   The gate reads `count` under `untrack`, which is load-bearing: the keymap
   *   evaluates an `enabled` predicate while resolving its own state, so
   *   subscribing to a filtered list's count there made every evaluation queue
   *   the state change that caused the next one.
   */
  activate?: { label: string; run: () => void; when?: () => boolean };
  extra?: OpenTuiBinding[];
  /** Commands referenced by `extra`, registered atomically with those bindings. */
  extraCommands?: OpenTuiCommand[];
  priority?: number;
  page?: number;
  letters?: boolean;
  when?: string;
  /** Reactive lifecycle gate that keeps this layer registered while its surface is hidden. */
  enabled?: ReactiveMatcher;
}

/**
 * Registers a key layer implementing standard list navigation: arrows, optional `j`/`k`, page
 * up/down, home/end, an optional activate binding, and any extra bindings.
 *
 * @param keymap - The OpenTUI keymap to register the layer on.
 * @param opts - Navigation state accessors and behaviour; see {@link ListNavOptions}.
 * @returns A function that unregisters the layer.
 */
export function registerListNav(
  keymap: Keymap<Renderable, KeyEvent>,
  opts: ListNavOptions,
): () => void {
  const page = opts.page ?? 8;
  const to = (i: number): void => opts.setIndex(clampListIndex(i, opts.count()));
  const by = (delta: number): void => to(opts.index() + delta);
  const activate: OpenTuiBinding[] = opts.activate
    ? [{ key: "return", cmd: "ui.list.activate" }]
    : [];
  const letters: OpenTuiBinding[] =
    (opts.letters ?? true)
      ? [
          { key: "k", cmd: "ui.list.previous" },
          { key: "j", cmd: "ui.list.next" },
        ]
      : [];
  const extraKeys = new Set(
    (opts.extra ?? []).flatMap((binding) =>
      typeof binding.key === "string" ? [binding.key.toLowerCase()] : [],
    ),
  );
  const focusTraversal: OpenTuiBinding[] = extraKeys.has("tab")
    ? []
    : [{ key: "tab", cmd: "ui.list.next" }];
  return keymap.registerLayer({
    ...(opts.when === undefined ? {} : { when: opts.when }),
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
    priority: opts.priority ?? LAYER.LIST,
    commands: [
      uiCommand({
        id: "ui.list.previous",
        title: "Previous item",
        description: "Move selection to the previous item",
        category: "navigation",
        surfaces: ["footer"],
        footerLabel: "move",
        hintPriority: 40,
        hintGroup: "navigation",
        run: () => by(-1),
      }),
      uiCommand({
        id: "ui.list.next",
        title: "Next item",
        description: "Move selection to the next item",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => by(1),
      }),
      uiCommand({
        id: "ui.list.pagePrevious",
        title: "Previous page",
        description: "Move selection one page up",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => by(-page),
      }),
      uiCommand({
        id: "ui.list.pageNext",
        title: "Next page",
        description: "Move selection one page down",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => by(page),
      }),
      uiCommand({
        id: "ui.list.first",
        title: "First item",
        description: "Move selection to the first item",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => to(0),
      }),
      uiCommand({
        id: "ui.list.last",
        title: "Last item",
        description: "Move selection to the last item",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => to(opts.count() - 1),
      }),
      ...(opts.activate
        ? [
            uiCommand({
              id: "ui.list.activate",
              title: `${sentenceCase(opts.activate.label)} selected item`,
              description: `${opts.activate.label} the selected row`,
              category: "primary",
              surfaces: ["footer"],
              footerLabel: opts.activate.label,
              hintPriority: 80,
              hintGroup: "primary",
              enabled: () => untrack(() => opts.count() > 0 && (opts.activate?.when?.() ?? true)),
              run: opts.activate.run,
            }),
          ]
        : []),
      ...(opts.extraCommands ?? []),
    ],
    bindings: [
      { key: "up", cmd: "ui.list.previous" },
      { key: "down", cmd: "ui.list.next" },
      ...focusTraversal,
      ...letters,
      { key: "pageup", cmd: "ui.list.pagePrevious" },
      { key: "pagedown", cmd: "ui.list.pageNext" },
      { key: "home", cmd: "ui.list.first" },
      { key: "end", cmd: "ui.list.last" },
      ...activate,
      ...(opts.extra ?? []),
    ],
  });
}

/**
 * Reactively scrolls the selected row into view whenever `index` changes.
 *
 * @param scroll - Accessor for the scroll box to scroll within; a no-op while undefined.
 * @param idPrefix - The row id prefix; the target row's id is `${idPrefix}${index()}`.
 * @param index - The currently selected index.
 */
export function followSelection(
  scroll: () => ScrollBoxRenderable | undefined,
  idPrefix: string,
  index: () => number,
): void {
  createEffect(() => {
    const i = index();
    scroll()?.scrollChildIntoView(`${idPrefix}${i}`);
  });
}

/**
 * Registers a key layer that scrolls a box (arrows, `j`/`k`, page up/down) instead of moving a
 * selection — for a level whose body is scrollable prose rather than a list of rows.
 *
 * @param keymap - The OpenTUI keymap to register the layer on.
 * @param scroll - Accessor for the scroll box to scroll within; a no-op while undefined.
 * @param priority - The layer priority; defaults to `LAYER.LIST`.
 * @returns A function that unregisters the layer.
 */
export function registerScrollKeys(
  keymap: Keymap<Renderable, KeyEvent>,
  scroll: () => ScrollBoxRenderable | undefined,
  priority: number = LAYER.LIST,
  reservedKeys: readonly string[] = [],
  when?: string,
  enabled?: ReactiveMatcher,
): () => void {
  const move = (rows: number): void => scroll()?.scrollBy({ x: 0, y: rows });
  const tabReserved = reservedKeys.some((key) => key.toLowerCase() === "tab");
  return keymap.registerLayer({
    ...(when === undefined ? {} : { when }),
    ...(enabled === undefined ? {} : { enabled }),
    priority,
    commands: [
      uiCommand({
        id: "ui.scroll.up",
        title: "Scroll up",
        description: "Scroll the current document up",
        category: "navigation",
        surfaces: ["footer"],
        footerLabel: "scroll",
        hintPriority: 40,
        hintGroup: "navigation",
        run: () => move(-2),
      }),
      uiCommand({
        id: "ui.scroll.down",
        title: "Scroll down",
        description: "Scroll the current document down",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => move(2),
      }),
      uiCommand({
        id: "ui.scroll.pageUp",
        title: "Scroll previous page",
        description: "Scroll the current document one page up",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => move(-8),
      }),
      uiCommand({
        id: "ui.scroll.pageDown",
        title: "Scroll next page",
        description: "Scroll the current document one page down",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => move(8),
      }),
    ],
    bindings: [
      { key: "up", cmd: "ui.scroll.up" },
      { key: "k", cmd: "ui.scroll.up" },
      { key: "down", cmd: "ui.scroll.down" },
      { key: "j", cmd: "ui.scroll.down" },
      ...(tabReserved ? [] : [{ key: "tab", cmd: "ui.scroll.pageDown" }]),
      { key: "pageup", cmd: "ui.scroll.pageUp" },
      { key: "pagedown", cmd: "ui.scroll.pageDown" },
    ],
  });
}
