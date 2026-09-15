import { createHash } from "node:crypto";
import type { LLMCallResult } from "@clarvis/capability";

type PrefixEvidence = NonNullable<LLMCallResult["requestPrefix"]>;
interface Prefix {
  instructions: string;
  tools: string;
  items: string[];
  evidence: PrefixEvidence;
}
const MAX_CONVERSATIONS = 32;
const MAX_ITEMS = 8192;
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");

/** Bounded, content-opaque diagnostics of the JSON actually serialized by the SDK. */
export class SerializedPrefixWatch {
  private readonly conversations: Map<string, Prefix>;

  constructor() {
    this.conversations = new Map();
  }

  evidence(key: string | undefined): PrefixEvidence | undefined {
    return key === undefined ? undefined : this.conversations.get(hash(key))?.evidence;
  }

  wrap(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
    return Object.assign(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body === "string") {
          let body: Record<string, unknown> | undefined;
          try {
            body = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            /* Non-JSON transports have no comparable SDK request. */
          }
          if (body && typeof body.prompt_cache_key === "string")
            this.observe(body.prompt_cache_key, body);
        }
        return fetcher(input, init);
      },
      { preconnect: fetcher.preconnect },
    );
  }

  private observe(identity: string, body: Record<string, unknown>): void {
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];
    const items = Array.isArray(body.input)
      ? body.input
      : messages.filter((message) => message.role !== "system");
    const key = hash(identity);
    const previous = this.conversations.get(key);
    this.conversations.delete(key);
    if (items.length > MAX_ITEMS) return;
    const next: Prefix = {
      instructions: hash(
        body.instructions ?? messages.filter((message) => message.role === "system"),
      ),
      tools: hash(body.tools ?? []),
      items: items.map(hash),
      evidence: { previousItems: previous?.items.length ?? 0, currentItems: items.length },
    };
    if (previous) {
      if (previous.instructions !== next.instructions)
        next.evidence.divergence = { surface: "instructions" };
      else if (previous.tools !== next.tools) next.evidence.divergence = { surface: "tools" };
      else {
        const index = previous.items.findIndex((item, itemIndex) => next.items[itemIndex] !== item);
        if (index !== -1) next.evidence.divergence = { surface: "history", item: index };
      }
    }
    this.conversations.set(key, next);
    if (this.conversations.size > MAX_CONVERSATIONS)
      this.conversations.delete(this.conversations.keys().next().value!);
  }
}
