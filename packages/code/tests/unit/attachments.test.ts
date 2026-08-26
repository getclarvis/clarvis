import { expect, test } from "bun:test";
import type { ImagePart } from "@clarvis/protocol";
import { createRoot } from "solid-js";
import {
  appendMentionImages,
  attachmentBytes,
  base64DecodedBytes,
  buildContent,
  checkAttachmentAdmission,
  composeWithAttachments,
  isImageRef,
  MAX_COMPOSER_IMAGE_BYTES,
  MAX_COMPOSER_IMAGE_TOTAL_BYTES,
  MAX_COMPOSER_IMAGES,
  MentionImageAdmissionError,
  MentionImageLoadError,
  nextAttachmentId,
  parseMentions,
  type Attachment,
} from "../../src/core/attachments.ts";
import { createAttachmentStore } from "../../src/views/input/attachments.ts";
import { detectTrigger } from "../../src/views/input/autocomplete.ts";

function imageAttachment(id: string, data = "b64", mediaType = "image/png", size = 10): Attachment {
  return { id, kind: "image", label: "shot.png", size, data, mediaType };
}

function base64PayloadForBytes(bytes: number): string {
  const padding = (3 - (bytes % 3)) % 3;
  return "A".repeat(Math.ceil(bytes / 3) * 4 - padding) + "=".repeat(padding);
}

test("parseMentions: extracts @paths at start/after-space; ignores emails", () => {
  expect(parseMentions("see @src/auth.ts and @docs/x.md")).toEqual(["src/auth.ts", "docs/x.md"]);
  expect(parseMentions("mail me at a@b.com")).toEqual([]);
  expect(parseMentions("no mentions here")).toEqual([]);
});

test("isImageRef: recognizes image extensions case-insensitively", () => {
  expect(isImageRef("shot.png")).toBe(true);
  expect(isImageRef("a/b/PHOTO.JPEG")).toBe(true);
  expect(isImageRef("src/main.ts")).toBe(false);
});

test("buildContent: no image mentions → the plain string (pointer refs stay inline, D24)", async () => {
  expect(await buildContent("review @src/auth.ts please", async () => null)).toBe(
    "review @src/auth.ts please",
  );
});

test("buildContent: an image mention resolves to a ContentPart[] of text + ImagePart", async () => {
  const img: ImagePart = { type: "image", mime: "image/png", data: "b64" };
  const load = async (p: string): Promise<ImagePart | null> => (p === "shot.png" ? img : null);
  const out = await buildContent("look at @shot.png", load);
  expect(out).toEqual([{ type: "text", text: "look at @shot.png" }, img]);
});

test("buildContent: an unresolvable image (missing file) is skipped → stays a string", async () => {
  expect(await buildContent("look at @gone.png", async () => null)).toBe("look at @gone.png");
});

test("buildContent: an oversized @image is rejected with the clipboard per-item limit", async () => {
  const data = base64PayloadForBytes(MAX_COMPOSER_IMAGE_BYTES + 1);
  const load = async (): Promise<ImagePart> => ({ type: "image", mime: "image/png", data });

  try {
    await buildContent("look at @large.png", load);
    throw new Error("expected mentioned image admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MentionImageAdmissionError);
    expect(error).toMatchObject({
      path: "large.png",
      admission: { ok: false, reason: "item_bytes", limit: MAX_COMPOSER_IMAGE_BYTES },
    });
  }
});

test("appendMentionImages: no image mentions in the text parts → the parts array is returned unchanged", async () => {
  const parts = [{ type: "text" as const, text: "review @src/auth.ts please" }];
  const out = await appendMentionImages(parts, async () => null);
  expect(out).toBe(parts);
});

test("appendMentionImages: joins only the text parts before scanning for mentions", async () => {
  const img: ImagePart = { type: "image", mime: "image/png", data: "b64" };
  const load = async (p: string): Promise<ImagePart | null> => (p === "shot.png" ? img : null);
  const parts = [
    { type: "text" as const, text: "look at" },
    { type: "image" as const, mime: "image/jpeg", data: "already-there" },
    { type: "text" as const, text: "@shot.png" },
  ];
  const out = await appendMentionImages(parts, load);
  expect(out).toEqual([...parts, img]);
});

test("appendMentionImages: duplicate mentions of the same image are only appended once", async () => {
  const img: ImagePart = { type: "image", mime: "image/png", data: "b64" };
  const load = async (p: string): Promise<ImagePart | null> => (p === "shot.png" ? img : null);
  const parts = [{ type: "text" as const, text: "@shot.png and again @shot.png" }];
  const out = await appendMentionImages(parts, load);
  expect(out).toEqual([...parts, img]);
});

test("appendMentionImages: an unresolvable mention leaves the parts untouched", async () => {
  const parts = [{ type: "text" as const, text: "@gone.png" }];
  const out = await appendMentionImages(parts, async () => null);
  expect(out).toBe(parts);
});

test("appendMentionImages: an operational load error is explicit and names the mention", async () => {
  const error = await appendMentionImages(
    [{ type: "text", text: "inspect @huge.png" }],
    async () => {
      throw new Error("backend image limit exceeded");
    },
  ).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(MentionImageLoadError);
  expect(error).toMatchObject({ path: "huge.png" });
  expect((error as Error).message).toContain("message not sent");
});

test("appendMentionImages: staged images count toward the @mention aggregate limit", async () => {
  const fiveMiB = base64PayloadForBytes(MAX_COMPOSER_IMAGE_BYTES);
  const parts = [
    { type: "image" as const, mime: "image/png", data: fiveMiB },
    { type: "image" as const, mime: "image/png", data: fiveMiB },
    { type: "text" as const, text: "and @one-more.png" },
  ];
  const load = async (): Promise<ImagePart> => ({
    type: "image",
    mime: "image/png",
    data: "AA==",
  });

  try {
    await appendMentionImages(parts, load);
    throw new Error("expected mentioned image aggregate admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MentionImageAdmissionError);
    expect(error).toMatchObject({
      path: "one-more.png",
      admission: { ok: false, reason: "total_bytes", limit: MAX_COMPOSER_IMAGE_TOTAL_BYTES },
    });
  }
});

test("detectTrigger: `/` anchors at start only; whitespace after closes it", () => {
  expect(detectTrigger("/exp", ["/", "@"])).toEqual({ trigger: "/", term: "exp" });
  expect(detectTrigger("/export done", ["/", "@"])).toBeNull();
  expect(detectTrigger("hi /export", ["/", "@"])).not.toEqual({ trigger: "/", term: "export" });
});

test("detectTrigger: `@` matches the current (last) token, mid-line", () => {
  expect(detectTrigger("@src", ["/", "@"])).toEqual({ trigger: "@", term: "src" });
  expect(detectTrigger("review @aut", ["/", "@"])).toEqual({ trigger: "@", term: "aut" });
  expect(detectTrigger("a@b", ["/", "@"])).toBeNull();
});

test("createAttachmentStore: add/remove/clear/list over solid signals", () => {
  createRoot((dispose) => {
    const store = createAttachmentStore();
    expect(store.list()).toEqual([]);

    const a = imageAttachment("att_1");
    const b = imageAttachment("att_2");
    expect(store.add(a)).toEqual({ ok: true });
    expect(store.add(b)).toEqual({ ok: true });
    expect(store.list()).toEqual([a, b]);

    store.remove("att_1");
    expect(store.list()).toEqual([b]);

    store.clear();
    expect(store.list()).toEqual([]);
    dispose();
  });
});

test("base64DecodedBytes: measures padded payloads without decoding them", () => {
  for (const bytes of [1, 2, 3, 4, 5, 31]) {
    const data = Buffer.alloc(bytes, 0x61).toString("base64");
    expect(base64DecodedBytes(data)).toBe(bytes);
  }
  expect(base64DecodedBytes("")).toBe(0);
});

test("attachmentBytes: encoded data cannot hide behind an understated size", () => {
  const data = Buffer.alloc(32, 0x61).toString("base64");
  expect(attachmentBytes(imageAttachment("att_1", data, "image/png", 1))).toBe(32);
});

test("checkAttachmentAdmission: rejects empty, fifth, oversized and aggregate-overflow images", () => {
  expect(checkAttachmentAdmission([], 0)).toMatchObject({ ok: false, reason: "empty" });
  expect(checkAttachmentAdmission([], MAX_COMPOSER_IMAGE_BYTES + 1)).toMatchObject({
    ok: false,
    reason: "item_bytes",
    limit: MAX_COMPOSER_IMAGE_BYTES,
  });

  const four = Array.from({ length: MAX_COMPOSER_IMAGES }, (_, index) =>
    imageAttachment(`att_${index}`, "AA==", "image/png", 1),
  );
  expect(checkAttachmentAdmission(four, 1)).toMatchObject({
    ok: false,
    reason: "count",
    limit: MAX_COMPOSER_IMAGES,
  });

  const fullBudget = [
    imageAttachment("att_1", "AA==", "image/png", MAX_COMPOSER_IMAGE_TOTAL_BYTES / 2),
    imageAttachment("att_2", "AA==", "image/png", MAX_COMPOSER_IMAGE_TOTAL_BYTES / 2),
  ];
  expect(checkAttachmentAdmission(fullBudget, 1)).toMatchObject({
    ok: false,
    reason: "total_bytes",
    limit: MAX_COMPOSER_IMAGE_TOTAL_BYTES,
  });
});

test("createAttachmentStore: rejected images never enter reactive composer state", () => {
  createRoot((dispose) => {
    const store = createAttachmentStore();
    for (let index = 0; index < MAX_COMPOSER_IMAGES; index += 1) {
      expect(store.add(imageAttachment(`att_${index}`, "AA==", "image/png", 1))).toEqual({
        ok: true,
      });
    }
    expect(store.add(imageAttachment("att_extra", "AA==", "image/png", 1))).toMatchObject({
      ok: false,
      reason: "count",
    });
    expect(store.list()).toHaveLength(MAX_COMPOSER_IMAGES);
    dispose();
  });
});

test("nextAttachmentId: successive calls produce unique ids", () => {
  const a = nextAttachmentId();
  const b = nextAttachmentId();
  const c = nextAttachmentId();
  expect(a).not.toBe(b);
  expect(b).not.toBe(c);
  expect(a).not.toBe(c);
  expect(a.startsWith("att_")).toBe(true);
});

test("composeWithAttachments: 0 attachments → the plain string", () => {
  expect(composeWithAttachments("hello", [])).toBe("hello");
});

test("composeWithAttachments: 1 image + non-empty text → [TextPart, ImagePart]", () => {
  const out = composeWithAttachments("look", [imageAttachment("att_1", "b64", "image/png")]);
  expect(out).toEqual([
    { type: "text", text: "look" },
    { type: "image", mime: "image/png", data: "b64" },
  ]);
});

test("composeWithAttachments: 1 image + empty text → only [ImagePart]", () => {
  const out = composeWithAttachments("   ", [imageAttachment("att_1", "b64", "image/png")]);
  expect(out).toEqual([{ type: "image", mime: "image/png", data: "b64" }]);
});

test("composeWithAttachments: 2 images + non-empty text → [TextPart, ImagePart, ImagePart]", () => {
  const out = composeWithAttachments("two", [
    imageAttachment("att_1", "d1", "image/png"),
    imageAttachment("att_2", "d2", "image/jpeg"),
  ]);
  expect(out).toEqual([
    { type: "text", text: "two" },
    { type: "image", mime: "image/png", data: "d1" },
    { type: "image", mime: "image/jpeg", data: "d2" },
  ]);
});

test("composeWithAttachments: no attachments → the plain string (not a ContentPart[])", () => {
  expect(composeWithAttachments("just text", [])).toBe("just text");
});
