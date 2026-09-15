import { sanitizeText } from "@clarvis/capability";
import { cacheHash } from "../cache/wire.ts";
import type { GoalPhysicalCall } from "./fixture.ts";

/** Compare the recorded hashes at the ChatGPT boundary, whose header already hashes the key. */
export function goalChatGptAffinity(call: GoalPhysicalCall, sessionId: string): boolean {
  return call.sessionId === sessionId && call.sessionHeaderHash === cacheHash(call.keyHash);
}

/** Bounded argument structure for diagnostics; text, file contents and reasoning are never copied. */
export function goalArgumentShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth >= 4) return Array.isArray(value) ? "array" : "object";
  if (Array.isArray(value))
    return {
      length: value.length,
      items: value.slice(0, 2).map((item) => goalArgumentShape(item, depth + 1)),
    };
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 16)
      .map(([key, item]) => [key.slice(0, 80), goalArgumentShape(item, depth + 1)]),
  );
}

/** Retain safe failure text only; successful tool payloads remain in the host's private trace. */
export function goalToolFailure(error: string | null): string | undefined {
  return error === null ? undefined : sanitizeText(error).slice(0, 512);
}
