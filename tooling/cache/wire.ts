import { createHash } from "node:crypto";
import type { CacheCall } from "./types.ts";

/** Hash exact serialized bytes or a JSON value without retaining its private contents. */
export function cacheHash(value: unknown): string {
  return createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : (JSON.stringify(value) ?? "undefined"),
    )
    .digest("hex");
}

export interface CapturedPrompt {
  instructions: unknown;
  tools: unknown;
  items: unknown[];
  key: string;
  parameters: Record<string, unknown>;
}

/** Separate prompt-bearing fields from transport/operational parameters at the actual HTTP boundary. */
export function capturePrompt(body: Record<string, unknown>): CapturedPrompt {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : [];
  const {
    input: _input,
    messages: _messages,
    tools = [],
    instructions,
    prompt_cache_key,
    ...parameters
  } = body;
  return {
    instructions: instructions ?? messages.filter((message) => message.role === "system"),
    tools,
    items: Array.isArray(body.input)
      ? body.input
      : messages.filter((message) => message.role !== "system"),
    key: typeof prompt_cache_key === "string" ? prompt_cache_key : "",
    parameters,
  };
}

/** Report the first changed historical item; hashes are never interpreted as remote token boundaries. */
export function firstPromptDivergence(
  previous: CapturedPrompt,
  current: CapturedPrompt,
): CacheCall["divergence"] {
  if (previous.key !== current.key) return { surface: "identity" };
  if (JSON.stringify(previous.instructions) !== JSON.stringify(current.instructions))
    return { surface: "instructions" };
  if (JSON.stringify(previous.tools) !== JSON.stringify(current.tools)) return { surface: "tools" };
  for (let index = 0; index < previous.items.length; index += 1) {
    if (JSON.stringify(previous.items[index]) !== JSON.stringify(current.items[index]))
      return { surface: "history", item: index };
  }
  return undefined;
}

/** Decode the two canonical components only after the production composer validated their format. */
export function cacheIdentityFromKey(key: string): { sessionId: string; agentInstanceId: string } {
  const parts = key.split("_");
  if (
    key.length > 512 ||
    parts.length !== 2 ||
    !parts.every((part) => /^(?:[A-Za-z0-9.:-]|%5F)+$/.test(part))
  )
    throw new Error("noncanonical_prompt_cache_identity");
  return {
    sessionId: parts[0].replaceAll("%5F", "_"),
    agentInstanceId: parts[1].replaceAll("%5F", "_"),
  };
}
