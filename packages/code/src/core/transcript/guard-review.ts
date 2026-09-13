import type { TranscriptToolNode } from "./types.ts";

const ANSWERER_LABEL = {
  policy: "policy",
  human: "user",
  judge: "judge",
  session_allowlist: "session approval",
  unavailable: "no reviewer",
} as const;

/** Visible, replay-stable command-review label for a shell transcript row. */
export function guardReviewLabel(node: TranscriptToolNode): string {
  if ((node.toolName || node.mcpName) !== "shell" || node.guard === undefined) return "";
  const verdict = node.guard.outcome === "allowed" ? "approved" : "denied";
  return `${verdict} by ${ANSWERER_LABEL[node.guard.answerer]}`;
}
