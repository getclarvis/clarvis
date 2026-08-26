import { glyph } from "../../theme/glyphs.ts";
import {
  liveRunStatus,
  memoryNoticeStatus,
  progressStatus,
  type LiveRunLineInput,
  type StatusLine,
} from "../../core/run-status.ts";
import type { MemoryIngestNotice, RunProgress } from "../../core/run-types.ts";
import { formatElapsed } from "../../core/format-elapsed.ts";
import { scopedUsageText } from "../../ui/presentation.ts";

/** Renders a structured run status using the active terminal glyph mode. */
export function presentStatusLine(line: StatusLine): string {
  return line.map((part) => (typeof part === "string" ? part : glyph(part.mark))).join("");
}

/** Presents a memory indexing notice. */
export function memoryNoticeText(notice: MemoryIngestNotice): string {
  return presentStatusLine(memoryNoticeStatus(notice));
}

/** Presents a kernel progress update. */
export function progressStatusText(progress: RunProgress): string {
  return presentStatusLine(progressStatus(progress));
}

/** Presents the live footer line. */
export function liveRunStatusLine(input: LiveRunLineInput): string {
  return presentStatusLine(liveRunStatus(input));
}

export interface RunStripInput {
  active: boolean;
  status: string;
  startedAt: number | null;
  now: number;
  context?: { used: number; limit: number };
  usage?: { input: number; output: number; cached?: number };
  sessionCost?: string;
  width: number;
}

/**
 * Classifies a settled run's own outcome from its status line.
 *
 * @param status - the status line as presented, which may carry a trailing
 *   post-run notice after a separator.
 * @returns `"Failed"`, `"Canceled"`, `"Completed"`, or `undefined` when the line
 *   names no outcome.
 * @remarks Only the segment **before the first separator** is classified. The
 *   run's outcome and what happened afterwards are composed onto one line, and
 *   matching `/fail/` across the whole of it labelled a run that had completed
 *   with a full, correct answer as `Failed` in both the header and the footer
 *   because its memory-indexing pass failed after the fact. The true state was
 *   readable only in Sessions > Status.
 */
export function runOutcomeLabel(status: string): string | undefined {
  const own = status.split(glyph("separator"))[0] ?? status;
  if (/fail|error/i.test(own)) return "Failed";
  if (/cancel/i.test(own)) return "Canceled";
  if (/done|completed/i.test(own)) return "Completed";
  return undefined;
}

/**
 * The sole shell-owned projection of phase, time, iteration, context, run usage and session spend.
 *
 * @remarks The token counts on this row report **input the provider had to
 * read** — the gross prompt less what its prefix cache served. `Context` is the
 * one figure that stays gross, because a cached prefix still occupies the
 * window.
 */
export function runStripText(input: RunStripInput): string {
  const context = input.context
    ? `Context ${Math.round(
        input.context.limit > 0 ? (input.context.used / input.context.limit) * 100 : 0,
      )}%`
    : "";
  if (!input.active) {
    const outcome = runOutcomeLabel(input.status) ?? "";
    return [outcome, context, input.sessionCost ? `Session ${input.sessionCost}` : ""]
      .filter(Boolean)
      .join(` ${glyph("separator")} `);
  }
  const parts = ["Running"];
  const iteration = /iteration\s+(\d+)/i.exec(input.status)?.[1];
  if (iteration) parts.push(`iteration ${iteration}`);
  if (input.startedAt !== null) parts.push(formatElapsed(input.now - input.startedAt));
  if (context) parts.push(context);
  if (input.sessionCost) parts.push(`Session ${input.sessionCost}`);
  if (input.width >= 120 && input.usage) {
    parts.push(
      scopedUsageText(
        {
          owner: "Run",
          input: Math.max(0, input.usage.input - (input.usage.cached ?? 0)),
          output: input.usage.output,
        },
        true,
      ),
    );
  }
  return parts.join(` ${glyph("separator")} `);
}
