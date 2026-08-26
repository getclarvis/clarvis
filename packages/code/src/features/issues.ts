import type { FieldIssue } from "../adapters/settings.ts";
import type { ReadinessSeal } from "../adapters/agent-files.ts";
import { mark } from "../core/marks.ts";

/** Severity of a {@link PanelIssue}: `"error"` blocks save, `"warn"` does not. */
export type IssueLevel = "error" | "warn";

/** A validation issue projected onto a settings-panel field. */
export interface PanelIssue {
  field: string;
  level: IssueLevel;
  message: string;
}

/** Queryable view over a reactive list of {@link PanelIssue}s. */
export interface IssueSet {
  all(): PanelIssue[];
  for(field: string): PanelIssue | undefined;
  blockers(): PanelIssue[];
  warnings(): PanelIssue[];
}

/**
 * Wraps a reactive issues accessor as a queryable {@link IssueSet}.
 *
 * @param issues - Accessor returning the current issue list.
 * @returns The issue set view.
 */
export function issueSet(issues: () => PanelIssue[]): IssueSet {
  return {
    all: () => issues(),
    for: (field) => issues().find((i) => i.field === field),
    blockers: () => issues().filter((i) => i.level === "error"),
    warnings: () => issues().filter((i) => i.level === "warn"),
  };
}

/**
 * Maps a provider readiness check to panel issues, optionally scoped to one provider.
 *
 * @param check - The readiness check result.
 * @param providerName - When given, keeps only issues for that provider or with no provider.
 * @returns Panel issues, all at `"error"` level; empty when `check.ok`.
 */
export function mapProviderIssues(
  check: { ok: true } | { ok: false; issues: FieldIssue[] },
  providerName?: string,
): PanelIssue[] {
  if (check.ok) return [];
  const scoped =
    providerName == null
      ? check.issues
      : check.issues.filter((i) => i.provider === providerName || i.provider == null);
  return scoped.map((i) => ({ field: i.field, level: "error", message: i.message }));
}

/**
 * Agent readiness issue codes that block saving the current draft file, as
 * opposed to codes that only matter once other agent files also change (and
 * so are surfaced as warnings, not blockers, for the file being edited).
 */
const FILE_LOCAL_AGENT_ISSUES: ReadonlySet<string> = new Set([
  "budget_needs_limit",
  "default_spawn_not_in_can_spawn",
  "orchestration_needs_can_spawn",
  "unknown_grant",
]);

/** Maps an agent readiness issue code to the panel field it should highlight. */
const AGENT_ISSUE_FIELDS: Record<string, string> = {
  missing_model: "model",
  unknown_provider: "model",
  invalid_model: "model",
  budget_needs_limit: "budget",
  unknown_spawn_target: "can_spawn",
  default_spawn_not_in_can_spawn: "default_spawn",
  orchestration_needs_can_spawn: "can_spawn",
  unknown_grant: "grants",
};

/**
 * Maps an agent readiness seal to panel issues.
 *
 * @param seal - The readiness seal for a draft agent file.
 * @returns Panel issues; level is `"error"` for {@link FILE_LOCAL_AGENT_ISSUES} codes, `"warn"` otherwise.
 */
export function mapAgentIssues(seal: ReadinessSeal): PanelIssue[] {
  return seal.issues.map((i) => ({
    field: AGENT_ISSUE_FIELDS[i.code] ?? i.code,
    level: FILE_LOCAL_AGENT_ISSUES.has(i.code) ? "error" : "warn",
    message: i.message,
  }));
}

/**
 * Builds a one-line save confirmation note that surfaces the first warning, if any.
 *
 * @param warnings - Warning-level issues present after a successful save.
 * @returns `null` when `warnings` is empty, otherwise a summary naming the count and first message.
 */
export function saveWarningsNote(warnings: PanelIssue[]): string | null {
  if (warnings.length === 0) return null;
  const plural = warnings.length === 1 ? "warning" : "warnings";
  return `saved ${mark("emDash")} ${warnings.length} ${plural}: ${warnings[0]!.message}`;
}
