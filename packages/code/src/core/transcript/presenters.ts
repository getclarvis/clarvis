import { glyph } from "../marks.ts";
import type { TranscriptNode, TranscriptPlanNode } from "./types.ts";

/** Maximum semantic-text characters one prose artifact can hand to OpenTUI. */
export const TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS = 512 * 1024;

/** Honest recovery route for prose released from the live Solid/OpenTUI store. */
export const TRANSCRIPT_PROSE_RELEASED_DISPLAY =
  "[Earlier transcript prose was released from this live view to protect memory. Use /export to read the persisted transcript.]";

/** Visible suffix when one pathological semantic node alone exceeds the mounted-text ceiling. */
export const TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE =
  "\n\n[Display shortened to keep the terminal responsive.]";

function proseWasReleased(node: TranscriptNode): boolean {
  return "proseReleased" in node && node.proseReleased === true;
}

/** Number of characters {@link transcriptDisplayText} will hand to an OpenTUI text renderable. */
export function transcriptDisplayTextChars(node: TranscriptNode): number {
  if (proseWasReleased(node)) return TRANSCRIPT_PROSE_RELEASED_DISPLAY.length;
  return Math.min(node.text.length, TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS);
}

/**
 * Text projected into the mounted transcript.
 *
 * Released prose is a persistence state, not truncation: its explicit export
 * route wins even when the backing store also carries its legacy
 * `textTruncated` marker. A single remaining pathological node is shortened at
 * the same ceiling the transcript pager accounts for, so the two layers cannot
 * disagree about how much text OpenTUI receives.
 */
export function transcriptDisplayText(node: TranscriptNode): string {
  if (proseWasReleased(node)) return TRANSCRIPT_PROSE_RELEASED_DISPLAY;
  if (node.text.length <= TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS) return node.text;
  const prefixChars =
    TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS - TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE.length;
  return node.text.slice(0, prefixChars) + TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE;
}

/**
 * Plan-event summary. Proposed tasks and executed completion are deliberately different concepts.
 */
export function planMetaText(
  node: Pick<
    TranscriptPlanNode,
    "tasks" | "revision" | "planStatus" | "planRemoved" | "planDiscarded"
  >,
): string {
  const tasks = node.tasks ?? [];
  const completed = tasks.filter((task) => task.status === "done").length;
  const sep = " " + glyph("separator") + " ";
  const status = node.planStatus;
  const bits = node.planDiscarded
    ? [`${completed}/${tasks.length} completed`, "History discarded"]
    : node.planRemoved
      ? [status === "completed" ? "Removed" : "Unavailable"]
      : [
          status === "awaiting_approval"
            ? `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} proposed`
            : `${completed}/${tasks.length} completed`,
        ];
  if (!node.planRemoved) {
    if (status === "awaiting_approval") bits.push("Awaiting approval");
    else if (status === "active") bits.push("Running");
    else if (status === "completed") bits.push("Completed");
    else if (status === "failed") bits.push("Failed");
    else if (status === "cancelled") bits.push("Canceled");
  }
  if ((node.revision ?? 1) > 1) bits.push(`revision ${node.revision}`);
  return sep + bits.join(sep);
}

/** Compaction annotation one-liner (store projection / export-friendly text). */
export function compactionNoticeText(
  operation: string,
  freedChars?: number,
  opts: {
    requested?: boolean;
    userContributionCount?: number;
    fallbackReason?: "summarization_failed" | "summary_not_effective";
  } = {},
): string {
  const freed = freedChars
    ? ` ${glyph("separator")} ${glyph("minus")}${Math.round(freedChars / 1000)}k chars`
    : "";
  const manual = opts.requested ? "requested " : "";
  const contributed = opts.userContributionCount
    ? ` ${glyph("separator")} ${opts.userContributionCount} user instruction${opts.userContributionCount === 1 ? "" : "s"}`
    : "";
  const fallback = opts.fallbackReason
    ? ` ${glyph("separator")} ${opts.fallbackReason.replace(/_/g, " ")}`
    : "";
  return `${manual}compaction (${operation})${freed}${contributed}${fallback}`;
}

/** Explicit compaction request that could not be applied. */
export function compactionSkippedNoticeText(reason: string): string {
  return `requested compaction skipped ${glyph("emDash")} ${reason.replace(/_/g, " ")}`;
}

/**
 * Vision pre-pass annotation line.
 *
 * @remarks Names the model rather than an agent: the pass is one completion, so
 * there is no child in the run tree for a reader to go looking for.
 */
export function visionNoticeText(
  model: string,
  imageCount: number,
  status: "completed" | "failed",
): string {
  const plural = imageCount === 1 ? "image" : "images";
  return status === "completed"
    ? `read ${String(imageCount)} ${plural} ${glyph("separator")} ${model}`
    : `image reading failed ${glyph("separator")} ${model}`;
}

/** Soft-limit annotation line. */
export function softLimitNoticeText(
  dimension: string,
  used: number | string,
  limit: number | string,
  outcome: string,
): string {
  return `soft ${dimension} ${used}/${limit} ${glyph("arrowRight")} ${outcome}`;
}

/** Steer-applied annotation line. */
export function steerNoticeText(message: string): string {
  return `Steer delivered ${glyph("separator")} ${message}`;
}

/** The bounded one-line preview a steer notice quotes the message as. */
function steerPreview(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const max = 160;
  const preview =
    normalized.length <= max
      ? normalized
      : normalized.slice(0, max - glyph("ellipsis").length) + glyph("ellipsis");
  return preview.length > 0 ? ` ${glyph("separator")} ${preview}` : "";
}

/** Immediate, bounded acknowledgement shown after the kernel accepts a steer. */
export function steerQueuedNoticeText(message: string): string {
  return `Steer queued${steerPreview(message)}`;
}

/**
 * Notice for a steer the kernel accepted but the run ended before applying.
 *
 * @remarks The queued notice is written optimistically on acceptance and only
 * promoted by a later `steering_applied`. A run that completes, fails or is
 * cancelled in between leaves nothing to promote it, so the node has to be
 * settled explicitly or it reads "Steer queued" for the rest of the session — a
 * message the user is entitled to read as delivered when it never was.
 */
export function steerUndeliveredNoticeText(message: string): string {
  return `Steer not delivered${steerPreview(message)}`;
}

/** Toast when focusing a sub-agent in the transcript. */
export function subagentFocusToast(title: string): string {
  return `focused sub-agent: ${title}`;
}
