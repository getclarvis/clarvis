import type { MessageContent } from "./api.ts";

/**
 * Flatten {@link MessageContent} to plain text.
 *
 * @param content - a string, or an array of content parts.
 * @returns the string as-is, or the parts joined by newlines with text parts
 *   inlined and every non-text part rendered as a `[type]` placeholder.
 */
export function contentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}
