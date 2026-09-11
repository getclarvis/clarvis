import type { ModelMessage, AssistantContent, ProviderMetadata, UserContent } from "ai";
import type { LiveMessage, MessageContent } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";

/**
 * Converts one user message's content into AI SDK {@link UserContent}, replacing
 * each image with a numbered placeholder when `stripImages` is set (for a model
 * that lacks vision).
 *
 * @param content - the message content, a plain string or an array of parts.
 * @param stripImages - when true, image parts become `[image #n omitted: …]`
 *   text rather than image parts.
 * @param imageCounter - a mutable counter shared across the whole message list so
 *   placeholder numbers are stable and monotonic.
 * @returns the content unchanged for a string, or the mapped parts (an empty
 *   string when stripping leaves nothing).
 */
function toUserContent(
  content: MessageContent,
  stripImages: boolean,
  imageCounter: { n: number },
): UserContent | string {
  if (typeof content === "string") return content;
  if (stripImages) {
    const parts: { type: "text"; text: string }[] = [];
    for (const p of content) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text });
      } else {
        const idx = imageCounter.n++;
        parts.push({ type: "text", text: `[image #${idx} omitted: active model lacks vision]` });
      }
    }
    return parts.length > 0 ? parts : "";
  }
  return content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    imageCounter.n++;
    return {
      type: "image" as const,
      image: part.image,
      ...(part.mediaType ? { mediaType: part.mediaType } : {}),
    };
  });
}

/**
 * Options for {@link toModelMessages}; `stripImages` replaces every image with a
 * numbered text placeholder for a model without vision.
 */
export interface ToModelMessagesOptions {
  stripImages?: boolean;
}

/**
 * Converts the loop's provider-neutral {@link LiveMessage} list into the AI SDK's
 * {@link ModelMessage} shape, wiring tool calls to their results and optionally
 * stripping images.
 *
 * @param messages - the conversation in the loop's internal representation.
 * @param opts - conversion options; see {@link ToModelMessagesOptions}.
 * @returns the messages as AI SDK `ModelMessage`s.
 * @remarks A first pass indexes tool names by call id so each `tool` message can
 *   name the tool its result answers (falling back to `"unknown"`); a tool
 *   result with images becomes a structured `content` output unless images are
 *   stripped, otherwise a plain text output. Assistant messages with tool calls
 *   emit leading text (if any) followed by `tool-call` parts.
 */
export function toModelMessages(
  messages: LiveMessage[],
  opts: ToModelMessagesOptions = {},
): ModelMessage[] {
  const stripImages = opts.stripImages ?? false;
  const imageCounter = { n: 0 };
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && "tool_calls" in m) {
      for (const tc of m.tool_calls) toolNameById.set(tc.id, tc.name);
    }
  }
  return messages.map((m): ModelMessage => {
    if (m.role === "tool") {
      const images = "images" in m ? m.images : undefined;
      const effectiveImages = stripImages ? undefined : images;
      const output =
        effectiveImages && effectiveImages.length > 0
          ? {
              type: "content" as const,
              value: [
                ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
                ...effectiveImages.map((img) => ({
                  type: "file" as const,
                  data: { type: "data" as const, data: img.data },
                  mediaType: img.mediaType,
                })),
              ],
            }
          : { type: "text" as const, value: m.content };
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id,
            toolName: toolNameById.get(m.tool_call_id) ?? "unknown",
            output,
          },
        ],
      };
    }
    if (m.role === "assistant") {
      const reasoning: AssistantContent =
        "reasoning" in m
          ? (m.reasoning ?? []).map((part) => ({
              type: "reasoning" as const,
              text: part.text,
              ...(part.providerOptions !== undefined
                ? { providerOptions: part.providerOptions as ProviderMetadata }
                : {}),
            }))
          : [];
      const textParts: AssistantContent =
        "text_parts" in m
          ? (m.text_parts ?? []).map((part) => ({
              type: "text" as const,
              text: part.text,
              ...(part.providerOptions !== undefined
                ? { providerOptions: part.providerOptions as ProviderMetadata }
                : {}),
            }))
          : [];
      if (
        reasoning.length > 0 ||
        textParts.length > 0 ||
        ("tool_calls" in m && m.tool_calls.length > 0)
      ) {
        const content: AssistantContent = [
          ...reasoning,
          ...(textParts.length > 0
            ? textParts
            : contentToText(m.content)
              ? [{ type: "text" as const, text: contentToText(m.content) }]
              : []),
          ...("tool_calls" in m
            ? m.tool_calls.map((tc) => ({
                type: "tool-call" as const,
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.arguments ?? {},
                ...(tc.providerOptions === undefined
                  ? {}
                  : { providerOptions: tc.providerOptions as ProviderMetadata }),
              }))
            : []),
        ];
        return { role: "assistant", content };
      }
      return { role: "assistant", content: contentToText(m.content) };
    }
    if (m.role === "system") return { role: "system", content: contentToText(m.content) };
    return { role: "user", content: toUserContent(m.content, stripImages, imageCounter) };
  });
}
