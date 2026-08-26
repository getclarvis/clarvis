import { type GlobalPaths, type WorkspacePaths, type WorkspaceStatePaths } from "@clarvis/paths";
import type { ProfileInfo } from "./run-types.ts";

/** A grant the built-in agent editor knows how to present. */
export type GrantId =
  "ask_user" | "read_workspace" | "edit_workspace" | "run_commands" | "use_skills" | "workflow";

/** One selectable capability grant: its id, the compact badge shown in listings,
 * and the one-line description shown in the grants picker. */
export interface GrantSpec {
  id: GrantId;
  label: string;
  detail: string;
}

/**
 * The single source of truth for the grants the built-in agent editor presents —
 * badges, picker rows, and label lookup all derive from it, so the three never
 * drift.
 *
 * @remarks It covers every engine-owned grant. Capability-owned grants may add
 *   a curated presentation here, but their validity and semantics come from the
 *   capability registry, not from this UI catalog. Unknown grants already stored
 *   on a profile are preserved and rendered by their raw id.
 */
export const GRANT_CATALOG: readonly GrantSpec[] = [
  { id: "read_workspace", label: "read", detail: "read-only coding tools (read/list/glob/grep)" },
  { id: "edit_workspace", label: "edit", detail: "mutating file tools; implies read" },
  { id: "run_commands", label: "exec", detail: "bash host commands; implies edit" },
  { id: "ask_user", label: "ask", detail: "human elicitation tool (entry agent)" },
  { id: "use_skills", label: "skills", detail: "skill catalog + load_skill tool" },
  { id: "workflow", label: "workflow", detail: "workflow manager: run_leader tool (entry agent)" },
];

interface BudgetLite {
  on_exceed?: string;
  total_token_limit?: number;
}

/** An agent profile as the TUI displays it, derived from the kernel's {@link ProfileInfo}. */
export interface AgentProfileView {
  name: string;
  model?: string;
  description?: string;
  canSpawn: string[];
  budget?: BudgetLite;
  grants: GrantId[] | "unknown";
}

/** Coarse behavioral traits derived from a profile view, used to gate UI affordances. */
export interface AgentShape {
  isLead: boolean;
  askUserGranted: boolean | "unknown";
  softMode: boolean;
}

/** The global and (if present) workspace Clarvis path sets. */
export interface ClarvisDirs {
  global: GlobalPaths;
  workspace?: WorkspacePaths;
  /**
   * The workspace's machine-local state tree, under the global root.
   *
   * @remarks Present exactly when {@link ClarvisDirs.workspace} is. It is a
   * separate member because the two answer different questions: `workspace`
   * names what a repository versions, this names what must never reach one.
   */
  state?: WorkspaceStatePaths;
}

/** Projects a kernel {@link ProfileInfo} into the view the TUI renders. */
export function profileView(profile: ProfileInfo): AgentProfileView {
  return {
    name: profile.name,
    model: profile.model,
    description: profile.description,
    canSpawn: profile.canSpawn ?? [],
    budget: profile.budget,
    grants: profile.grants ? (profile.grants as GrantId[]) : "unknown",
  };
}

/**
 * Derives an {@link AgentShape} from a profile view.
 *
 * @remarks `askUserGranted` stays `"unknown"` whenever `grants` itself is
 *   `"unknown"` (an older or unresolved profile), rather than defaulting to
 *   `false` and implying a grant the profile may in fact have.
 */
export function deriveAgentShape(v: AgentProfileView): AgentShape {
  const known = v.grants !== "unknown";
  const has = (g: GrantId): boolean => known && (v.grants as GrantId[]).includes(g);
  return {
    isLead: v.canSpawn.length > 0,
    askUserGranted: known ? has("ask_user") : "unknown",
    softMode: v.budget?.on_exceed === "escalate",
  };
}

const GRANT_LABELS: Record<string, string> = Object.fromEntries(
  GRANT_CATALOG.map((g) => [g.id, g.label]),
);

/**
 * Renders a profile's grants as the compact badge string shown in listings.
 *
 * @param grants - the profile's grants, or `"unknown"` when they could not be read.
 * @param max - the column width the badges must fit. Omit to render them all.
 * @returns the labels, space-joined; when they do not fit, as many whole labels
 *   as do plus a `+N` count of those dropped.
 *
 * @remarks
 * **Whole labels only, never a cut one.** Letting the cell clip a joined string
 * elided in its middle, which for this content is not merely unreadable but
 * misleading: a long grant list could leave a fragment looking like a separate
 * capability, so the screen where a user decides what to
 * trust with their repository appeared to grant a destructive-sounding power
 * nothing had. Dropping whole tokens and counting the remainder keeps every
 * badge legible and, unlike an elision, preserves how many are hidden.
 */
export function grantBadges(grants: GrantId[] | "unknown", max?: number): string {
  if (grants === "unknown") return "grants ?";
  const labels = grants.map((g) => GRANT_LABELS[g] ?? g);
  const all = labels.join(" ");
  if (max === undefined || all.length <= max) return all;
  for (let keep = labels.length - 1; keep > 0; keep -= 1) {
    const candidate = `${labels.slice(0, keep).join(" ")} +${String(labels.length - keep)}`;
    if (candidate.length <= max) return candidate;
  }
  return `+${String(labels.length)}`;
}
