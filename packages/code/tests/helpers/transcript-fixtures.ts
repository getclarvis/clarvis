import type { TranscriptNode } from "../../src/adapters/store.ts";

/**
 * A transcript node plus the legacy `collapsed` flag.
 *
 * @remarks `TranscriptNode` does not declare `collapsed`, and deliberately so —
 * but `src/views/block-focus.ts` still honours it as the default-fold fallback,
 * reading it through exactly the widening this type expresses
 * (`node as TranscriptNode & { collapsed?: boolean }`). Fixtures that exercise
 * that path need somewhere to put the flag, and expressing the widening once
 * here keeps it from becoming a cast in every render suite.
 */
export type LegacyCollapsibleNode = TranscriptNode & { collapsed?: boolean };

/** A {@link LegacyCollapsibleNode} already narrowed to the `tool_call` member. */
export type LegacyCollapsibleToolNode = Extract<TranscriptNode, { kind: "tool_call" }> & {
  collapsed?: boolean;
};
