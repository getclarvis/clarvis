import { createHash } from "node:crypto";
import { GoalError } from "@clarvis/goal";

const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Canonical JSON for evidence digests; arrays retain order and object keys sort lexically. */
export function goalEvidenceDigest(value: unknown): string {
  const canonical = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new GoalError("resource_exhausted", "Evidence nesting exceeds its bound");
    if (Array.isArray(item)) return item.map((child) => canonical(child, depth + 1));
    if (typeof item === "object" && item !== null)
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child, depth + 1)]),
      );
    return item;
  };
  const encoded = JSON.stringify(canonical(value, 0));
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES)
    throw new GoalError("resource_exhausted", "Evidence payload exceeds its bound");
  return createHash("sha256").update(encoded).digest("hex");
}
