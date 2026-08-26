import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@clarvis/capability";

describe("sanitizeText — the free-text rule set", () => {
  it("stays linear on a long unbroken token", () => {
    const small = "x".repeat(5_000);
    const large = "x".repeat(50_000);

    const t0 = performance.now();
    sanitizeText(small);
    const smallMs = performance.now() - t0;

    const t1 = performance.now();
    sanitizeText(large);
    const largeMs = performance.now() - t1;

    expect(largeMs).toBeLessThan(Math.max(50, smallMs * 30));
  });
});
