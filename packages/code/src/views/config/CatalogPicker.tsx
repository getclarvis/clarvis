import type { Accessor, JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { InputRenderable, KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useTerminalDimensions } from "@opentui/solid";
import { tokens } from "../../theme/tokens.ts";
import { labelRuns } from "../../core/fuzzy.ts";
import { LAYER } from "../../ui/patterns/level-keys.ts";
import { ListPicker } from "../overlays/ListPicker.tsx";
import type { PickerCell } from "../overlays/PickerRow.tsx";
import { filterRows, MODEL_LABEL_WIDTH, type CatalogRow } from "./catalog-pick.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { BANNER, BrandBanner, firstRunSplashFits } from "../Splash.tsx";

const ADDED_COL_WIDTH = glyphColWidth("success");

const COMPACT_FILTER_MAX = 8;

/** Behavior and data supplied to one catalog-picker activation. */
export interface CatalogPickerSpec {
  title: string;
  rows: () => CatalogRow[];
  onPick: (id: string) => void;
  onManual?: () => void;
  manualEnabled?: Accessor<boolean>;
  onClose: () => void;
  /** Contextual Escape wording when cancel/done would misstate navigation. */
  escLabel?: string;
  /** Contextual action label; may depend on the currently selected row. */
  confirmLabel?: string | ((row: CatalogRow | undefined) => string);
  stayOpen?: boolean;
  counter?: () => number;
  counterLabel?: string;
  /** Force (or forbid) compact mode; unset auto-compacts short lists. */
  compact?: boolean;
  /** Open pre-selected on this row (fe.startEnum's "current value" contract). */
  initialId?: string;
  /** Persistently marks the applied enum value independently from the row cursor. */
  currentId?: string;
}

export interface CatalogPickerProps extends CatalogPickerSpec {
  keymap: Keymap<Renderable, KeyEvent>;
  active?: Accessor<boolean>;
  resetKey?: Accessor<unknown>;
  /** Keeps the complete Clarvis splash above a first-run picker when it fits. */
  firstRun?: boolean;
}

export interface CatalogPickerSurfaceProps {
  keymap: Keymap<Renderable, KeyEvent>;
  /** Current activation data; null while a retained picker is hidden. */
  spec: Accessor<CatalogPickerSpec | null>;
  active?: Accessor<boolean>;
  /** Keeps the complete Clarvis splash above a first-run picker when it fits. */
  firstRun?: boolean;
}

/**
 * A filterable, fuzzy-highlighted list picker over a model/provider catalog,
 * built on {@link ListPicker}.
 *
 * @remarks
 * `compact` and `initialId` (see {@link CatalogPickerProps}) auto-derive
 * sensible defaults, but a caller with an already-known selection or list
 * length can override either.
 */
export function CatalogPicker(props: CatalogPickerProps | CatalogPickerSurfaceProps): JSX.Element {
  const dims = useTerminalDimensions();
  const [term, setTerm] = createSignal("");
  let inputEl: InputRenderable | undefined;
  let latest: CatalogPickerSpec | undefined;
  const current = (): CatalogPickerSpec => {
    if (!("spec" in props)) return props;
    const next = props.spec();
    if (next) latest = next;
    if (!latest) throw new Error("catalog picker mounted before its first activation spec");
    return latest;
  };
  const active = (): boolean => props.active?.() ?? true;
  const resetKey = "spec" in props ? props.spec : props.resetKey;
  const showFirstRunSplash = (): boolean =>
    props.firstRun === true && firstRunSplashFits(dims().width, dims().height);
  const pickerContentWidth = (): number =>
    Math.max(0, Math.min(Math.floor(dims().width * 0.85), 100) - 4);
  const firstRunIntroRows = (): number => (showFirstRunSplash() ? BANNER.length + 1 : 0);

  const compact = (): boolean => current().compact ?? current().rows().length <= COMPACT_FILTER_MAX;
  const manualEnabled = (): boolean =>
    current().manualEnabled?.() ?? current().onManual !== undefined;
  const initialIndex = (): number | undefined => {
    if (current().initialId === undefined) return undefined;
    const i = filterRows(current().rows(), "", manualEnabled()).findIndex(
      (r) => r.id === current().initialId,
    );
    return i >= 0 ? i : undefined;
  };

  function pick(row: CatalogRow): void {
    if (row.manual) {
      current().onManual?.();
      return;
    }
    current().onPick(row.id);
    if (current().stayOpen && inputEl) inputEl.value = "";
  }

  const labelCell = (row: CatalogRow, selected: () => boolean): PickerCell => ({
    ...(row.columns?.length ? { grow: true } : { width: MODEL_LABEL_WIDTH, shrink: true }),
    render: () => (
      <Show when={!row.manual} fallback={<span style={{ fg: tokens.accent2 }}>{row.label}</span>}>
        <For each={labelRuns(row.label, term())}>
          {(run) => (
            <span style={{ fg: run.hit ? tokens.accent : selected() ? tokens.fg : tokens.muted }}>
              {run.text}
            </span>
          )}
        </For>
      </Show>
    ),
  });

  const cells = (row: CatalogRow, selected: () => boolean): PickerCell[] => [
    current().currentId !== undefined
      ? {
          width: ADDED_COL_WIDTH,
          fg: row.id === current().currentId ? tokens.accent : tokens.muted,
          text: row.id === current().currentId ? glyph("radioOn") : glyph("radioOff"),
        }
      : row.action
        ? { width: ADDED_COL_WIDTH, fg: tokens.accent2, text: glyph("arrowRight") }
        : { width: ADDED_COL_WIDTH, fg: tokens.add, text: row.added ? glyph("success") : " " },
    labelCell(row, selected),
    ...(row.columns ?? []).map((col) => ({
      width: col.width,
      shrink: true,
      marginLeft: 2,
      text: col.text,
    })),
    ...(row.detail ? [{ grow: true, marginLeft: 2, text: row.detail }] : []),
  ];

  const counterExtra = (): string | undefined => {
    const n = current().counter?.() ?? 0;
    return n > 0 ? `${glyph("separator")}  ${n} ${current().counterLabel ?? "added"}` : undefined;
  };

  return (
    <ListPicker<CatalogRow>
      keymap={props.keymap}
      title={current().title}
      items={() => filterRows(current().rows(), term(), manualEnabled())}
      cells={cells}
      onConfirm={pick}
      confirmLabel={current().confirmLabel ?? (current().stayOpen ? "add/remove" : "select")}
      onClose={() => current().onClose()}
      escLabel={current().escLabel ?? (current().stayOpen ? "done" : "cancel")}
      filter={
        compact()
          ? undefined
          : {
              haystack: () => term(),
              onInput: (el) => {
                inputEl = el;
                const forward = el.onContentChange;
                el.onContentChange = (event) => {
                  forward?.(event);
                  setTerm(el.value);
                };
              },
            }
      }
      footerExtra={counterExtra()}
      intro={
        <Show when={showFirstRunSplash()}>
          <box flexDirection="column" flexShrink={0} alignItems="center" paddingBottom={1}>
            <BrandBanner width={pickerContentWidth} />
          </box>
        </Show>
      }
      introRows={firstRunIntroRows}
      idPrefix="cat-"
      initialIndex={initialIndex()}
      priority={LAYER.MODAL}
      guards={["ctrl+s", "ctrl+t"]}
      active={active}
      resetKey={resetKey}
    />
  );
}
