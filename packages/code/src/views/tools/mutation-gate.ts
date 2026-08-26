import { isMutationTool, toolIdentity } from "../../adapters/tool-identity.ts";
import { editsFromArgs, synthesizeUnifiedDiff } from "../../adapters/tool-parsers.ts";
import { glyph } from "../../theme/glyphs.ts";
import { moreChip } from "../truncate.ts";

/**
 * Line count above which a mutation tool's body is collapsed behind a
 * {@link DiffStats} chip instead of rendered inline.
 *
 * @remarks Deliberately far above the allowance an ordinary tool result gets,
 * because a mutation's body is the thing a reviewer is here to read — the
 * default has to be *show it*, and the gate only catches the case where showing
 * it would bury the conversation. Roughly a screen's worth of lines is where
 * that turns over: a diff that still fits on screen is reviewed in place, and
 * one that does not is reviewed by opening it either way.
 */
export const MUTATION_GATE_LINES = 40;

/** Added/removed line counts plus the total line count of a diff or content body. */
export interface DiffStats {
  added: number;
  removed: number;
  lines: number;
}

/** Counts added (`+`) and removed (`-`) lines in a unified diff, ignoring the `+++`/`---` file headers. */
export function diffStats(diff: string): DiffStats {
  const rows = diff.split("\n");
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("+")) added++;
    else if (row.startsWith("-")) removed++;
  }
  return { added, removed, lines: rows.length };
}

/** Formats a {@link DiffStats} into the added/removed/tail spans a gate chip renders. */
export function formatStatsChip(s: DiffStats): { added: string; removed: string; tail: string } {
  return {
    added: `+${s.added}`,
    removed: s.removed > 0 ? ` ${glyph("minus")}${s.removed}` : "",
    tail: ` ${glyph("separator")} ${moreChip(s.lines)}`,
  };
}

/** The subset of a transcript tool node's fields needed to gate and render a mutation's body. */
export interface MutationNode {
  mcpName?: string;
  toolName?: string;
  subagentOrder?: number;
  diff?: string;
  args?: Record<string, unknown>;
}

/** Whether a mutation belongs to the run lead rather than a delegated sub-agent. */
export function isLeadMutation(node: MutationNode): boolean {
  return node.subagentOrder === undefined && isMutationTool(node.mcpName, node.toolName);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function synthesizedDiff(n: MutationNode): string {
  if (n.diff) return n.diff;
  const args = n.args ?? {};
  return synthesizeUnifiedDiff(String(args.path ?? ""), editsFromArgs(args));
}

const GATED_BODY: Record<string, (node: MutationNode) => string> = {
  write_file: (n) => n.diff || str(n.args?.content),
  edit_file: synthesizedDiff,
  multi_edit: synthesizedDiff,
  apply_patch: (n) => n.diff || str(n.args?.patch),
  replace: (n) => str(n.diff).replace(/\n+$/, ""),
  write_memory: (n) => n.diff || str(n.args?.content),
  edit_memory: synthesizedDiff,
};

/**
 * The body a mutation tool's collapsed/gated view would render: the real
 * diff/content when the node carries one, or a synthesized unified diff
 * reconstructed from its arguments otherwise.
 */
export function mutationBody(node: MutationNode): string {
  return GATED_BODY[toolIdentity(node.mcpName, node.toolName)]?.(node) ?? "";
}

/** Stats of what a collapsed mutation is hiding. The tool result is a one-line
 * summary ("Wrote N bytes…"), so counting its lines under-reports the real
 * change — measure the diff/content the body would render instead. */
export function mutationStats(node: MutationNode): DiffStats | null {
  if (!isMutationTool(node.mcpName, node.toolName)) return null;
  const body = mutationBody(node);
  if (body.length === 0) return null;
  const id = toolIdentity(node.mcpName, node.toolName);
  if ((id === "write_file" || id === "write_memory") && !node.diff) {
    const n = body.split("\n").length;
    return { added: n, removed: 0, lines: n };
  }
  return diffStats(body);
}

/** Whether a mutation tool node's body exceeds {@link MUTATION_GATE_LINES} and should render behind a gate chip. */
export function isOversizeMutation(node: MutationNode): boolean {
  if (!isMutationTool(node.mcpName, node.toolName)) return false;
  const body = mutationBody(node);
  return body.length > 0 && body.split("\n").length > MUTATION_GATE_LINES;
}
