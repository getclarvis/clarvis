import type { ContentPart, ImagePart, MessageContent } from "@clarvis/protocol";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * Reports whether `path` has a recognized image file extension.
 *
 * @param path - A file path or reference string.
 * @returns `true` if the extension matches a known image type.
 */
export function isImageRef(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTS.has(path.slice(dot).toLowerCase());
}

/**
 * Extracts `@path` mention tokens from prompt text.
 *
 * @param text - The prompt text to scan.
 * @returns Every mentioned path, in order of appearance (duplicates kept).
 */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

/** Resolves a mentioned path to an {@link ImagePart}, or `null` if it cannot be loaded as one. */
export type ImageLoader = (path: string) => Promise<ImagePart | null>;

/**
 * Loads every distinct image mentioned in `text`, skipping non-image
 * mentions and mentions already seen earlier in the text.
 */
async function loadMentionImages(
  text: string,
  loadImage: ImageLoader,
  existing: readonly ImagePart[],
): Promise<ImagePart[]> {
  const images: ImagePart[] = [];
  const seen = new Set<string>();
  let imageCount = existing.length;
  let totalBytes = existing.reduce((total, image) => total + imagePartBytes(image), 0);
  for (const path of parseMentions(text)) {
    if (!isImageRef(path) || seen.has(path)) continue;
    seen.add(path);
    let img: ImagePart | null;
    try {
      img = await loadImage(path);
    } catch (error) {
      throw new MentionImageLoadError(path, error);
    }
    if (!img) continue;
    const bytes = imagePartBytes(img);
    const admission = checkImageAdmission(imageCount, totalBytes, bytes);
    if (!admission.ok) throw new MentionImageAdmissionError(path, admission);
    images.push(img);
    imageCount += 1;
    totalBytes += bytes;
  }
  return images;
}

/**
 * Builds message content from prompt text, folding in any mentioned images.
 *
 * @param text - The prompt text.
 * @param loadImage - Loader for `@path` image mentions.
 * @returns Plain `text` when no images resolved, otherwise a content-part array.
 */
export async function buildContent(text: string, loadImage: ImageLoader): Promise<MessageContent> {
  const images = await loadMentionImages(text, loadImage, []);
  if (images.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text.trim().length > 0) parts.push({ type: "text", text });
  parts.push(...images);
  return parts;
}

/**
 * Appends any images mentioned in the text parts of `parts` that are not
 * already present as content parts.
 *
 * @param parts - Existing content parts (text and/or images).
 * @param loadImage - Loader for `@path` image mentions.
 * @returns `parts` unchanged when no new images resolved, otherwise `parts` with images appended.
 */
export async function appendMentionImages(
  parts: ContentPart[],
  loadImage: ImageLoader,
): Promise<ContentPart[]> {
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
  const existing = parts.filter((part): part is ImagePart => part.type === "image");
  const images = await loadMentionImages(text, loadImage, existing);
  return images.length === 0 ? parts : [...parts, ...images];
}

type AttachmentKind = "image";

/** Maximum number of images staged in one composer submission. */
export const MAX_COMPOSER_IMAGES = 4;

/** Maximum decoded size of one staged composer image (5 MiB). */
export const MAX_COMPOSER_IMAGE_BYTES = 5 * 1024 * 1024;

/** Maximum decoded size shared by all staged composer images (10 MiB). */
export const MAX_COMPOSER_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;

/** Why a prospective composer image was refused. */
export type AttachmentAdmissionFailure = "empty" | "count" | "item_bytes" | "total_bytes";

/** Result of checking a prospective image against the composer budget. */
export type AttachmentAdmission =
  | { ok: true }
  | {
      ok: false;
      reason: AttachmentAdmissionFailure;
      actual: number;
      limit: number;
    };

/** A mentioned image failure that keeps the prompt out of a run and restores its draft. */
export abstract class MentionImageError extends Error {
  abstract readonly path: string;
}

/** The workspace could not return a mentioned image; never silently send without it. */
export class MentionImageLoadError extends MentionImageError {
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`message not sent; could not load @${path}: ${reason}`);
    this.name = "MentionImageLoadError";
  }
}

/** Format a byte count for composer-facing diagnostics. */
export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Human-readable reason shared by clipboard and mentioned-image admission. */
export function attachmentAdmissionMessage(
  admission: Exclude<AttachmentAdmission, { ok: true }>,
  prefix = "image not attached",
): string {
  switch (admission.reason) {
    case "empty":
      return `${prefix}: the image is empty`;
    case "count":
      return `${prefix}: at most ${admission.limit} images are allowed per message`;
    case "item_bytes":
      return `${prefix}: ${formatAttachmentBytes(admission.actual)} exceeds the ${formatAttachmentBytes(admission.limit)} per-image limit`;
    case "total_bytes":
      return `${prefix}: ${formatAttachmentBytes(admission.actual)} would exceed the ${formatAttachmentBytes(admission.limit)} total attachment limit`;
  }
}

/** Typed refusal raised before a mentioned image can reach a run request. */
export class MentionImageAdmissionError extends MentionImageError {
  constructor(
    readonly path: string,
    readonly admission: Exclude<AttachmentAdmission, { ok: true }>,
  ) {
    super(attachmentAdmissionMessage(admission, `message not sent; @${path}`));
    this.name = "MentionImageAdmissionError";
  }
}

/** A pending attachment staged in the composer before a prompt is submitted. */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  label: string;
  size?: number;
  data: string;
  mediaType?: string;
}

/** In-memory collection of staged {@link Attachment}s for the composer. */
export interface AttachmentStore {
  list: () => Attachment[];
  /** Check a decoded image size without retaining or encoding its payload. */
  canAddImage(bytes: number): AttachmentAdmission;
  /** Retain an attachment only when it fits every composer budget. */
  add(attachment: Attachment): AttachmentAdmission;
  remove(id: string): void;
  clear(): void;
}

/**
 * Computes the decoded byte length of an ordinary padded base64 payload
 * without allocating a decoded copy.
 */
export function base64DecodedBytes(data: string): number {
  if (data.length === 0) return 0;
  let padding = 0;
  if (data.endsWith("=")) padding += 1;
  if (data.endsWith("==")) padding += 1;
  return Math.max(0, Math.ceil((data.length * 3) / 4) - padding);
}

/** Decoded bytes represented by an inline image part; refs have no resident payload. */
function imagePartBytes(image: ImagePart): number {
  return image.data === undefined ? 0 : base64DecodedBytes(image.data);
}

/** Returns the larger of an attachment's declared and encoded payload sizes. */
export function attachmentBytes(attachment: Attachment): number {
  const declared = attachment.size;
  const normalizedDeclared =
    declared !== undefined && Number.isFinite(declared) && declared >= 0 ? Math.floor(declared) : 0;
  return Math.max(normalizedDeclared, base64DecodedBytes(attachment.data));
}

/**
 * Checks one prospective decoded image size against count, per-item and
 * aggregate composer budgets. The calculation walks existing metadata only;
 * it never serializes or decodes resident image payloads.
 */
export function checkAttachmentAdmission(
  existing: readonly Attachment[],
  bytes: number,
): AttachmentAdmission {
  const imageCount = existing.reduce((count, item) => count + (item.kind === "image" ? 1 : 0), 0);
  const totalBytes = existing.reduce(
    (total, item) => total + (item.kind === "image" ? attachmentBytes(item) : 0),
    0,
  );
  return checkImageAdmission(imageCount, totalBytes, bytes);
}

function checkImageAdmission(
  imageCount: number,
  existingBytes: number,
  bytes: number,
): AttachmentAdmission {
  if (imageCount >= MAX_COMPOSER_IMAGES) {
    return {
      ok: false,
      reason: "count",
      actual: imageCount + 1,
      limit: MAX_COMPOSER_IMAGES,
    };
  }

  const normalizedBytes =
    Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : Number.MAX_SAFE_INTEGER;
  if (normalizedBytes === 0) {
    return { ok: false, reason: "empty", actual: 0, limit: 1 };
  }
  if (normalizedBytes > MAX_COMPOSER_IMAGE_BYTES) {
    return {
      ok: false,
      reason: "item_bytes",
      actual: normalizedBytes,
      limit: MAX_COMPOSER_IMAGE_BYTES,
    };
  }

  const totalBytes = existingBytes + normalizedBytes;
  if (totalBytes > MAX_COMPOSER_IMAGE_TOTAL_BYTES) {
    return {
      ok: false,
      reason: "total_bytes",
      actual: totalBytes,
      limit: MAX_COMPOSER_IMAGE_TOTAL_BYTES,
    };
  }
  return { ok: true };
}

let attachSeq = 0;

/**
 * Generates a unique, monotonically distinct attachment id for this process.
 *
 * @returns A new attachment id of the form `att_<timestamp>_<seq>`.
 */
export function nextAttachmentId(): string {
  attachSeq += 1;
  return `att_${Date.now()}_${attachSeq}`;
}

/**
 * Composes message content from prompt text and staged attachments.
 *
 * @param text - The prompt text.
 * @param attachments - Staged attachments; only `"image"` attachments contribute content.
 * @returns Plain `text` when there are no image attachments, otherwise a content-part array.
 */
export function composeWithAttachments(text: string, attachments: Attachment[]): MessageContent {
  const images = attachments.filter((a) => a.kind === "image");
  if (images.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text.trim().length > 0) parts.push({ type: "text", text });
  for (const img of images) {
    const imagePart: ImagePart = {
      type: "image",
      mime: img.mediaType ?? "application/octet-stream",
      data: img.data,
    };
    parts.push(imagePart);
  }
  return parts;
}
