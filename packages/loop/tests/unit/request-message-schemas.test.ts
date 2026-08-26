import { describe, expect, it } from "../bun-test.ts";
import { messageSchema, messagesField } from "../../src/validation/request/message-schemas.ts";

describe("request message schemas", () => {
  it.each([
    { role: "system", content: "instructions" },
    { role: "assistant", content: "answer" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", image: "https://example.test/image.png" },
        { type: "image", image: "data:image/png;base64,AA==", mediaType: "image/png" },
      ],
    },
  ])("accepts a valid $role message", (message) => {
    expect(messageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    ["unknown role", { role: "tool", content: "x" }],
    ["empty text", { role: "user", content: "" }],
    ["oversized text", { role: "user", content: "x".repeat(1_000_001) }],
    ["multimodal system", { role: "system", content: [{ type: "text", text: "x" }] }],
    ["empty parts", { role: "user", content: [] }],
    ["unknown part", { role: "user", content: [{ type: "audio", audio: "x" }] }],
    ["empty text part", { role: "user", content: [{ type: "text", text: "" }] }],
    [
      "oversized image",
      { role: "user", content: [{ type: "image", image: "x".repeat(10_000_001) }] },
    ],
    [
      "too many parts",
      { role: "user", content: Array.from({ length: 101 }, () => ({ type: "text", text: "x" })) },
    ],
    ["unknown key", { role: "user", content: "x", extra: true }],
  ])("rejects %s", (_label, message) => {
    expect(messageSchema.safeParse(message).success).toBe(false);
  });

  it("owns the non-empty and maximum history bounds", () => {
    expect(messagesField.safeParse([]).success).toBe(false);
    expect(
      messagesField.safeParse(
        Array.from({ length: 10_001 }, () => ({ role: "user", content: "x" })),
      ).success,
    ).toBe(false);
  });

  it("rejects aggregate multimodal payloads even when every image is individually legal", () => {
    const image = "x".repeat(9_000_000);
    expect(
      messageSchema.safeParse({
        role: "user",
        content: [
          { type: "image", image },
          { type: "image", image },
        ],
      }).success,
    ).toBe(false);
  });

  it("bounds the complete history payload rather than only each message", () => {
    const image = "x".repeat(9_000_000);
    const message = { role: "user", content: [{ type: "image", image }] };
    expect(messagesField.safeParse([message, message, message, message]).success).toBe(false);
  });
});
