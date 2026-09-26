import type { ReviewInput } from "./types.ts";

/** The action and authority-bearing evidence are kept intact or review fails. */
export function reviewPayload(input: ReviewInput, maxCharacters: number): string | undefined {
  const required = JSON.stringify({
    action: input.action,
    profile: input.profile,
    evidence: input.evidence.filter(
      (item) =>
        item.role === "user" ||
        item.role === "developer" ||
        item.role === "host" ||
        item.adoptedByUser,
    ),
  });
  if (required.length > maxCharacters) return undefined;
  const optional = JSON.stringify({
    previousResult: input.previousResult,
    otherEvidence: input.evidence.filter(
      (item) =>
        item.role !== "user" &&
        item.role !== "developer" &&
        item.role !== "host" &&
        !item.adoptedByUser,
    ),
  });
  return `${required}\n${optional.slice(0, Math.max(0, maxCharacters - required.length - 1))}`;
}
