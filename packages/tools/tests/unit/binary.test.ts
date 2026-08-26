import { describe, expect, it } from "bun:test";
import { isBinary, isUtf16Bom } from "../../src/lib/binary.ts";

describe("isBinary (NUL-byte detection)", () => {
  it("detects a NUL near the start of a small buffer", () => {
    expect(isBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });

  it("returns false for a small clean buffer", () => {
    expect(isBinary(Buffer.from("plain text", "utf8"))).toBe(false);
  });

  it("detects a NUL that appears only in the trailing scan window", () => {
    const big = Buffer.alloc(9000, 0x61);
    big[8500] = 0;
    expect(isBinary(big)).toBe(true);
  });

  it("returns false for a large buffer that contains no NUL", () => {
    const big = Buffer.alloc(9000, 0x61);
    expect(isBinary(big)).toBe(false);
  });

  it("returns false for a NUL that sits between the head and tail scan windows", () => {
    const big = Buffer.alloc(20000, 0x61);
    big[10000] = 0;
    expect(isBinary(big)).toBe(false);
  });
});

describe("isUtf16Bom (BOM recognition)", () => {
  it("recognizes UTF-16 LE and BE BOMs and rejects others", () => {
    expect(isUtf16Bom(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe(true);
    expect(isUtf16Bom(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toBe(true);
    expect(isUtf16Bom(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(isUtf16Bom(Buffer.from([0xff]))).toBe(false);
  });
});
