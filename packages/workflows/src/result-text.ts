/**
 * Projection of a finished leader's outcome into the text a manager reads.
 *
 * @remarks Shared by both dispatchers — `run_leader` and `run_work_items` — so a
 * leader's result reads the same however it was started.
 */
import type { LeaderResult } from "./types.ts";

/** Best-effort text projection of a leader's structured result. */
function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable result]";
  }
}

/** Render a finished leader's outcome as the text handed back to the manager. */
export function describeLeaderResult(result: LeaderResult): string {
  if (result.error !== undefined) return result.error.message;
  return stringifyResult(result.result);
}
