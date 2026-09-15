import type { LiveMessage } from "@clarvis/capability";

/**
 * Restore provider-issued function-call item ids omitted by the SDK's Responses serializer.
 *
 * @remarks Only a matching persisted call id can supply an item id. User messages,
 * tool results and newly synthesized items receive no identifiers. Existing SDK
 * ids win. The transform leaves native store/reference handling and all other
 * provider fields unchanged, and runs before host subscription authorization.
 */
export function withResponsesReplayIds(
  fetcher: typeof globalThis.fetch,
  messages: readonly LiveMessage[],
): typeof globalThis.fetch {
  const itemIds = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !("tool_calls" in message)) continue;
    for (const call of message.tool_calls) {
      const id = call.providerOptions?.openai?.itemId;
      if (typeof id === "string" && id.length > 0) itemIds.set(call.id, id);
    }
  }
  if (itemIds.size === 0) return fetcher;
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") return fetcher(input, init);
      const body = JSON.parse(init.body) as { input?: Array<Record<string, unknown>> };
      if (!Array.isArray(body.input)) return fetcher(input, init);
      let changed = false;
      for (const item of body.input) {
        if (
          item.type !== "function_call" ||
          item.id !== undefined ||
          typeof item.call_id !== "string"
        )
          continue;
        const id = itemIds.get(item.call_id);
        if (id === undefined) continue;
        item.id = id;
        changed = true;
      }
      return fetcher(input, changed ? { ...init, body: JSON.stringify(body) } : init);
    },
    { preconnect: fetcher.preconnect },
  );
}
