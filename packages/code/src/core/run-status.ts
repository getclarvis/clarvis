import { formatElapsed } from "./format-elapsed.ts";
import type { MemoryIngestNotice, RunProgress } from "./run-types.ts";

/** Semantic marks a presentation layer may render as Unicode or ASCII. */
export type StatusMark = "arrowRight" | "emDash" | "ellipsis" | "separator";

/** One framework- and theme-free status segment. */
export type StatusSegment = string | { mark: StatusMark };

/** Structured status line emitted by run orchestration and projections. */
export type StatusLine = readonly StatusSegment[];

/** Converts a structured line to the historical headless Unicode representation. */
export function plainStatusLine(line: StatusLine): string {
  const marks: Record<StatusMark, string> = {
    arrowRight: "→",
    emDash: "—",
    ellipsis: "…",
    separator: "·",
  };
  return line.map((part) => (typeof part === "string" ? part : marks[part.mark])).join("");
}

/** Builds the semantic status for a memory indexing notice. */
export function memoryNoticeStatus(notice: MemoryIngestNotice): StatusLine {
  if (notice.phase === "started") return ["memory: learning", { mark: "ellipsis" }];
  if (notice.phase === "queued") return ["memory: queued"];
  if (notice.phase === "blocked")
    return ["memory: blocked", ...(notice.note ? [` (${notice.note})`] : [])];
  if (notice.phase === "failed")
    return [
      "memory index failed ",
      { mark: "emDash" },
      " run not learned",
      ...(notice.indexer_run_id ? [` (${notice.indexer_run_id})`] : []),
    ];
  // "the pass declined to run" and "the pass ran and judged there was nothing
  // durable here" are different outcomes and used to read identically. So did
  // "the learning died", until the failed branch above started naming its run.
  if (notice.skipped) return ["memory: nothing to record"];
  const parts: string[] = [];
  if (notice.written) parts.push(`+${notice.written}`);
  if (notice.deleted) parts.push(`-${notice.deleted}`);
  return [parts.length > 0 ? `memory ${parts.join(" ")}` : "memory: nothing new"];
}

/** Builds the semantic status for a kernel progress update. */
export function progressStatus(progress: RunProgress): StatusLine {
  const event = progress.event;
  if (event?.type === "run_ended" && event.reason && event.reason !== "completed")
    return ["ended ", { mark: "emDash" }, ` ${event.reason.replaceAll("_", " ")}`];
  return [progress.label || `iteration ${progress.iteration ?? "?"}`];
}

/** Input for the live footer status projection. */
export interface LiveRunLineInput {
  status: string;
  startedAt: number | null;
  now: number;
  usage: { input: number; output: number } | null;
}

/** Builds the semantic live footer line without choosing glyphs. */
export function liveRunStatus(input: LiveRunLineInput): StatusLine {
  const parts: StatusLine[] = [];
  if (input.status) parts.push([input.status]);
  if (input.startedAt !== null) parts.push([formatElapsed(input.now - input.startedAt)]);
  if (input.usage)
    parts.push([`${input.usage.input}`, { mark: "arrowRight" }, `${input.usage.output} tok`]);
  return parts.flatMap((part, index) =>
    index === 0 ? part : ["  ", { mark: "separator" }, "  ", ...part],
  );
}
