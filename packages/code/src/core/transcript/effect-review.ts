import type { EffectReviewDetail } from "@clarvis/protocol";

/** Render bounded host receipt fields without incorporating reviewer prose or evidence text. */
export function effectReviewExplanation(detail: EffectReviewDetail): string[] {
  const lines: string[] = [];
  const word = (value: string): string =>
    /^[a-z][a-z0-9_.]{0,127}$/.test(value) ? value.replaceAll("_", " ") : "unknown";
  if (detail.effect !== undefined) {
    const effect = detail.effect;
    lines.push(`${word(effect.id)} · ${word(effect.attestation)} attestation`);
  }
  for (const issue of detail.analysis?.issues.slice(0, 8) ?? []) {
    if (!Number.isSafeInteger(issue.segmentIndex) || issue.segmentIndex < 0) continue;
    lines.push(
      `Segment ${issue.segmentIndex + 1}: ${word(issue.kind)} · ${issue.impact === "value" ? "argument value" : word(issue.impact)}`,
    );
  }
  if (detail.authority !== undefined) {
    lines.push(
      detail.authority.within_scope
        ? `Within authorized outcome · ${word(detail.authority.relation)}`
        : "Authority coverage could not be confirmed",
    );
  }
  if (detail.reviewer !== undefined) {
    const reviewer = detail.reviewer;
    const status =
      reviewer.failure_kind === "timeout"
        ? "timed out"
        : word(reviewer.failure_kind ?? reviewer.status);
    const attempts = reviewer.attempts;
    lines.push(
      `Reviewer ${status}${Number.isSafeInteger(attempts) && attempts! >= 0 ? ` after ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}`,
    );
  }
  return lines;
}
