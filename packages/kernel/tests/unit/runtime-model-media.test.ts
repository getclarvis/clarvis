import { describe, expect, it } from "bun:test";
import { assertInlineModelMedia } from "../../src/runtime/model-media.ts";

describe("host model media admission", () => {
  it("preserves inline user and tool images byte-for-byte", () => {
    const messages = [
      { role: "system", content: "https://example.invalid is ordinary text" },
      {
        role: "user",
        content: [
          { type: "text", text: "read the images" },
          { type: "image", image: "YQ==" },
          { type: "image", image: "YWI" },
          { type: "image", image: "data:image/png;base64,YWJj" },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call",
        content: "",
        images: [{ data: "YWI=", mediaType: "image/png" }],
      },
    ];
    const original = structuredClone(messages);
    expect(() => assertInlineModelMedia(messages)).not.toThrow();
    expect(messages).toEqual(original);
  });

  it.each([
    "https://media.invalid/private?secret=fixture",
    "http://127.0.0.1/private",
    "http://[::1]/private",
    "file:///private.png",
    "blob:https://media.invalid/id",
    "//media.invalid/private",
    "data:image/png,https://media.invalid/private",
    "data:text/html;base64,YQ==",
    "data:image/png;base64,https://media.invalid/private",
    "data:image/png;base64,",
    "",
    "a",
    "ab=",
    "ab===",
    { url: "https://media.invalid/private" },
    null,
  ])("rejects non-inline or malformed image data %j in both media surfaces", (value) => {
    for (const message of [
      { role: "user", content: [{ type: "image", image: value }] },
      {
        role: "tool",
        content: "",
        tool_call_id: "call",
        images: [{ data: value, mediaType: "image/png" }],
      },
    ]) {
      expect(() => assertInlineModelMedia([message])).toThrow("inline base64 image data");
      try {
        assertInlineModelMedia([message]);
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_request" });
        expect((error as Error).message).not.toContain("private");
      }
    }
  });

  it.each([
    null,
    {},
    [null],
    [{ content: [null] }],
    [{ content: [{ type: "file", image: "https://media.invalid" }] }],
    [{ images: {} }],
    [{ images: [null] }],
  ])("fails closed on malformed media containers %j", (messages) => {
    expect(() => assertInlineModelMedia(messages)).toThrow("inline base64 image data");
  });
});
