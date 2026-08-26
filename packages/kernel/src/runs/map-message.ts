import type {
  ContentPart as EngineContentPart,
  Message as EngineMessage,
  MessageContent,
} from "@clarvis/loop";
import type { ContentPart as ProtoContentPart, Message as ProtoMessage } from "@clarvis/protocol";

/** Fallback MIME assigned to an image part whose engine `mediaType` is unset. */
const DEFAULT_IMAGE_MIME = "application/octet-stream";

/** Projects engine message content to protocol content: a plain string passes
 * through; a part list maps text verbatim and carries an image's bytes as
 * `data` with its `mediaType` (or {@link DEFAULT_IMAGE_MIME}) as `mime`. */
function engineContentToProto(content: MessageContent): string | ProtoContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part: EngineContentPart): ProtoContentPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "image", mime: part.mediaType ?? DEFAULT_IMAGE_MIME, data: part.image };
  });
}

/** Inverse of {@link engineContentToProto}: an image resolves its bytes from the
 * protocol part's `data`, falling back to `ref` then the empty string, and its
 * `mime` becomes the engine `mediaType` only when present. */
function protoContentToEngine(content: string | ProtoContentPart[]): MessageContent {
  if (typeof content === "string") return content;
  return content.map((part): EngineContentPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image",
      image: part.data ?? part.ref ?? "",
      ...(part.mime ? { mediaType: part.mime } : {}),
    };
  });
}

/**
 * Converts engine messages to protocol messages, keeping only `user` and `assistant` roles.
 */
export function engineMessagesToProto(messages: readonly EngineMessage[]): ProtoMessage[] {
  const out: ProtoMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({ role: m.role, content: engineContentToProto(m.content) });
  }
  return out;
}

/** Normalizes a steer payload (string or protocol message) into engine message content. */
export function protoSteerToEngineContent(message: ProtoMessage | string): MessageContent {
  if (typeof message === "string") return message;
  return protoContentToEngine(message.content);
}

/** Converts protocol chat messages into engine messages. */
export function protoMessagesToEngine(messages: readonly ProtoMessage[]): EngineMessage[] {
  return messages.map((m) => ({ role: m.role, content: protoContentToEngine(m.content) }));
}
