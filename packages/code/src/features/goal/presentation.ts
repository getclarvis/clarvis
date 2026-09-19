import type { GoalRecord } from "@clarvis/protocol";
import { detailStatusColor } from "../../ui/patterns/detail-view.tsx";

/** Compact Steward state; technical audit identities stay out of the sidebar. */
export function stewardStatusLabel(goal: GoalRecord): string | undefined {
  const status = goal.steward?.status;
  return status === undefined || status === "idle"
    ? undefined
    : status === "evidence_requested"
      ? "asked for clarification · main agent answering"
      : status === "attention"
        ? "requested changes"
        : status === "verifying"
          ? "reviewing"
          : status;
}

/** Product vocabulary and tone for the durable Goal lifecycle. */
export function goalStatusPresentation(status: GoalRecord["status"]): {
  label: string;
  color: string;
} {
  switch (status) {
    case "active":
      return { label: "Running", color: detailStatusColor("running") };
    case "complete":
      return { label: "Completed", color: detailStatusColor("completed") };
    case "paused":
      return { label: "Paused", color: detailStatusColor("paused") };
    case "blocked":
      return { label: "Blocked", color: detailStatusColor("attention") };
    case "budget_limited":
    case "usage_limited":
      return { label: "Limit reached", color: detailStatusColor("attention") };
    case "cancelled":
      return { label: "Canceled", color: detailStatusColor("canceled") };
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
