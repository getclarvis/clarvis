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
  const prefix = node.guard.mode === "auto" ? "auto-guard" : "guard";
  const verdict = node.guard.outcome === "allowed" ? "approved" : "denied";
  const facts = [node.guard.effect_id, node.guard.relation, node.guard.failure_kind].filter(
    (value): value is string => value !== undefined && /^[a-z][a-z0-9_.]{0,127}$/.test(value),
  );
  return `${prefix} ${verdict} · ${ANSWERER_LABEL[node.guard.answerer]}${facts.length === 0 ? "" : " · " + facts.join(" · ")}`;
}
