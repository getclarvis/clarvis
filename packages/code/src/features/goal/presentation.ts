import type { GoalRecord } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";

/** Compact Steward state; technical audit identities stay out of the sidebar. */
export function stewardStatusLabel(goal: GoalRecord): string | undefined {
  const status = goal.steward?.status;
  return status === undefined || status === "idle"
    ? undefined
    : status === "new_run_recommended"
      ? "new run recommended"
      : status;
}

/** Product vocabulary and tone for the durable Goal lifecycle. */
export function goalStatusPresentation(status: GoalRecord["status"]): {
  label: string;
  color: string;
} {
  switch (status) {
    case "active":
      return { label: "Running", color: tokens.add };
    case "complete":
      return { label: "Completed", color: tokens.add };
    case "paused":
      return { label: "Paused", color: tokens.muted };
    case "blocked":
      return { label: "Blocked", color: tokens.warn };
    case "budget_limited":
    case "usage_limited":
      return { label: "Limit reached", color: tokens.warn };
    case "cancelled":
      return { label: "Canceled", color: tokens.del };
  }
}

/** Short display form; the persisted source keeps the complete SHA-256 digest. */
export function compactSourceDigest(digest: string): string {
  return `sha256:${digest.slice(0, 12)}${digest.length > 12 ? "…" : ""}`;
}

/** Compact large budget values without hiding their order of magnitude. */
export function compactGoalCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
