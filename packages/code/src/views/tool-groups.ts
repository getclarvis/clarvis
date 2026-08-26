import type { NodeStatus, TranscriptNode, TranscriptToolNode } from "../adapters/store.ts";
import { isMutationTool } from "../adapters/tool-identity.ts";

/**
 * The minimum run of identical, non-mutating tool calls that collapses into one
 * group.
 *
 * @remarks Two is the smallest value at which collapsing means anything, and
 * there is no reason to wait for more: the group's head shows the same call the
 * first row would have, plus a count, so a pair costs nothing in information and
 * already saves a row. Raising it would leave short repetitions rendered one per
 * line for no gain, which is exactly the noise the grouping exists to remove.
 */
export const MIN_GROUP = 2;

type ToolGroupRole = "solo" | "head" | "member";

/** One tool call's place within its group: alone, the visible head, or a folded member. */
export interface ToolGroupInfo {
  role: ToolGroupRole;
  ordinal: number;
  size: number;
  members?: TranscriptToolNode[];
  headKey?: string;
}

/**
 * Collapses consecutive, same-tool, same-sub-agent calls into groups of
 * {@link MIN_GROUP} or more.
 *
 * @remarks
 * A mutation tool (per {@link isMutationTool}) is never grouped — each call
 * stays `"solo"` — because collapsing edits/writes would hide which files
 * changed. A run shorter than {@link MIN_GROUP} also stays `"solo"`; longer
 * runs get one `"head"` (carrying `members`) followed by `"member"` entries.
 */
export function computeToolGroups(nodes: readonly TranscriptNode[]): Map<string, ToolGroupInfo> {
  const info = new Map<string, ToolGroupInfo>();
  let i = 0;
  while (i < nodes.length) {
    const head = nodes[i]!;
    if (head.kind !== "tool_call" || isMutationTool(head.mcpName, head.toolName)) {
      info.set(head.key, { role: "solo", ordinal: 0, size: 1 });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < nodes.length) {
      const candidate = nodes[j]!;
      if (
        candidate.kind !== "tool_call" ||
        candidate.mcpName !== head.mcpName ||
        candidate.toolName !== head.toolName ||
        candidate.subagentOrder !== head.subagentOrder
      )
        break;
      j += 1;
    }
    const size = j - i;
    if (size < MIN_GROUP) {
      info.set(head.key, { role: "solo", ordinal: 0, size: 1 });
      i += 1;
      continue;
    }
    const members = nodes.slice(i, j) as TranscriptToolNode[];
    members.forEach((member, ordinal) =>
      info.set(
        member.key,
        ordinal === 0
          ? { role: "head", ordinal: 0, size, members, headKey: head.key }
          : { role: "member", ordinal, size, headKey: head.key },
      ),
    );
    i = j;
  }
  return info;
}

/** A group's overall status: `"running"` if any member is, else `"error"` if any failed, else `"ok"`. */
export function aggregateStatus(members: readonly TranscriptNode[]): NodeStatus {
  if (members.some((m) => m.status === "running")) return "running";
  if (members.some((m) => m.status === "error")) return "error";
  return "ok";
}

/** How many of `members` ended in `"error"`. */
export function failureCount(members: readonly TranscriptNode[]): number {
  return members.reduce((acc, m) => acc + (m.status === "error" ? 1 : 0), 0);
}
