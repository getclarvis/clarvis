import { createTwoFilesPatch } from "diff";

const DIFF_OMITTED = "[diff omitted: combined input exceeds the configured diff budget]";
const DIFF_TIMED_OUT = "[diff omitted: computation exceeded the 2000ms time budget]";
export const DEFAULT_DIFF_TIMEOUT_MS = 2_000;

function inputBytes(before: string, after: string): number {
  return Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8");
}

/**
 * Render a standard unified-diff patch between two versions of one file.
 *
 * @param rel - the path shown on both the `---`/`+++` header lines (typically a
 *   workspace-relative path).
 * @param before - the file's prior content.
 * @param after - the file's new content.
 * @returns the unified diff with 3 lines of context, or `undefined` when
 *   `before` and `after` are identical (no change to report).
 */
export function unifiedDiff(
  rel: string,
  before: string,
  after: string,
  maxInputBytes = Number.POSITIVE_INFINITY,
): string | undefined {
  if (before === after) return undefined;
  if (inputBytes(before, after) > maxInputBytes) return DIFF_OMITTED;
  return (
    createTwoFilesPatch(rel, rel, before, after, undefined, undefined, {
      context: 3,
      timeout: DEFAULT_DIFF_TIMEOUT_MS,
    }) ?? DIFF_TIMED_OUT
  );
}
