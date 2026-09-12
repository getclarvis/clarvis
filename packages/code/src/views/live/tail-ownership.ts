import type { TranscriptNode } from "../../adapters/store.ts";

/**
 * Live frontier nodes the tail may present for the current Lead/child projection.
 *
 * @remarks Matches {@link LiveTranscriptTail}'s selection filters so ownership and
 * painting agree on which mutable keys exist.
 */
export function selectLiveFrontierNodes(
  nodes: readonly TranscriptNode[],
  selectedSubagent: string | null,
): TranscriptNode[] {
  return nodes.filter((node) => {
    if (node.kind === "plan") return false;
    if (selectedSubagent === null) {
      if (node.kind === "thinking") return false;
      return node.subagentId === undefined && node.subagentOrder === undefined;
    }
    return node.subagentId === selectedSubagent;
  });
}
