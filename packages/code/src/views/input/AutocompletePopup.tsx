import type { JSX } from "solid-js";
import { createMemo, Index, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { tokens } from "../../theme/tokens.ts";
import { borderChars, glyph } from "../../theme/glyphs.ts";
import { overlayBg } from "../../theme/surfaces.ts";
import { PickerRow } from "../overlays/PickerRow.tsx";
import type { CompleteItem } from "./autocomplete.ts";
import { labelRuns, matchRuns, type HighlightRun, type ItemMatch } from "../../core/fuzzy.ts";
import { CommandGroupHeader } from "./CommandGroupHeader.tsx";
import { StableWindowedList } from "../../ui/patterns/windowed-list.tsx";

const MAX_ROWS_CAP = 10;
const MIN_ROWS = 1;
const CHROME_RESERVE = 12;
// Border + horizontal padding + cursor + cell margin + the label/detail gap.
const ROW_CHROME = 12;

type PopupItem = CompleteItem & { match?: ItemMatch };

/**
 * Splits an item's label and detail text into highlight runs for rendering.
 *
 * @remarks
 * When {@link ItemMatch.field} names which field matched, only that field is
 * diffed against the recorded positions and the other renders unhighlighted;
 * otherwise both are derived from `term` directly.
 */
function runsFor(item: PopupItem, term: string): { label: HighlightRun[]; detail: HighlightRun[] } {
  const detail = item.detail ?? "";
  if (item.match?.field === "label") {
    return {
      label: matchRuns(item.label, item.match.positions),
      detail: [{ text: detail, hit: false }],
    };
  }
  if (item.match?.field === "detail") {
    return {
      label: [{ text: item.label, hit: false }],
      detail: matchRuns(detail, item.match.positions),
    };
  }
  return { label: labelRuns(item.label, term), detail: [{ text: detail, hit: false }] };
}

/**
 * The floating suggestion list shown above the input while a trigger
 * (slash command, mention, etc.) is active, windowed and grouped for the
 * current terminal height.
 */
export function AutocompletePopup(props: {
  label: string;
  items: PopupItem[];
  index: number;
  term?: string;
  visible?: boolean;
  onSelect?: (index: number) => void;
  onConfirm?: () => void;
}): JSX.Element {
  const dims = useTerminalDimensions();
  const maxRows = (): number =>
    Math.max(MIN_ROWS, Math.min(MAX_ROWS_CAP, dims().height - CHROME_RESERVE));
  const popupWidth = createMemo(() => {
    const content = props.items.reduce(
      (width, item) => Math.max(width, item.label.length + (item.detail?.length ?? 0) + ROW_CHROME),
      props.label.length + 6,
    );
    return Math.max(24, Math.min(112, dims().width - 4, content));
  });
  const labelPad = createMemo<number>(() =>
    Math.min(
      24,
      props.items.reduce((m, i) => Math.max(m, i.label.length), 0),
    ),
  );
  return (
    <box
      visible={props.visible ?? true}
      flexDirection="column"
      flexShrink={0}
      width={popupWidth()}
      marginBottom={0}
      paddingLeft={1}
      paddingRight={1}
      border
      borderStyle="rounded"
      customBorderChars={borderChars()}
      backgroundColor={overlayBg()}
      zIndex={2}
      borderColor={tokens.muted}
      title={props.label}
      titleColor={tokens.muted}
      titleAlignment="left"
    >
      <text visible={props.items.length === 0} fg={tokens.muted}>
        {`no matching ${props.label}`}
      </text>
      <StableWindowedList
        items={props.items}
        index={props.index}
        maxLines={maxRows()}
        slotCount={MAX_ROWS_CAP}
        grouped
        above={(overflow) => (
          <text visible={overflow.visible()} fg={tokens.muted}>
            {`  ${glyph("arrowUp")} ${overflow.count()} more`}
          </text>
        )}
        row={(slot) => {
          const item = slot.item;
          const active = slot.selected;
          const runs = createMemo(() =>
            item()
              ? runsFor(item()!, props.term ?? "")
              : {
                  label: [{ text: "", hit: false }],
                  detail: [{ text: "", hit: false }],
                },
          );
          const highlighted = (): boolean =>
            item()?.match !== undefined || (props.term?.length ?? 0) > 0;
          return (
            <>
              <box visible={slot.headerVisible()} flexShrink={0}>
                <CommandGroupHeader label={slot.header() ?? ""} />
              </box>
              <PickerRow
                visible={slot.visible()}
                selected={active()}
                onSelect={props.onSelect && (() => props.onSelect!(slot.index()))}
                onConfirm={props.onConfirm && (() => props.onConfirm!())}
                cells={[
                  {
                    grow: true,
                    render: () => (
                      <Show
                        when={highlighted()}
                        fallback={
                          <>
                            <span style={{ fg: active() ? tokens.fg : tokens.muted }}>
                              {item()?.label ?? ""}
                            </span>
                            <span>
                              {" ".repeat(Math.max(0, labelPad() - (item()?.label.length ?? 0)))}
                            </span>
                            <span style={{ fg: tokens.muted }}>
                              {item()?.detail ? `  ${item()!.detail}` : ""}
                            </span>
                          </>
                        }
                      >
                        <>
                          <Index each={runs().label}>
                            {(run) => (
                              <span
                                style={{
                                  fg: run().hit
                                    ? tokens.accent
                                    : active()
                                      ? tokens.fg
                                      : tokens.muted,
                                }}
                              >
                                {run().text}
                              </span>
                            )}
                          </Index>
                          <span>
                            {" ".repeat(Math.max(0, labelPad() - (item()?.label.length ?? 0)))}
                          </span>
                          <span style={{ fg: tokens.muted }}>{item()?.detail ? "  " : ""}</span>
                          <Index each={runs().detail}>
                            {(run) => (
                              <span style={{ fg: run().hit ? tokens.accent : tokens.muted }}>
                                {run().text}
                              </span>
                            )}
                          </Index>
                        </>
                      </Show>
                    ),
                  },
                ]}
              />
            </>
          );
        }}
        below={(overflow) => (
          <text visible={overflow.visible()} fg={tokens.muted}>
            {`  ${glyph("arrowDown")} ${overflow.count()} more`}
          </text>
        )}
      />
    </box>
  );
}
