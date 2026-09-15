/** Refuse media without reflecting guest-controlled URLs or payloads in diagnostics. */
function invalidMedia(): never {
  throw Object.assign(new Error("Guest model media must contain inline base64 image data"), {
    code: "invalid_request",
  });
}

/** Narrow untrusted JSON without accepting arrays as content records. */
function mediaRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidMedia();
  return value as Record<string, unknown>;
}

/** Accept base64 bytes or an image data URL, never a downloader destination. */
function assertInlineImage(value: unknown): void {
  if (typeof value !== "string") invalidMedia();
  let data = value;
  if (data.startsWith("data:")) {
    const header = /^data:image\/[a-zA-Z0-9.+-]+;base64,/u.exec(data);
    if (header === null) invalidMedia();
    data = data.slice(header[0].length);
  }
  if (
    !/^[a-zA-Z0-9+/]+={0,2}$/u.test(data) ||
    data.length % 4 === 1 ||
    (data.includes("=") && data.length % 4 !== 0)
  )
    invalidMedia();
}

/**
 * Validate guest media before invoking a host provider or its SDK downloader.
 *
 * @remarks The model broker bounds the complete serialized request before this
 * validation. User content and tool-result images may carry only inline image
 * bytes. Reject URL media even for a model that would strip images or forward
 * URLs: provider capabilities must never widen the guest's host-network authority.
 * Valid payloads remain byte-identical for prompt-prefix preservation.
 */
export function assertInlineModelMedia(messages: unknown): void {
  if (!Array.isArray(messages)) invalidMedia();
  for (const value of messages as unknown[]) {
    const message = mediaRecord(value);
    if (Array.isArray(message.content)) {
      for (const value of message.content as unknown[]) {
        const part = mediaRecord(value);
        if (part.type === "text") continue;
        if (part.type !== "image") invalidMedia();
        assertInlineImage(part.image);
      }
    }
    if (message.images !== undefined) {
      if (!Array.isArray(message.images)) invalidMedia();
      for (const value of message.images as unknown[]) {
        const image = mediaRecord(value);
        assertInlineImage(image.data);
      }
    }
  }
}
