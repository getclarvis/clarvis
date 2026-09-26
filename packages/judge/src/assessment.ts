import type { Assessment } from "./types.ts";

const risks = new Set(["low", "medium", "high", "critical"]);
const authorizations = new Set(["unknown", "low", "medium", "high"]);

/** Accept strict JSON or one valid JSON object enclosed in prose. */
export function parseAssessment(text: string): Required<Assessment> | undefined {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const item = value as Record<string, unknown>;
        if (item.outcome !== "allow" && item.outcome !== "deny") continue;
        if (
          item.risk_level !== undefined &&
          (typeof item.risk_level !== "string" || !risks.has(item.risk_level))
        )
          continue;
        if (
          item.user_authorization !== undefined &&
          (typeof item.user_authorization !== "string" ||
            !authorizations.has(item.user_authorization))
        )
          continue;
        if (item.rationale !== undefined && typeof item.rationale !== "string") continue;
        return {
          outcome: item.outcome,
          risk_level:
            (item.risk_level as Assessment["risk_level"] | undefined) ??
            (item.outcome === "allow" ? "low" : "high"),
          user_authorization:
            (item.user_authorization as Assessment["user_authorization"]) ?? "unknown",
          rationale:
            item.rationale ??
            (item.outcome === "allow"
              ? "No additional risk identified in the supplied evidence."
              : "The supplied evidence does not support this action."),
        };
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
