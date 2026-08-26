/** A plain-text fragment of a tool's structured result. */
export interface TextPart {
  type: "text";
  text: string;
}

/** A base64-encoded image fragment of a tool's structured result, carrying its
 * own MIME type. */
export interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

/** One piece of a structured tool result: either a {@link TextPart} or an
 * {@link ImagePart}. */
export type ContentPart = TextPart | ImagePart;

/**
 * The full result a tool handler may return: either a bare string (wrapped as a
 * single text part downstream) or an array of {@link ContentPart}s, with
 * optional out-of-band `meta`.
 */
export interface ToolResult {
  content: string | ContentPart[];
  meta?: Record<string, unknown>;
}

/**
 * Construct a {@link TextPart}.
 *
 * @param text - the fragment's text.
 * @returns the text content part.
 */
export function textPart(text: string): TextPart {
  return { type: "text", text };
}

/**
 * Construct an {@link ImagePart}.
 *
 * @param data - the base64-encoded image bytes.
 * @param mimeType - the image's MIME type (e.g. `image/png`).
 * @returns the image content part.
 */
export function imagePart(data: string, mimeType: string): ImagePart {
  return { type: "image", data, mimeType };
}

/**
 * Flatten a content-part array to its concatenated text, dropping image parts.
 *
 * @param content - the parts to flatten.
 * @returns the joined text of every {@link TextPart}, with image parts
 *   contributing the empty string.
 */
export function contentText(content: ContentPart[]): string {
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}
