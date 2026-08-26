import { describe, it, expect } from "../helpers/bun-test.ts";
import { contentToText } from "../../src/message-content.ts";
import type { ContentPart } from "../../src/api.ts";

describe("contentToText", () => {
  it("returns a plain string unchanged", () => {
    expect(contentToText("hello world")).toBe("hello world");
  });

  it("joins text parts and renders images as an [image] placeholder", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "look:" },
      { type: "image", image: "data:image/png;base64,AAAA", mediaType: "image/png" },
      { type: "text", text: "done" },
    ];
    expect(contentToText(parts)).toBe("look:\n[image]\ndone");
  });

  it("renders an image-only array as just the placeholder", () => {
    expect(contentToText([{ type: "image", image: "https://ex.com/a.png" }])).toBe("[image]");
  });

  it("returns an empty string for an empty parts array", () => {
    expect(contentToText([])).toBe("");
  });
});
