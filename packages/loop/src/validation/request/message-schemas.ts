import { z } from "zod";

const CONTENT_MAX_CHARS = 1_000_000;
const IMAGE_MAX_CHARS = 10_000_000;
const CONTENT_PARTS_MAX = 100;
const MESSAGE_CONTENT_MAX_CHARS = 16_000_000;
const MESSAGES_TOTAL_MAX_CHARS = 16_000_000;

/** Count request payload characters without serializing or copying the body. */
function contentChars(
  content: string | Array<{ type: string; text?: string; image?: string }>,
): number {
  if (typeof content === "string") return content.length;
  let total = 0;
  for (const part of content) {
    total += part.type === "image" ? (part.image?.length ?? 0) : (part.text?.length ?? 0);
  }
  return total;
}

const textPartSchema = z
  .object({
    type: z.literal("text", { error: "content part type must be 'text' | 'image'" }),
    text: z
      .string()
      .min(1, "text part must be a non-empty string")
      .max(CONTENT_MAX_CHARS, `text part must be at most ${CONTENT_MAX_CHARS} characters`),
  })
  .strict();

const imagePartSchema = z
  .object({
    type: z.literal("image", { error: "content part type must be 'text' | 'image'" }),
    image: z
      .string()
      .min(1, "image must be a non-empty URL or base64 string")
      .max(IMAGE_MAX_CHARS, `image must be at most ${IMAGE_MAX_CHARS} characters`),
    mediaType: z.string().min(1, "mediaType must be a non-empty string").optional(),
  })
  .strict();

const contentPartSchema = z.discriminatedUnion("type", [textPartSchema, imagePartSchema]);

/**
 * A message body: either a single non-empty string (capped at
 * {@link CONTENT_MAX_CHARS}) or a non-empty array of up to
 * {@link CONTENT_PARTS_MAX} `text`/`image` parts (multimodal content).
 */
const messageContentSchema = z.union([
  z
    .string()
    .min(1, "content must be a non-empty string")
    .max(CONTENT_MAX_CHARS, `content must be at most ${CONTENT_MAX_CHARS} characters`),
  z
    .array(contentPartSchema)
    .min(1, "content parts must be a non-empty array")
    .max(CONTENT_PARTS_MAX, `content must contain at most ${CONTENT_PARTS_MAX} parts`),
]);

/**
 * A single conversation message: a `system`/`user`/`assistant` role and a
 * {@link messageContentSchema} body.
 *
 * @remarks Strict (no extra keys) and refined so array (multimodal) content is
 *   allowed only on a `user` message.
 */
export const messageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"], {
      error: "role must be 'system' | 'user' | 'assistant'",
    }),
    content: messageContentSchema,
  })
  .strict()
  .superRefine((m, ctx) => {
    if (Array.isArray(m.content) && m.role !== "user") {
      ctx.addIssue({
        code: "custom",
        message: "only 'user' messages may use array (multimodal) content",
        path: ["content"],
      });
    }
    if (contentChars(m.content) > MESSAGE_CONTENT_MAX_CHARS) {
      ctx.addIssue({
        code: "custom",
        message: `one message may contain at most ${MESSAGE_CONTENT_MAX_CHARS} payload characters`,
        path: ["content"],
      });
    }
  });

/**
 * The conversation history: a non-empty, count- and payload-bounded array of
 * {@link messageSchema} entries, forwarded verbatim.
 *
 * @remarks Per-part limits alone are not an aggregate limit: without this
 * refinement 100 legal 10 MB images in one message (and 10,000 such messages)
 * passed validation and could be retained by every child run.
 */
export const messagesField = z
  .array(messageSchema, { error: "messages must be a non-empty array" })
  .min(1, "messages must be a non-empty array")
  .max(10_000, "messages must contain at most 10000 entries")
  .superRefine((messages, ctx) => {
    let total = 0;
    for (const message of messages) {
      total += contentChars(message.content);
      if (total <= MESSAGES_TOTAL_MAX_CHARS) continue;
      ctx.addIssue({
        code: "custom",
        message: `messages may contain at most ${MESSAGES_TOTAL_MAX_CHARS} payload characters in total`,
      });
      break;
    }
  })
  .describe("Conversation history, forwarded verbatim.");
