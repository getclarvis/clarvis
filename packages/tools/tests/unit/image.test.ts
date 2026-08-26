import { describe, expect, it } from "bun:test";
import { sniffImageMime } from "../../src/lib/image.ts";

describe("sniffImageMime", () => {
  it("detects PNG", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
  });

  it("detects JPEG", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("detects GIF (87a and 89a)", () => {
    expect(sniffImageMime(Buffer.from("GIF87a"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
  });

  it("detects WebP", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP"),
    ]);
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("returns null for a non-image buffer", () => {
    expect(sniffImageMime(Buffer.from("not an image at all"))).toBeNull();
  });

  it("returns null for a truncated signature", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it("does not treat a non-WEBP RIFF container as an image", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE"),
    ]);
    expect(sniffImageMime(wav)).toBeNull();
  });
});
