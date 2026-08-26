import type { MessageContent } from "@clarvis/protocol";

/**
 * Flatten a {@link MessageContent} into plain text for previews and legacy
 * text-only surfaces.
 *
 * @param content - a plain string or an array of content parts.
 * @returns the string as-is, or each part's text joined by newlines with
 *   non-text parts rendered as `[type]` placeholders.
 * @remarks This is a deliberate duplicate of `@clarvis/capability`'s own
 * `contentToText` (`packages/capability/src/message-content.ts`), which
 * operates on that package's own `MessageContent`/`ContentPart` types rather
 * than `@clarvis/protocol`'s. `@clarvis/code` may depend only on
 * `@clarvis/kernel`, `@clarvis/protocol` and `@clarvis/paths` — never
 * `@clarvis/capability`, not even for a type — so the two implementations
 * cannot share a module or a test import. Each package's own test suite
 * (this file's `tests/message-content.test.ts` and capability's
 * `tests/message-content.test.ts`) independently asserts the same five
 * behavioral cases — string passthrough, empty string, a single text part, a
 * non-text part rendered as `[type]`, mixed parts joined by newline, and an
 * empty array — as the drift check: a change to one body that a maintainer
 * forgets to mirror in the other still fails its own package's suite, even
 * though nothing here enforces the two implementations stay byte-identical.
 */
export function contentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}
