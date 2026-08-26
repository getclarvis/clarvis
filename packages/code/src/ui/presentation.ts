import { mark, type MarkName } from "../core/marks.ts";

/** Product vocabulary used by ordinary UI chrome. Wire values stay available in diagnostics. */
export type UiLifecycle =
  "waiting" | "running" | "needs-approval" | "completed" | "failed" | "canceled";

const LIFECYCLE_ALIASES: Readonly<Record<string, UiLifecycle>> = {
  spawned: "waiting",
  pending: "waiting",
  returned: "waiting",
  awaiting_approval: "needs-approval",
  active: "running",
  in_progress: "running",
  running: "running",
  composing: "running",
  ok: "completed",
  done: "completed",
  completed: "completed",
  error: "failed",
  failed: "failed",
  abandoned: "canceled",
  cancelled: "canceled",
  canceled: "canceled",
};

/** Maps protocol/runtime status variants once, before they reach product chrome. */
export function uiLifecycle(value: string): UiLifecycle {
  return LIFECYCLE_ALIASES[value] ?? "waiting";
}

export function lifecycleLabel(value: UiLifecycle): string {
  switch (value) {
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "needs-approval":
      return "Needs approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}

/** Meanings that must remain distinct when color is unavailable. */
export type MarkerMeaning =
  | "cursor"
  | "current"
  | "unselected"
  | "checked"
  | "unchecked"
  | "collapsed"
  | "expanded"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "dirty"
  | "inherited"
  | "read-only"
  | "file";

/** Pure marker projection used by components and no-color policy tests. */
export function markerText(meaning: MarkerMeaning, ascii: boolean, spinner = "..."): string {
  const glyph = (name: MarkName): string => mark(name, ascii);
  switch (meaning) {
    case "cursor":
      return ">";
    case "current":
      return glyph("radioOn");
    case "unselected":
      return glyph("radioOff");
    case "checked":
      return "[x]";
    case "unchecked":
      return "[ ]";
    case "collapsed":
      return ascii ? "[+]" : glyph("expand");
    case "expanded":
      return ascii ? "[-]" : glyph("collapse");
    case "waiting":
      return ascii ? "[wait]" : "◷";
    case "running":
      return ascii ? "..." : spinner;
    case "completed":
      return glyph("success");
    case "failed":
      return ascii ? "[error]" : glyph("error");
    case "canceled":
      return ascii ? "[canceled]" : glyph("emDash");
    case "dirty":
      return ascii ? "[modified]" : "~";
    case "inherited":
      return glyph("arrowLeft");
    case "read-only":
      return "[read-only]";
    case "file":
      return "[file]";
  }
}

export type SettingSource =
  "global" | "workspace" | "provider" | "product default" | "session" | (string & {});
export type SettingApplies = "now" | "next run" | "when spawned";
export type SettingMutation = "immediate" | "staged" | "read-only";

/** Complete user-facing explanation of an effective setting. */
export interface SettingPresentation {
  label: string;
  /** Optional concise row text when exact values belong only in expanded provenance. */
  summary?: string;
  configured: string;
  effective: string;
  /** Staged value that is not effective until the owning page is saved. */
  pending?: string;
  source: SettingSource;
  applies: SettingApplies;
  mutation: SettingMutation;
  readOnlyReason?: string;
}

/** Produces the canonical compact value shown by a setting row. */
export function settingSummary(setting: SettingPresentation): string {
  if (setting.summary !== undefined) return setting.summary;
  if (setting.pending !== undefined)
    return `${setting.effective} now · pending ${setting.pending} · save to apply`;
  if (setting.configured === "inherit")
    return `${setting.effective} · from ${setting.source} · ${setting.applies}`;
  if (setting.configured !== setting.effective)
    return `${setting.effective} · configured ${setting.configured} · ${setting.source} · ${setting.applies}`;
  return `${setting.effective} · ${setting.source} · ${setting.applies}`;
}

/** A list/detail entity summary. Long payloads deliberately do not belong here. */
export interface EntitySummary {
  id?: string;
  title: string;
  state?: UiLifecycle;
  description?: string;
  metadata?: string[];
  current?: boolean;
  default?: boolean;
  readOnlyReason?: string;
}

/** Labelled metrics for exactly one owner. */
export interface ScopedUsage {
  owner: "Run" | "Agent" | "Workflow" | "Context";
  input?: number;
  output?: number;
  used?: number;
  limit?: number;
  percent?: number;
  iterations?: number;
  elapsed?: string;
  cost?: number;
}

function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/** Formats metrics without bare arrows and without losing their owner. */
export function scopedUsageText(usage: ScopedUsage, compact = false): string {
  const segments: string[] = [];
  if (usage.input !== undefined) segments.push(`In ${compactCount(usage.input)}`);
  if (usage.output !== undefined) segments.push(`Out ${compactCount(usage.output)}`);
  if (usage.used !== undefined && usage.limit !== undefined)
    segments.push(`Context ${compactCount(usage.used)} / ${compactCount(usage.limit)}`);
  if (usage.percent !== undefined) segments.push(`Context ${Math.round(usage.percent)}%`);
  if (!compact && usage.iterations !== undefined)
    segments.push(`${usage.iterations} ${usage.iterations === 1 ? "iteration" : "iterations"}`);
  if (usage.elapsed) segments.push(usage.elapsed);
  if (!compact && usage.cost !== undefined) segments.push(`$${usage.cost.toFixed(3)}`);
  return `${usage.owner}  ${segments.join(" · ")}`.trimEnd();
}
