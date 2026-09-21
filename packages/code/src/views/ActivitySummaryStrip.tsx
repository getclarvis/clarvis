import { For, type Accessor, type JSX } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { detailStatusColor } from "../ui/patterns/detail-view.tsx";
import { glyph } from "../theme/glyphs.ts";
import {
  activitySummaryRows,
  type ActivitySummaryFact,
  type ActivitySummaryTone,
} from "./activity-summary.ts";

/** Columns of breathing room on each side of the summary row. */
export const ACTIVITY_SUMMARY_PADDING = 1;

function factFg(tone: ActivitySummaryTone): string {
  return tone === "muted" ? tokens.muted : detailStatusColor(tone);
}

/** Props for the compact band's activity summary. */
export interface ActivitySummaryStripProps {
  /** Ordered canonical facts, optionally followed by the strip's own action affordance. */
  facts: Accessor<ActivitySummaryFact[]>;
  /** Terminal columns the strip spans. */
  width: Accessor<number>;
  /** Rows the strip may occupy. */
  maxRows: Accessor<number>;
  /** Opens the full-width Activity panel; the strip is its pointer route. */
  onToggle?: () => void;
  /** Whether the strip currently owns the pointer. */
  active?: Accessor<boolean>;
}

/**
 * Renders the compact band's activity summary: one canonical statement of Goal,
 * Plan, workflow and child state in place of an automatically opened panel.
 *
 * @remarks The strip is read-only chrome, not a second Sidebar. Every fact comes from the same
 *   projections the Sidebar reads, whole facts wrap between rows, and the trailing affordance
 *   names the effective `activity.toggle` binding — never a hardcoded chord. Complete detail
 *   stays in the Activity panel the strip opens.
 */
export function ActivitySummaryStrip(props: ActivitySummaryStripProps): JSX.Element {
  const rows = (): ActivitySummaryFact[][] =>
    activitySummaryRows(
      props.facts(),
      Math.max(1, props.width() - ACTIVITY_SUMMARY_PADDING * 2),
      props.maxRows(),
    );
  const runs = (): { text: string; fg: string }[][] =>
    rows().map((row) =>
      row.flatMap((entry, index) =>
        index === 0
          ? [{ text: entry.text, fg: factFg(entry.tone) }]
          : [
              { text: ` ${glyph("separator")} `, fg: tokens.muted },
              { text: entry.text, fg: factFg(entry.tone) },
            ],
      ),
    );
  return (
    <box
      id="activity-summary"
      flexDirection="column"
      flexShrink={0}
      paddingLeft={ACTIVITY_SUMMARY_PADDING}
      paddingRight={ACTIVITY_SUMMARY_PADDING}
      backgroundColor={tokens.bgElev}
      onMouseDown={() => {
        if (props.active?.() ?? true) props.onToggle?.();
      }}
    >
      <For each={runs()}>
        {(row) => (
          <text wrapMode="none" truncate selectable={false}>
            <For each={row}>{(run) => <span style={{ fg: run.fg }}>{run.text}</span>}</For>
          </text>
        )}
      </For>
    </box>
  );
}
