import { glyph } from "../../theme/glyphs.ts";
import {
  liveRunStatus,
  memoryNoticeStatus,
  progressStatus,
  type LiveRunLineInput,
  type StatusLine,
} from "../../core/run-status.ts";
import type { MemoryIngestNotice, RunProgress } from "../../core/run-types.ts";
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
  sessionUsage?: { input: number; output: number; cached?: number };
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
 * The shell-owned projection of stable context, usage, spend, and a settled outcome.
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
  const tokenUsage = input.sessionUsage ?? input.usage;
  const tokenScope = input.sessionUsage === undefined ? "Run" : "Session";
  const tokens =
    input.width >= 120 && tokenUsage
      ? scopedUsageText(
          {
            owner: tokenScope,
            input: Math.max(0, tokenUsage.input - (tokenUsage.cached ?? 0)),
            output: tokenUsage.output,
          },
          true,
        )
      : "";
  if (!input.active) {
    const outcome = runOutcomeLabel(input.status) ?? "";
    return [outcome, context, input.sessionCost ? `Session ${input.sessionCost}` : "", tokens]
      .filter(Boolean)
      .join(` ${glyph("separator")} `);
  }
  return [context, input.sessionCost ? `Session ${input.sessionCost}` : "", tokens]
    .filter(Boolean)
    .join(` ${glyph("separator")} `);
}
