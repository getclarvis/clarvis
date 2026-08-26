import type { TranscriptNode } from "../adapters/store.ts";

function runIdOf(node: TranscriptNode): string {
  const separator = node.key.indexOf("::");
  return separator < 0 ? "" : node.key.slice(0, separator);
}

/**
 * Places UI-owned terminal chrome immediately before the run's final lead answer.
 *
 * The store keeps protocol event order for persistence and exports; this is a
 * presentation-only arrangement, so model-authored Markdown remains untouched.
 */
export function completionBeforeFinalAnswer(nodes: readonly TranscriptNode[]): TranscriptNode[] {
  const runAt = new Map<string, number>();
  const finalAnswerAt = new Map<string, number>();
  nodes.forEach((node, index) => {
    const runId = runIdOf(node);
    if (!runId) return;
    if (node.kind === "run") runAt.set(runId, index);
    else if (node.kind === "assistant" && node.subagentOrder === undefined)
      finalAnswerAt.set(runId, index);
  });

  const movedRuns = new Set<string>();
  for (const [runId, runIndex] of runAt) {
    const answerIndex = finalAnswerAt.get(runId);
    if (answerIndex !== undefined && answerIndex < runIndex) movedRuns.add(runId);
  }
  if (movedRuns.size === 0) return [...nodes];

  const arranged: TranscriptNode[] = [];
  nodes.forEach((node, index) => {
    const runId = runIdOf(node);
    if (movedRuns.has(runId) && finalAnswerAt.get(runId) === index)
      arranged.push(nodes[runAt.get(runId)!]!);
    if (!(node.kind === "run" && movedRuns.has(runId))) arranged.push(node);
  });
  return arranged;
}
