import type { TranscriptNode } from "../adapters/store.ts";
import type { GroupedTranscript } from "./subagent-sections.ts";
import type { ToolGroupInfo } from "./tool-groups.ts";
import { isLeadMutation, isOversizeMutation } from "./tools/mutation-gate.ts";

/** A user's explicit fold choice for one block key, overriding its computed default. */
export type BlockOverride = "expanded" | "collapsed";

/** Per-key {@link BlockOverride}s, keyed by transcript node/section key. */
export type Overrides = ReadonlyMap<string, BlockOverride>;

/**
 * Whether the node at `key` is hidden inside a folded subagent section — true
 * only when the section is folded and its anchor has not been explicitly
 * re-expanded via `overrides`.
 */
export function isFoldedAway(g: GroupedTranscript, key: string, overrides: Overrides): boolean {
  if (!g.folded.has(key)) return false;
  const anchor = g.anchors.get(key);
  return !(anchor !== undefined && overrides.get(anchor) === "expanded");
}

function isFoldedSectionAnchor(g: GroupedTranscript, key: string, overrides: Overrides): boolean {
  const header = g.headers.get(key);
  return (
    header !== undefined && (header.hiddenEntries ?? 0) > 0 && overrides.get(key) !== "expanded"
  );
}

/**
 * The ordered list of block keys a user can cycle keyboard focus through: a
 * folded section's anchor (one stop for the whole section), and — outside
 * folded sections — every visible tool call that is either solo or the head
 * of a group.
 */
export function computeFocusables(
  g: GroupedTranscript,
  groups: Map<string, ToolGroupInfo>,
  overrides: Overrides,
): string[] {
  const keys: string[] = [];
  for (const n of g.ordered) {
    if (isFoldedSectionAnchor(g, n.key, overrides)) {
      keys.push(n.key);
      continue;
    }
    if (isFoldedAway(g, n.key, overrides)) continue;
    if (n.kind === "tool_call") {
      const role = groups.get(n.key)?.role ?? "solo";
      if (role === "solo" || role === "head") keys.push(n.key);
    }
  }
  return keys;
}

/**
 * Flips the fold state for `key` and returns the resulting overrides map.
 *
 * @remarks
 * A folded section's anchor toggles only its own `"expanded"` override
 * (revealing/hiding the hidden entries beneath it). An ordinary node's next
 * state is derived from its current override, `expandAll`, and its computed
 * default fold state (group role, `defaultFolded`, or an oversize mutation),
 * so a caller never has to compute that default itself.
 *
 * The `defaultFolded` computation falls back to a `collapsed` field that is
 * not part of `TranscriptNode` and that no production node ever sets —
 * `showcase.test.ts` guards that a real store-derived node never carries it.
 * It exists solely so render-test fixtures (`tests/helpers/transcript-fixtures.ts`'s
 * `LegacyCollapsibleNode`) can force default-fold state without wiring a full
 * `defaultFolded` callback through every test.
 */
export function toggleOverride(args: {
  key: string;
  g: GroupedTranscript;
  groups: Map<string, ToolGroupInfo>;
  node: TranscriptNode | undefined;
  defaultFolded?: (key: string) => boolean;
  expandAll: boolean;
  overrides: Overrides;
}): Map<string, BlockOverride> {
  const { key, g, groups, node, expandAll, overrides } = args;
  const next = new Map(overrides);
  const own = overrides.get(key);
  const header = g.headers.get(key);
  if (header && (header.hiddenEntries ?? 0) > 0) {
    if (own === "expanded") next.delete(key);
    else next.set(key, "expanded");
    return next;
  }
  if (!node) return next;
  const role = groups.get(key)?.role ?? "solo";
  const fixtureCollapsedFallback =
    (node as TranscriptNode & { collapsed?: boolean }).collapsed ?? false;
  const defaultFolded = args.defaultFolded?.(key) ?? fixtureCollapsedFallback;
  const leadMutation = node.kind === "tool_call" && isLeadMutation(node);
  const defaultExpanded =
    role === "head"
      ? false
      : leadMutation ||
        (!defaultFolded && !(node.kind === "tool_call" && isOversizeMutation(node)));
  const expanded =
    own === "expanded" ? true : own === "collapsed" ? false : expandAll || defaultExpanded;
  next.set(key, expanded ? "collapsed" : "expanded");
  return next;
}

/**
 * Steps `delta` positions from `current` within `keys`, clamped to the list's
 * bounds. Returns `null` when `keys` is empty; an unrecognized `current`
 * starts from the last key.
 */
export function nextFocus(keys: string[], current: string | null, delta: number): string | null {
  if (keys.length === 0) return null;
  const idx = current === null ? -1 : keys.indexOf(current);
  if (idx === -1) return keys[keys.length - 1]!;
  const next = Math.max(0, Math.min(keys.length - 1, idx + delta));
  return keys[next]!;
}
