import type { Message } from "@clarvis/capability";

const MAX_OPERATOR_MESSAGE_BYTES = 4 * 1024;

/** Keep a UTF-8 suffix without a partial code point or an unbounded intermediate allocation. */
function tail(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const encoded = Buffer.from(text.slice(-bytes));
  let start = Math.max(0, encoded.length - bytes);
  while (start < encoded.length && (encoded.at(start)! & 0xc0) === 0x80) start++;
  return encoded.subarray(start).toString("utf8");
}

/**
 * Snapshot start/continue user text only, prioritizing newest messages within 4 KiB and retaining
 * chronological order. Non-text parts and assistant messages never supply operator intent.
 * Steers do not update RunRequest.messages and are deliberately absent from this snapshot.
 */
export function operatorMessage(messages: readonly Message[]): string | undefined {
  let result = "";
  let remaining = MAX_OPERATOR_MESSAGE_BYTES;
  for (let at = messages.length - 1; at >= 0 && remaining > 0; at--) {
    const message = messages.at(at)!;
    if (message.role !== "user") continue;
    const parts =
      typeof message.content === "string"
        ? [message.content]
        : message.content.filter((part) => part.type === "text").map((part) => part.text);
    for (let index = parts.length - 1; index >= 0 && remaining > 0; index--) {
      const text = parts.at(index)!;
      if (text.length === 0) continue;
      const separator = result.length === 0 ? "" : "\n";
      const kept = tail(text, remaining - separator.length);
      if (kept.length === 0) return result || undefined;
      result = kept + separator + result;
      remaining -= Buffer.byteLength(kept) + separator.length;
      if (kept.length < text.length) return result;
    }
  }
  return result || undefined;
}
